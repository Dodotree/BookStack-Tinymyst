# Tinymist Attachment File Flow

End-to-end lifecycle of an attachment file in the Tinymist editor integration.

---

## Storage Locations

| Purpose | Path |
|---------|------|
| **Permanent storage** (DB-tracked) | `storage/uploads/files/{Y-m-M}/{hash}` (disk: `local_secure_attachments`) |
| **Preview directory** (per-page working copy) | `storage/app/tinymist/page_{pageId}/` |
| **Main Typst source** | `storage/app/tinymist/page_{pageId}/entry.typ` |
| **Attachment preview copy** | `storage/app/tinymist/page_{pageId}/{fileName}` |
| **DB record** | `attachments` table (`path`, `name`, `extension`, `page_id`, `uploaded_to`) |

---

## HTTP Endpoints

| Method | Path | Controller | Purpose |
|--------|------|------------|---------|
| `POST` | `/attachments/upload/{pageId}` | `AttachmentController::upload` | Standard BookStack attachment upload |
| `POST` | `/attachments/upload/{id}` | `AttachmentController::uploadUpdate` | Replace existing attachment file |
| `DELETE` | `/attachments/{id}` | `AttachmentController::delete` | Delete attachment |
| `GET` | `/attachments/dirty/page/{pageId}` | `TinymistAttachmentController::dirtyMapForPage` | Dirty-state map (hash comparison) |
| `PUT` | `/attachments/{id}/save-from-preview` | `TinymistAttachmentController::saveFromPreview` | Preview → permanent storage |
| `PUT` | `/attachments/{id}/undo-from-preview` | `TinymistAttachmentController::undoFromPreview` | Permanent → preview (revert) |
| `POST` | `/attachments/new-file` | `TinymistAttachmentController::createBlankFile` | Create empty attachment file |

---

