# Integration with the base BookStack, merge or rebase document

List of expected merges. Collection of integration hooks and small patches for Bookstack core files.

## PHP

- `app/Config/app.php`
add Tinymist provider, 1 line:

```php
    BookStack\App\Providers\TinymistServiceProvider::class,
```

- `app/Entities/Controllers/PageController.php`

```php
    $page->html = $pageContent->renderForView(); // instead of render()

    $this->pageRepo->updatePageDraft($page, $request->only(['name', 'html', 'markdown', 'tinymist']));
```

- `app/Entities/Repos/PageRepo.php`
a lot to be merged, but very little of it is related to Tinymist
all we need is to reference tinymist bridge in few places

```php
use BookStack\Extensions\Tinymist\Pages\TinymistPageRepoBridge;


class PageRepo
{
    protected TinymistPageRepoBridge $tinymistPageRepoBridge;

    public function __construct(
    ...
    ) {
        $this->tinymistPageRepoBridge = app()->make(TinymistPageRepoBridge::class);
    }

165,166d167
<         } elseif ($this->tinymistPageRepoBridge->applyTinymistContent($pageContent, $input)) {
<             $newEditor = PageEditorType::Tinymist;

200,202c201
<         if ($this->tinymistPageRepoBridge->applyTinymistDraft($draft, $input)) {
<             // handled by Tinymist bridge
<         } elseif (!empty($input['markdown'])) {
---
>         if (!empty($input['markdown'])) {
205c204
<         } elseif (isset($input['html'])) {
---
>         } else {

```

- `app/Entities/Tools/PageContent.php`
a lot to be merged

```php

use BookStack\Extensions\Tinymist\Pages\TinymistPageContentHandler;

28d28
     protected TinymistPageContentHandler $tinymistPageContentHandler;
34d33
            $this->tinymistPageContentHandler = app()->make(TinymistPageContentHandler::class);
        }

    /**
     * Save the content of the page with new provided Tinymist (Typst) source.
     */
    public function setNewTinymist(string $source, User $updater): void
    {
        $this->tinymistPageContentHandler->apply($this->page, $source);
    }
```

- `app/Entities/Tools/PageEditorData.php`

```php
    use BookStack\Extensions\Tinymist\Pages\TinymistPageEditorBridge;
    ...
        $this->updateContentForEditor($page, $editorType);

        // Start Tinymist preview server if this is a Tinymist page
        $tinymistPreview = null;
        if ($editorType === PageEditorType::Tinymist && config('tinymist.enabled', false)) {
            // Get ws_token and report status, mutates $page->markdown with content used for preview.
            $tinymistPreview = $this->tinymistPageEditorBridge->startPreview($page);
        }
```

- `app/Entities/Tools/PageEditorType.php`
small inserts to recognize Tinymist editor type

```log
<     case Tinymist = 'tinymist';
18c17
>             self::Markdown => false,
<             self::Markdown, self::Tinymist => false,
20,24d18
<     }
<
<     public function usesTypstSource(): bool
<     {
<         return $this === self::Tinymist;
```

- `app/Theming/ThemeController.php`

```php
      * @var array<string, string>
      */
     protected array $assetMimeByExtension = [
         'js' => 'text/javascript',
         'mjs' => 'text/javascript',
         'css' => 'text/css',
         'map' => 'application/json',
         'json' => 'application/json',
         'svg' => 'image/svg+xml',
     ];

         $extension = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
         $mime = $this->assetMimeByExtension[$extension] ?? null;
         if ($mime) {
             $response->headers->set('Content-Type', $mime);
             $response->headers->set('Content-Disposition', 'inline; filename="' . basename($filePath) . '"');
         }
```

- `app/Uploads/AttachmentService.php`

A lot, it's because changes should be reflected both in Bookstack and in preview folder (when preview is active)

```php
use BookStack\Entities\Models\Page;
use BookStack\Extensions\Tinymist\Attachments\TinymistAttachmentSyncService;

15>         protected TinymistAttachmentSyncService $tinymistAttachmentSyncService,
    ) {

59>         $this->tinymistAttachmentSyncService->syncAttachmentIfNeeded($attachment, $pageId); //
        return $attachment;
    }

71>    {
            $oldFileName = $attachment->external ? null : $attachment->getFileName(); //
        if (!$attachment->external) {
            $this->tinymistAttachmentSyncService->removeAttachmentIfNeeded($attachment, $oldFileName); //

86>        $attachment->save();
        $this->tinymistAttachmentSyncService->syncAttachmentIfNeeded($attachment);

155>    $oldFileName = $attachment->external ? null : $attachment->getFileName(); // in updateFile
        $oldExternal = $attachment->external;

164>            if (!$attachment->external) {
                $this->tinymistAttachmentSyncService->removeAttachmentIfNeeded($attachment, $oldFileName);

175>         if (!$attachment->external && !$oldExternal) {
            $newFileName = $attachment->getFileName();
            if ($oldFileName && $oldFileName !== $newFileName) {
                $this->tinymistAttachmentSyncService->removeAttachmentIfNeeded($attachment, $oldFileName);
                $this->tinymistAttachmentSyncService->syncAttachmentIfNeeded($attachment);
            }
        }

```

