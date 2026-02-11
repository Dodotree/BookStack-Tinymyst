# Tinymist Architecture & Workflow

**On-Demand Per-Page Preview Servers** - Each page gets its own Tinymist process with dynamic port allocation.

## Architecture Overview

This document describes the **on-demand per-page architecture** for Tinymist integration in BookStack. Each Typst page being edited gets its own `tinymist preview` process with dedicated ports.

---

## System Diagram (Per-Page Architecture)

```log
┌─────────────────────────────────────────────────────────────────┐
│                    Browser (User editing Page 5)                 │
│  ┌──────────────────┐              ┌──────────────────┐         │
│  │  CodeMirror 6    │              │  Preview Pane    │         │
│  │  + Typst Mode    │              │  (SVG Display)   │         │
│  └────────┬─────────┘              └────────┬─────────┘         │
│           │                                  │                   │
│           │ WebSocket (JSON Events)          │ WebSocket (Binary)│
└───────────┼──────────────────────────────────┼───────────────────┘
            │                                  │
            │ ws://127.0.0.1:33636            │ ws://127.0.0.1:33637
            │ (Control: base+2*pageId)         │ (Data: base+2*pageId+1)
            │                                  │
┌───────────┼──────────────────────────────────┼───────────────────┐
│           ▼                                  ▼                   │
│  ┌────────────────────────────────────────────────────┐         │
│  │    Tinymist Preview Server for Page 5 (Rust)      │         │
│  │    Started: POST /ajax/tinymist/start-preview      │         │
│  │    Watches: storage/app/tinymist/page_5.typ        │         │
│  │    Flags: --partial-rendering true                 │         │
│  │                                                    │         │
│  │  ┌──────────────┐         ┌──────────────────┐    │         │
│  │  │Control Plane │         │   Data Plane     │    │         │
│  │  │  Port 33636  │         │   Port 33637     │    │         │
│  │  │              │         │                  │    │         │
│  │  │ • Events     │         │ • Binary diffs   │    │         │
│  │  │ • Status     │         │ • Incremental    │    │         │
│  │  │ • Outline    │         │ • SVG patches    │    │         │
│  │  └──────────────┘         └──────────────────┘    │         │
│  │                                                    │         │
│  │  ┌──────────────────────────────────────────┐    │         │
│  │  │     Typst Compiler (Native Rust)         │    │         │
│  │  │  • Incremental compilation (sub-ms)      │    │         │
│  │  │  • Partial rendering (diffs only)        │    │         │
│  │  │  • Binary diff protocol (diff-v1)        │    │         │
│  │  └──────────────────────────────────────────┘    │         │
│  └────────────────────────────────────────────────────┘         │
│                          Server                                 │
│                                                                 │
│  ┌─── Another user editing Page 10 simultaneously ───┐         │
│  │  Tinymist Preview Server for Page 10              │         │
│  │  Watches: storage/app/tinymist/page_10.typ        │         │
│  │  Control Port: 33646                              │         │
│  │  Data Port: 33647                                 │         │
│  └───────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│          BookStack Backend (PHP/Laravel) - Process Manager      │
│  ┌──────────────────────────────────────────────────┐           │
│  │         TinymistPreviewManager (PHP)              │           │
│  │  • Start preview server on page open              │           │
│  │  • Stop preview server on page close             │           │
│  │  • Track idle processes                          │           │
│  │  • Cleanup after timeout                         │           │
│  └──────────────────────────────────────────────────┘           │
│  ┌──────────────────────────────────────────────────┐           │
│  │         TinymistController (PHP)                 │           │
│  │  • Update file content (triggers recompile)      │           │
│  │  • CLI compilation (save/publish only)           │           │
│  │  • Database persistence                          │           │
│  │  • Search text extraction                       │           │
│  └──────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Database (MySQL/PostgreSQL)                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐         │
│  │ pages.content│  │  pages.html  │  │ pages.markdown│         │
│  │ (typst src)  │  │ (final SVG)  │  │ (for search)  │         │
│  └──────────────┘  └──────────────┘  └───────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

## On-Demand Lifecycle

### Process Start (When User Opens Editor)

```log
1. User clicks "Edit Page"
   ↓
