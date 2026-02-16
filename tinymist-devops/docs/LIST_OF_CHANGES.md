# List of changes in the Bookstack files

Attempt to keep track of what was changed in the original repository and why it was required.

## Added Tinymist Change Event Listener (page-editor.js)

```javascript
window.$events.listen('editor-html-change', onContentChange);
window.$events.listen('editor-markdown-change', onContentChange);
window.$events.listen('editor-tinymist-change', onContentChange);  // NEW
```

**What it does:**

- Enables autosave functionality for tinymist editor
- Sets `autoSave.pendingChange = true` when content changes
- Triggers draft saves every 30 seconds if content changed

### How Data Flows Now

### Draft Save (Auto-save every 30s)

1. User types in CodeMirror editor
2. `onInput()` fires → emits `'editor-tinymist-change'` event
3. Page editor's `onContentChange()` sets `pendingChange = true`
4. Auto-save timer triggers `saveDraft()`
5. Calls `getContent()` → syncs to textarea → returns `{tinymist: content}`
6. POSTs to `/ajax/page/{id}/save-draft` with tinymist field
7. PageRepo's `updatePageDraft()` stores in revision's markdown field

### Full Page Save (User clicks Save)

1. User clicks Save button
2. Page editor calls `savePage()` → triggers form submit
3. Form submit event fires → `syncContentToTextarea()` runs
4. CodeMirror content copied to `<textarea name="tinymist">`
5. Form submits with correct tinymist value and editor type
6. PageRepo's `updateTemplateStatusAndContentFromInput()` processes:
   - Checks `!empty($input['tinymist'])`
   - Sets editor to `PageEditorType::Tinymist`
   - Calls `$pageContent->setNewTinymist($input['tinymist'], user())`
7. Content saved to database with correct editor type

## Backend

The backend in PageRepo.php:

```php
elseif (!empty($input['tinymist']) && is_string($input['tinymist'])) {
    $newEditor = PageEditorType::Tinymist;
    $pageContent->setNewTinymist($input['tinymist'], user());
}
```

Make sure that  `$input['tinymist']` textarea field was synced with CodeMirror content.

### Testing Checklist

- [x] Create new tinymist page
- [ ] Type content in CodeMirror editor
- [ ] Wait 30 seconds → verify autosave notification appears
- [ ] Click Save button
- [ ] Verify content is saved to database
- [ ] Verify editor type is "tinymist" (not "markdown")
- [ ] Reload page → verify content loads correctly
- [ ] Edit existing content → save → verify updates work
- [ ] Check page revisions show tinymist content

## Related Files

- `page-editor.js`
- `app/Entities/Repos/PageRepo.php` - Handles save logic
- `app/Entities/Tools/PageContent.php` - Has `setNewTinymist()` method
- `app/Entities/Tools/PageEditorType.php` - Enum with Tinymist case
- `resources/views/pages/parts/form.blade.php` - Form with hidden editor input
- `resources/views/pages/parts/tinymist-editor.blade.php` - Textarea with name="tinymist"


## 📁 Files Created/Modified

### Configuration

- ✅ **`app/Config/tinymist.php`** (NEW)
  - `TYPST_CLI_PATH` - Path to typst binary
  - `TINYMIST_CLI_PATH` - Path to tinymist binary
  - `TINYMIST_ENABLED` - Enable/disable flag
  - `TINYMIST_TIMEOUT` - Compilation timeout (30s)
  - `TINYMIST_MAX_SIZE` - Max document size (1024 KB)

### Or update .env.example

```env
# Tinymist Editor Settings
TINYMIST_ENABLED=false
TYPST_CLI_PATH=typst
TINYMIST_CLI_PATH=tinymist
TINYMIST_TIMEOUT=30
TINYMIST_MAX_SIZE=1024
```

### Backend - Core

- `app/Entities/Tools/PageEditorType.php` (MODIFIED)
  - Added `case Tinymist = 'tinymist';`
  - Added `usesTypstSource(): bool` method
  - Updated `isHtmlBased()` to return false for Tinymist

- `app/Entities/Tools/PageContent.php` (MODIFIED)
  - Added `setNewTinymist(string $source, User $updater): void`
  - Added `toPlainTextFromTypst(string $source): string`
  - Handles SVG compilation and error display

- `app/Entities/Repos/PageRepo.php` (MODIFIED)
  - Added Tinymist handling in `updateTemplateStatusAndContentFromInput()`
  - Added Tinymist handling in `updatePageDraft()`

- `app/Entities/Tools/Tinymist/TinymistService.php` (NEW)
  - `compileToSvg(string $source): array` - Compiles Typst to SVG
  - `validate(string $source): array` - Validates Typst syntax
  - `isTypstAvailable(): bool` - Checks if Typst CLI is available
  - Uses PHP `exec()` to run: `typst compile input.typ output.svg --format svg`

### Backend - Controller & Routes

- `app/Entities/Controllers/TinymistController.php` (NEW)
  - `compile(Request $request)` - POST `/ajax/tinymist/compile`
  - `~~validate~~ check(Request $request)` - POST `/ajax/tinymist/check` ("validate" was a name conflict)
  - `status()` - GET `/ajax/tinymist/status`

- `routes/web.php` (MODIFIED)
  - Added 3 routes for Tinymist AJAX endpoints

### Frontend - Components

- `resources/js/components/tinymist-editor.ts` (NEW)
  - TypeScript component extending `Component`
  - Features:
    - Textarea editor with syntax highlighting styles
    - Live SVG preview pane
    - Debounced compilation (800ms delay)
    - Error display
    - Toolbar buttons (Bold, Italic, Heading, Math)
    - `getContent()` method for page saving
  - ~160 lines

- `resources/js/components/index.ts` (MODIFIED)
  - Exported `TinymistEditor` component

- `resources/js/components/page-editor.js` (MODIFIED)
  - Updated `getEditorComponent()` to check for `tinymist-editor`

- `resources/js/services/component.js` (MODIFIED)
  - Protection from double initiation of components (that led to double events including toggle)

### Frontend - Views

- `resources/views/pages/parts/tinymist-editor.blade.php` (NEW)
  - Split-pane layout (Editor | Preview)
  - Toolbar with formatting buttons
  - Error container
  - SVG preview container
  - Responsive CSS (stacks vertically on mobile <1000px)

- `resources/views/pages/parts/form.blade.php` (MODIFIED)
  - Added conditional include for Tinymist editor
