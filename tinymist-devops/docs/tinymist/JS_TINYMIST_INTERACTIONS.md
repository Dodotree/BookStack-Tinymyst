# Tinymist JS Interaction Map (`themes/tinymist/resources/js/tinymist`)

## Goal

This document inventories **all external interactions** made by code inside `themes/tinymist/resources/js/tinymist/**`.

It is intended as prep work for extracting Tinymist into an npm package, so it focuses on:

1. BookStack backend HTTP interactions
2. WebSocket interactions with the two Node bridge servers
3. Interactions with UI/DOM outside Tinymist internal classes
4. Browser persistence (`localStorage`)
5. Required host-app bridge contracts

---

## Scope & Boundaries

### In scope

- All `.ts` files under `themes/tinymist/resources/js/tinymist/`
- Events emitted/consumed by those files (`window.$tmEventBus`)
- Their externally observable contracts (HTTP, WS, host DOM, host global APIs)

### Adjacent but out-of-scope code (still relevant)

- `themes/tinymist/resources/js/components/tinymist-editor.ts` bridges host BookStack event bus `<->` Tinymist event bus
- `themes/tinymist/resources/js/components/tinymist-attachments-bridge.ts` is host-side attachment UI integration

The out-of-scope files above are referenced when necessary to explain external contracts used by `js/tinymist`.

---

## High-Level Runtime Topology

- `TinymistApp` (`index.ts`) initializes:
  - editor UI (`editor/editor.ts`)
  - toolbar/search/file selector/theme settings (`editor/*`)
  - console (`console.ts`)
  - fallback compiler (`connections/fallback.ts`)
  - connection manager (`connections/connections-manager.ts`)
  - preview renderer + toolbar + cursor (`preview/*`)
- Internal communication: `window.$tmEventBus` (typed event bus)
- External communication:
  - HTTP via `window.$http`
  - WebSocket x2 (File Sync/LSP and Preview)
  - Host page DOM + form submit lifecycle
  - Browser `localStorage`

---

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

### Outgoing channels

- `preview-send-control` -> raw JSON string
- `preview-send-data` -> raw string/bytes

### Incoming demux logic

- If binary first byte is `{` -> control JSON string
- Else binary -> data plane bytes
- String -> control plane

### Control/Data plane processors

- `preview/control-plane.ts`
  - handles compile status, outline, cursor requests, render-version tracking
  - sends control events like `SyncMemoryFiles`, `UpdateMemoryFiles`, `changeCursorPosition`, etc.
- `preview/data-plane.ts`
  - parses `"command,payload"` binary protocol
  - handles commands such as `diff-v1`, `new`, `cursor-paths`, etc.
  - forwards to renderer/cursor via event bus

---

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

Key patterns:

- `document.querySelector(...)` against root-scoped selectors from `constants/ui-selectors.ts`
- Preview toolbar updates global iframe src for PDF mode
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

---

## 5) Event Bus Contract Summary (`window.$tmEventBus`)

Central event names/payloads are defined in `constants/custom-events.ts`.

Major domains:

- Connection lifecycle: `sync-connect`, `preview-connect`, `status`, `invalid-token`, `token-renewed`
- Editor state: `text-diff`, `entry-text-modified`, `active-file-change`, `sync-open-file`
- Preview pipeline: `preview-control-message`, `preview-data-message`, `preview-send-control`, `preview-send-data`, `render-version`
- Diagnostics/highlighting: `diagnostics`, `lsp-semantic-tokens`, `lsp-semantic-tokens-delta`
- UI state: `theme-settings-open`, `preview-connection-state`, cursor spotlight/scroll toggles

For package extraction this file is the best source-of-truth for typed host integration.

---

## 6) Per-File Interaction Inventory (`js/tinymist`)

## Root files

- `index.ts`
  - Initializes all Tinymist subsystems
  - Binds to host form submit + page lifecycle events
  - Creates/destroys global `window.$tmEventBus`
- `event-bus.ts`
  - Typed in-memory bus (listen/remove/emit)
  - Supports DOM `CustomEvent` dispatch via `emitPublic`
- `constants.ts`
  - Re-export layer + HTTP endpoint constants

## `connections/*`

- `connections-manager.ts`
  - Orchestrates both WS clients + fallback mode switching
