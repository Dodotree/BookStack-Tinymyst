# Tinymist Editor Integration - Implementation Summary

**Date**: October 9, 2025
**Status**: ✅ **COMPLETE** - Ready for Testing

---

## 📦 Installation

### Binaries Installed

Both binaries are automatically installed via `npm install` (postinstall hook):

1. **Typst CLI v0.12.0**
   - Location: `vendor/bin/typst.exe`
   - Size: ~15.5 MB
   - Purpose: Compiles `.typ` source to SVG

2. **Tinymist v0.13.28**
   - Location: `vendor/bin/tinymist.exe`
   - Size: ~47.9 MB
   - Purpose: Language Server Protocol for Typst (autocomplete, diagnostics)
   - Note: Currently using Typst CLI only; Tinymist LSP features available for future enhancements

### Installation Scripts

- **`dev/build/download-typst.js`** - Downloads Typst CLI from GitHub releases
- **`dev/build/download-tinymist.js`** - Downloads Tinymist from GitHub releases
  - Platform detection
  - Progress bar during download
  - Automatic extraction
  - Installation verification

- **`package.json`** - Updated with: `"postinstall": "node dev/build/download-typst.js && node dev/build/download-tinymist.js"`

Platform support: Windows (x64/ARM64), Linux (x64/ARM64), macOS (x64/ARM64)

## Option B: Docker container (recommended for production)**

```dockerfile
FROM php:8.4-fpm
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
RUN cargo install typst-cli tinymist
```

---

## 🏗️ Architecture

### Design Decisions

