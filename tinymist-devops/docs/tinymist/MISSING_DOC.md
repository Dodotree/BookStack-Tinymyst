# Typst Preview WebSocket Processing

This directory contains a complete, production-ready implementation of the
Typst preview WebSocket lifecycle with full WASM integration.

## Why tinymist preview has 2 channels - developed for VSCode

┌─────────────────────────────────────┐
│  VSCode Extension (Node.js)         │
│  ┌─────────────────────────────┐   │
│  │ Tinymist Language Server    │   │
│  │  ├─ Document analysis        │   │
│  │  ├─ Outline extraction       │   │
│  │  └─ Compilation              │   │
│  └─────────────────────────────┘   │
│           │              │           │
│      WebSocket      postMessage     │
│     (Binary data)  (Control/JSON)   │
└───────────┼──────────────┼──────────┘
            │              │
            ▼              ▼
┌─────────────────────────────────────┐
│  Webview (Browser context)          │
│  - ws.ts handles WebSocket          │
│  - window.message handles control   │
└─────────────────────────────────────┘

WebSocket - High-performance binary data streaming

1. **WebSocket - High-performance binary data streaming**
Document diffs (can be large, binary format)
Real-time updates during typing
Direct connection to preview server
**became Data Plane**

2. **Window Messages - VSCode extension control**
Structured JSON data
Extension → webview communication
Configuration, outline, reconnect commands
VSCode API (postMessage)
**became Control Plane**

---

ARCHITECTURE OVERVIEW

The preview system transforms binary WebSocket messages into visible SVG
documents in the browser using WASM for high-performance operations.

Binary Message Flow:
┌─────────────────────────────────────────────────────────────────┐
│ WebSocket Binary Message (ArrayBuffer)                          │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Message Parsing (find comma separator 0x2C)                     │
│ command,<binary_data>                                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
             ┌───────────┼───────────┐
             │           │           │
             ▼           ▼           ▼
          "new"      "diff-v1"    "jump"  ... (8+ commands)
             │           │           │
             ▼           ▼           ▼
         [Handlers with WASM Integration]
             │           │           │
             │           │           ├──────────────────────┐
             │           │           │                      │
             ▼           ▼           ▼                      ▼
        Render New  Apply Diffs  Navigation          Color/Cursor
          SVG       (via WASM)    (WASM metrics)      (WASM analysis)
             │           │           │                      │
             └───────────┼───────────┼──────────────────────┘
                         │
                         ▼
         ┌──────────────────────────────────┐
         │ DOM Manipulation & Updates        │
         └──────────────────┬───────────────┘
                            │
                            ▼
             ┌──────────────────────────────┐
             │ Browser Rendering            │
             │ (SVG visible to user)        │
             └──────────────────────────────┘

## KEY COMPONENTS

### 1. WebSocketPreviewProcessor

-

Main class that orchestrates the entire lifecycle

Responsibilities:

- Manage WebSocket connection state
- Parse binary messages
- Route to command handlers
- Manage WASM rendering session
- Update DOM based on messages

### 2. Message Handler Pipeline

Each command type has a dedicated handler:

- `handleNewDocument()`
  Input: Binary SVG string
  WASM: initWasm() → loadSvgState()
  Output: New SVG rendered in container
  Use: Full document reload or page refresh

- `handleIncrementalUpdate()`
  Input: Binary SVG diff (reflexo-vec2svg format)
  WASM: manipulateData() → returns DOM operations
  Output: Only changed elements updated
  Use: Real-time document editing (most common)
  Performance: 100-500x smaller than full SVG

- `handleNavigation()`
  Input: Page number and coordinates
  WASM: getPageLayout() → precise metrics
  Output: Document scrolls to position
  Use: Link clicks, table of contents, search results

- `handleCursor()`
  Input: Cursor position (page, x, y)
  WASM: getElementAtPosition() → element info
  Output: Visual cursor at position
  Use: Show text cursor position during editing

- `handleCursorPaths()`
  Input: JSON array of element point arrays
  WASM: getPathRenderInfo() → styling info
  Output: Highlighted selection paths
  Use: Show selected text or multiple selections

