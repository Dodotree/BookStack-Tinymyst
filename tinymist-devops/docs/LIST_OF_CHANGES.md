# List of changes in BookStack files (Tinymist)

This file tracks Tinymist-related changes and their current file locations.

## Current key behavior

### Autosave change events

In `resources/js/components/page-editor.js`:

```javascript
window.$events.listen('editor-html-change', onContentChange);
window.$events.listen('editor-markdown-change', onContentChange);
window.$events.listen('editor-tinymist-change', onContentChange);
```

This marks pending autosave changes for Tinymist pages the same as other editors.

### Page save flow (current)

In `app/Entities/Repos/PageRepo.php` Tinymist input is handled via bridge:

```php
} elseif ($this->tinymistPageRepoBridge->applyTinymistContent($pageContent, $input)) {
    $newEditor = PageEditorType::Tinymist;
}
```

Draft updates are also handled via bridge (`applyTinymistDraft(...)`).

## Related files (current paths)

### Core backend

- `app/Entities/Repos/PageRepo.php` (Tinymist save/draft bridge calls)
- `app/Entities/Tools/PageContent.php` (`setNewTinymist(...)`)
- `app/Entities/Tools/PageEditorType.php` (Tinymist enum case)
- `app/Entities/Tools/Tinymist/TinymistService.php`
- `app/Entities/Tools/Tinymist/TinymistPreviewManager.php`
- `app/Entities/Controllers/TinymistController.php`
- `app/App/Providers/TinymistServiceProvider.php` (loads `routes/tinymist.php`)

### Extension-scoped backend

- `app/Extensions/Tinymist/Pages/TinymistPageRepoBridge.php`
- `app/Extensions/Tinymist/Pages/TinymistPageEditorBridge.php`
- `app/Extensions/Tinymist/Pages/TinymistPageContentHandler.php`
- `app/Extensions/Tinymist/Attachments/TinymistAttachmentController.php`
- `app/Extensions/Tinymist/Attachments/TinymistAttachmentSyncService.php`
- `app/Extensions/Tinymist/Attachments/TinymistAttachmentEditorContentService.php`
- `app/Extensions/Tinymist/Imports/TinymistImportBridge.php`
- `app/Extensions/Tinymist/Imports/TinymistImportController.php`
- `app/Extensions/Tinymist/Imports/SinglePageImportService.php`

### Routes

- `routes/tinymist.php`
  - `/ajax/tinymist/compile`
  - `/ajax/tinymist/check`
  - `/ajax/tinymist/status`
  - `/ajax/tinymist/renew-ws-token`
  - Tinymist attachment integration routes
  - `/import/single` (Tinymist single-page import)

### Frontend + theme

- `themes/tinymist/resources/js/components/tinymist-editor.ts`
- `themes/tinymist/resources/js/components/tinymist-attachments-bridge.ts`
- `themes/tinymist/resources/js/tinymist-bookstack.ts`
- `resources/js/components/page-editor.js` (autosave event listeners)
- `resources/js/services/components.ts` (component init behavior; note filename is `components.ts`)

### Blade templates (theme overrides)

- `themes/tinymist/pages/parts/tinymist-editor.blade.php`
- `themes/tinymist/pages/parts/form.blade.php`
- `themes/tinymist/pages/parts/editor-toolbar.blade.php`
- `themes/tinymist/pages/parts/page-display.blade.php`
- `themes/tinymist/attachments/manager-list.blade.php`
- `themes/tinymist/exports/import.blade.php`
- `themes/tinymist/settings/categories/customization.blade.php`

### Styles and language

- `themes/tinymist/resources/sass/tinymist.scss`
- `themes/tinymist/resources/sass/_tinymist.scss`
- `themes/tinymist/lang/en/entities.php`

### Configuration

- `app/Config/tinymist.php`

Environment keys:

```env
TINYMIST_ENABLED=false
TYPST_CLI_PATH=typst  # path to binary
TINYMIST_CLI_PATH=tinymist # path to binary
TINYMIST_TIMEOUT=30 # compilation timeout
TINYMIST_MAX_SIZE=1024
```

## Notes on outdated paths (fixed in this doc)

- `resources/views/pages/parts/tinymist-editor.blade.php` → now `themes/tinymist/pages/parts/tinymist-editor.blade.php`
- `resources/views/pages/parts/form.blade.php` Tinymist changes are now theme override (`themes/tinymist/pages/parts/form.blade.php`)
- `resources/js/services/component.js` → actual file is `resources/js/services/components.ts`
- Tinymist AJAX/import routes are now defined in `routes/tinymist.php` (loaded by `TinymistServiceProvider`), not directly in `routes/web.php`

Check for more details about inserts into clean BookStack core in the REBASE.md