## Block Diagram – Upload Flow

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                            │
│                                                                                 │
│  ┌──────────────────────┐     ┌──────────────────────────────────┐              │
│  │  BookStack Attachment │     │  TinymistAttachmentsBridge (JS)  │              │
│  │  Panel (dropzone)     │────▶│  - listens: dropzone-upload-     │              │
│  │  themes/tinymist/     │     │    success, ajax-form-success,   │              │
│  │  attachments/         │     │    ajax-delete-row-success       │              │
│  │  manager-list.blade   │     │  - reloads attachment list       │              │
│  └──────────┬───────────┘     │  - refreshes dirty map           │              │
│             │ POST            └──────────────────────────────────┘              │
│             │ /attachments/upload/{pageId}                                       │
│             │ (multipart file)                                                  │
└─────────────┼───────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              LARAVEL (PHP)                                      │
│                                                                                 │
│  ┌─────────────────────────┐                                                    │
│  │ AttachmentController    │                                                    │
│  │ ::upload()              │                                                    │
│  │  - validates: perms,    │                                                    │
│  │    file size, extension │                                                    │
│  └───────────┬─────────────┘                                                    │
│              │                                                                  │
│              ▼                                                                  │
│  ┌─────────────────────────┐                                                    │
│  │ AttachmentService       │                                                    │
│  │ ::saveNewUpload()       │                                                    │
│  │  1. putFileInStorage()  │──▶ uploads/files/{Y-m-M}/{hash}                    │
│  │  2. create Attachment   │──▶ DB: attachments table                           │
│  │     record              │                                                    │
│  │  3. tinymistAttachment  │                                                    │
│  │     SyncService         │                                                    │
│  │     ->syncAttachment    │                                                    │
│  │       IfNeeded()        │                                                    │
│  └───────────┬─────────────┘                                                    │
│              │                                                                  │
│              ▼                                                                  │
│  ┌─────────────────────────┐                                                    │
│  │ TinymistAttachment      │                                                    │
│  │ SyncService              │                                                    │
│  │ ::syncAttachmentIfNeeded │                                                    │
│  │  - checks: external?    │                                                    │
│  │  - checks: page.editor  │                                                    │
│  │    === 'tinymist'?      │                                                    │
│  └───────────┬─────────────┘                                                    │
│              │ if tinymist page                                                 │
│              ▼                                                                  │
│  ┌─────────────────────────┐                                                    │
│  │ TinymistPreviewManager  │                                                    │
│  │ ::syncNewAttachment     │                                                    │
│  │   ToPreviewDir()        │                                                    │
│  │  - ensures dir exists   │                                                    │
│  │  - syncSingleAttach()   │──▶ COPY: permanent → page_{id}/{fileName}          │
│  │    (skips entry.typ)    │    (skip if dest mtime ≥ source mtime)             │
│  └─────────────────────────┘                                                    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Block Diagram – Editor Load & Initial Sync

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                            │
│                                                                                 │
│  User opens page for editing                                                    │
│             │                                                                   │
│             ▼  GET /pages/{slug}/edit                                           │
└─────────────┼───────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  PageController::edit() → PageEditorData                                        │
│  if editor === Tinymist && tinymist.enabled:                                    │
│     TinymistPageEditorBridge::startPreview()                                    │
│       │                                                                         │
│       ▼                                                                         │
│  TinymistPreviewManager::ensurePreviewFileContent(page)                         │
│   1. Create storage/app/tinymist/page_{id}/ if needed                           │
│   2. Migrate legacy page_{id}.typ → page_{id}/entry.typ                         │
│   3. Write entry.typ from DB markdown (or keep newer preview file)              │
│   4. syncAttachmentFiles(page) ── copies ALL page attachments ──▶               │
│      For each non-external attachment:                                           │
│        syncSingleAttachment(pageId, attachment)                                 │
│          permanent storage ──COPY──▶ page_{id}/{fileName}                       │
│   5. Mint JWT ws_token for browser WS auth                                      │
│                                                                                 │
│  Returns: { ws_token } → passed to blade view                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                            │
│                                                                                 │
│  Blade renders tinymist-editor.blade.php with ws_token                          │
│     │                                                                           │
│     ├──▶ TinymistEditor component (tinymist-editor.ts)                          │
│     │      └──▶ TinymistApp (tinymist/index.ts)                                 │
│     │             ├──▶ TinymistEditorUI (editor/editor.ts)                      │
│     │             ├──▶ TinymistConnectionsManager                               │
│     │             │      ├──▶ TinymistTokenManager (WS auth)                    │
│     │             │      ├──▶ TinymistFileSyncClient (sync-and-lsp.ts)          │
│     │             │      │     connects WS: /ws/tinymist/file-sync/?token=...   │
│     │             │      └──▶ PreviewWS (preview-ws.ts)                         │
│     │             │            connects WS: /ws/tinymist/preview/?token=...     │
│     │             └──▶ TinymistFileDropdown (file-dropdown.ts)                  │
│     │                                                                           │
│     └──▶ TinymistAttachmentsBridge (tinymist-attachments-bridge.ts)             │
│            └──▶ GET /attachments/dirty/page/{pageId}                            │
│                 (initial dirty map)                                              │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Block Diagram – Editing & Live Sync

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER: Editor                                                                 │
│                                                                                 │
│  TinymistEditorUI (CodeMirror)                                                  │
│   │  user types / edits attachment file via file dropdown                        │
│   │                                                                             │
│   ├──▶ updateListener fires on docChanged                                       │
│   │    sends WS: { type:"changes", pageId, fileName, docVersion, changes }      │
│   │                                                                             │
│   ├──▶ queueDirtyStateEmit() (debounced 300ms)                                  │
│   │    compares content hash vs savedContentHash                                │
│   │    emits tmEvents.FileDirtyState = "file-dirty-state"                       │
│   │      { fileName, isDirty: true/false }                                      │
│   │                                                                             │
│   └──▶ (skips entry.typ for dirty tracking)                                     │
│                                                                                 │
│  EVENT BRIDGE (tinymist-editor.ts):                                             │
│   "file-dirty-state" ──▶ "attachments-file-dirty-state"                         │
│                                                                                 │
│  TinymistAttachmentsBridge:                                                     │
│   listens "attachments-file-dirty-state"                                        │
│    └──▶ handleAttachmentStateChange()                                           │
│         updates attachmentSessionDirtyByName map                                │
│         applies dirty styling to list row                                       │
│         emits "attachments-dirty-map-updated"                                   │
│                                                                                 │
│  EVENT BRIDGE:                                                                  │
│   "attachments-dirty-map-updated" ──▶ "files-dirty-updated"                     │
│                                                                                 │
│  TinymistFileDropdown:                                                          │
│   listens "files-dirty-updated"                                                 │
│    └──▶ marks dropdown options with "* " prefix for dirty files                 │
│                                                                                 │
└──────────────────────────────┬──────────────────────────────────────────────────┘
                               │ WS: changes
                               ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ NODE: File Sync Server (file-sync/server.ts)                                    │
