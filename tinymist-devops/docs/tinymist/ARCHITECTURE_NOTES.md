# Tinymist Architecture & Workflow

## Objective

Making Typst markup easily available for engineers, scientists, students, and such without the need to program or manage packages. Expected features:
    - customizable highlighting of the Typst markup itself for easier editing
    - live preview with zoom-in/zoom-out and full rendering support
    - ability to use #import #include #image to link additional files
    - show the Typst editor cursor in the rendered preview
    - save/download both Typst text and preview as SVG/PDF/images
    - print PDFs
    - save/load templates or examples of use
    - light and dark themes and font selection
    - save user preferences

## Main Tools for components and their responsibilities

- Typst CLI compiler for one-off renders of the whole file or selected pages from it.
- Tinymist wrapper around the Typst compiler initially created for VS Code and other IDEs. Tinymist preview for real-time rendering in the preview panel. Tinymist LSP for editor diagnostics, semantic tokens, tips, autocomplete, and more.
- CodeMirror as a rich text editor that can also be used on the backend for real-time syncing with the copy of the edited file. The live copy of the edited file is needed for Tinymist.
- @myriaddreamin/typst-ts-renderer WASM Tinymist renderer to convert the Tinymist custom vector format into a live SVG preview. This is very important to have the right release for it to be able to decode backend Tinymist renders:
    0.6.x release that matches tinymist 0.13.x.
    0.7.x release that matches tinymist 0.14.x. (current)
- Node.js for creating clients for Tinymist processes and bridges to connect Tinymist with the browser through WebSockets. Also, a Node.js WebSocket connects the browser and backend CodeMirror for real-time sync of the editor's content in the browser with the backend temporary copy of the file. (The reason for Node.js being a tool of choice was the ease of use and CodeMirror module availability. I couldn't find PHP tools that can support custom protocol WebSockets, meaning there are required fields in their protocols and Tinymist will drop any message that contains fields it does not recognize.)
- BookStack Laravel for user authentication, file organization, saving to the database, and search. Also for some scheduled tasks and logging.

## System Diagram (Per-Page Architecture)

```log
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
```

## Preview Data Flow

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
```

## In-memory file preview

It allows posting changes directly to the control plane of the preview,
but consumes memory and creates traffic with the whole file going back and forth
on each change. This is more suitable for desktop applications.

**Note, "partial rendering" refers to:**

- ✅ **Compilation efficiency** - Tinymist recompiles only changed parts
- ✅ **Transfer efficiency** - Browser receives only SVG diffs
- ❌ **NOT input efficiency** - You still send the full document

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
```

---

## Save/Publish Flow

```log
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
```

## Page View Flow

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

**Note: the PHP HTML5 parser doesn't properly handle SVG namespaces; formatHtml()** will strip SVG tags before saving, so bypass it.
**Note: using DOMDocument->loadHTML()** will strip SVG tags (`xlink:href` and the <defs> section).
Bypass the render() method since it uses loadHTML().

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
