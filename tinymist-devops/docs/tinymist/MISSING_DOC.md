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

## Preview Data Plane

**Client → Server Message Types:**

```js
// Request current SVG
dataWs.send('current');
```

**Server → Client Message Types:**

**Response:** Binary SVG patch (incremental update sent automatically if it's a real file, not in-memory-file)

## BINARY MESSAGE FORMAT

All WebSocket messages follow: command,<binary_data>
**Binary Type of node websockets**: `arraybuffer`

Format Breakdown:
┌─────────────────┬──────┬──────────────────┐
│ Command (ASCII) │ 0x2C │ Payload (Binary) │
└─────────────────┴──────┴──────────────────┘

- `message_type`: ASCII text (e.g., "diff-v1", "new", "svg")
- `,`: ASCII comma (byte 44) or (0x2C)
- `payload`: Binary data

- Find comma separator (0x2C) in binary data
- Extract command (ASCII text before comma)
- Extract payload (binary data after comma)

### Example Binary Message

```javascript
// Received on Data Plane WebSocket
Blob(1140 bytes)

// Parsed structure:
[100, 105, 102, 102, 45, 118, 49, 44, ...]  // "diff-v1," + binary diff data
     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
     "diff-v1" in ASCII (bytes 100-118)
                                     ^^
                                     comma separator (byte 44)
                                          ^^^^^^^^^^^^
                                          Binary diff payload (1132 bytes)
```

### Message Types

| Type | Size | Description | When |
| ------ | ------ | ------------- | ------ |
| `partial-rendering,true` | 4 bytes | Configuration confirmation | On connect |
| `diff-v1,<binary>` | 1-3 KB | **Incremental diff** | After file change |
| `new,<binary>` | 10-15 KB | **Full document** | Initial render or manual request |

### Example of splitting off the start

```javascript
// Browser console test
const blob = new Blob([
    ...new TextEncoder().encode("diff-v1,"),
    ...new Uint8Array([1, 2, 3, 4, 5])  // Mock binary data
]);

const buffer = await blob.arrayBuffer();
const uint8 = new Uint8Array(buffer);
const comma = uint8.indexOf(44);
const type = new TextDecoder().decode(uint8.slice(0, comma));
const payload = uint8.slice(comma + 1);

console.log(`Type: ${type}, Payload: ${payload.length} bytes`);
// Output: Type: diff-v1, Payload: 5 bytes
```

--- svg (No comma = full SVG render)
**Format:** Raw binary SVG data
**Size:** 1 KB - 500 KB (depending on document complexity)
Binary SVG response (31,404 bytes in test)
Blob { size: 31404, type: "" }

--- new
**Format:** ? It looks very similar to the full document `diff-v1` but misses important parts, not usable for incremental updates
**Purpose:** Reset document state. Patched tinymist provides foll document diff-v1 instead so the reset can work with incremental updates
Compressed binary document (Binary SVG diff reflexo-vec2svg format)
**Handler**: Resets the renderer and loads the complete new document
**Binary Processing**: The SVG data is passed directly to `kModule.manipulateData()` with action "merge" after applying .reset() to session

--- svg patch
**Format:** Binary diff/patch data
**Purpose:** Incremental SVG update (smaller than full render)
**Key Flag:** `--partial-rendering true` at tinymist cli initiation (can not toggle later)
Command: "diff-v1" (7 bytes for diff-v1)
Separator: 0x2C (1 byte)
Blob { size: 1234, type: `diff-v1` (or `new`) }
Compressed binary document (Binary SVG diff reflexo-vec2svg format)
WASM deserializes it using rkyv
**Handler**: Merges the changes into existing document
**Binary Processing**: Applied as incremental patch via `kModule.manipulateData()` with action "merge"

--- jump
**Format:** `jump,[page] [x] [y]`
**Purpose:** Scroll to specific position
Command: "jump" (4 bytes)
Separator: 0x2C (1 byte)
Payload: Position string (15 bytes)
Binary data: `jump,1 70.866 112.127`
**Data**: Comma-separated position strings in format `"page x y,page x y,..."`
**Handler**: Scrolls to the closest position, handles multi-page documents
**Example**: `"1 100.5 200.0,2 50.0 150.0"`

--- viewport
**Format:** `viewport,<position>`
**Purpose**: Update viewport to show specific position
**Data**: Single position string in format `"page x y"`
**Handler**: Similar to jump but for viewport updates
**Example**: `"1 100.5 200.0"`
PS I saw something like that but not confirmed it yet

--- cursor
**Format:** `cursor,<position>` never received it, don't know how to trigger, probably confused with outgoing control message `changeCursorPosition`
**Purpose**: Show cursor at specific document position
**Data**: Position string in format `"page x y"`
**Handler**: Displays cursor indicator and triggers viewport change
**Example**: `"1 100.5 200.0"`

--- cursor-paths
**Format:** `cursor-paths,<json_paths>` in reaction to Control Plane request `changeCursorPosition`
**Purpose**: Show cursor based on element paths in the document
**Data**: JSON array of element point arrays
**Handler**: Draws cursor at text positions using SVG elements
**Example**: `[[[1, 2, "text"], [3, 4, "span"]]]`
PS It only counts SVG non-zero size branches as nodes, so you have to keep it in mind while parsing the path

"viewport-change" // (something before initialization?)

#### Configuration Messages

**Format:** `partial-rendering,true`
**Purpose**: Inform of the partial-rendering option that was set during initialization
**Data**: String "true"
**Handler**: Sets `svgDoc.setPartialRendering(true)`

**Format:**  `invert-colors,<strategy>`
**Purpose**: Configure color inversion strategy (also only on init?)
**Data**: Strategy string or JSON object
**Strategies**:
    - `"never"`: Never invert colors
    - `"auto"`: Auto-detect based on theme
    - `"always"`: Always invert colors
    - JSON object: `{"rest": "auto", "image": "never"}`
**Handler**: Applies CSS classes for color inversion

**Format:**  `outline,<outline_data>` never seen in Data Plane but it's a common control plane message
**Purpose**: Send document outline/table of contents
**Data**: Outline structure data
**Handler**: Currently logged as experimental feature

### Client → Server Messages

#### Initial Connection

**Format:**  `current`
**Purpose**: Request current document state
**Sent**: Automatically when WebSocket connection opens
**Response**: Server sends current document via `new,` or `diff-v1,` message

#### Navigation and Interaction

**Format:**  `srclocation <span_id>` ?
**Purpose**: Request source location for document element
**Format**: `"srclocation <span_identifier>"`
**Response**: Server resolves to source file position

**Format:** `outline-sync,<position>` ?
**Purpose**: Sync outline with viewport position
**Format**: `"outline-sync,page x y"`
**Response**: Updates viewport position in other clients

**Format:**  `srcpath <json_path>` ?
**Purpose**: Resolve span by element path
**Format**: `"srcpath <json_array>"`
**Data**: JSON array of `(u32, u32, String)` tuples representing element path
**Response**: Server resolves to source spans

`src-point <position>`
**Purpose**: Resolve frame location to source
**Format**: `"src-point <json_position>"`
**Data**: JSON document position object
**Response**: Server resolves to source location

---

## KEY COMPONENTS

### 1. WebSocketPreviewProcessor

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
  WASM: initWasm() → reset()
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
Tinymist tags/releases carry the Typst version in their release notes; visit <https://github.com/Myriad-Dreamin/tinymist/releases> and match the “Typst v0.xx” line (for example v0.13.x releases ship Typst 0.13.x).
When the versions match, the reflexo crate revisions match too; confirm via the Cargo.lock in both projects or the crates/reflexo-* commit mentioned in their changelog entries.
For day-to-day updates, the tinymist docs in TINYMIST_ARCHITECTURE.md and the Typst.ts “cookery” docs (<https://myriad-dreamin.github.io/typst.ts>) both note the compatible release pairs whenever they switch Typst versions.

@myriaddreamin/typst.ts and @myriaddreamin/typst-ts-renderer
0.6.x release that matches tinymist 0.13.x.
0.7.x release that matches tinymist 0.14.x. (current)
*************************************************

WASM provides high-performance operations:

- `initWasm()`: Initialize WASM module  -- should be `renderer.init()`
- first load should be session `.reset()`: Store SVG baseline for diffs -- (?)
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

## Import Statements, not sure any of it is available separately or required

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

## LIFECYCLE SUMMARY

Step 1: Binary Reception
  WebSocket receives ArrayBuffer
  Add to buffer for batching

Step 2: Message Parsing
  Find comma byte (0x2C) separator
  Extract command (before comma), decode it
  Extract payload (after comma), leave it as is (do not decode)

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
  Replace SVG

Step 7: Repeat
  Next message arrives
  Process continues

### Message Batching

- Messages are batched using RxJS `buffer()` and `debounceTime(0)`
- Batched messages processed sequentially to maintain order
- Batch size logged for debugging: `"batch N messages"`

```typescript
// Multiple messages arriving rapidly are batched
this.messageBuffer.push(data);
queueMicrotask(() => this.processBatchedMessages());
```

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

## ADVANCED TOPICS

Virtual DOM Diffing: -- As far as know, this is misleading
  WASM returns optimized DOM operations
  Each operation updates one element
  Only affected DOM nodes are touched
  Results in minimal repaints

Message Batching: -- For RxJS users
  Multiple rapid messages are collected
  Processed together using `queueMicrotask` from RxJS
  Reduces rendering overhead
  User sees smooth updates

Partial Rendering:
  WASM can render only visible pages -- Would be nice to have, but not verified
  Reduces memory usage for large documents
  Improves initial load time

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
  currentState: this.currentSvgElement.outerHTML, // no such option available, artifactContent?
});
// Returns: { operations: DOMOperation[] } // No such thing, at least in js
```

### Linter approves of this

`session.renderSvg` takes a `RenderSvgOptions` object (or the wider `RenderOptions<RenderSvgOptions>` union, though you normally just pass the base object when you already have a session).
`window?`: Rect – clip the output to a rectangular window. Rect is `{ lo: { x, y }, hi: { x, y } }` in Typst document units (pt). Use it to render just a slice of the page stack.
`data_selection?`: `{ body: boolean; defs: boolean; css: boolean; js: boolean }` – toggle which parts of the SVG payload you want back. All flags default to true:
    -  `body`: the `<svg>` body with page content.
    -  `defs`: gradients, glyph outlines, etc. inside `<defs>`.
    -  `css`: the injected `<style>` block, needed to hide debug elements, or include it on your page already
    -  `js`: the inline helper script (the big Typst selection/highlight script).

**Note, If you pass** `renderSvg({})` you get the full document with js, css etc (all flags true, full bounds),
so load the copy of js and css once and set `data_selection` css and js to false

```js
  // reset document state before setting full document
  if (command === 'new') {
      this.session.reset()
  }

  // Apply incremental data update to loaded document
  this.renderer.manipulateData({
      renderSession: this.session,
      action: "merge",
      data: payload,
  });

  // Re-render to SVG, applies to dom. But probably it's a full replacement too since this.renderSession.manipulateData does not
  // return diffResult for incremental dom manipulation
  // Not sure it works like this at all either
  await this.renderer.renderToSvg({
      renderSession: this.session,
      container: this.previewElement,
  })

  // This is what actually worked
  const svg = await session.renderSvg({
      data_selection: { body: true, defs: true, css: false, js: false },
  });

  // where session is obtained and kept as long as possible because you need session to apply diffs to
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

