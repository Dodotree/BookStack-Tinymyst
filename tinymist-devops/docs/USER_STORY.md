# How to use tinymist editor in Bookstack

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

## Check lists

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

---

## Useful improvements

1. **Tinymist LSP Integration**
   [x] Use full Tinymist LSP instead of just Typst CLI
   [ ] Enable autocomplete in editor
   [x] Real-time diagnostics (errors/warnings as you type)
   [x] Incremental compilation for large documents

2. **Syntax Highlighting**
   [x] Integrate CodeMirror with Typst grammar
   [x] Color-coded Typst syntax in editor

3. **Collaborative Editing**
   [ ] WebSocket support for real-time multi-user editing
   [ ] Operational Transform or CRDT for conflict resolution

4. **PDF Export and Typst source export**
   [ ] Add "Export to PDF" button
   [ ] Use: `typst compile document.typ output.pdf`

5. **Template Gallery**
   [ ] Pre-built Typst templates (Academic papers, Reports, Letters)
   [ ] One-click template insertion

6. **Image Upload Support**
   [ ] Allow drag-drop images into Typst editor
   [ ] Upload to BookStack and insert `#image("path")` syntax

7. **Zoom controls**
   [x] Add +/- buttons to zoom SVG
   [ ] Store preference per user

8. **Print optimization**
   [ ] Remove filters for printing
   [ ] Ensure black text prints correctly
