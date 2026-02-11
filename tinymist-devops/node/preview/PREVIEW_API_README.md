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