- `app/Util/CspService.php`
bookstack updated so watch out for their changes too

```php
'\'wasm-unsafe-eval\''  // Required for WebAssembly (Tinymist WASM modules)
```

- `app/Util/WebSafeMimeSniffer.php`

```php
// Instead of:
         if ($mime === 'text/plain' && $extension) {
             $mime = $this->textTypesByExtension[$extension] ?? 'text/plain';
// Allow to load WASM into extension:
         if ($extension) {
             $extension = strtolower($extension);
         }

         if (($mime === 'text/plain' || $mime === 'application/octet-stream') && $extension) {
             $mime = $this->textTypesByExtension[$extension] ?? $mime;
```

## JS/TS

- `resources/js/components/ajax-delete-row.ts` needed for files dropdown, attachment delete success

```ts
            this.$emit('success', {
                id: this.row.dataset.id,
            });
            this.row.remove();
```

- `resources/js/components/page-editor.js` for autosave support

```ts
73>         window.$events.listen('editor-tinymist-change', onContentChange);

    /**
     * @return {TinymistEditor|MarkdownEditor|WysiwygEditor|WysiwygEditorTinymce}
     */
    getEditorComponent() {
        return window.$components.first('tinymist-editor')
            || window.$components.first('markdown-editor')
            || window.$components.first('wysiwyg-editor')
            || window.$components.first('wysiwyg-editor-tinymce');e
    }
```

- `resources/js/services/components.ts`
probably related to attachment node initiation, small patch:

```ts
// instead of:
const componentElems = parentElement.querySelectorAll('[component],[components]');
// patch:
         const componentElems = [...parentElement.querySelectorAll('[component],[components]')];
         if (parentElement instanceof HTMLElement && parentElement.matches('[component],[components]')) {
             componentElems.push(parentElement);
         }
```

- `resources/js/services/components/index.ts`
Register not editor scripts so they would be bundled with the main package, not with WASM

```ts
export {TinymistPackageAdmin} from '../../../themes/tinymist/resources/js/components/tinymist-package-admin';
export {TinymistPackageManager} from '../../../themes/tinymist/resources/js/components/tinymist-package-manager';
```

- `resources/js/services/events.ts` for capping their trace, shouldn't be there anyway

- `resources/js/services/http.ts`
patch for 419 PageExpired response and CSRF reloading flag  is used as a one-shot guard
to prevent repeated reload scheduling from multiple failing requests.

```ts
const CSRF_RELOAD_FLAG = '__bookstackCsrfReloadPending';

18>
declare global {
    interface Window {
        __bookstackCsrfReloadPending?: boolean;
    }
}

114>
        if (response.status === 419) {
            this.scheduleCsrfReload();
        }

    protected scheduleCsrfReload(): void {
        if (window[CSRF_RELOAD_FLAG]) {
            return;
        }

        window[CSRF_RELOAD_FLAG] = true;
        console.warn('[HTTP] CSRF token mismatch detected (419). Reloading to refresh session...');
        setTimeout(() => window.location.reload(), 250);
    }
```

## Configs

.gitignore
.prettierrc.json
tsconfig.json
tsconfig.server.json
eslint.config.mjs
jest.config.ts
package.json

## CI related changes since it's a fork

readme.md

### Temporary

- `tests/Uploads/ImageTest.php`
    eh, commented out 2 functions because of the git CI

```php
    public function test_image_display_thumbnail_generation_for_animated_avif_images_uses_original_file()
    public function test_gif_thumbnail_generation()
```

## No DB migrations needed

Tinymist changes so far are in controllers/services/routes/views/theme/lang/JS/CSS,
not DB schema.
Page entity has tinymist editor type added: `case Tinymist = 'tinymist';` and SVG of the document is saved in the HTML column for ready preview.

## Files and folders

Full copy

```sh
./app/App/Providers/TinymistServiceProvider.php
./app/Config/tinymist.php
./app/Entities/Controllers/TinymistController.php
./app/Entities/Tools/Tinymist/TinymistPreviewManager.php
./app/Entities/Tools/Tinymist/TinymistService.php
./routes/tinymist.php

./app/Extensions/Tinymist/
./themes/tinymist/
./tinymist-devops/
```
