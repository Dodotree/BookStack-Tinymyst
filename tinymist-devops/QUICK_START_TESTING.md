# Quick Start Guide - Tinymyst Editor Testing

Clone the repository

### **Step 1: Create Environment Configuration File**

Create a `.env` file in your BookStack root directory with this configuration:

```bash
cp .env.example .env
```

Then edit the `.env` file with these key settings:

```properties
# Application key - will be generated in next steps
APP_KEY=

# Development mode
APP_ENV=local
APP_DEBUG=true

# Local server URL (we'll use PHP's built-in server)
APP_URL=http://localhost:8000

# MariaDB Database Configuration
DB_HOST=localhost
DB_PORT=3306
DB_DATABASE=bookstack_dev
DB_USERNAME=root
DB_PASSWORD=your_mariadb_password_here

# Disable email requirements (logs emails to storage/logs instead)
MAIL_DRIVER=log
MAIL_FROM_NAME="BookStack Dev"
MAIL_FROM=dev@bookstack.local

# Easy local registration without email verification
ALLOW_PUBLIC_REGISTRATION=true
```

### **Step 2: Set Up MariaDB Database**

Create a new database named `bookstack_dev`:

```sql
CREATE DATABASE bookstack_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### **Step 3: Install PHP Dependencies**

Run Composer to install Laravel and all backend dependencies:

```bash
cd c:\Users\Ooo\Desktop\GitWork\BookStack
composer install --no-dev
```

For development with debugging tools, use:

```bash
composer install
```

### **Step 4: Generate Application Key**

Laravel requires an encryption key. Generate it with:

```bash
php artisan key:generate
```

This will automatically update your `.env` file with a secure `APP_KEY`.

### **Step 5: Run Database Migrations**

Set up the database schema:

```bash
php artisan migrate
```

If you want some dummy content for testing:

```bash
php artisan db:seed --class=DummyContentSeeder
```

### **Step 6: Install Node.js Dependencies**

Install frontend build tools:

```bash
npm install
```

### **Step 7: Build Frontend Assets**

For development with auto-rebuild on changes:

```bash
npm run dev
```

Or for a one-time build:

```bash
npm run build
```

The `npm run dev` command will:

- Build JavaScript and CSS
- Watch for file changes
- Run LiveReload for automatic browser refresh

## 🚀 Quick Test

### 1. Start BookStack Server

```bash
php artisan serve
# Server running at: http://localhost:8000
```

Alternatively, you can specify a different port:

```bash
php artisan serve --port=8080
```

### **Helpful Artisan Commands:**

```bash
# Clear all caches during development
php artisan cache:clear
php artisan config:clear
php artisan view:clear
php artisan route:clear

# Create a new migration if you need database changes
php artisan make:migration add_latex_support_to_pages

# Run tests to ensure your changes don't break anything
php artisan test
```

## 🔧 Troubleshooting Tips

**If you get PHP extension errors:**

- BookStack requires: curl, dom, fileinfo, gd, json, mbstring, xml, zip
- Check with: `php -m`
- Enable in `php.ini` if missing

**If npm build fails:**

- Clear node_modules: `rm -rf node_modules && npm install`
- Clear npm cache: `npm cache clean --force`

**If database connection fails:**

- Verify MariaDB is running: `mysql -u root -p` (should connect)
- Check `.env` has correct credentials
- Ensure database exists in Beaver

**Authentication issues:**

- Default credentials: admin@admin.com password
- Email logs go to `storage/logs/laravel.log`

### 2. Create a Test Page

1. Navigate to: <http://localhost:8000>
2. Login to BookStack
3. Click "Create New Page"
4. You should see the **Tinymyst editor** with:
   - Left pane: Code editor
   - Right pane: Live SVG preview

### 3. Try Sample Typst Code

Copy and paste this into the editor:

```typst
= Welcome to Typst in BookStack

This is a demonstration of the *Tinymyst editor*.

== Features

- Live preview with SVG rendering
- Mathematical formulas: $x^2 + y^2 = z^2$
- Code highlighting
- Professional typography

== Mathematics

The quadratic formula:

$ x = (-b plus.minus sqrt(b^2 - 4a c)) / (2a) $

== Lists

1. First item
2. Second item
   - Nested bullet
   - Another bullet

== Conclusion

