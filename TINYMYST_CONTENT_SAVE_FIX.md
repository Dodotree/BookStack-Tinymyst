# 1. Added Form Submit Handler (tinymyst-editor.ts)

```typescript
setupFormSubmitHandler() {
    // Find the form containing this editor
    const form = this.elem.closest('form');
    if (!form) return;

    // Before form submit, sync CodeMirror content to textarea
    form.addEventListener('submit', () => {
        this.syncContentToTextarea();
    });
}

syncContentToTextarea() {
    if (this.editorView) {
        const content = this.editorView.state.doc.toString();
        this.editor.value = content;
        this.currentSource = content;
    }
}
```

**What it does:**

- Finds the parent form element
- Adds a submit event listener
- Before submission, copies CodeMirror content to the hidden textarea
- Updates currentSource to keep state consistent

## 2. Updated getContent() Method (tinymyst-editor.ts)

```typescript
async getContent() {
    // Sync CodeMirror content to textarea before returning
    this.syncContentToTextarea();

    return {
        tinymyst: this.editorView
            ? this.editorView.state.doc.toString()
            : this.editor.value
    };
}
```

**What it does:**

- Called by page-editor.js when saving drafts
- Ensures textarea is synced before returning content
- Returns the current CodeMirror content (or textarea fallback)
- Returns object with `tinymyst` key (matching the textarea name)

### 3. Added Tinymyst Change Event Listener (page-editor.js)

```javascript
window.$events.listen('editor-html-change', onContentChange);
window.$events.listen('editor-markdown-change', onContentChange);
window.$events.listen('editor-tinymyst-change', onContentChange);  // NEW
```

**What it does:**

- Enables autosave functionality for tinymyst editor
- Sets `autoSave.pendingChange = true` when content changes
- Triggers draft saves every 30 seconds if content changed

## How Data Flows Now

### Draft Save (Auto-save every 30s)

1. User types in CodeMirror editor
2. `onInput()` fires → emits `'editor-tinymyst-change'` event
3. Page editor's `onContentChange()` sets `pendingChange = true`
4. Auto-save timer triggers `saveDraft()`
5. Calls `getContent()` → syncs to textarea → returns `{tinymyst: content}`
6. POSTs to `/ajax/page/{id}/save-draft` with tinymyst field
7. PageRepo's `updatePageDraft()` stores in revision's markdown field

### Full Page Save (User clicks Save)

1. User clicks Save button
2. Page editor calls `savePage()` → triggers form submit
3. Form submit event fires → `syncContentToTextarea()` runs
4. CodeMirror content copied to `<textarea name="tinymyst">`
5. Form submits with correct tinymyst value and editor type
6. PageRepo's `updateTemplateStatusAndContentFromInput()` processes:
   - Checks `!empty($input['tinymyst'])`
   - Sets editor to `PageEditorType::Tinymyst`
   - Calls `$pageContent->setNewTinymyst($input['tinymyst'], user())`
7. Content saved to database with correct editor type

## Backend Flow (Already Working)

The backend was already set up correctly in PageRepo.php:

```php
elseif (!empty($input['tinymyst']) && is_string($input['tinymyst'])) {
    $newEditor = PageEditorType::Tinymyst;
    $pageContent->setNewTinymyst($input['tinymyst'], user());
}
```

The issue was frontend-only: the `$input['tinymyst']` field was empty because CodeMirror content wasn't synced to the textarea.

## Files Modified

1. **resources/js/components/tinymyst-editor.ts**
   - Added `setupFormSubmitHandler()` method
   - Added `syncContentToTextarea()` method
   - Updated `getContent()` to call sync before returning
   - Modified `setup()` to call `setupFormSubmitHandler()`

2. **resources/js/components/page-editor.js**
   - Added `editor-tinymyst-change` event listener to enable autosave

## Testing Checklist

- [x] Create new tinymyst page
- [ ] Type content in CodeMirror editor
- [ ] Wait 30 seconds → verify autosave notification appears
- [ ] Click Save button
- [ ] Verify content is saved to database
- [ ] Verify editor type is "tinymyst" (not "markdown")
- [ ] Reload page → verify content loads correctly
- [ ] Edit existing content → save → verify updates work
- [ ] Check page revisions show tinymyst content

## Related Files (Backend - Already Working)

- `app/Entities/Repos/PageRepo.php` - Handles save logic
- `app/Entities/Tools/PageContent.php` - Has `setNewTinymyst()` method
- `app/Entities/Tools/PageEditorType.php` - Enum with Tinymyst case
- `resources/views/pages/parts/form.blade.php` - Form with hidden editor input
- `resources/views/pages/parts/tinymyst-editor.blade.php` - Textarea with name="tinymyst"