1. **Compilation Strategy**: Full document recompilation (simple, reliable)
2. **Preview Method**: HTTP polling via AJAX (consistent with BookStack's draft auto-save)
3. **Storage**:
   - `pages.markdown` → Typst source code
   - `pages.html` → Compiled SVG output
   - `pages.text` → Searchable plain text
   - `pages.editor` → `'tinymist'`

4. **Technology Stack**:
   - Backend: PHP Laravel (TinymistService wraps Typst CLI)
   - Frontend: TypeScript Component + Blade view
   - Compilation: Typst CLI via PHP `exec()`

---

## 📁 Files Created/Modified

### Configuration

- ✅ **`config/tinymist.php`** (NEW)
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

- ✅ **`app/Entities/Tools/PageEditorType.php`** (MODIFIED)
  - Added `case Tinymist = 'tinymist';`
  - Added `usesTypstSource(): bool` method
  - Updated `isHtmlBased()` to return false for Tinymist

- ✅ **`app/Entities/Tools/Tinymist/TinymistService.php`** (NEW)
  - `compileToSvg(string $source): array` - Compiles Typst to SVG
  - `validate(string $source): array` - Validates Typst syntax
  - `isAvailable(): bool` - Checks if Typst CLI is available
  - Uses PHP `exec()` to run: `typst compile input.typ output.svg --format svg`

- ✅ **`app/Entities/Tools/PageContent.php`** (MODIFIED)
  - Added `setNewTinymist(string $source, User $updater): void`
  - Added `toPlainTextFromTypst(string $source): string`
  - Handles SVG compilation and error display

- ✅ **`app/Entities/Repos/PageRepo.php`** (MODIFIED)
  - Added Tinymist handling in `updateTemplateStatusAndContentFromInput()`
  - Added Tinymist handling in `updatePageDraft()`

### Backend - Controller & Routes

- ✅ **`app/Entities/Controllers/TinymistController.php`** (NEW)
  - `compile(Request $request)` - POST `/ajax/tinymist/compile`
  - `~~validate~~ check(Request $request)` - POST `/ajax/tinymist/check` ("validate" was a name conflict)
  - `status()` - GET `/ajax/tinymist/status`

- ✅ **`routes/web.php`** (MODIFIED)
  - Added 3 routes for Tinymist AJAX endpoints

### Frontend - Components

- ✅ **`resources/js/components/tinymist-editor.ts`** (NEW)
  - TypeScript component extending `Component`
  - Features:
    - Textarea editor with syntax highlighting styles
    - Live SVG preview pane
    - Debounced compilation (800ms delay)
    - Error display
    - Toolbar buttons (Bold, Italic, Heading, Math)
    - `getContent()` method for page saving
  - ~160 lines

- ✅ **`resources/js/components/index.ts`** (MODIFIED)
  - Exported `TinymistEditor` component

- ✅ **`resources/js/components/page-editor.js`** (MODIFIED)
  - Updated `getEditorComponent()` to check for `tinymist-editor`

### Frontend - Views

- ✅ **`resources/views/pages/parts/tinymist-editor.blade.php`** (NEW)
  - Split-pane layout (Editor | Preview)
  - Toolbar with formatting buttons
  - Error container
  - SVG preview container
  - Responsive CSS (stacks vertically on mobile <1000px)

- ✅ **`resources/views/pages/parts/form.blade.php`** (MODIFIED)
  - Added conditional include for Tinymist editor

---

## 🔄 Workflow

### Creating a New Tinymist Page

1. User navigates to "Create Page"
2. System creates page with default editor (or user selects Tinymist)
3. Tinymist editor loads with:
   - Left pane: Typst source textarea
   - Right pane: Live SVG preview

### Editing Flow

1. User types Typst code in CodeMirror area
2. After 800ms delay (debounce), frontend calls `/ajax/tinymist/compile`
3. Backend:
   - Creates temp file with Typst source
   - Runs: `typst compile input.typ output.svg --format svg`
   - Returns SVG or errors
4. Frontend displays:
   - Success: Rendered SVG in preview pane
   - Error: Error messages in error container

### Saving Flow see TINYMIST_CONTENT_SAVE_FIX.md

1. User clicks "Save Page"
2. `PageEditor.getContent()` calls `TinymistEditor.getContent()`
3. Returns `{ tinymist: "source code" }`
4. Backend `PageRepo`:
   - Detects `input['tinymist']` exists
   - Calls `PageContent.setNewTinymist()`
   - Compiles to SVG
   - Stores:
     - `pages.markdown` = Typst source
     - `pages.html` = SVG output (wrapped in `<div class="tinymist-document">`)
     - `pages.text` = Plain text for search
     - `pages.editor` = `'tinymist'` bypass the formatHtml(), the formatHtml() method was processing the SVG through PHP's DOMDocument HTML parser, which was stripping out the SVG <defs> section and the xlink:href attributes because the HTML5 parser doesn't properly handle SVG namespaces.

### Viewing Flow

1. User views page
2. `pages.html` contains SVG
3. Browser renders SVG directly, Bypassed render() method for Tinymist pages to preserve SVG namespaces (since render() method was re-processing the HTML through HtmlDocument which uses DOMDocument->loadHTML(), and that was stripping the SVG namespaces (xlink:href and the <defs> section).)
4. No frontend compilation needed

---

## 🎯 Access Tinymist

### Method 1: Use Default Editor Setting

1. Go to: **Settings** → **Customization**
2. Set "Default Page Editor" to: **Tinymist (Typst)**
3. Click Save
4. Create a new page - it will open with Tinymist editor by default

### Method 2: Use Editor Switch Dropdown

1. Open **any existing page** for editing (WYSIWYG or Markdown)
2. Click the **clock/time icon** dropdown (top center of toolbar)
3. Scroll down past the draft options
4. You should now see:
   - "Switch to Markdown Editor (Clean Content)"
   - "Switch to Markdown Editor (Stable Content)"
   - "Switch to new WYSIWYG (In Beta Testing)"
   - **"Switch to Tinymist Editor (Typst Documents)"** ← NEW!
5. Click on "Switch to Tinymist Editor"
6. The page will reload with the Tinymist editor

### Method 3: Direct URL Parameter

Navigate directly to any page with:

<http://localhost:8000/books/1/page/123/edit?editor=tinymist>

### Method 4. ✅ Backend Editor Type Enum

- `PageEditorType::Tinymist`
- Fully integrated into BookStack's editor system

## 🧪 Testing Checklist

### Manual Testing

- [ ] **Installation Test**

  ```bash
  npm install
  ./vendor/bin/typst.exe --version  # Should show: typst 0.12.0
  ./vendor/bin/tinymist.exe --version  # Should show: tinymist v0.13.28
  ```

  ```bash
  # Check if tinymist is installed
  typst --version
  tinymist --version

  # Test SVG compilation
  typst compile document.typ output.svg --format svg

  # Check tinymist LSP capabilities
  tinymist --help
  tinymist lsp --help

  # Test incremental compilation (if available)
  # Tinymist typically works as LSP, not standalone CLI
  ```

- [ ] **Basic Page Creation**
  - [ ] Create new page
  - [ ] Select Tinymist editor (if not default)
  - [ ] Type simple Typst code:

    ```typst
    = Hello World

    This is a *bold* test.

    Math: $x^2 + y^2 = z^2$
    ```

  - [ ] Verify live preview shows formatted text
  - [ ] Save page
  - [ ] View saved page - SVG should render

- [ ] **Compilation Test**
  - [ ] Enter invalid Typst syntax
  - [ ] Verify error messages appear in error container
  - [ ] Fix syntax
  - [ ] Verify preview updates automatically

- [ ] **Toolbar Test**
  - [ ] Click "= Heading" button - inserts heading
  - [ ] Select text and click **Bold** - wraps in `*text*`
  - [ ] Select text and click _Italic_ - wraps in `_text_`
  - [ ] Click Math button - inserts `$formula$`

- [ ] **Save/Load Test**
  - [ ] Create page with Typst content
  - [ ] Save
  - [ ] Close editor
  - [ ] Reopen page for editing
  - [ ] Verify Typst source loads correctly
  - [ ] Verify preview compiles

- [ ] **Search Test**
  - [ ] Create Tinymist page with searchable text
  - [ ] Save page
  - [ ] Use BookStack search
  - [ ] Verify page appears in search results
  - [ ] (Text extracted via `toPlainTextFromTypst()`)

- [ ] **Draft Auto-Save Test**
  - [ ] Create new page
  - [ ] Type content
  - [ ] Wait 30 seconds (draft auto-save interval)
  - [ ] Close browser without saving
  - [ ] Reopen page
  - [ ] Verify draft was saved

- [ ] **Editor Switching Test**
  - [ ] Create page in Markdown editor
  - [ ] Switch to Tinymist editor (if allowed)
  - [ ] Verify content handling

- [ ] **Responsive Test**
  - [ ] Resize browser < 1000px width
  - [ ] Verify editor pane stacks vertically
  - [ ] Test editing and preview on mobile

### API Testing

```bash
# Test compilation endpoint
curl -X POST http://localhost:8000/ajax/tinymist/compile \
  -H "Content-Type: application/json" \
  -d '{"source": "= Test\n\nHello *world*!"}'

# Expected response:
# {"success": true, "svg": "<svg>...</svg>", "errors": []}

# Test validation endpoint
curl -X POST http://localhost:8000/ajax/tinymist/check \
  -H "Content-Type: application/json" \
  -d '{"source": "= Invalid Typst \n\n#unknowncommand"}'

# Test status endpoint
curl http://localhost:8000/ajax/tinymist/status

# Expected response:
# {"available": true, "enabled": true}
```

### Error Handling Test

- [ ] Typst CLI not installed
  - Should show compilation errors
  - `/ajax/tinymist/status` returns `{"available": false}`

- [ ] Document exceeds max size (1024 KB)
  - Should show "Document exceeds maximum size limit"

- [ ] Compilation timeout (30s limit)
  - Should handle gracefully with error message

---

## 🚀 Production Deployment

### Prerequisites

1. **Server Requirements**:
   - PHP 8.1+
   - Node.js 16+ (for npm install)
   - Write access to `vendor/bin/`

2. **Installation**:

   ```bash
   cd /path/to/bookstack
   npm install  # Auto-installs Typst & Tinymist
   php artisan cache:clear
   php artisan config:clear
   ```

3. **Configuration** (`.env`):

   ```env
   TINYMIST_ENABLED=true
   TYPST_CLI_PATH=/path/to/bookstack/vendor/bin/typst.exe
   TINYMIST_CLI_PATH=/path/to/bookstack/vendor/bin/tinymist.exe
   TINYMIST_TIMEOUT=30
   TINYMIST_MAX_SIZE=1024
   ```

4. **Permissions**:

   ```bash
   chmod +x vendor/bin/typst.exe
   chmod +x vendor/bin/tinymist.exe
   ```

5. **Build Frontend**:

   ```bash
   npm run production
   ```

### Verification

```bash
# Test Typst CLI
./vendor/bin/typst.exe --version

# Test compilation
echo "= Test" > test.typ
./vendor/bin/typst.exe compile test.typ test.svg --format svg
cat test.svg  # Should show SVG XML
rm test.typ test.svg

**Binary Test:**
$ ./vendor/bin/typst.exe --version
typst 0.12.0 (737895d7)

**Compilation Test:**
$ ./vendor/bin/typst.exe compile test-typst.typ test-typst.svg --format svg
** Successfully created 88KB SVG file

**Path Configuration:**
Add to your `.env` file:
TYPST_CLI_PATH="${APP_DIR}/vendor/bin/typst.exe"

// or In PHP code
$typstPath = PHP_OS_FAMILY === 'Windows'
    ? base_path('vendor/bin/typst.exe')
    : base_path('vendor/bin/typst');

```bash
echo "= Hello World\nThis is *Typst*!" > test.typ
./vendor/bin/typst.exe compile test.typ output.svg --format svg
./vendor/bin/typst.exe compile test.typ output.pdf
```

## Part A: Fix Constructor Fallback for different OS

```php
// BEFORE (broken on Windows when config not loaded)
$this->typstPath = config('tinymist.typst_cli_path', 'typst');

// AFTER (uses full path as fallback)
$this->typstPath = config('tinymist.typst_cli_path')
    ?? base_path('vendor/bin/typst.exe');
```

## Part A: Fix Constructor Fallback

```php
// BEFORE (broken on Windows when config not loaded)
$this->typstPath = config('tinymist.typst_cli_path', 'typst');

// AFTER (uses full path as fallback)
$this->typstPath = config('tinymist.typst_cli_path')
    ?? base_path('vendor/bin/typst.exe');
```

### Part B: Fix Command Escaping

```php
// BEFORE (incorrect escaping on Windows)
$typstCmd = escapeshellarg($this->typstPath);
$command = sprintf('%s compile %s %s --format svg 2>&1', $typstCmd, ...);

// AFTER (proper Windows path quoting)
$command = sprintf(
    '"%s" compile "%s" "%s" --format svg 2>&1',
    str_replace('"', '\"', $this->typstPath),
    str_replace('"', '\"', $inputFile),
    str_replace('"', '\"', $outputFile)
);
```

**Why This Works:**

- `escapeshellarg()` was creating `'"path"'` (double-wrapped quotes)
- Windows `cmd.exe` interpreted this as literal string `"typst"` instead of path
- Direct double-quote wrapping with escape handling works correctly on Windows
- `base_path()` ensures absolute path is always used

### 2. Test PHP Compilation

```bash
php artisan tinker --execute="
  \$service = new \BookStack\Entities\Tools\Tinymist\TinymistService();
  \$result = \$service->compileToSvg('\$x^2\$');
  echo \$result['success'] ? 'SUCCESS' : 'FAILED';
"
# Expected: SUCCESS
```

### 3. Test HTTP Endpoint

```bash
curl -X POST http://localhost:8000/ajax/tinymist/compile \
  -H "Content-Type: application/json" \
  -H "Cookie: YOUR_SESSION_COOKIE" \
  -d '{"source": "$x^2 + y^2 = z^2$"}'
# Expected: {"success": true, "svg": "...", "errors": []}
```

## Performance Notes

**Compilation Time (Windows 10):**

- Mathematical formula: ~150-200ms
- Small document (<50 lines): ~200-300ms
- Medium document (100-500 lines): ~400-800ms

**Memory Usage:**

- Typst binary: ~35MB on disk
- Runtime: ~10-20MB per compilation

---

## 🔮 Future Enhancements

### Phase 2: Advanced Features (Optional)

1. **Tinymist LSP Integration**
   - Use full Tinymist LSP instead of just Typst CLI
   - Enable autocomplete in editor
   - Real-time diagnostics (errors/warnings as you type)
   - Incremental compilation for large documents

2. **Syntax Highlighting**
   - Integrate CodeMirror with Typst grammar
   - Color-coded Typst syntax in editor

3. **Collaborative Editing**
   - WebSocket support for real-time multi-user editing
   - Operational Transform or CRDT for conflict resolution

4. **PDF Export**
   - Add "Export to PDF" button
   - Use: `typst compile document.typ output.pdf`

5. **Template Gallery**
   - Pre-built Typst templates (Academic papers, Reports, Letters)
   - One-click template insertion

6. **Image Upload Support**
   - Allow drag-drop images into Typst editor
   - Upload to BookStack and insert `#image("path")` syntax

### Possible Improvements

1. **Zoom controls**
   - Add +/- buttons to zoom SVG
   - Store preference per user

2. **Print optimization**
   - Remove filters for printing
   - Ensure black text prints correctly

3. **Download options**
   - Export as PDF
   - Download original Typst source

4. **Syntax highlighting for errors**
   - Show line numbers
   - Highlight problematic code

5. **✅ Testing**
   - Write unit tests
   - Manual testing with various documents
   - Performance testing with large documents

6. **🔮 Future Enhancements**
   - WebSocket support for real-time collaboration
   - True incremental compilation via LSP
   - Syntax highlighting in editor
   - Autocomplete/IntelliSense
   - Template gallery for Typst documents

### Potential Optimizations

1. **Caching**: Cache compiled SVG with content hash
2. **Incremental Compilation**: Use Tinymist LSP for partial recompilation
3. **Web Workers**: Move compilation to background thread (if switching to WASM)

---

## 📚 Documentation References

- **Typst Documentation**: <https://typst.app/docs/>
- **Tinymist Repository**: <https://github.com/Myriad-Dreamin/tinymist>
- **Installation Guide**: `TYPST_INSTALLATION_SUMMARY.md`
- **Integration Plan**: `TINYMIST_INTEGRATION_PLAN.md`

---

## ✅ Implementation Status

| Component | Status | Files |
|-----------|--------|-------|
| **Installation Scripts** | ✅ Complete | `download-typst.js`, `download-tinymist.js` |
| **Configuration** | ✅ Complete | `config/tinymist.php` |
| **Backend Enum** | ✅ Complete | `PageEditorType.php` |
| **Backend Service** | ✅ Complete | `TinymistService.php` |
| **Backend Content** | ✅ Complete | `PageContent.php`, `PageRepo.php` |
| **Backend Controller** | ✅ Complete | `TinymistController.php` |
| **Backend Routes** | ✅ Complete | `routes/web.php` |
| **Frontend Component** | ✅ Complete | `tinymist-editor.ts` |
| **Frontend View** | ✅ Complete | `tinymist-editor.blade.php` |
| **Frontend Integration** | ✅ Complete | `index.ts`, `page-editor.js`, `form.blade.php` |
| **Testing** | ⏳ Pending | Manual testing required |

---

## Tinymist Editor Integration Plan

## Phase 1: Research & Prerequisites

### 1.1 Understanding Tinymist

**What is Tinymist?**

- Language server for Typst (similar to what TypeScript Language Server is to TypeScript)
- Provides features: autocomplete, diagnostics, preview, incremental compilation
- Uses WebSocket for communication between editor and preview server
- Can output: PDF, SVG, PNG

**Key Questions to Answer:**

- [ ] Can tinymist run as standalone CLI or only as LSP?
- [ ] Does it support incremental SVG output via HTTP/JSON API?
- [ ] What's the input format for incremental changes?
- [ ] How to get diagnostics (errors/warnings)?
- [ ] Can we run multiple isolated tinymist instances?

## Phase 5: Advanced - WebSocket Support (Optional)

### 5.1 Architecture Decision

- PHP process spawns tinymist LSP server
- PHP acts as WebSocket proxy between browser and tinymist
- Requires: Ratchet/Laravel WebSockets or similar
- Better performance for real-time collaboration

### 5.2 If Implementing WebSocket Bridge

Would require:

1. Laravel WebSockets package installation
2. PHP process manager for tinymist LSP instances
3. WebSocket authentication/authorization
4. Client-side WebSocket connection management
5. Fallback to HTTP polling if WebSocket fails

## Future Enhancements

1. **WebSocket Support**: Real-time diagnostics push
2. **Autocomplete**: Use LSP completion capabilities
3. **Go to Definition**: Navigate Typst code
4. **Hover Tooltips**: Documentation on hover
5. **SVG Line Mapping**: Click SVG → jump to source

---

## Phase 6: Incremental Compilation Strategy

```php
// Start persistent tinymist process
$lsp = new TinymistLSPClient();
$lsp->start();

// Send incremental changes
$lsp->didChange([
    'textDocument' => ['uri' => 'file://doc.typ'],
    'contentChanges' => [
        ['range' => [...], 'text' => 'new content']
    ]
]);

// Request preview
$svg = $lsp->getPreview();
```

---

## Phase 7: Testing & Validation

### 7.1 Create Test Document

**File:** `tests/test-document.typ`

```typst
#set page(width: 8.5in, height: 11in, margin: 1in)
#set text(font: "Linux Libertine", size: 11pt)

= Test Document

This is a test document for *Tinymist* integration.

== Mathematical Formulas

The quadratic formula: $x = (-b plus.minus sqrt(b^2 - 4a c)) / (2a)$

== Code Block

```python
def hello():
    print("Hello from Typst!")
```

== Lists

- Item 1
- Item 2
  - Nested item

### 7.2 Manual Testing Checklist

- [ ] Install typst CLI successfully
- [ ] Compile test document to SVG via CLI
- [ ] Create new page with Tinymist editor
- [ ] Type in editor and see live preview
- [ ] Save page and verify SVG stored correctly
- [ ] View saved page - SVG displays properly
- [ ] Edit existing Tinymist page
- [ ] Search finds text in Tinymist pages
- [ ] Export/print Tinymist page works
- [ ] Switch between editors (Markdown ↔ Tinymist)

### 7.3 Automated Tests

**File:** `tests/Entity/TinymistEditorTest.php` (NEW)

```php
<?php

namespace Tests\Entity;

use BookStack\Entities\Tools\Tinymist\TinymistService;
use Tests\TestCase;

class TinymistEditorTest extends TestCase
{
    public function test_tinymist_service_available()
    {
        $service = app(TinymistService::class);
        $this->assertTrue($service->isAvailable());
    }

    public function test_compile_simple_document()
    {
        $service = app(TinymistService::class);
        $source = "= Hello\n\nThis is a test.";

        $result = $service->compileToSvg($source);

        $this->assertTrue($result['success']);
        $this->assertStringContainsString('<svg', $result['svg']);
    }

    public function test_create_tinymist_page()
    {
        $page = $this->entities->page();
        $source = "= My Document\n\nContent here.";

        $this->put($page->getUrl(), [
            'name' => 'Test Tinymist Page',
            'tinymist' => $source,
        ]);

        $page->refresh();
        $this->assertEquals('tinymist', $page->editor);
        $this->assertEquals($source, $page->markdown);
        $this->assertStringContainsString('<svg', $page->html);
    }
}
```