- `handleInvertColors()`
  Input: Inversion strategy ("auto", "always", "never")
  WASM: analyzeColors() → shouldInvertColors()
  Output: CSS filter applied to SVG
  Use: Dark mode support

### 3. WASM Integration

*************************************************
**Back end tinymist version**
**should be compatible with front end version**
Tinymist tags/releases carry the Typst version in their release notes; visit https://github.com/Myriad-Dreamin/tinymist/releases and match the “Typst v0.xx” line (for example v0.13.x releases ship Typst 0.13.x).
When the versions match, the reflexo crate revisions match too; confirm via the Cargo.lock in both projects or the crates/reflexo-* commit mentioned in their changelog entries.
For day-to-day updates, the tinymist docs in TINYMIST_ARCHITECTURE.md and the Typst.ts “cookery” docs (https://myriad-dreamin.github.io/typst.ts) both note the compatible release pairs whenever they switch Typst versions.

@myriaddreamin/typst.ts and @myriaddreamin/typst-ts-renderer
0.6.x release that matches tinymist 0.13.x.
0.7.x release that matches tinymist 0.14.x. (current)
*************************************************

WASM provides high-performance operations:

- `initWasm()`: Initialize WASM module  -- should be `renderer.init()`
- `renderSession.loadSvgState()`: Store SVG baseline for diffs -- (?)
- `renderSession.manipulateData()`: Apply binary diffs -- checks out

    **session methods**
    getSourceLoc
    retrievePagesInfo -- offset and w,h
    reset
    manipulateData
    renderCanvas
    renderToSvg -- to get svg html: `const svg = await session.renderSvg({});`
    renderSvgDiff
    renderSvg -- does not include "container" parameter to place SVG
    pixelPerPt
    docWidth
    docHeight
    backgroundColor

    **renderer methods**
    createWorkerV0
    getCustomV1
    init
    loadGlyphPack
    manipulateData
    renderDom -- TypstDomDocument which is renamed during export TypstDocument
    renderCanvas
    renderToCanvas
    renderSvgDiff // experimental
    renderToSvg -- does not include "container" parameter to place SVG
    renderSvg // not incremental
    resetSession
    retrievePagesInfoFromSession
    runWithSession

```js
  PageInfo {
    pageOffset: number;
    width: number;
    height: number;
  }
```

## WASM MODULE REFERENCES

The implementation uses these WASM modules (imported as needed):

1. `@myriaddreamin/typst.ts/rs`
   - initWasm(): Initialize WASM module
   - RenderSession: Main WASM interface
   - SvgDiff: Binary diff format

2. `@myriaddreamin/typst-dom`
   - SVG utilities for DOM manipulation
   - Page and document management

3. `reflexo-vec2svg` -- format that comes with `diff-v1`
   - Binary SVG format conversion
   - Vector-to-SVG rendering

These are optional - the code gracefully handles WASM unavailability

## LIFECYCLE SUMMARY

Step 1: Binary Reception
  WebSocket receives ArrayBuffer
  Add to buffer for batching

Step 2: Message Parsing
  Find comma byte (0x2C) separator
  Extract command (before comma), decode it
  Extract payload (after comma), leave it as is (?)

Step 3: Command Routing
  Match command to handler
  Check preview mode filters

Step 4: Handler Execution
  Decode binary payload (?)
  Query WASM if available
  Process content

Step 5: DOM Updates
  Create/modify DOM elements
  Apply WASM-computed changes
  Maintain document state

Step 6: Browser Rendering
  Browser layout engine reflows affected regions
  Paint changes to screen
  User sees visual update

Step 7: Repeat
  Next message arrives
  Process continues

## BINARY MESSAGE FORMAT

All WebSocket messages follow: command,<binary_data>

Format Breakdown:
┌─────────────────┬──────┬──────────────────┐
│ Command (ASCII) │ 0x2C │ Payload (Binary) │
└─────────────────┴──────┴──────────────────┘

Examples:

`new`,[SVG bytes]
  Command: "new" (3 bytes)
  Separator: 0x2C (1 byte)
  Payload: UTF-8 encoded SVG (100KB+)

`diff-v1`,[diff bytes]
  Command: "diff-v1" (7 bytes)
  Separator: 0x2C (1 byte)
  Payload: reflexo-vec2svg binary format (100-500 bytes)

`jump`,`1 250.5 500.3` -- need to decode?
  Command: "jump" (4 bytes)
  Separator: 0x2C (1 byte)
  Payload: Position string (15 bytes)

## Typst Preview WebSocket API Documentation

This document describes the WebSocket API used by the Typst preview frontend to communicate with the preview server.

### Connection

The frontend connects to the preview server via WebSocket. The connection is established with:

- **Protocol**: WebSocket (Binary and Text messages)
- **Default URL**: `ws://127.0.0.1:23625`
- **Binary Type**: `arraybuffer`

### Message Format

All messages follow a common format:

#### Binary Messages (Server → Client)

Format: `<command>,<data>`

- **Command**: String identifier followed by a comma
- **Data**: Binary or text payload after the comma

#### Text Messages (Client → Server)

Simple text commands sent from client to server.

### Server → Client Messages

#### Document Rendering Messages

##### `new,<svg_data>`

- **Purpose**: Send complete new SVG document
- **Data**: Binary SVG data
- **Handler**: Resets the renderer and loads the complete new document
- **Binary Processing**: The SVG data is passed directly to `kModule.manipulateData()` with action "merge"

##### `diff-v1,<svg_diff_data>`

- **Purpose**: Send incremental SVG changes
- **Data**: Binary SVG diff data for efficient updates
- **Handler**: Merges the changes into existing document
- **Binary Processing**: Applied as incremental patch via `kModule.manipulateData()` with action "merge"

#### Navigation Messages

##### `jump,<positions>`

- **Purpose**: Navigate to specific document positions
- **Data**: Comma-separated position strings in format `"page x y,page x y,..."`
- **Handler**: Scrolls to the closest position, handles multi-page documents
- **Example**: `"1 100.5 200.0,2 50.0 150.0"`

##### `viewport,<position>`

- **Purpose**: Update viewport to show specific position
- **Data**: Single position string in format `"page x y"`
- **Handler**: Similar to jump but for viewport updates
- **Example**: `"1 100.5 200.0"`

#### Cursor and Selection Messages

##### `cursor,<position>` never received it, don't know how to trigger

- **Purpose**: Show cursor at specific document position
- **Data**: Position string in format `"page x y"`
- **Handler**: Displays cursor indicator and triggers viewport change
- **Example**: `"1 100.5 200.0"`

##### `cursor-paths,<json_paths>` in reaction to Control Plane request changeCursorPosition

- **Purpose**: Show cursor based on element paths in the document
- **Data**: JSON array of element point arrays
- **Handler**: Draws cursor at text positions using SVG elements
- **Example**: `[[[1, 2, "text"], [3, 4, "span"]]]`

#### Configuration Messages

##### `partial-rendering,true`

- **Purpose**: Enable partial rendering optimization
- **Data**: String "true"
- **Handler**: Sets `svgDoc.setPartialRendering(true)`

##### `invert-colors,<strategy>`

- **Purpose**: Configure color inversion strategy
- **Data**: Strategy string or JSON object
- **Strategies**:
  - `"never"`: Never invert colors
  - `"auto"`: Auto-detect based on theme
  - `"always"`: Always invert colors
  - JSON object: `{"rest": "auto", "image": "never"}`
- **Handler**: Applies CSS classes for color inversion

##### `outline,<outline_data>` never seen in Data Plane

- **Purpose**: Send document outline/table of contents
- **Data**: Outline structure data
- **Handler**: Currently logged as experimental feature

### Client → Server Messages

#### Initial Connection

##### `current`

- **Purpose**: Request current document state
- **Sent**: Automatically when WebSocket connection opens
- **Response**: Server sends current document via `new,` or `diff-v1,` message

#### Navigation and Interaction

##### `srclocation <span_id>`

- **Purpose**: Request source location for document element
- **Format**: `"srclocation <span_identifier>"`
- **Response**: Server resolves to source file position

##### `outline-sync,<position>`

- **Purpose**: Sync outline with viewport position
- **Format**: `"outline-sync,page x y"`
- **Response**: Updates viewport position in other clients

##### `srcpath <json_path>`

- **Purpose**: Resolve span by element path
- **Format**: `"srcpath <json_array>"`
- **Data**: JSON array of `(u32, u32, String)` tuples representing element path
- **Response**: Server resolves to source spans

##### `src-point <position>`

- **Purpose**: Resolve frame location to source
- **Format**: `"src-point <json_position>"`
- **Data**: JSON document position object
- **Response**: Server resolves to source location

### Binary Data Processing

#### SVG Data Translation

1. **Reception**: Binary data received as `ArrayBuffer`
2. **Parsing**: Split on first comma to separate command and data
3. **SVG Processing**:
   - For `new,` and `diff-v1,` messages, data is passed to WASM module
   - WASM module (`kModule`) processes binary data via `manipulateData()` method
   - Binary data contains optimized SVG diff format from `reflexo-vec2svg` crate
4. **DOM Insertion**: Processed SVG is patched into DOM using virtual DOM diffing

#### Error Handling

- **WebSocket Errors**: Logged to console as `"WebSocket Error: "`
- **Invalid Data**: Non-ArrayBuffer data logs error and continues
- **Unknown Messages**: Server responds with error message for unknown text commands
- **Connection Loss**: Automatic reconnection after 1 second delay

#### Message Batching

- Messages are batched using RxJS `buffer()` and `debounceTime(0)`
- Batched messages processed sequentially to maintain order
- Batch size logged for debugging: `"batch N messages"`

```typescript
// Multiple messages arriving rapidly are batched
this.messageBuffer.push(data);
queueMicrotask(() => this.processBatchedMessages());
```

### Example Message Flow

1. **Connection**: Client connects and sends `"current"`
2. **Initial Document**: Server responds with `"new,<svg_data>"`
3. **User Interaction**: User clicks element, client sends `"srclocation <span>"`
4. **Document Update**: Server detects change, sends `"diff-v1,<svg_diff>"`
5. **Navigation**: Server sends `"jump,1 100 200"` to scroll to position

### Content Preview Mode (for minified version of the page)

When `isContentPreview` is true:

- Automatic scrolling can be disabled for `jump` messages
- `viewport`, `partial-rendering`, and `cursor` messages are ignored
- Canvas rendering mode is forced for better performance
- Partial rendering is always enabled
- Lower pixel density (`pixelPerPt = 1`) for performance

### Slide Mode Specifics

In slide preview mode:

- Navigation is page-based rather than continuous scroll
- Page selector UI elements are updated
- Keyboard navigation (arrow keys, space, 'g', 'h', escape) is enabled
- Height adjustments account for single-page display

This API enables efficient real-time preview of Typst documents with incremental updates, source-to-preview navigation, and interactive features.

## INTEGRATION WITH VS CODE EXTENSION

The extension architecture:

Main Extension Process (Node.js)
  ├── WebSocket Connection to Language Server
  ├── File Change Detection
  └── Message Routing

Preview Webview (Browser)
  ├── WebSocket Listener
  ├── WebSocketPreviewProcessor ← This implementation
  ├── WASM Runtime
  └── SVG Container

Data Flow:
  User edits file
  → Language Server recompiles
  → Server sends binary diff
  → WebSocket delivers to webview
  → WebSocketPreviewProcessor handles message
  → SVG preview updates in <100ms

## TROUBLESHOOTING

Color inversion not working?

- Verify WASM color analysis is available
- Check invertColorsStrategy configuration
- Ensure CSS filters are not disabled

Cursor not appearing?

- Check if WASM element position query is available
- Verify page number is correct
- Check SVG CSS for cursor style conflicts

## ADVANCED TOPICS

Virtual DOM Diffing:
  WASM returns optimized DOM operations
  Each operation updates one element
  Only affected DOM nodes are touched
  Results in minimal repaints

Message Batching:
  Multiple rapid messages are collected
  Processed together using `queueMicrotask` from RxJS
  Reduces rendering overhead
  User sees smooth updates

Partial Rendering:
  WASM can render only visible pages
  Reduces memory usage for large documents
  Improves initial load time
  Transparently handled by WASM

## WASM Integration Points in `websocket-lifecycle.ts`

### 1. **New Document Handler** (`handleNewDocument`)

**Transformation:** Binary → UTF-8 String → SVG DOM → Visible

### 2. **Incremental Update Handler** (`handleIncrementalUpdate`)

**Transformation:** Binary Diff → WASM Processing → DOM Patches → Browser Update

#### Not sure where this example comes from, see below what is more likely

```typescript
// Step 1: Parse binary SVG diff data (reflexo-vec2svg format)
const svgDiffData: SvgDiff = {
  data: Array.from(payload),
  encoding: 'reflexo-vec2svg-v1', // not realistic, probably 'vector'
};

// Step 2: Pass diff to WASM module

// what might work for initiation (didn't test it, but lint approves)
                    await session.renderToSvg({
                        container: this.previewElement,
                        format: 'vector',
                        artifactContent: payload
                    })

// does not return diffResult or anything, other things also were wrong:
const diffResult = this.renderSession.manipulateData({
  action: 'diff', // no, actions actually are "merge" or "reset"
  diff: svgDiffData, // called data: not diff:
  currentState: this.currentSvgElement.outerHTML, // no such option available
});
// Returns: { operations: DOMOperation[] } // No such thing, at least in js

// Step 3: Apply DOM patches (update, insert, remove, replace operations)
// This is not what is happening right now
// Whole SVG gets re-rendered and inserted via innerHTML

// since diffResult does not exist this does not exist
for (const operation of diffResult.operations) {
  switch (operation.type) {
    case 'update':
      // Update element attributes
      element.setAttribute(key, value);
      break;
    case 'insert':
      // Insert new SVG element
      parent.appendChild(newElement);
      break;
    case 'remove':
      // Remove element
      element.remove();
      break;
    case 'replace':
      // Replace entire element with new SVG
      parent.replaceChild(newElement, element);
      break;
  }
}

// Step 4: Browser repaints only changed regions
```

#### Linters approves of this

`session.renderSvg` takes a `RenderSvgOptions` object (or the wider `RenderOptions<RenderSvgOptions>` union, though you normally just pass the base object when you already have a session).
`window?`: Rect – clip the output to a rectangular window. Rect is `{ lo: { x, y }, hi: { x, y } }` in Typst document units (pt). Use it to render just a slice of the page stack.
`data_selection?`: `{ body: boolean; defs: boolean; css: boolean; js: boolean }` – toggle which parts of the SVG payload you want back. All flags default to true:
`body`: the <svg> body with page content.
`defs`: gradients, glyph outlines, etc. inside <defs>.
`css`: the injected <style> block, needed to hide debug elements, or include it on your page already
`js`: the inline helper script (the big Typst selection/highlight script).

If you pass `renderSvg({})` you get the full document with js, css etc (all flags true, full bounds).

```js
                // this is where the document is loaded into session
                if (command === 'new') {
                    this.session.reset()
                }

                // Apply incremental data update to loaded document
                this.renderer.manipulateData({
                    renderSession: this.session,
                    action: "merge",
                    data: payload,
                });

                // Re-render to SVG, applies to dom. But it's unclear if the change will be incremental
                await this.renderer.renderToSvg({
                    renderSession: this.session,
                    container: this.previewElement,
                })

      // This is what actually worked
      const svg = await session.renderSvg({
          data_selection: { body: true, defs: true, css: false, js: false },
      });

      // where session is obtained and kept as long as possible
      private async ensureSession(): Promise<RenderSession> {
        if (!this.renderer) {
            throw new Error('Renderer not initialized');
        }

        if (this.session) {
            return this.session;
        }

        if (!this.sessionPromise) {
            console.log('[Preview Data] Creating persistent session');
            this.sessionPromise = new Promise<RenderSession>((resolve, reject) => {
                this.renderer!.runWithSession(async (session) => {
                    this.session = session;
                    this.hasInitialDocument = false;
                    resolve(session);

                    await new Promise<void>((res) => {
                        this.sessionResolve = res;
                    });
                }).catch((err) => {
                    this.session = null;
                    this.sessionPromise = null;
                    this.sessionResolve = null;
                    reject(err);
                });
            });
        }

        return this.sessionPromise;
    }

```

## Everything below is not easily accessible reality for browser, will see

### 3. **Navigation Handler** (`handleNavigation`)

**Transformation:** Binary Position → WASM Layout Query → DOM Scroll

```typescript
// Step 1: Decode binary position data
const positions = parsePositionString(payload); // "page x y"

// Step 2: Query WASM for page layout metrics
const pageLayout = this.renderSession.getPageLayout(targetPage);
// Returns: { width, height, offsetX, offsetY }

// Step 3: Calculate absolute position using WASM metrics
const absoluteX = pageLayout.offsetX + relativeX;
const absoluteY = pageLayout.offsetY + relativeY;

// Step 4: Navigate using WASM-computed metrics
this.navigateToPosition(positions, pageLayout);
```

**Key WASM APIs Used:**

- `renderSession.getPageLayout(page)` - Get precise page metrics

### 4. **Cursor Handler** (`handleCursor`)

**Transformation:** Binary Position → WASM Element Query → DOM Cursor

```typescript
// Step 1: Parse cursor position from binary
const [page, x, y] = parsePositionData(payload);

// Step 2: Query WASM for element information at cursor
const elementInfo = this.renderSession.getElementAtPosition(page, x, y);
// Returns: { id, type, bounds: { width, height } }

// Step 3: Create cursor with WASM-determined size
const cursorRadius = Math.max(1, Math.min(5, elementInfo.bounds.height / 20));

// Step 4: Render cursor with WASM-computed properties
const cursor = createCursorCircle(x, y, cursorRadius);
pageElement.appendChild(cursor);
```

**Key WASM APIs Used:**

- `renderSession.getElementAtPosition(page, x, y)` - Get element at position

### 5. **Cursor Paths Handler** (`handleCursorPaths`)

**Transformation:** Binary JSON → WASM Path Analysis → SVG Paths

```typescript
// Step 1: Decode and parse JSON cursor paths
const paths = JSON.parse(this.decoder.decode(payload));
// Format: [{ page, points: [[x, y], ...] }, ...]

// Step 2: Query WASM for path rendering information
const pathRenderInfo = this.renderSession.getPathRenderInfo(page, points);
// Returns: { type, color, strokeWidth }

// Step 3: Create SVG path with WASM-computed styling
const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
path.setAttribute('stroke', pathRenderInfo.color);
path.setAttribute('stroke-width', String(pathRenderInfo.strokeWidth));
path.setAttribute('d', pathData);

// Step 4: Add to page
pageElement.appendChild(path);
```

**Key WASM APIs Used:**

- `renderSession.getPathRenderInfo(page, points)` - Get path styling

### 6. **Color Inversion Handler** (`handleInvertColors`)

**Transformation:** Binary Strategy → WASM Color Analysis → DOM Filter

```typescript
// Step 1: Parse inversion strategy from binary
const strategy = parseStrategy(payload); // "never" | "auto" | "always" | {...}

// Step 2: Analyze colors with WASM
const colorAnalysis = this.renderSession.analyzeColors();
// Returns: { dominantColor, colorSpace, hasLightBackground, contrastRatio }

// Step 3: Get WASM inversion recommendation
const shouldInvert = this.renderSession.shouldInvertColors(
  strategy,
  colorAnalysis
);

// Step 4: Apply WASM-computed color transformations
if (shouldInvert) {
  // Use WASM-determined color space for optimal results
  const filter = colorAnalysis.colorSpace === 'srgb'
    ? 'invert(1) hue-rotate(180deg)'
    : 'invert(1)';
  previewElement.style.filter = filter;
}
```

**Key WASM APIs Used:**

- `renderSession.analyzeColors()` - Analyze color space and palette
- `renderSession.shouldInvertColors(strategy, analysis)` - Get recommendation

## Import Statements

```typescript
// WASM rendering module
import type { RenderSession, SvgDiff } from '@myriaddreamin/typst.ts/rs';
import { initWasm } from '@myriaddreamin/typst.ts/rs';

// Typst DOM utilities
import type { TypstDocumentContext } from '@myriaddreamin/typst-dom';

// SVG patching utilities
import { patchSvgContainer } from '@myriaddreamin/typst-dom/svg';

// Vector-to-SVG conversion
import { vec2svg } from 'reflexo-vec2svg';
```

## Key Features Demonstrated

### Commands from decoded Data Plane reply

```typescript
switch (command) {
  case 'new': this.handleNewDocument(payload); break;
  case 'diff-v1': this.handleIncrementalUpdate(payload); break;
  case 'jump':
  case 'viewport': this.handleNavigation(payload); break;
  case 'cursor': this.handleCursor(payload); break;
  case 'cursor-paths': this.handleCursorPaths(payload); break;
  case 'partial-rendering': this.handlePartialRendering(payload); break;
  case 'invert-colors': this.handleInvertColors(payload); break;
  case 'outline': this.handleOutline(payload); break;
}
```

#### cursor-paths

You have to use file's absolute path to get it calculate the cursor
Their path is different from the actual svg elements tree. They don't count
data-tid wrappers and only count listed below elements as leaf on their tree
Beware that inline helper script (if enabled) can alter document tree even more

```js

        const kindMap: Record<number, string> = {
            0: '.typst-text',  // g
            1: '.typst-group', // g
            2: '.typst-image', // ?
            3: '.typst-shape', // path
            4: '.typst-page',  // g
            5: 'use' // theoretically .tsel (?), but actually "use" tag
            // .tsel elements are <h5:div> inside <foreignObject> for holding text for copy/paste
        };

[
  [
    {"kind":4,"index":0,"fingerprint":""},   // page
    {"kind":1,"index":0,"fingerprint":""},   // group
    {"kind":0,"index":7,"fingerprint":""},   // text block
    {"kind":5,"index":28,"fingerprint":""}   // character index
  ]
]

// example

[
    [
        {"kind": 4, "index": 0, "fingerprint": ""}, // page[0]
        {"kind": 1, "index": 0, "fingerprint": ""}, // page[0].g[0]
        {"kind": 1, "index": 11,"fingerprint": ""}, // page[0].g[0].g[11]
        {"kind": 1, "index": 3, "fingerprint": ""}, // page[0].g[0].g[11].g[3]
        {"kind": 1, "index": 2, "fingerprint": ""}, // page[0].g[0].g[11].g[3].g[2]
        {"kind": 0, "index": 0, "fingerprint": ""}, // page[0].g[0].g[11].g[3].g[2].text[0]
        {"kind": 5, "index": 10,"fingerprint": ""}  // page[0].g[0].g[11].g[3].g[2].text[0].char[10]
    ]
]
```



#### Paging

AI: Tinymist preview renders the whole document; it doesn’t have a “render only page 2” mode. If you need a single page, export with Typst CLI and a page range (e.g., --pages 2) instead.
To find what text corresponds to page 2, use preview/source sync: click in the preview to jump to the source, or use the editor’s “sync/reveal in preview” command to scroll the preview to the current source position.

-- With incremental updates it could be ok. Otherwise we can work on separate parts and only at the end combine them in single file.

```typst  styles.typ
#set page(width: 8.5in, height: 4in, margin: 1in)
#set text(font: "Linux Libertine", size: 11pt)        // top‑level content
#let heading = [#set text(size: 14pt)]    // symbol
```

```typst doc.typ
#include "styles.typ"

== Heading
My text
#image("assets/logo.svg", width: 2cm)
#image("assets/photo.png", width: 5cm)
```

##### Include vs Import

```typst
#include "styles.typ" runs the top‑level #set and also makes heading available.
#import "styles.typ": heading only brings in heading; it does not run the top‑level #set line.
```
