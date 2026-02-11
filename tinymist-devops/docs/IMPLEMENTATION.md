# Tinymist Editor Integration

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

---

## 🏗️ Architecture without sockets

### Design Decisions

1. **Compilation Strategy**: Full document recompilation (simple, reliable)
2. **Preview Method**: HTTP polling via AJAX
3. **Database**:
   - `pages.markdown` → Typst source code
   - `pages.html` → Compiled SVG output
   - `pages.text` → Searchable plain text
   - `pages.editor` → `'tinymist'`

4. **Technology Stack**:
   - Backend: PHP Laravel (TinymistService wraps Typst CLI)
   - Frontend: TypeScript Component + Blade view
   - Compilation: Typst CLI via PHP `exec()`

---

## 🔄 Workflow

### Creating a New Tinymist Page

1. User navigates to "Create Page"
2. System creates page with default editor (or user selects Tinymist)
3. Tinymist editor loads with:
   - Left pane: Typst source textarea
   - Right pane: Live SVG preview

### Editing Fallback Flow

1. User types Typst code in CodeMirror area
2. After 800ms delay (debounce), frontend calls `/ajax/tinymist/compile`
3. Backend:
   - Creates temp file with Typst source
   - Runs: `typst compile input.typ output.svg --format svg`
   - Returns SVG or errors
4. Frontend displays:
   - Success: Rendered SVG in preview pane
   - Error: Error messages in error container

### Saving Flow

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

### Path

```php
# Path Configuration:
# Add to your `.env` file:
TYPST_CLI_PATH="${APP_DIR}/vendor/bin/typst.exe"

# or In PHP code
$typstPath = PHP_OS_FAMILY === 'Windows'
    ? base_path('vendor/bin/typst.exe')
    : base_path('vendor/bin/typst');
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


5. **✅ Testing**
   - Write unit tests
   - Manual testing with various documents
   - Performance testing with large documents


### Potential Optimizations

1. **Caching**: Cache compiled SVG with content hash
2. **Incremental Compilation**: Use Tinymist LSP for partial recompilation
3. **Web Workers**: Move compilation to background thread (if switching to WASM)

---

## ✅ Implementation Status

| Component | Status | Files |
|-----------|--------|-------|
| **Installation Scripts** | ✅ Complete | `download-typst.js`, `download-tinymist.js` |
| **Configuration** | ✅ Complete | `app/Config/tinymist.php` |
| **Backend Enum** | ✅ Complete | `PageEditorType.php` |
| **Backend Service** | ✅ Complete | `TinymistService.php` |
| **Backend Content** | ✅ Complete | `PageContent.php`, `PageRepo.php` |
| **Backend Controller** | ✅ Complete | `TinymistController.php` |
| **Backend Routes** | ✅ Complete | `routes/web.php` |
| **Frontend Component** | ✅ Complete | `tinymist-editor.ts` |
| **Frontend View** | ✅ Complete | `tinymist-editor.blade.php` |
| **Frontend Integration** | ✅ Complete | `index.ts`, `page-editor.js`, `form.blade.php` |
