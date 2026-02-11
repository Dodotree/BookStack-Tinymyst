# Tinymist Node Services – Preview Flow

This folder contains the Node.js services used for Tinymist real‑time preview and file sync.

## Components

- **Preview bridge**: [node/preview/preview-server.ts](node/preview/preview-server.ts)
  Is a browser facing web socket server. It spawns preview-clients that spawn instances of tinymist-preview for each file that needs previewing. Each preview-client keep connections to both tinymist-preview websockets (data and control). It forwards messages from the browser to tinymist-preview and forwards encoded render object back to the browser for WASM in the browser to decode it and render into svg.

- **File sync + LSP**: [node/file-sync/server.ts](node/file-sync/server.ts)
   Is a browser facing web socket server. It also spawns LSP-server client (one for all browsers) lsp-client.ts and uses file-manager.ts for syncing the file state with the editor in the browser. Preview-tinymist instances are watching the files they were spawned for. LSP-tinymist does not watch files registered in it by itself, the state of the file has to be updated by messages didChange etc. from LSP-client. LSP provides diagnostics and semantic tokens.

## High‑level Flow

1) **Editor opens (browser)**
   - Frontend calls `POST /ajax/tinymist/start-preview`.
   - Laravel writes the Typst file to `storage/app/tinymist/page_<id>.typ`.

2) **Preview process starts (server)**

   - A Tinymist preview process is spawned and watches the `.typ` file.
   - Two WebSocket planes are exposed locally:
      - **Control plane** (JSON status/events)
      - **Data plane** (binary diffs/SVG updates)

3) **Browser connects via Node bridge**

   - Frontend opens a single WebSocket to the preview bridge (Node).
   - The bridge connects to Tinymist control/data ports on localhost.
   - On Ubuntu, traffic is usually: **Browser → Nginx → Node preview bridge**.

4) **Realtime updates**
   - Edits are sent via the file‑sync WebSocket.
   - File‑sync server writes the updated Typst file.
   - Tinymist preview detects the file change and emits new diff payloads.
   - Browser receives diffs and re-renders the preview.

## Diagram: End‑to‑End Preview

Browser (Tinymist editor)
  |  POST /ajax/tinymist/start-preview
  v
Laravel (TinymistPreviewManager)
  |  writes storage/app/tinymist/page_<id>.typ
  |  spawns tinymist preview process
  v
Tinymist preview process (localhost)
  |  Control WS (JSON)
  |  Data WS (binary diff/SVG)
  v
Node preview bridge (preview-server.ts)
  |  single WS to browser (proxied by Nginx on Ubuntu)
  v
Browser receives updates

## Diagram: Realtime Update Path

Browser editor input
  |  WebSocket changes
  v
File Sync Server (node/file-sync)
  |  writes page_<id>.typ
  v
Tinymist preview process watches file
  |  emits diff/new SVG via Data WS
  v
Node preview bridge
  |  forwards to browser WS
  v
Browser preview updates

## How the Preview Process Begins

- `POST /ajax/tinymist/start-preview` calls `TinymistPreviewManager::startPreviewServer()`.
- The manager ensures `storage/app/tinymist/page_<id>.typ` exists and spawns:
  - `tinymist preview --control-plane-host HOST:PORT --data-plane-host HOST:PORT --partial-rendering true <relative_file_path>`

## How WebSocket Updates Are Produced

- The preview process watches the Typst file.
- File changes (from the file‑sync server) trigger incremental compilation.
- Tinymist emits:
  - **Control messages** (JSON status, outline, sync events)
  - **Data messages** (binary diffs / SVG)

## Notes

- For dev, run:
  - `npm run ws:dev` (file‑sync + LSP)
  - `npm run preview:dev` (preview bridge)
- For prod, use PM2/systemd with `npm run ws:start` and `npm run preview:start` after building.