│                                                                                 │
│  receives { type:"changes", pageId, fileName, docVersion, changes }             │
│    │                                                                            │
│    ▼                                                                            │
│  FileManager (file-manager.ts)                                                  │
│   - reconstructs ChangeSet via CodeMirror                                       │
│   - applies to in-memory Text object                                            │
│   - version check (reject if docVersion behind)                                 │
│   - writes result to:                                                           │
│     storage/app/tinymist/page_{id}/{fileName}    ◀── PREVIEW DIRECTORY          │
│                                                                                 │
│  LSPClient (lsp-client.ts)                                                      │
│   - notified of change via didChange                                            │
│   - sends diagnostics back → forwarded to browser                               │
│                                                                                 │
│  Tinymist Preview Process (separate child process)                              │
│   - watches the .typ files in page_{id}/ directory                              │
│   - detects change, emits incremental SVG render diffs                          │
│   - diffs forwarded via Preview Bridge → browser WASM → SVG                     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Block Diagram – Save from Preview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                         │
│                                                                                 │
│  Attachment list row: [Save] button clicked                                     │
│    │                                                                            │
│    ▼                                                                            │
│  DOM event: "event-emit-select-save" { id: attachmentId }                       │
│    │                                                                            │
│    ▼                                                                            │
│  TinymistAttachmentsBridge::handleSaveRequest()                                 │
│    │  PUT /attachments/{id}/save-from-preview                                   │
│    │                                                                            │
└────┼────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ LARAVEL                                                                         │
│                                                                                 │
│  TinymistAttachmentController::saveFromPreview($id)                             │
│    - validates: attachment exists, page.editor === tinymist                      │
│    - checks: AttachmentUpdate permission                                        │
│    │                                                                            │
│    ▼                                                                            │
│  TinymistAttachmentSyncService::saveFromPreview(attachment)                     │
│    1. reads preview file:                                                       │
│       storage/app/tinymist/page_{id}/{fileName}                                 │
│    2. writeFromLocalPath() → writes to permanent storage disk                   │
│       uploads/files/{date}/{hash}                                               │
│    3. updates attachment.updated_by                                             │
│    │                                                                            │
│    ▼                                                                            │
│  returns { fileName }                                                           │
│                                                                                 │
└────┬────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                         │
│                                                                                 │
│  TinymistAttachmentsBridge::markAttachmentClean(fileName)                       │
│    - sets both dirty maps to false                                              │
│    - updates list row UI (disables Save/Undo buttons)                           │
│    - emits "attachments-dirty-map-updated" → "files-dirty-updated"              │
│    - file dropdown removes "* " prefix                                          │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Block Diagram – Undo / Revert from Preview

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                         │
│                                                                                 │
│  Attachment list row: [Undo] button clicked                                     │
│    │                                                                            │
│    ▼                                                                            │
│  DOM event: "event-emit-select-undo" { id: attachmentId }                       │
│    │                                                                            │
│    ▼                                                                            │
│  TinymistAttachmentsBridge::handleUndoRequest()                                 │
│    │  PUT /attachments/{id}/undo-from-preview                                   │
│    │                                                                            │
└────┼────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ LARAVEL                                                                         │
│                                                                                 │
│  TinymistAttachmentController::undoFromPreview($id)                             │
│    - validates: attachment exists, page.editor === tinymist                      │
│    - checks: AttachmentUpdate permission                                        │
│    │                                                                            │
│    ▼                                                                            │
│  TinymistAttachmentSyncService::undoPreviewChanges(attachment)                  │
│    │                                                                            │
│    ▼                                                                            │
│  TinymistPreviewManager::restoreAttachmentToPreviewDir(pageId, attachment)      │
│    - FORCE COPY: permanent storage ──▶ page_{id}/{fileName}                     │
│    - overwrites preview file with original                                      │
│    │                                                                            │
│    ▼                                                                            │
│  returns { fileName }                                                           │
│                                                                                 │
└────┬────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                         │
│                                                                                 │
│  TinymistAttachmentsBridge:                                                     │
│    1. markAttachmentClean(fileName) — reset dirty maps, update UI               │
│    2. emit "attachments-reset-file" { fileName }                                │
│                                                                                 │
│  EVENT BRIDGE:                                                                  │
│   "attachments-reset-file" ──▶ "reset-file"                                     │
│                                                                                 │
│  TinymistEditorUI::resetAttachmentFileFromServer()                              │
│    - clears in-memory file state for that fileName                              │
│    - marks content hash as clean                                                │
│    - sends WS: { type: "openFile", pageId, fileName }                           │
│      to re-request full file state from Node server                             │
│                                                                                 │
│  Node FileManager reads the restored file from disk                             │
│    → sends back fullState { content, docVersion }                               │
│    → editor replaces buffer contents with original                              │
│                                                                                 │
│  Tinymist Preview watches the file, re-renders                                  │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Block Diagram – Delete Attachment

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                         │
│                                                                                 │
│  Attachment list row: [Delete] button clicked                                   │
│    │  DELETE /attachments/{id}                                                  │
│    │  (handled by standard BookStack ajax-delete-row)                           │
│    │                                                                            │
└────┼────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ LARAVEL                                                                         │
│                                                                                 │
│  AttachmentController::delete($id)                                              │
│    │                                                                            │
│    ▼                                                                            │
│  AttachmentService::deleteFile(attachment)                                       │
│    1. tinymistAttachmentSyncService                                             │
│       ->removeAttachmentIfNeeded(attachment, fileName)                          │
│         │                                                                       │
│         ▼                                                                       │
│       TinymistPreviewManager::removeAttachmentFromPreviewDir(pageId, fileName)  │
│         - unlink: storage/app/tinymist/page_{id}/{fileName}                     │
│         - (skips entry.typ)                                                     │
│    2. deleteFileInStorage(attachment) → removes from permanent disk             │
│    3. attachment->delete() → removes DB record                                  │
│                                                                                 │
└────┬────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                         │
│                                                                                 │
│  "ajax-delete-row-success" event fires                                          │
│    │                                                                            │
│    ▼                                                                            │
│  TinymistAttachmentsBridge::reloadAttachmentList()                              │
│    - re-fetches: GET /attachments/get/page/{pageId}                             │
│    - refreshes dirty map                                                        │
│    - emits "attachments-page-updated" ──▶ "files-updated"                       │
│    - file dropdown rebuilds its option list                                     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Block Diagram – Create Blank File

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                         │
│                                                                                 │
│  [New File] button → shows new-file form                                        │
│  User enters file name, selects extension (e.g. .typ, .csv, .bib)              │
│  [Create] button clicked                                                        │
│    │                                                                            │
│    ▼                                                                            │
│  TinymistAttachmentsBridge::handleNewFileActions()                              │
│    - checkDuplicateNewFileName()                                                │
│      scans existing [data-file-name] rows for match                             │
│      if duplicate → event.preventDefault(), show error toast                    │
│      if unique → form submits normally                                          │
│    │  POST /attachments/new-file                                                │
│    │  { page_id, name, extension }                                              │
│    │                                                                            │
└────┼────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ LARAVEL                                                                         │
│                                                                                 │
│  TinymistAttachmentController::createBlankFile()                                │
│    - validates: page exists, page.editor === tinymist                           │
│    - checks: PageUpdate permission                                              │
│    - validates: name (not_regex:/[\\/]/, max:200)                               │
│    - validates: extension in allowed list (.typ, .csv, .bib, etc.)             │
│    - server-side duplicate check: attachmentFileNameExists()                    │
│    │                                                                            │
│    ▼                                                                            │
│  TinymistBlankAttachmentFileService::saveNewBlankFile(page, name, extension)    │
│    1. creates temp empty file in system temp dir                                │
│    2. wraps as UploadedFile object                                              │
│    │                                                                            │
│    ▼                                                                            │
│  AttachmentService::saveNewUpload(uploadedFile, pageId)                         │
│    1. putFileInStorage() → permanent disk                                       │
│    2. create Attachment DB record                                               │
│    3. syncAttachmentIfNeeded() → COPY to page_{id}/{fileName}                   │
│    │                                                                            │
│    ▼                                                                            │
│  returns success                                                                │
│                                                                                 │
└────┬────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                         │
│                                                                                 │
│  "ajax-form-success" event fires                                                │
│    │                                                                            │
│    ▼                                                                            │
│  TinymistAttachmentsBridge::reloadAttachmentList()                              │
│    - re-fetches attachment list HTML                                             │
│    - refreshes dirty map                                                        │
│    - emits "attachments-page-updated" ──▶ "files-updated"                       │
│    - file dropdown adds new file to options                                     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Block Diagram – Update Existing Attachment

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                         │
│                                                                                 │
│  Attachment list row: [Edit] → upload new version                               │
│    │  POST /attachments/upload/{id}                                             │
│    │  (multipart replacement file)                                              │
│    │                                                                            │
└────┼────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ LARAVEL                                                                         │
│                                                                                 │
│  AttachmentService::saveUpdatedUpload(uploadedFile, attachment)                 │
│    1. tinymistSyncService->removeAttachmentIfNeeded(attachment, oldFileName)     │
│       → unlink old preview copy                                                │
│    2. deleteFileInStorage() → remove old permanent file                         │
│    3. putFileInStorage() → store new file to permanent disk                     │
│    4. update DB record (name, extension, path)                                  │
│    5. tinymistSyncService->syncAttachmentIfNeeded(attachment)                   │
│       → COPY new file to page_{id}/{newFileName}                               │
│                                                                                 │
└────┬────────────────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ BROWSER                                                                         │
│                                                                                 │
│  "ajax-form-success" / "dropzone-upload-success"                                │
│    → reloadAttachmentList() → refreshDirtyMap()                                 │
│    → "attachments-page-updated" ──▶ "files-updated"                             │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## Dirty Detection

