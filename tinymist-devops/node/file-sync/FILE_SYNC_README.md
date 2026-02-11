# Tinymist File Sync (Node + Laravel)

Production places the Node server behind Nginx on Ubuntu; local development runs it directly.

## Architecture Summary

1. **Laravel bootstraps the file**
   - Source-of-truth is the page content in DB.
   - File path: storage/app/tinymist/page_<id>.typ
   - Logic (see TinymistPreviewManager + PageEditorData):
     - If file does not exist, create from DB and fill the editor textarea.
     - If file exists and is newer than DB, keep file and fill editor with file content.

2. **CodeMirror in the front end editor in the Browser** captures changes,
    - editor.ts,
      - Tracks `docVersion` and maintains up to 3 trailing snapshots.
      - Debounces and accumulates ChangeSets before sending (all in CodeMirror format).
      - Receives semantic tokens + diagnostics with `docVersion` for mapping.
    - sync-and-lsp.ts module keeps connection to file sync websocket server.

3. **Node WebSocket service** (`tinymist-devops/node/file-sync/server.ts`) handles authenticated connections and forwards file-related tasks to the FileManager. Server also notifies lsp-client.ts about changes and it in turn notifies LSP server.

4. **Code Mirror in the back end file-manager.ts**  checks document version for the sync, and writes updates to the of the file in the `storage/app/tinymist`. If the version of the file is bigger on the back end, it sends "full sync" document to the browser to sync it.

5. `storage/app/tinymist/page_#` files a real files, not virtual ones. That allows for tinymist preview to watch it and send incremental updates. As soon as LSP server is notified of changes it will provide diagnostics. It can also provide other things if queried for them specifically.

6. Temporary storage files should be removed after no connections are using them anymore + some wait period allowing to recover lost connections or "back" returns of the user from settings and such. **Full sync note** in many such cases WASM also goes out sync and "current" data-plane request is needed for reset. Standard tinymist preview provides slightly different "new" reply to "current" from what is needed for incremental changes, that's why I keep patched version of tinymist.

7. Actual save and autosave to db happens outside of the websocket area through saving browser form to Laravel.

## Protocol Between Browser and Node

1. **Change capture** – Extend `tinymist/editor.ts` with a CodeMirror `updateListener` that, whenever `transaction.docChanged`, serializes `transaction.changes.toJSON()` alongside the client’s current document version (`docVersion`). Debounce transmissions to ~150 ms to reduce chatter.

2. **Message payload** – Send JSON frames such as:

  ```json
  {
   "type": "changes",
   "pageId": 266,
   "docVersion": 42,
   "changes": { /* ChangeSet JSON from CodeMirror */ }
  }
  ```

  Reserve other message types for `ping`, `pong`, and optional server notifications.

3.**Server apply** – In the Node handler, load the current text into `@codemirror/state`’s `Text` object, reconstruct the `ChangeSet` from the JSON (`ChangeSet.fromJSON`), apply it, update the stored version, and write the resulting string back to `storage/app/tinymist/page_<id>.typ` using `fs.promises.writeFile`. Reject messages whose `docVersion` is behind the server’s version and request a resync.

4.**Resync flow** – Provide a `fullState` message type so the server can push the authoritative document when a client reconnects or drifts. The browser replaces its CodeMirror contents and resets the local version counter.

## Confirmed Decisions

- Laravel/DB is the initial content authority.
- Node writes the authoritative file under storage/app/tinymist/page_<id>.typ.
- Tinymist preview watches files directly; LSP is notified via didOpen/didChange.