2. Frontend: POST /ajax/tinymist/start-preview {page_id: 5}
   ↓
3. TinymistPreviewManager:
   - Calculate ports: Control=33636, Data=33637
   - Check if already running (avoid duplicates)
   - Create temp file: storage/app/tinymist/page_5.typ
   - Start process: tinymist preview --control-port 33636 --data-port 33637 page_5.typ
   ↓
4. Return ports to frontend: {control_port: 33636, data_port: 33637}
   ↓
5. Frontend connects WebSockets to those specific ports
```

### Process Termination (When User Closes Editor)

```log
1. User clicks "Close" or "Save"
   ↓
2. Frontend: POST /ajax/tinymist/stop-preview {page_id: 5}
   ↓
3. TinymistPreviewManager:
   - Send SIGTERM to process
   - Wait 5s for graceful shutdown
   - If still running: SIGKILL
   - Remove from process tracking
   ↓
4. Ports 33636/33637 become available for reuse
```

### Automatic Cleanup (Idle Timeout)

```log
Scheduled task runs every 10 minutes:
   ↓
TinymistPreviewManager::cleanupIdleServers()
   ↓
For each running preview server:
   - Check last activity timestamp
   - If idle > 30 minutes: Stop process
   ↓
Free up resources for active users
```

---

## Component Responsibilities

| Component | Purpose | Technology | Lifecycle |
|-----------|---------|------------|-----------|
| **TinymistPreviewManager** | Manage preview server processes | PHP/Laravel | Singleton service |
| **CodeMirror Editor** | Edit Typst source | JavaScript | Per-page component |
| **Preview Pane** | Display rendered SVG | typst-ts-renderer (WASM) | Per-page component |
| **Control Plane** | Events & status | Tinymist (Rust) | Per-page process |
| **Data Plane** | SVG binary streaming | Tinymist (Rust) | Per-page process |
| **TinymistController** | Save/publish + file updates | PHP/Laravel | Request-scoped |
| **Database** | Persistent storage | MySQL/PostgreSQL | Always available |

---

## WebSocket Protocols (Per-Page)

### Control Plane API (Dynamic Port per Page)

**Purpose:** Receive compilation status, document outline, and synchronization events.

**URL:** `ws://127.0.0.1:{controlPort}` where `controlPort = 33626 + (2 * pageId)`
**Protocol:** JSON messages
**Direction:** Bidirectional

**Client → Server Message Types:**

```json
// Updates file in tinymist memory. It will return right "current" if queried,
// but file watcher will not be triggered to provide updates.
{
    "event": "updateMemoryFiles",
    "files": {
        [FILE_PATH]: content
    }
}

{
    "event": "syncMemoryFiles",
    "files": {
        [FILE_PATH]: content
    }
}

{
    "event": "removeMemoryFiles",
    "files": [
        [FILE_PATH]
    ]
}

// SrcToDocJump message
//  The line number and the character number are 0-based
{
  "event": "panelScrollTo",
  "filepath": [FILE_PATH],
  "line": 0,
  "character": 0
}

"sourceScrollBySpan"
"panelScrollByPosition"
"changeCursorPosition"

// I'm not clear if it's incoming for the client or not (or both)
// Old documentation states:
// Preview to source jumping
// To implement preview to source jumping, the editor extension should listen to the EditorScrollTo message from the preview server. The start field is the start position of the selection. The end field is the end position of the selection.
// A (row, column) pair is used to represent a position. Both row and column are 0-based. You can use this information to scroll the editor to the corresponding position.

```

**Server → Client Message Types:**