Enjoy writing beautiful documents with Typst!
```

### 4. Watch the Magic ✨

- Type in the left pane
- After 0.8 seconds, the right pane will show the compiled SVG
- Try the toolbar buttons:
  - **=** Insert heading
  - **B** Make text bold
  - **_I_** Make text italic
  - **$x$** Insert math formula

### 5. Save the Page

1. Enter a page name: "Test Typst Page"
2. Click **Save Page**
3. The page will save with:
   - Typst source in database
   - Compiled SVG for display
   - Searchable text extracted

### 6. View the Saved Page

1. Navigate to the saved page
2. You should see the beautifully rendered SVG output
3. No frontend compilation needed - SVG is stored!

---

## 🧪 Verify Installation

```bash
# Check Typst CLI
./vendor/bin/typst.exe --version
# Expected: typst 0.12.0 (737895d7)

# Check Tinymyst
./vendor/bin/tinymyst.exe --version
# Expected: tinymyst v0.13.28 (Build Timestamp: 2025-09-28...)

# Test compilation directly
echo "= Test" > test.typ
./vendor/bin/typst.exe compile test.typ test.svg --format svg
cat test.svg  # Should show SVG XML
rm test.typ test.svg
```

---

## 🐛 Troubleshooting

### Issue: "Typst not found" error

**Solution:**

```bash
npm install  # Re-run postinstall script
chmod +x vendor/bin/typst.exe
chmod +x vendor/bin/tinymist.exe
```

### Issue: Preview not updating

**Check:**

1. Browser console for JavaScript errors
2. Network tab for AJAX calls to `/ajax/tinymyst/compile`
3. Laravel logs: `storage/logs/laravel.log`

**Debug:**

```bash
# Test API endpoint directly
curl -X POST http://localhost:8000/ajax/tinymyst/compile \
  -H "Content-Type: application/json" \
  -H "Cookie: YOUR_SESSION_COOKIE" \
  -d '{"source": "= Test"}'
```

### Issue: Compilation errors

**Common Causes:**

1. Invalid Typst syntax - check error messages
2. Timeout (>30s) - reduce document size
3. Document too large (>1024 KB) - split into multiple pages

---

## 📁 Key Files Reference

### Backend

- **Service**: `app/Entities/Tools/Tinymyst/TinymystService.php`
- **Controller**: `app/Entities/Controllers/TinymystController.php`
- **Content**: `app/Entities/Tools/PageContent.php` (see `setNewTinymyst()`)
- **Routes**: `routes/web.php` (lines 174-176)

### Frontend

- **Component**: `resources/js/components/tinymyst-editor.ts`
- **View**: `resources/views/pages/parts/tinymyst-editor.blade.php`
- **Integration**: `resources/js/components/page-editor.js` (line 245)

### Configuration

- **Config**: `config/tinymyst.php`
- **Binaries**: `vendor/bin/typst.exe`, `vendor/bin/tinymist.exe`

---

## 🎯 Success Criteria

✅ **Basic Functionality**

- [x] Editor loads without errors ✅ FIXED
- [x] Typing triggers preview update (after 0.8s) ✅ WORKING
- [x] Valid Typst code compiles to SVG ✅ WORKING
- [x] SVG output at readable size ✅ FIXED
- [x] Theme-aware styling (light/dark mode) ✅ FIXED
- [x] Panels fill entire height ✅ FIXED
- [ ] Invalid syntax shows error messages
- [ ] Page saves successfully
- [ ] Saved page displays SVG correctly

✅ **Advanced Functionality**

- [ ] Toolbar buttons insert markup
- [ ] Draft auto-save works (wait 30s)
- [ ] Search finds text in Tinymyst pages
- [ ] Responsive layout works on mobile
- [ ] Multiple pages can coexist (WYSIWYG, Markdown, Tinymyst)

---

## 📊 Performance Benchmarks

**Expected Compilation Times:**

- Small doc (<100 lines): ~100-300ms
- Medium doc (100-500 lines): ~300-800ms
- Large doc (>500 lines): ~800ms-2s

**Debounce Delay:** 800ms (prevents excessive compilations)

---

## 📚 Documentation

- **Integration Plan**: `TINYMYST_INTEGRATION_PLAN.md`
- **Typst Documentation**: <https://typst.app/docs/>
- **Tinymyst Repository**: <https://github.com/Myriad-Dreamin/tinymist>
