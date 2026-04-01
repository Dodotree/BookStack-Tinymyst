# Tinymist JS Interaction Map (`themes/tinymist/resources/js/tinymist`)


## 1) BookStack Backend HTTP Interactions

## Endpoints called from `js/tinymist`

| Endpoint | Method | Caller(s) | Purpose | Request payload | Expected response |
|---|---|---|---|---|---|
| `/ajax/tinymist/compile` | POST | `connections/fallback.ts` | Fallback compile when WS unavailable | `{ content, docVersion, pageId }` | `{ success, svg?, errors?, diagnostics?, docVersion? }` |
| `/ajax/tinymist/renew-ws-token` | POST | `connections/token-manager.ts` | Renew JWT for WS auth | `{ page_id }` | `{ success, token, expires_at }` |
| `/ajax/tinymist/{pageId}/pdf/{pdfPage}` | GET (iframe src) | `preview/preview-toolbar.ts` | Render inline PDF page/all | URL params only | PDF stream/inline |
| `/ajax/tinymist/{pageId}/pdf/download-all` | GET (navigation) | `preview/preview-toolbar.ts` | Download full PDF | URL params only | file download |

### Notes

- No direct `fetch` is used; all AJAX uses `window.$http` abstraction.
- No cookies/session APIs are touched directly by Tinymist code; auth is delegated to host infra (`window.$http` + JWT WS renewal endpoint).

---

## 2) WebSocket Interactions (2 Node Servers)

WS constants are defined in `constants/ws-constants.ts`.

## 2.1 File Sync + LSP WS

- Client class: `connections/sync-and-lsp.ts` (`TinymistFileSyncClient`)
- Base transport/reconnect/token behavior: `connections/ws-base.ts`
- URL construction behavior:
  - Local dev host (`localhost` / `127.0.0.1`): `ws://{hostname}:4000`
  - Non-local host: `{wss|ws}://{window.location.host}/ws/tinymist/file-sync/`
  - Query params: `?token=<jwt>&uniqueTabId=<id>`

### Outgoing message types

- `ping`
- `updateToken` (sent on token renew while connected)
- `openFile`:
  - `{ type: "openFile", pageId, fileName }`
- `changes`:
  - `{ type: "changes", pageId, fileName, docVersion, changes }`

### Incoming message types

- `pong`
- `ack` (file sync ack / token ack)
- `fullState` (full file content + version)
- `remoteChanges` (incremental remote change set)
- `semanticTokens`
- `semanticTokensDelta`
- `diagnostics`
- `error`

### Internal event fan-out (selected)

- emits `file-sync-ack`, `sync-full-state`, `sync-remote-changes`
- emits `lsp-semantic-tokens`, `lsp-semantic-tokens-delta`, `diagnostics`
- emits `status` (`what: "file-lsp-ws"`)

## 2.2 Preview WS (Control + Data plane multiplexed)

- Client class: `connections/preview-ws.ts` (`PreviewBridgeClient`)
- URL construction behavior:
  - Local dev host: `ws://{hostname}:4020`
  - Non-local host: `{wss|ws}://{window.location.host}/ws/tinymist/preview/`
  - Query params: `?token=<jwt>&uniqueTabId=<id>`



## 3) Host-App / Non-Tinymist UI Interactions

This section captures communication from `js/tinymist` to elements/systems **outside core Tinymist internals**.

## 3.1 Host form submission lifecycle

From `index.ts` + `editor/editor.ts`:

- Locates Tinymist root and attaches to `root.closest("form")`
- On form submit, synchronizes current editor content back into hidden textarea (`#tinymist-editor-input`) so BookStack native save pipeline receives latest source

## 3.2 Global window/browser lifecycle

- `beforeunload` / `pagehide` -> triggers Tinymist destroy and socket shutdown sequence
- `online` / `offline` -> editor pauses/resumes outgoing diff flush behavior
- `resize`, `blur`, `keydown`, `keyup` -> preview pan/zoom/settings behavior


## 3.3 DOM interactions outside component-local state


- `document.querySelector(...)` against root-scoped selectors from `constants/ui-selectors.ts`


- Theme settings reads document-level dark mode (`document.documentElement.classList.contains("dark-mode")`)

## 3.4 Host bridge contracts (adjacent file)

While not inside `js/tinymist`, `components/tinymist-editor.ts` defines required host bridge events:

### External -> Tinymist

- `editor::insert` -> `insert`
- `attachments-page-updated` -> `files-updated`
- `attachments-dirty-map-updated` -> `files-dirty-updated`
- `attachments-reset-file` -> `reset-file`

### Tinymist -> External

- `entry-text-modified` -> `editor-tinymist-change`
- `file-dirty-state` -> `attachments-file-dirty-state`

For npm extraction, these should become adapter interfaces instead of hard-coded global event names.

---

## 4) Browser Persistence (`localStorage`)

Only `localStorage` is used (no `sessionStorage`, IndexedDB, cookies directly in `js/tinymist`).

| Key | Defined in | Read/Write caller(s) | Shape | Purpose |
|---|---|---|---|---|
| `tinymist-theme-settings-v1` | `constants/theme-settings.ts` | `editor/theme-settings.ts` | JSON object of token->value | Editor/preview theme, font family, semantic highlight colors, font sizes |
| `tinymist-preview-settings-v1` | `constants/preview-settings.ts` | `preview/preview-toolbar.ts` | `{ initialZoom: number }` | Initial preview zoom preference |

### Behavior

- Both storage reads are guarded with `try/catch` and fallback defaults.
- Theme settings writes happen on each setting input update/reset.
- Preview settings writes happen when initial zoom input changes.


- `window.$http` (HTTP client abstraction)

            const response = await window.$http.post(FALLBACK_COMPILE_URL, {
                content,
                docVersion,
                pageId: this.pageId,
            });
            const response = (await window.$http.post(AUTH_TOKEN_RENEWAL_URL, {
                page_id: this.pageId,
            })) as any;