```json
// Compilation status, error should provide diagnostics (? TODO verify)
{
  "event": "compileStatus",
  "kind": "CompileSuccess" | "Compiling" | "CompileError"
}

// Editor synchronization signal, sent periodically to signal editor state sync
// Purpose: Indicates that Tinymist has processed recent changes. (?)
{
  "event": "syncEditorChanges"
}

{
  "event":"editorScrollTo" // or "DocToSrcJump" ?
}
{
  "event": "editorScrollTo",
  "filepath":  [FILE_PATH],
  "start": [
    9,
    2
  ],
  "end": [
    9,
    32
  ]
}

// Document outline/structure example
// Sent after successful compilation
// - `title` - Section heading text
// - `span` - Internal document span identifier
// - `position.page_no` - Page number (1-indexed)
// - `position.x` - X coordinate in points
// - `position.y` - Y coordinate in points
// - `children` - Nested outline items
{
  "event":"outline",
  "items":[
    {
      "title":"Hello Tinymist",
      "span":"200000001",
      "position":{"page_no":1,"x":70.86614,"y":70.86614},
      "children":[
        {
          "title":"Features",
          "span":"200000000",
          "position":{"page_no":1,"x":70.86614,"y":112.127144},
          "children":[]
        }
      ]
    }
  ]
}
```

**Example of the use for the outline (as in VSCode 'outline'):**

```typescript
function handleOutline(items: OutlineItem[]) {
    const tocElement = document.querySelector('.table-of-contents');
    tocElement.innerHTML = renderOutline(items);
}

function renderOutline(items: OutlineItem[], level = 0): string {
    return items.map(item => `
        <div class="outline-item level-${level}"
             data-page="${item.position.page_no}"
             data-x="${item.position.x}"
             data-y="${item.position.y}">
            ${item.title}
            ${item.children.length > 0 ? renderOutline(item.children, level + 1) : ''}
        </div>
    `).join('');
}
```

### CodeMirror Editor View updates

``` typescript
import { EditorView } from '@codemirror/view';

const customExtension = EditorView.updateListener.of((update) => {
    // 1. DOCUMENT CHANGES
    update.docChanged          // boolean: true if document text changed
    update.changes             // ChangeSet: details of what changed
    update.startState          // EditorState: state before update
    update.state               // EditorState: current state after update

    // 2. SELECTION CHANGES
    update.selectionSet        // boolean: true if selection/cursor moved

    // 3. VIEW/VIEWPORT CHANGES
    update.viewportChanged     // boolean: true if visible area changed (scrolling)
    update.geometryChanged     // boolean: true if editor size changed
    update.focusChanged        // boolean: true if editor focus changed

    // 4. TRANSACTIONS
    update.transactions        // readonly Transaction[]: all transactions in this update
    update.view                // EditorView: the editor view itself
});
```

### Data Plane (Dynamic Port per Page)

**Purpose:** Receive compiled SVG output and send rendering commands.

**URL:** `ws://127.0.0.1:{dataPort}` where `dataPort = 33625 + (2 * pageId) + 1`
**Protocol:** Binary WebSocket (SVG text or binary frames) binaryType = "arraybuffer"
**Direction:** Bidirectional

**Client → Server Message Types:**

```js
// Request current SVG
dataWs.send('current');
```

**Server → Client Message Types:**

**Response:** Binary SVG patch (incremental update sent automatically)

### Binary Message Format

Data Plane messages are binary data in this format:

```js
[message_type],[payload]
```

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
|------|------|-------------|------|
| `partial-rendering,true` | 4 bytes | Configuration confirmation | On connect |
| `diff-v1,<binary>` | 1-3 KB | **Incremental diff** | After file change |
| `new,<binary>` | 10-15 KB | **Full document** | Initial render or manual request |

svg (No comma = full SVG render)
**Format:** Raw binary SVG data
**Size:** 1 KB - 500 KB (depending on document complexity)
Binary SVG response (31,404 bytes in test)
Blob { size: 31404, type: "" }

svg patch
**Format:** Binary diff/patch data
**Purpose:** Incremental SVG update (smaller than full render)
Blob { size: 1234, type: `diff-v1` (or `new`) }
Compressed binary document (Binary SVG diff reflexo-vec2svg format)
WASM deserializes it using rkyv

jump
**Format:** `jump,[page] [x] [y]`
**Purpose:** Scroll to specific position
Jump command example
Binary data: "jump,1 70.866 112.127"