```
┌──────────────────────────────────────────────────────────────────┐
│                    TWO SOURCES OF DIRTY STATE                    │
│                                                                  │
│  ┌──────────────────────┐    ┌─────────────────────────────────┐ │
│  │ Server-side (hash)   │    │ Client-side (session)           │ │
│  │                      │    │                                 │ │
│  │ GET /attachments/    │    │ CodeMirror updateListener       │ │
│  │   dirty/page/{id}    │    │   content hash vs saved hash    │ │
│  │                      │    │                                 │ │
│  │ SHA-256 compare:     │    │ emits "file-dirty-state"        │ │
│  │  permanent file      │    │   { fileName, isDirty }         │ │
│  │  vs preview file     │    │                                 │ │
│  │                      │    │ Catches edits BEFORE they       │ │
│  │ Catches external     │    │ are written to disk (300ms      │ │
│  │ changes (e.g. from   │    │ debounce)                       │ │
│  │ another save)        │    │                                 │ │
│  └──────────┬───────────┘    └────────────┬────────────────────┘ │
│             │                             │                      │
│             ▼                             ▼                      │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ TinymistAttachmentsBridge                                   │ │
│  │   attachmentServerDirtyByName  ∪  attachmentSessionDirtyByName │
│  │                                                              │ │
│  │   isAttachmentDirty(fileName) = either map says true         │ │
│  │   → enables/disables Save/Undo buttons in attachment list    │ │
│  │   → emits merged "attachments-dirty-map-updated"             │ │
│  │     → "files-dirty-updated" → file dropdown "* " prefix     │ │
│  └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## Event Bridge Summary

```
┌──────────────────────────────────────────────────────────────────┐
│                    EXTERNAL ←→ INTERNAL EVENTS                   │
│                  (tinymist-editor.ts event bridge)                │
│                                                                  │
│  External (window.$events)         Internal (window.$tmEventBus) │
│  ─────────────────────────         ──────────────────────────── │
│                                                                  │
│  EXTERNAL → INTERNAL:                                            │
│  "editor::insert"              →   "insert"                      │
│  "attachments-page-updated"    →   "files-updated"               │
│  "attachments-dirty-map-updated" → "files-dirty-updated"         │
│  "attachments-reset-file"      →   "reset-file"                  │
│                                                                  │
│  INTERNAL → EXTERNAL:                                            │
│  "text-modified"                 →   "editor-tinymist-change"      │
│  "file-dirty-state"           →   "attachments-file-dirty-state" │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Validation & Protection Summary

