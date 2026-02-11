# CodeMirror

## Editor View updates

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

## LSP plugin

Since Tinymist LSP sends deltas to be applied to previous tokens, the plugin has no use for us.
Also they seems to be in different formats. Forgot what exactly went wrong, but plugin only
adds another layer of complexity instead of streamlining the process.
