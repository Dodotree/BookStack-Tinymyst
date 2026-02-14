# Preview API

This document describes the preview control plane (JSON messages between editor and preview backend) and data plane (websocket messages between preview frontend and preview backend).  The control plane uses plain JSON objects with an event field. The data plane is plain text/binary over websocket.

## Tree (expanded)

- Control plane (JSON over `ControlPlaneTx`/`ControlPlaneRx`)
- Requests (editor → preview)
- `changeCursorPosition` → `ChangeCursorPositionRequest`
- `panelScrollTo` → `ResolveSourceLocRequest`
- `panelScrollByPosition` → `PanelScrollByPositionRequest`
- `sourceScrollBySpan` → `DocToSrcJumpResolveRequest`
- `syncMemoryFiles` → `MemoryFiles`
- `updateMemoryFiles` → `MemoryFiles`
- `removeMemoryFiles` → `MemoryFilesShort`
- Responses (preview → editor)
- `editorScrollTo` → `DocToSrcJumpInfo`
- `syncEditorChanges` → `()`
- `compileStatus` → `CompileStatus`
- `outline` → `Outline`

- Data plane (websocket between preview frontend and server)
- Client → server (text)
- `current`
- `srclocation <spanId>`
- `outline-sync,<page> <x> <y>`
- `srcpath <json>`
- `src-point <json>`
- Server → client (binary)
- `jump,<page> <x> <y>[,<page> <x> <y>...]`
- `viewport,<page> <x> <y>`
- `cursor-paths,<json>`
- `partial-rendering,true`
- `invert-colors,<value>`
- SVG delta payloads (render stream)

## Control plane message format

All messages are JSON objects with an `event` field. For requests, the `event` value selects the command; for responses, it indicates the payload kind. Line and character positions are 0-based.

### Requests (editor → preview)

// Change cursor position in source, update preview highlight
//  The line number and the character number are 0-based
{
 "event": "changeCursorPosition",
 "filepath": "<FILE_PATH>",
 "line": 0,
 "character": 0
}

// Resolve a source location (file/line/character) to document positions
//  The line number and the character number are 0-based
{
 "event": "panelScrollTo",
 "filepath": "<FILE_PATH>",
 "line": 0,
 "character": 0
}

// Scroll preview to a document position (page/x/y)
{
 "event": "panelScrollByPosition",
 "position": {
  "page_no": 1,
  "x": 0.0,
  "y": 0.0
 }
}

// Resolve a span id (hex) to a source location
{
 "event": "sourceScrollBySpan",
 "span": "<SPAN_ID_HEX>"
}

// Sync all in-memory files (full snapshot)
{
 "event": "syncMemoryFiles",
 "files": {
  "<FILE_PATH>": "<FILE_CONTENT>"
 }
}

// Update in-memory files (partial update)
{
 "event": "updateMemoryFiles",
 "files": {
  "<FILE_PATH>": "<FILE_CONTENT>"
 }
}

// Remove in-memory files
{
 "event": "removeMemoryFiles",
 "files": ["<FILE_PATH>"]
}

### Responses (preview → editor)

// Jump editor to source range resolved from preview
//  The line number and the character number are 0-based
{
 "event": "editorScrollTo",
 "filepath": "<FILE_PATH>",
 "start": [0, 0],
 "end": [0, 10]
}

// Request editor to sync all open buffers (standalone mode)
{
 "event": "syncEditorChanges"
}

// Compile status update
{
 "event": "compileStatus",
 "kind": "CompileSuccess"
}

// Outline update
{
 "event": "outline",
 "kind": "<Outline data>"
}

## Data plane message format

Client → server messages are plain text. Server → client messages are binary; the prefix before the first comma is the message name.

### Client → server (text)

- `current`
- Request a full render of the latest document.

- `srclocation <spanId>`
- Resolve a span id (hex) to a source location.

- `outline-sync,<page> <x> <y>`
- Notify preview viewport position.

- `srcpath <json>`
- Resolve an element path to a span range.
- `<json>` format: array of tuples `[page_no, depth, id]`.
- Example: `[[1, 2, "abcd"], [1, 3, "ef01"]]`.

- `src-point <json>`
- Resolve a document position to a span range.
- `<json>` format: `{ "page_no": 1, "x": 0.0, "y": 0.0 }`.

### Server → client (binary)

- `jump,<page> <x> <y>[,<page> <x> <y>...]`
- Jump preview to document positions (often from source → doc mapping).

- `viewport,<page> <x> <y>`
- Update viewport position.

- `cursor-paths,<json>`
- Update cursor paths in preview.
- `<json>` format: array of element path arrays.

- SVG delta payloads
- Render stream from server to frontend.

#### Initial config

- `partial-rendering,true`
- Enable partial rendering in frontend.

- `invert-colors,<value>`
- Set invert-colors strategy.
