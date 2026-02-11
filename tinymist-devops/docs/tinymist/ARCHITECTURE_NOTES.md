# Tinymist Architecture & Workflow

## Objective

Making Typst markup easily available for engineers, scientist, students, and such without the need to program or manage packages. Features expected:
    - customizable highlighting of the typst markup itself for easier editing
    - live preview with zoom-in/zoom-out with full rendering support
    - ability to use #import #include #image to link additional files
    - show typst text editor cursor in the rendered preview
    - save/download both typst text and preview as svg/pdf/image
    - print pdf
    - save/load templates or examples of use
    - light and dark themes, fonts selection
    - save user preferences

## Main Tools for components and their responsibilities

    - Typst cli compiler for one off renders of the whole file or selected pages from it.
    - Tinymist wrapper around typst compiler initially created for VScode and other IDE. Tinymist preview for realtime rendering preview panel. Tinymist LSP for editor panel diagnostics, semantic tokens, tips, autofill and whatever works.
    - CodeMirror as rich text editor that also can be used on the back end for realtime syncing with the copy of the edited file. Live copy of the edited file is needed for the tinymist.
    - @myriaddreamin/typst-ts-renderer WASM tinymist renderer to convert tinymist custom vector format into live .svg preview. This is very important to have the right release for it to be able to decode back end tinymist renders:
        0.6.x release that matches tinymist 0.13.x.
        0.7.x release that matches tinymist 0.14.x. (current)
    - Nodejs for creating clients for tinymist processes and bridges to connect through web sockets tinymist with the browser. Also nodejs websocket connects browser and back end CodeMirror for realtime sync of the editors content in the browser with the back end temporary copy of the file. (The reason for nodejs being a tool of choice was the ease of use and CodeMirror module availability. I was not able to find PHP tools that can support custom protocol websockets, meaning, there will be required fields in their protocols and Tinymist will drop any message that contains fields it does not recognize)
    - Bookstack Laravel for user authentication, file organization, saving to database, search. Also for some scheduled tasks and logging.

## System Diagram (Per-Page Architecture)

┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                    Browser (User editing Page 5)                                                       │
│  ┌──────────────────┐                                                     ┌──────────────────┐         │
│  │  Editor Pane     │           Cursor position                           │  Preview Pane    │         │
│  │  CodeMirror      ├────────────────────────────────────────────────────►│  Connection      │         │
│  └────────┬─────────┘                                                     └────────┬─────────┘         │
│           │                                                                        │                   │
│           │ WebSocket (JSON Events)                                                │ WebSocket (Binary)│
└───────────┼────────────────────────────────────────────────────────────────────────┼───────────────────┘
            │                                                                        │
            │ ws://host:4000                                                         │ ws://host:4020
            │                                                                        │
┌───────────┼────────────┐       ┌──────────────────────────────┐     ┌──────────────┼────────────────────────────────┐
│           ▼            │       │ Page 5 copy in storage/      │     │              ▼                                │
│ file-sync/server.ts    │       │ created by Laravel           │     │ preview/preview-server.ts                     │
│                        │       │ when serving the page        │     │                                               │
│ ┌──────────────┐       │       │                              │     │ ┌───────────────┐ ┌───────────────┐ ┌───────┐ │
│ │ file-manager │       │       │                              │     │ │ Page 5        │ │ Page 8        │ │ ...   │ │
│ │ CodeMirror   ┼───────┼───────┼──►                           │     │ │ PreviewClient │ │ PreviewClient │ │       │ │
│ │ updates      │       │       │                    Tinymist  │     │ │┌─────────────┐│ │┌─────────────┐│ │       │ │
│ └──────────────┘       │       │                     preview  │     │ ││ Tinymist    ││ ││ Tinymist    ││ │       │ │
│ ┌────────────────────┐ │       │                       ───────┼─────┼─┼┼─►  Preview  ││ ││ Preview     ││ │       │ │
│ │ LSP Client    │    │ │       │                file watcher  │     │ │├───────┬─────││ │├───────┬─────││ │       │ │
│ │┌──────────────┼───┐│ │       │              inotify/kqueue  │     │ ││Control│ Data││ ││Control│ Data││ │       │ │
│ ││ LSP Server   ▼   ││ │       │ Pulls                        │     │ ││Plane  │Plane││ ││Plane  │Plane││ │       │ │
│ ││                ◄─┼┼─┼───────┼── upon                       │     │ │└───────┴─────┘│ │└───────┴─────┘│ │       │ │
│ ││ • Diagnostics    ││ │       │ notification                 │     │ │ Both ports    │ │               │ │───────│ │
│ ││ • Semantic Tokens││ │       └──────────────────────────────┘     │ └───────────────┘ └───────────────┘ └───────┘ │
│ ││ ...              ││ │                                            └─────────────┼─────────────────────────────────┘
│ │└──────────────────┘│ │                                                          │
│ └────────────────────┘ │                                                          │
└───────┼────────────────┘                                                          │
        │                                                                           │