"viewport-change" // (?)
"svgUpdateEvent" (default) // (?)

#### Parsing Binary Messages

```typescript

private handleSVG(data: Uint8Array) {
    // My hope is that typst-dom (typst-ts-renderer) knows how to deal with it
    // deserializes it using rkyv and apply the changes to the VDOM
    // to get the latest document
    if (this.renderer) {
        // Use WASM renderer for incremental updates
        //// addChangement should be on the svgDoc, not renderer
        this.renderer.addChangement(data);
    } else {
        // Fallback: display as text, that is ridiculous
        const svgText = new TextDecoder().decode(data);
        this.displaySVG(svgText);
    }
}

```

### Test Binary Message Parsing

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

## Data Flow

```log
┌────────────────────────┐
│ User types in editor   │
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ CodeMirror LSP Client  │
│ textDocument/didChange │
│ (incremental changes)  │
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ Backend LSP Bridge     │
│ (PHP WebSocket/HTTP)   │
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ Update .typ file       │
│ (apply didChange patch)│
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ Tinymist detects       │
│ file change            │
│ (file watcher)         │
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ Incremental compile    │
│ (200-500µs!)           │
└──────────┬─────────────┘
           │
           ├─► Control Plane emits
           │   {"event":"compileStatus",
           │    "kind":"CompileSuccess"}
           │
           └─► Data Plane sends
               Binary diff-v1
               (1-3 KB instead of 10 KB!)
           ▼
┌────────────────────────┐
│ WASM decoder applies   │
│ binary diff            │
│ (faster, smaller)      │
└──────────┬─────────────┘
           │
           ▼
┌────────────────────────┐
│ Preview updates        │
│ (50-100ms latency)     │
└────────────────────────┘

```

**Key Implementation Steps:**

1. **CodeMirror sends didChange events** (range-based edits)
2. **Backend receives LSP events** via File WebSocket (not implemented yet) or HTTP polling
3. **Backend updates .typ file** on disk (apply text edits)
4. **Tinymist file watcher detects change** (inotify/kqueue)
5. **Incremental compilation** produces binary diff or new
6. **Data Plane sends diff-v1** (only changed regions)
7. **Frontend typst-dom extension (and WASM)** applies diff to current document

```typescript
// resources/js/components/tinymist-editor-lsp.ts
import {EditorView} from "@codemirror/view";
import {EditorState, ChangeSet} from "@codemirror/state";
import {LanguageServerClient} from "@codemirror/language-server";

export class TinymistEditorLSP {
    private pageId: number;
    private editor: EditorView;
    private lspClient: LanguageServerClient;
    private controlWs: WebSocket | null = null;
    private dataWs: WebSocket | null = null;
    private controlPort: number | null = null;
    private dataPort: number | null = null;
    private fileUri: string;

    async initialize() {
        this.pageId = parseInt(this.elem.dataset.pageId!);
        this.fileUri = `file:///storage/app/tinymist/page_${this.pageId}.typ`;

        // Start preview server (gets ports)
        await this.startPreviewServer();

        // Initialize CodeMirror with LSP
        this.initializeEditor();

        // Connect WebSocket for preview
        this.connectWebSockets();
    }

    private initializeEditor() {
        // Create LSP client (communicates changes to backend)
        this.lspClient = new LanguageServerClient({
            documentUri: this.fileUri,
            languageId: "typst",

            // Send textDocument/didChange to backend
            transport: {
                send: async (message) => {
                    await fetch('/ajax/tinymist/lsp-message', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            page_id: this.pageId,
                            message: message
                        })
                    });
                }
            }
        });

        this.editor = new EditorView({
            doc: this.getInitialContent(),
            extensions: [
                typstLanguage(),
                this.lspClient.extension,  // Automatically sends didChange!
                this.createChangeListener(),
            ],
            parent: this.elem.querySelector('.editor-pane')
        });
    }

    /**
     * Listen to editor changes and track for LSP
     */
    private createChangeListener() {
        return EditorView.updateListener.of((update) => {
            if (update.docChanged) {
                // LSP extension automatically sends textDocument/didChange
                // with incremental edits (range-based, not full document)
                console.log('Document changed, LSP didChange sent');

                // Optional: Log the changes
                update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
                    console.log(`Changed: [${fromA},${toA}] → "${inserted}"`);
                });
            }
        });
    }

    /**
     * Connect to WebSockets for live preview updates
     */
    private connectWebSockets() {
        this.connectControlPlane();
        this.connectDataPlane();
    }

    private connectControlPlane() {
        this.controlWs = new WebSocket(`ws://127.0.0.1:${this.controlPort}`);

        this.controlWs.onmessage = (event) => {
            const message = JSON.parse(event.data);

            if (message.event === 'compileStatus' && message.kind === 'CompileSuccess') {
                console.log('✓ Compilation successful');
                // Compilation complete - Data Plane will send diff automatically
            }
        };
    }
}
```

## Tinymist Partial Rendering

**Key Flag:** `--partial-rendering true`

**Workflow:**

```log
User types in CodeMirror
         ↓
