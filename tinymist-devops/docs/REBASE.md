# List of expected merges

## PHP

- `app/Config/app.php`
add Tinymist provider, 1 line: BookStack\App\Providers\TinymistServiceProvider::class,

- `app/Entities/Controllers/PageController.php`

```php
    $page->html = $pageContent->renderForView(); (instead of render())
    $this->pageRepo->updatePageDraft($page, $request->only(['name', 'html', 'markdown', 'tinymist']));
```

- `app/Entities/Repos/PageRepo.php`
a lot to be merged, but very little of it is related to Tinymist

- `app/Entities/Tools/PageContent.php`
a lot to be merged

- `app/Entities/Tools/PageEditorData.php`
a lot to be merged

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
// a lot

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

- `resources/js/components/ajax-delete-row.ts` needed for attachment delete success
- `resources/js/components/page-editor.js` for listening for autosave

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

- `resources/js/services/events.ts` for capping their trace, shouldn't be there anyway
- `resources/js/services/http.ts`
patch for 419 PageExpired response and CSRF reloading flag  is used as a one-shot guard
to prevent repeated reload scheduling from multiple failing requests.

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

### Probably safe to ignore

- `resources/views/entities/breadcrumbs.blade.php` // nothing? Like different method of writing 'continue'
- `tests/Uploads/ImageTest.php` // eh, could be because of the CI complains

## No DB migrations needed

Tinymist changes so far are in controllers/services/routes/views/theme/lang/JS/CSS,
not DB schema.
Page entity has tinymist editor type added: `case Tinymist = 'tinymist';` and SVG of the document is saved in the HTML column for ready preview.
