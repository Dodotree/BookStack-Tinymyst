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

## sync-and-lsp.ts notes

// Initial state of the file comes from db to both front and back ends
// If newer version is cached for preview, this version is used
// Subsequent changes are synced via incremental updates with version tracking
// On page load first ws connection verifies if front and back ends have the same version

// sent: verify versions -> server verifies and responds with current version or requests full sync
// sent: (gets from editor) {full sync, forceReset -?} -> server applies full content (version N)
// sent: initial request for full semanticTokens -> server -> LSP -> server -> tokens
// sent: editor {change increment} -> server updates file (if version is > server version)
// sent: request for semanticTokens delta -> server -> LSP -> server -> tokens delta

// receive: "ack" acknowledged token on update or file changes
// receive: server {full sync to version N} (if server version > client version) -> here -> editor applies full content
// receive: LSP pushes diagnostics when file updates -> server -> here -> diagnostics.ts
// receive: encoded semanticTokens here -> semantic_tokens.ts -> editor applies tokens
// receive: semanticTokens delta here -> semantic_tokens.ts -> editor applies token edits
// receive: Error, see list below

// Errors:
// page mismatch
// version mismatch
// can not apply change (most likely cursor drift)
// failed to write the file
// LSP request failed

## Cursor path notes

```js
    /**
     * * * * * CssClassToType
     * ["typst-text", SourceMappingType.Text],
     * ["typst-group", SourceMappingType.Group],
     * ["typst-image", SourceMappingType.Image],
     * ["typst-shape", SourceMappingType.Shape],
     * ["typst-page", SourceMappingType.Page],
     * ["tsel", SourceMappingType.CharIndex],
     *
     * SVG Structure Notes:
     * svg.typst-doc
     *  > g.typst-page (one per page)
     *    > g data-tid="..." (data-tid wrappers)
     *      > g.typst-group (frames, groups)
     *        > g data-tid="..." (data-tid wrappers)
     *          > g.typst-text (text blocks)
     *            > use (glyphs)
     * Every group except the first one is wrapped in a data-tid element.
     * Cursor paths count only mentioned below elements as children
     * ${n} is 1-based index
     * `svg.typst-doc > :nth-child(${n} of .typst-page)` is a starting point
     * `> :nth-child(${n} of :is(.typst-group,.typst-text))` first element in the page
     *  followed by data-tid wrapper for the 12th group and the group itself
     * :is() and :has() should have all allowed child types (except typst-page)
     * `> :nth-child(${n} of g:has(>g.typst-group,>g.typst-text, ...))>g`
     *  repeats for nested groups until text g.typst-text
     *  > :nth-child(${n} of g:has(>g.typst-group,>g.typst-text, ...))>g> :nth-child(${n} of use)
     *
     * The g.typst-text element is where we will append the cursor svg circle.
     * And we should copy "x" from "use" element to "cx" of the circle.
     *
     * Path format notes:
     *
     * Nested data-tid without class can throw off indexing, handled for 2 levels (for now)
     *
     * Usually cursor paths have only 1 path [[]]
     * Code blocks give extra paths [[],[],[],[],[]]
     * "occur when a single source-code cursor position maps to multiple rendered elements"
     * Put a circle at each resolved node of not 0 bounding box
     *
     * Cursor Paths are not provided for $infinity$ and functions like #datetime.today()
     */

    /*
    data-tid is the SVG element identity used by the incremental SVG patcher. It’s typically a content hash (with a suffix if not unique) and is used to compare/reuse <g> elements when applying diffs; see patch.mts:9-33. The renderer attaches it when emitting SVG nodes (e.g., render_item_at) in mod.rs:496-506 data-tid is attached to SVG nodes that correspond to vector items (Fingerprint-backed content) during rendering. That includes pages/groups/items that exist as real render nodes; see mod.rs:496-506. Structural SVG nodes like defs, style, clipPath, or empty branches that don’t map to a vector item typically won’t have data-tid. *** But ".typst-content-hint" have them *** -- so it's not a useful selector for typst path after all.
    ".typst-content-hint" usually only has data-hint="a" which means hex 0a "new line" and is before heading node

    svg.typst-doc > :nth-child(1 of .typst-page) > :nth-child(1 of [data-tid])> :nth-child(14 of :has(>g>:not(g:empty))

    Interestingly fingerprints are hardcoded to be empty Span2VecPass::query_element_paths (every ElementPoint uses fingerprint: "".to_owned() (unless you rewrite it)
    */

    /*
    data-spans contain source-code, their span id is a hex string of the same "span" provided by the outline.
    would be nice to have them, maybe they existed some time ago with debugging enabled?
    but currently source code mapping is not emitted by tinymist and there are no functions to insert them in the renderer
    */
        const el = (e.target as Element).closest('[data-span]') as Element | null;
        if (!el) return;
        const spanHex = el.getAttribute('data-span')!;

        // cursorPath from tinymist: [kind0, index0, kind1, index1, ...]
        const cursorPath = [4, 0, 1, 3, 0, 12]; // sample
        const path = new Uint32Array(cursorPath);
        const loc = session.getSourceLoc(path);
        console.debug(loc); // e.g. "1f2a3b4c" (span id as hex) or undefined


const validChildren = `>g.typst-group,>g.typst-text,>.typst-image,>.typst-shape,>g.typst-wrap`;
```