HTTP POST /ajax/tinymist/update-content
         ↓
PHP writes FULL content to storage/app/tinymist/page_X.typ
         ↓
Tinymist file watcher detects change
         ↓
Incremental compilation (200-500µs)
         ↓
Data Plane WebSocket sends diff-v1 (1-3 KB)
         ↓
Browser receives and renders SVG diff
```

### Key Clarification: What's "Incremental" in Partial Rendering?

**You might wonder:** "If I send the full document each time, where's the incremental part?"

**Answer:**

| Layer | What You Send | What Tinymist Does | What You Receive |
|-------|---------------|-------------------|------------------|
| **Input (Your Side)** | ❌ Full document (~10 KB text) | - | - |
| **Compilation (Tinymist)** | - | ✅ Incremental (only reprocesses changed AST nodes) | - |
| **Output (Your Side)** | - | - | ✅ Incremental (binary diff ~1-3 KB) |

**So "partial rendering" refers to:**

- ✅ **Compilation efficiency** - Tinymist recompiles only changed parts
- ✅ **Transfer efficiency** - Browser receives only SVG diffs
- ❌ **NOT input efficiency** - You still send full document

### WebSocket Approach with memory save

```log
┌──────────────────────┐
│ User types           │
│ in CodeMirror        │
└──────┬───────────────┘
       │ onChange event
       ▼
┌──────────────────────┐
│ JavaScript:          │
│ sendMemoryFileUpdate │
└──────┬───────────────┘
       │ Control Plane WebSocket
       │ {"UpdateMemoryFiles": {...}}
       ▼
┌──────────────────────┐
│ Tinymist Preview     │
│ Server               │
│ - Updates in-memory  │
│ - Incremental        │
│   compilation        │
│   (200-500µs)        │
└──────┬───────────────┘
       │
       ├─► Control Plane
       │   {"event":"compileStatus",
       │    "kind":"CompileSuccess"}
       │
       └─► Data Plane (But! not really triggering on memory updates)
           Binary message:
           "diff-v1,<1-3KB binary>"
       ▼
┌──────────────────────┐
│ Browser receives     │
│ binary diff          │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Apply diff           │
│ (WASM decoder)       │
│ OR request full      │
│ render (fallback)    │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Preview updates      │
│ (50-100ms latency)   │
└──────────────────────┘
```

## More diagrams

```log
┌──────────────────────────────────────────────────────────┐
│                    PHASE 1: EDITING                       │
│         (Real-time, File-based, WebSocket delivery)       │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────┐
        │  Browser → API → File System      │
        │  POST /ajax/tinymist/update-content
        │  ↓ Update storage/app/tinymist/page_X.typ
        │                                   │
        │  Tinymist (file watcher) ────────┘
        │  ↓ Detects change
        │  ↓ Auto-compiles (~50-200ms)
        │  ↓ Sends SVG via WebSocket
        │                                   │
        │  WebSocket → Browser ─────────────┘
        │  • Dynamic ports per page         │
        │  • Control: 33626 + (2 × page_id) │
        │  • Data: 33625 + (2 × page_id) + 1│
        │  • NO database writes             │
        └───────────────────────────────────┘
                            │
                            │
