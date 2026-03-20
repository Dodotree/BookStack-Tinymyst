# Tinymist Editor Integration

## Overview

Tinymist integration in this repo is **WebSocket-first** for editing/preview, with a reliable HTTP fallback compile endpoint.

Current persistence model for Tinymist pages:

- `pages.markdown` → Typst source
- `pages.text` → searchable plain text extracted from Typst source
- `pages.html` → intentionally blank for Tinymist saves
- Rendered page HTML is stored as file in `storage/app/tinymist/preview/page_{id}.html`

This avoids storing large SVG/HTML blobs in DB and reduces save-time memory pressure.

---

## Binaries and Install

Binaries are downloaded during `npm install` via `postinstall` in `package.json`:

- `tinymist-devops/download-typst.js`
- `tinymist-devops/download-tinymist.js`
- `tinymist-devops/download-pandoc.js`

Installed into project `vendor/bin` with platform-specific executable naming.

---

## Runtime Architecture

### Editor and Preview

- Frontend editor uses Tinymist-specific components under `themes/tinymist/resources/js`.
- WebSocket services run from `tinymist-devops/node`:
  - file sync + LSP bridge
  - preview bridge
- HTTP fallback compile endpoint remains available at `/ajax/tinymist/compile`.

### Save Paths

#### Draft Save (`/ajax/page/{id}/save-draft`)

- Stores Tinymist source into draft markdown field (`PageRevision.markdown` for non-draft pages, page markdown for draft pages).
- Does not perform full publish-save flow.

#### Full Page Save (form submit)

1. Page save submits `tinymist` source.
2. `PageRepo` routes Tinymist input to `PageContent::setNewTinymist()`.
3. `TinymistPageContentHandler` compiles via Typst CLI.
4. Multi-page SVG output is streamed into:
   - `storage/app/tinymist/preview/page_{id}.html`
5. DB fields updated:
   - `pages.markdown` set to Typst source
   - `pages.text` set to extracted plain text
   - `pages.html` set to empty string

### Page View

- Page controller renders through `PageContent::render()`.
- For Tinymist editor pages, render path reads HTML from
  `storage/app/tinymist/preview/page_{id}.html` via Tinymist handler/store.
- This avoids DOM reprocessing of SVG content and preserves SVG namespaces.

---

## Storage Layout

- Typst source + attachments workspace: `storage/app/tinymist/page_{id}/...`
  - main source file: `entry.typ`
- Compiled viewer HTML: `storage/app/tinymist/preview/page_{id}.html`
- Typst command log (PHP side): `storage/logs/tinymist-php-typst.log`
- Unhandled LSP notifications log (Node file-sync): `storage/logs/tinymist-lsp-unhandled-notifications.log`

---

## Performance and Stability Notes

### Memory behavior

The save path no longer concatenates full SVG into one big PHP string for page storage.
It now composes output into the preview HTML file using streamed file operations.

### Compile execution

- Typst CLI is executed by `TinymistService`.
- Linux deployments can run Typst under dedicated `tinymist` user (via sudo rule) for network isolation.

### Token/Auth

WebSocket auth token validation supports standard payload claims used by this integration,
including robust page-id parsing for runtime compatibility.

---

## Fallback HTTP Compile Flow

`/ajax/tinymist/compile` remains useful for diagnostics/fallback:

1. Accept Typst content (+ optional page id)
2. Run Typst compile
3. Return SVG/errors JSON for editor preview consumption

This path is separate from full page save persistence behavior.

---

## Deployment Essentials

Required env config (minimum):

- `APP_THEME=tinymist`
- `TINYMIST_ENABLED=true`
- `TINYMIST_WS_SECRET=<random 64-hex string>`
- `TYPST_CLI_PATH=...` (optional if default resolver works)
- `TINYMIST_CLI_PATH=...` (optional if default resolver works)

For production websocket services, use build/start scripts:

- `npm run ws:build` + `npm run ws:start`
- `npm run preview:build` + `npm run preview:start`

---

## Current Status

- Tinymist editor integrated with BookStack page editor pipeline.
- Draft + full save flows operational.
- File-based viewer HTML persistence implemented.
- DB `pages.html` no longer used for Tinymist rendered output.
- WebSocket bridges and token renewal flow integrated.

---

## Remaining Work

- Add targeted unit/integration tests for Tinymist save/view flows.
- Add optional cleanup strategy for stale preview files.
- Continue performance testing on large multi-page Typst documents.