| Check | Where | What |
|-------|-------|------|
| Permission: `AttachmentCreateAll` | `AttachmentController::upload` | Can user create attachments? |
| Permission: `PageUpdate` | `TinymistAttachmentController::createBlankFile` | Can user edit this page? |
| Permission: `AttachmentUpdate` | `TinymistAttachmentController::saveFromPreview/undo` | Can user modify attachments? |
| Editor type gate | `TinymistAttachmentSyncService` (all methods) | `page.editor === 'tinymist'` |
| File name regex | `TinymistAttachmentController::createBlankFile` | `not_regex:/[\\/]/`, max 200 |
| Extension whitelist | `TinymistBlankAttachmentFileService` | `.typ`, `.csv`, `.bib`, etc. |
| Duplicate name (client) | `TinymistAttachmentsBridge::checkDuplicateNewFileName` | Scans `[data-file-name]` rows |
| Duplicate name (server) | `TinymistAttachmentController::createBlankFile` | `attachmentFileNameExists()` |
| `entry.typ` protection | `TinymistPreviewManager::syncSingleAttachment` | Skips syncing/deleting `entry.typ` |
| Hash comparison | `TinymistAttachmentSyncService::getDirtyMap` | SHA-256 of permanent vs preview file |
| WS Token auth | `token-helper.ts` | JWT verification of `TINYMIST_WS_SECRET` |