### Experimental renderSvgDiff

Not tested yet, looks like another bunch of nonsense. Most likely it's possible to use data-tid with some morphing library. That is if session.renderSvgDiff works at all.

Q: Is there any performance benefit in using this approach instead of full replacement of svg?
A: Yes—when updates are frequent or SVGs are large. renderSvgDiff + patchRoot reuses existing DOM nodes (via data-tid) and only updates changed parts, avoiding full SVG parsing, layout, and GC churn. For small docs or infrequent updates, full replacement is simpler and often fast enough, and the diff/patch overhead may not pay off.

```ts
import { createTypstRenderer } from 'typst';
import { patchRoot } from 'typst/render/svg/patch.mjs';

const mount = document.getElementById('preview')!;

const renderer = createTypstRenderer();
await renderer.init();

// 1) create a session with initial vector artifact (full SIR/vector blob)
const session = await renderer.runWithSession(
  { format: 'vector', artifactContent: initialVectorBytes },
  async s => s,
);

// 2) initial full SVG render
const fullSvg = await session.renderSvg({});
mount.innerHTML = fullSvg;

// 3) on each websocket diff‑v1 message:
ws.onmessage = async ev => {
  const diffV1 = new Uint8Array(ev.data); // vector delta bytes

  // apply diff‑v1 inside WASM
  session.manipulateData({
    action: 'merge',
    data: diffV1,
  });

  // render SVG diff string for current view
  const patchStr = session.renderSvgDiff({
    // optional window for partial rendering
    // window: { lo: { x, y }, hi: { x2, y2 } },
  });

  // patch DOM
  const tmp = document.createElement('div');
  tmp.innerHTML = patchStr;
  const nextSvg = tmp.firstElementChild as SVGElement;

  const prevSvg = mount.firstElementChild as SVGElement | null;
  if (prevSvg) {
    patchRoot(prevSvg, nextSvg);
  } else {
    mount.innerHTML = patchStr;
  }
};

```

## Everything below is not easily accessible reality for browser, will see

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

### cursor-paths -- confirmed, works

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

#### Paging and includes

AI: Tinymist preview renders the whole document; it doesn’t have a “render only page 2” mode. If you need a single page, export with Typst CLI and a page range (e.g., --pages 2) instead.
To find what text corresponds to page 2, use preview/source sync: click in the preview to jump to the source, or use the editor’s “sync/reveal in preview” command to scroll the preview to the current source position.

-- With incremental updates it could be ok. Otherwise we can work on separate parts and only at the end combine them in single file.

```js  styles.typ
#set page(width: 8.5in, height: 4in, margin: 1in)
#set text(font: "Linux Libertine", size: 11pt)        // top‑level content
#let heading = [#set text(size: 14pt)]    // symbol
```

```js doc.typ
#include "styles.typ"

== Heading
My text
#image("assets/logo.svg", width: 2cm)
#image("assets/photo.png", width: 5cm)
```

##### Include vs Import

```js
#include "styles.typ" runs the top‑level #set and also makes heading available.
#import "styles.typ": heading only brings in heading; it does not run the top‑level #set line.
```