┌──────────────────────────────────────────────────────────┐
│                 PHASE 2: PUBLISHING                       │
│           (On save/publish, Typst CLI, With Storage)      │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
        ┌───────────────────────────────────┐
        │  • POST submit                    │
        │  • Typst CLI compile (full)       │
        │  • Database write: text for search, html (svg), markdown(typst)│
        │  • Search indexing                │
        └───────────────────────────────────┘
```

## Real-Time Editing Flow

### Detailed Sequence (File-Based Workflow)

```log
┌─────────────────────────┐
│ 1. User types in editor │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 2. CodeMirror onChange  │
│    event triggered      │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 3. POST /ajax/tinymist/ │
│    update-content       │
│    {page_id: 5, content}│
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 4. Laravel writes file  │
│    storage/app/tinymist/│
│    page_5.typ           │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 5. Tinymist file watcher│
│    detects change       │
│    Incremental compile  │
└───────────┬─────────────┘
            │
            ├────────────────────┐
            │                    │
            ▼                    ▼
┌─────────────────────────┐ ┌──────────────────────┐
│ 6a. Control Plane       │ │ 6b. Data Plane       │
│     ws://127.0.0.1:33636│ │     ws://127.0.0.1   │
│     Sends JSON events:  │ │     :33637           │
│     • compileStatus     │ │     Sends binary SVG │
│     • outline           │ │     patch (~1-50 KB) │
└─────────────┬───────────┘ └──────────┬───────────┘
              │                        │
              ▼                        ▼
┌─────────────────────────┐ ┌──────────────────────┐
│ 6a. Update UI           │ │ 6b. WASM renderer    │
│     • Show status       │ │     applies patch    │
│     • Update TOC        │ │     • Incremental    │
└─────────────────────────┘ └──────────┬───────────┘
                                       │
                                       ▼
                            ┌──────────────────────┐
                            │ 7. Preview updates   │
                            │    (50-200ms latency)│
                            └──────────────────────┘
```

## Save/Publish Flow

### Detailed Sequence1

```log
┌─────────────────────────┐
│ 1. User clicks "Save"   │
│    or "Publish" button  │
|    .submit()            |
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 2. PageRepo.php         |
| updateTemplateStatusAndContentFromInput|
|    PageContent.php      │
│    setNewTinymist()     │
│    • Validate request   │
│    • Check permissions  │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 3. Run Tinymist CLI     │
│    Process::run([       │
│      'tinymist',        │
│      'compile',         │
│      '-',  // stdin     │
│      '--format', 'svg', │
│      '-o', '-'  // stdout│
│    ], $typstSource)     │
│    Timeout: 30 seconds  │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 4. Extract search text  │
│    • extractPlainText() │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 5. Database transaction │
│    BEGIN;               │
│    UPDATE pages SET     │
│      content = ?,       │
│      html = ?,          │
│      markdown = ?,      │
│      editor = 'tinymist'│
│    WHERE id = ?;        │
│    COMMIT;              │
└───────────┬─────────────┘


```

## Page View Flow

### Detailed Sequence2

```log
┌─────────────────────────┐
│ 1. User visits page URL │
│    GET /books/foo/      │
│        pages/bar        │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 2. PageController       │
│    ::show()             │
│    • Find page by slug  │
│    • Check permissions  │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 3. Check editor type    │
│    if ($page->editor    │
│        === 'tinymist')  │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 4. Load from database   │
│    $svg = $page->html;  │
│    (SVG content)        │
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 5. Render Blade view    │
│    pages/show.blade.php │
│    with SVG content     │
└───────────┬─────────────┘
            │
            ▼
┌────────────────────────┐
│ Render Blade template  │
│ Display static SVG     │
└────────────────────────┘

```

### BookStack Search Integration

BookStack's existing search automatically indexes the `pages.markdown` and `pages.text` columns.