- `ws-base.ts`
  - Shared WS transport: URL build, heartbeat, reconnect, token update, status events
- `sync-and-lsp.ts`
  - File/LSP socket protocol + bus fan-out for doc sync, diagnostics, semantic tokens
- `preview-ws.ts`
  - Preview socket protocol + control/data demultiplexing
- `token-manager.ts`
  - JWT decode, renew scheduling, renew call to backend
- `fallback.ts`
  - Backend fallback compile call and bus fan-out

## `preview/*`

- `render.ts`
  - WASM renderer integration (`@myriaddreamin/typst.ts`)
  - Applies `new`/`diff-v1` payloads, emits render/document update events
- `control-plane.ts`
  - Builds/sends control messages and tracks render/cursor queue coordination
- `data-plane.ts`
  - Parses binary command stream from preview WS bridge
- `cursor.ts`
  - Maps cursor paths to SVG nodes and emits preview cursor positions
- `preview-toolbar.ts`
  - Preview mode, PDF iframe switching, pan/zoom, preview local settings storage

## `editor/*`

- `editor.ts`
  - CodeMirror editor, file state snapshots/versioning, emits diffs/cursor requests
  - Syncs hidden textarea to host form save flow
- `editor-toolbar.ts`
  - Toolbar actions, search/replace open, file change + image preview handling
- `file-dropdown.ts`
  - Attachment file selector state, receives host attachment updates via bus
- `diagnostics.ts`
  - Maps diagnostics across snapshot changes and pushes lint + console output
- `semantic-tokens.ts`
  - Applies semantic token full/delta highlights from LSP events
- `search-replace.ts`
  - Search/replace panel interaction with editor selection/decoration state
- `theme-settings.ts`
  - Theme overlay UI + persistent settings (`localStorage`)
- `font-probe.ts`
  - Helper utility used by theme settings font availability checks (no transport)

## `constants/*`

- `custom-events.ts`
  - Typed app contract for event payloads
- `ui-selectors.ts`
  - Selector/class contract for DOM dependencies
- `ws-constants.ts`
  - WS URI/port/status keys
- `theme-settings.ts`
  - Theme storage key/defaults
- `preview-settings.ts`
  - Preview storage key/defaults
- `semantic-tokens.ts`
  - Semantic token type/modifier constants

---

## 7) Host Dependencies Required for npm Extraction

The current Tinymist JS expects these host-provided globals/contracts:

- `window.$http` (HTTP client abstraction)
- `window.$tmEventBus` (or equivalent injected event hub)
- `window.$events` (via external bridge in `components/tinymist-editor.ts`)
- DOM structure matching selectors in `constants/ui-selectors.ts`
- A hidden textarea (`#tinymist-editor-input`) inside a host form for save integration
- Backend endpoints listed above
- Two WS bridges available at the configured routes

Recommended package boundary:

1. Keep `js/tinymist` pure and host-agnostic
2. Move host-specific event mapping and attachment integration into adapters
3. Inject `httpClient`, `eventAdapters`, `selectors`, `endpoints`, and `wsConfig` as constructor options

---

## 8) Known Tight Couplings to Address Before Packaging

1. Hard-coded endpoint strings in `constants.ts`
2. Hard-coded global dependencies (`window.$http`, `window.$events` bridge)
3. Direct DOM query dependence on BookStack page layout/selectors
4. Save behavior tied to host form submit + hidden textarea synchronization
5. Attachment-related event names coupled to BookStack attachment panel implementation

---

## 9) Quick Extraction Checklist

- [ ] Replace hardcoded endpoint constants with injected config
- [ ] Replace global `window.$http` with injected transport interface
- [ ] Replace direct `window.$events` bridge with adapter API
- [ ] Export `custom-events.ts` as public package contract
- [ ] Document required host DOM slots and fallback behaviors
- [ ] Keep localStorage keys namespaced and versioned (already versioned)

---

## Appendix: Verified External I/O Summary

- HTTP calls from `js/tinymist`: **4 routes**
- WebSocket clients: **2** (File Sync/LSP + Preview)
- Browser storage keys: **2**
- Host bridge event directions: **4 in / 2 out** (defined in adjacent bridge component)
- Native lifecycle hooks: `beforeunload`, `pagehide`, `online`, `offline`, `resize`, key/mouse listeners