┌───────┼───────────────────────────────────────────────────────────────────────────┼─────────────────────────────────┐
│       ▼            Browser (User editing Page 5)                                  ▼                                 │
│  ┌──────────────────────────────────────────┐                      ┌──────────────────────────────────────┐         │
│  │  CodeMirror Editor Pane                  │                      │  Preview Pane                        │         │
│  │                                          │                      │                                      │         │
│  │                                          │                      │  Compile status from control plane   │         │
│  │  Sync command:                           │                      │                                      │         │
│  │  • WS `fullState` resets local state     │                      │  SVG handling:                       │         │
│  │                                          │                      │  • WASM decodes binary full state    │         │
│  │                                          │                      │    or incremental diffs              │         │
│  │  Diagnostics:                            │                      │  • Render is always full             │         │
│  │  • WS `diagnostics` + docVersion         │                      │    (no svg patches)                  │         │
│  │  • Mapped via snapshots + ChangeSet      │                      │                                      │         │
│  │  • Logged into Console Pane              │                      │                                      │         │
│  │                                          │                      │  Cursor handling:                    │         │
│  │  Semantic tokens:                        │                      │  • Parse path                        │         │
│  │  • WS `semanticTokens*` + docVersion     │                      │  • Find node and calculate size      │         │
│  │  • Mapped via snapshots + ChangeSet      │                      │  • Insert spotlight circle           │         │
│  │                                          │                      │                                      │         │
│  │                                          │                      │  Outline handling: none              │         │
│  │                                          │                      │                                      │         │
│  └────────┬─────────────────────────────────┘                      └──────────────────────────────────────┘         │
│           │                                                                                                         │
└───────────┼─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│          BookStack Backend (PHP/Laravel)                        │
│  ┌──────────────────────────────────────────────────┐           │
│  │         TinymistController (PHP)                 │           │
│  │  • Fallback recompile                            │           │
│  │  • CLI compilation (save/publish only)           │           │
│  │  • Database persistence                          │           │
│  │  • Search text extraction                        │           │
│  └──────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Database (MySQL/PostgreSQL)                │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐          │
│  │ pages.content│  │  pages.html  │  │ pages.markdown│          │
│  │ (typst src)  │  │ (final SVG)  │  │ (for search)  │          │
│  └──────────────┘  └──────────────┘  └───────────────┘          │
└─────────────────────────────────────────────────────────────────┘

## Preview Data Flow

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
│     • Update TOC        │ │        `diff-v1`     │
└─────────────────────────┘ └──────────┬───────────┘
                                       │
                                       ▼
                            ┌──────────────────────┐
                            │ 7. Preview updates   │
                            │    (50-200ms latency)│
                            └──────────────────────┘

## In-memory-file preview

It allows to post changes directly to the control plane of the preview
But consumes memory and creates traffic with the whole file going back and forth
on each click. This is more suitable for desktop applications.

**Note, "partial rendering" refers to:**

- ✅ **Compilation efficiency** - Tinymist recompiles only changed parts
- ✅ **Transfer efficiency** - Browser receives only SVG diffs
- ❌ **NOT input efficiency** - You still send full document

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
       │ `{"UpdateMemoryFiles": {...}}`
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
       │   `{"event":"compileStatus",`
       │    `"kind":"CompileSuccess"}`
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

---

## Save/Publish Flow

┌─────────────────────────┐
│ 1. User clicks "Save"   │
│    or "Publish" button  │
|    `.submit()`           |
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ 2. PageRepo.php         |
| updateTemplateStatusAndContentFromInput|
|    PageContent.php      │
│    `setNewTinymist()`   │
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

**Note, PHP HTML5 parser doesn't properly handle SVG namespaces, formatHtml()** will strip svg tags before saving, bypass it
**Note, using DOMDocument->loadHTML()** will strip svg tags (`xlink:href` and the <defs> section)
bypass render() method since it's using loadHTML()

---

### BookStack Search Integration

BookStack's existing search automatically indexes the `pages.markdown` and `pages.text` columns.

### Automatic Cleanup (Idle Timeout)

Scheduled task runs every 10 minutes:
   ↓
TinymistPreviewManager::cleanupIdleServers()
   ↓
For each running preview server:

    - Check last activity timestamp
    - If idle > 30 minutes: Stop process
    ↓
Free up resources for active users
