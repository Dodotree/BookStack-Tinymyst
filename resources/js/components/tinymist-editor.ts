import {Component} from './component';
import {EditorView} from '@codemirror/view';
import {linter, Diagnostic, forceLinting, setDiagnostics} from '@codemirror/lint';

export class TinymistEditor extends Component {
    elem!: HTMLElement;
    editor!: HTMLTextAreaElement;
    editorView!: EditorView | null;
    preview!: HTMLElement;
    console!: HTMLElement;
    currentSource: any;
    compileTimer: ReturnType<typeof setTimeout> | null = null;
    compileDelay!: number;
    documentVersion: number = 0;
    previousContent: string = '';
    cachedDiagnostics: Diagnostic[] = []; // Store diagnostics from last compilation
    lastGoodSvg: string = ''; // Store last successful SVG to preserve on errors
    lastCompiledSource: string = ''; // Track source that diagnostics are for
    rawDiagnostics: any[] = []; // Store raw diagnostics (line/column/message) for recalculation
    diagnosticsSourceHash: string = ''; // Hash of source that diagnostics are for
    diagnosticsLogged: boolean = false; // Track if current diagnostics have been logged to console
    compilationSequence: number = 0; // Track compilation order to ignore stale responses
    lastProcessedSequence: number = 0; // Track last successfully processed compilation

    setup() {
        this.elem = this.$el;
        this.editor = this.$refs.editor as HTMLTextAreaElement;
        this.preview = this.$refs.preview;
        this.console = this.$refs.console;
        this.currentSource = this.editor.value;
        this.compileTimer = null;
        this.compileDelay = 800; // ms - debounce delay for compilation
        this.editorView = null;

        // Setup CodeMirror editor
        this.setupCodeMirror();

        // Setup event listeners
        this.setupListeners();

        // Setup form submit handler to sync CodeMirror content to textarea
        this.setupFormSubmitHandler();

        // Initial compilation
        this.compile();
    }

    async setupCodeMirror() {
        try {
            // Import CodeMirror modules
            const {EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine} = await import('@codemirror/view');
            const {EditorState} = await import('@codemirror/state');
            const {defaultKeymap} = await import('@codemirror/commands');

            // Create editor state
            const startState = EditorState.create({
                doc: this.editor.value,
                extensions: [
                    lineNumbers(), // Enable line numbers
                    highlightActiveLineGutter(), // Highlight current line number in gutter
                    highlightActiveLine(), // Highlight current line
                    keymap.of(defaultKeymap),
                    EditorView.editable.of(true), // Make editor editable
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) {
                            this.onInput();
                        }
                    }),
                ],
            });

            // Create editor view
            this.editorView = new EditorView({
                state: startState,
                parent: this.editor.parentElement!,
            });

            // Hide original textarea
            this.editor.style.display = 'none';

            // Store initial content
            this.previousContent = this.editor.value;

            this.logInfo('CodeMirror editor initialized');
        } catch (error) {
            console.error('Failed to initialize CodeMirror:', error);
            this.logError(`Failed to initialize CodeMirror editor: ${error}`);
            // Fall back to textarea if CodeMirror fails
            this.editor.style.display = 'block';
            this.editor.addEventListener('input', () => this.onInput());
        }
    }

    setupListeners() {
        // Only add textarea listener if CodeMirror failed to initialize
        if (!this.editorView) {
            this.editor.addEventListener('input', () => this.onInput());
        }

        // Button actions
        this.elem.addEventListener('click', event => {
            if (!event.target) return;
            const button = (event.target as Element).closest('button[data-action]');
            if (button === null) return;

            const action = button.getAttribute('data-action');
            if (action === 'insertBold') this.insertMarkup('*', '*');
            if (action === 'insertItalic') this.insertMarkup('_', '_');
            if (action === 'insertMath') this.insertMarkup('$', '$');
            if (action === 'insertHeading') this.insertHeading();
            if (action === 'clearConsole') this.clearConsole();
        });
    }

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

    onInput() {
        // Debounce compilation
        if (this.compileTimer) {
            clearTimeout(this.compileTimer);
        }

        this.compileTimer = setTimeout(() => {
            this.compile();
        }, this.compileDelay);

        // Notify page editor of changes
        window.$events.emit('editor-tinymist-change', '');
    }

    async compile() {
        // Get source from CodeMirror if available, otherwise from textarea
        const source = this.editorView
            ? this.editorView.state.doc.toString()
            : this.editor.value;
        this.currentSource = source;

        // Increment compilation sequence to track order
        this.compilationSequence++;
        const thisCompilationSequence = this.compilationSequence;
        console.log(`[Tinymist] Starting compilation #${thisCompilationSequence}`);

        // Show loading state
        this.preview.classList.add('loading');
        this.logInfo('Compiling...');

        try {
            let response;

            response = await window.$http.post('/ajax/tinymist/compile', {
                source: source
            });

            // Check if this response is stale (newer compilation already started OR finished)
            if (thisCompilationSequence <= this.lastProcessedSequence) {
                console.log(`[Tinymist] Ignoring stale compilation #${thisCompilationSequence} (last processed: #${this.lastProcessedSequence})`);
                return; // Ignore stale response
            }

            console.log(`[Tinymist] Compilation #${thisCompilationSequence} completed (processing...)`);

            // Mark this as the last processed compilation
            this.lastProcessedSequence = thisCompilationSequence;

            const respData = response && response.data;

            // Store the source that was compiled (for diagnostic position calculation)
            this.lastCompiledSource = source;

            // Guard the shape of respData before accessing properties to avoid errors
            if (respData && typeof respData === 'object' && 'success' in respData) {
                const data = respData as { success: boolean; svg?: string; errors?: string[]; diagnostics?: any[] };
                if (data.success) {
                    // Store and show SVG
                    this.lastGoodSvg = data.svg || '';
                    this.showSvg(this.lastGoodSvg);
                    this.logSuccess(`Compiled successfully (${source.length} chars)`);

                    // Update cached diagnostics and trigger linter update
                    if (data.diagnostics && data.diagnostics.length > 0) {
                        this.updateDiagnostics(data.diagnostics, source);
                    } else {
                        // Clear diagnostics on successful compilation with no errors
                        console.log('[Tinymist] Clearing diagnostics (success with no errors)');
                        this.rawDiagnostics = [];
                        this.cachedDiagnostics = [];
                        this.diagnosticsLogged = false;
                        this.triggerLinting();
                    }
                } else {
                    // Keep last good SVG visible

                    // Update diagnostics even on failure (for error highlighting)
                    if (data.diagnostics && Array.isArray(data.diagnostics) && data.diagnostics.length > 0) {
                        this.updateDiagnostics(data.diagnostics, source);
                    } else {
                        // No diagnostics parsed - log raw errors as fallback
                        this.logErrors(data.errors || []);
                        this.rawDiagnostics = [];
                        this.cachedDiagnostics = [];
                        this.diagnosticsLogged = false;
                        this.triggerLinting();
                    }
                }
            } else if (typeof respData === 'string') {
                // Server returned a plain string error/message
                this.logError(respData);
            } else {
                // Unexpected response shape
                console.error('Unexpected compile response:', response);
                this.logError('Compilation failed: unexpected server response.');
            }
        } catch (error) {
            console.error('Tinymist compilation failed:', error);
            this.logError('Compilation failed. Check console for details.');
        } finally {
            this.preview.classList.remove('loading');
        }
    }


    /**
     * Update diagnostics from compilation response
     * @param diagnostics Array of diagnostic objects
     * @param sourceText The exact source that was compiled (for correct position mapping)
     */
    updateDiagnostics(diagnostics: any[], sourceText?: string): void {
        if (!Array.isArray(diagnostics)) {
            this.rawDiagnostics = [];
            this.cachedDiagnostics = [];
            this.diagnosticsLogged = false;
            this.triggerLinting();
            return;
        }

        console.log('[Tinymist] Updating diagnostics:', diagnostics);

        // Store raw diagnostics (line/column) for position recalculation
        this.rawDiagnostics = diagnostics;

        // Calculate initial positions for immediate display
        const text = sourceText || this.getEditorContent();
        this.cachedDiagnostics = diagnostics.map((diag: any) => {
            const from = this.positionToOffsetInText(text, diag.line - 1, diag.column - 1);
            const to = this.positionToOffsetInText(text, diag.line - 1, Math.max(diag.column - 1, diag.column));

            return {
                from: from,
                to: Math.max(from + 1, to),
                severity: this.mapSeverity(diag.severity),
                message: diag.message,
            };
        });

        console.log('[Tinymist] Cached diagnostics:', this.cachedDiagnostics);

        diagnostics.forEach(diag => {
            if (diag.severity === 'error') {
                this.logError(`Line ${diag.line}, Col ${diag.column}: ${diag.message}`);
            } else if (diag.severity === 'warning') {
                this.logWarning(`Line ${diag.line}, Col ${diag.column}: ${diag.message}`);
            }
        });

        // Trigger linter update in CodeMirror
        this.triggerLinting();
    }

    /**
     * Map diagnostic severity to CodeMirror severity
     */
    mapSeverity(severity: string): 'error' | 'warning' | 'info' {
        switch (severity.toLowerCase()) {
            case 'error': return 'error';
            case 'warning': return 'warning';
            case 'information':
            case 'info':
            case 'hint':
                return 'info';
            default: return 'error';
        }
    }

    /**
     * Trigger linter update in CodeMirror
     */
    triggerLinting(): void {
        if (this.editorView) {
            this.editorView.dispatch(setDiagnostics(this.editorView.state, this.cachedDiagnostics));
        }
    }

    /**
     * Convert line/column to document offset
     */
    positionToOffset(line: number, column: number): number {
        if (!this.editorView) return 0;

        const doc = this.editorView.state.doc;
        if (line < 0 || line >= doc.lines) return 0;

        const lineObj = doc.line(line + 1); // CodeMirror lines are 1-indexed
        return lineObj.from + Math.min(column, lineObj.length);
    }

    /**
     * Convert line/column to offset in a given text string
     * Used for diagnostic position calculation with compiled source
     */
    positionToOffsetInText(text: string, line: number, column: number): number {
        const lines = text.split('\n');
        if (line < 0 || line >= lines.length) return 0;

        let offset = 0;
        for (let i = 0; i < line; i++) {
            offset += lines[i].length + 1; // +1 for newline
        }
        offset += Math.min(column, lines[line].length);
        return offset;
    }

    /**
     * Get current editor content
     */
    getEditorContent(): string {
        if (this.editorView) {
            return this.editorView.state.doc.toString();
        }
        return this.editor.value;
    }

    /**
     * Simple string hash function for content comparison
     */
    hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString();
    }

    showSvg(svg: string) {
        this.preview.innerHTML = svg;
    }

    logError(message: string) {
        this.logMessage(message, 'error');
    }

    logWarning(message: string) {
        this.logMessage(message, 'warning');
    }

    logInfo(message: string) {
        this.logMessage(message, 'info');
    }

    logSuccess(message: string) {
        this.logMessage(message, 'success');
    }

    logErrors(errors: string[]) {
        errors.forEach(err => this.logError(err));
        // Don't clear the SVG - keep last good preview visible
        // The errors are shown in the console which is visible below
    }

    logMessage(message: string, type: 'error' | 'warning' | 'info' | 'success') {
        const timestamp = new Date().toLocaleTimeString();
        const messageDiv = document.createElement('div');
        messageDiv.className = `console-message ${type}`;
        messageDiv.innerHTML = `<span class="text-muted">[${timestamp}]</span> ${this.escapeHtml(message)}`;

        this.console.appendChild(messageDiv);

        // Auto-scroll to bottom
        this.console.scrollTop = this.console.scrollHeight;
    }

    clearConsole() {
        this.console.innerHTML = '<div class="text-muted p-m text-small">Console cleared.</div>';
    }

    escapeHtml(text: string) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Insert markup around selected text or at cursor position.
     */
    insertMarkup(before: string, after: string) {
        if (this.editorView) {
            const state = this.editorView.state;
            const selection = state.selection.main;
            const selectedText = state.doc.sliceString(selection.from, selection.to);
            const replacement = before + selectedText + after;

            this.editorView.dispatch({
                changes: {from: selection.from, to: selection.to, insert: replacement},
                selection: {anchor: selection.from + before.length, head: selection.from + before.length + selectedText.length}
            });
            this.editorView.focus();
        } else {
            const start = this.editor.selectionStart;
            const end = this.editor.selectionEnd;
            const selectedText = this.editor.value.substring(start, end);
            const replacement = before + selectedText + after;

            this.editor.setRangeText(replacement, start, end, 'select');
            this.editor.focus();
            this.onInput();
        }
    }

    /**
     * Insert heading at cursor position.
     */
    insertHeading() {
        if (this.editorView) {
            const state = this.editorView.state;
            const selection = state.selection.main;
            const before = state.doc.sliceString(0, selection.from);
            const heading = (before.endsWith('\n') || before === '') ? '= Heading\n' : '\n= Heading\n';

            this.editorView.dispatch({
                changes: {from: selection.from, insert: heading},
                selection: {anchor: selection.from + heading.length - 1}
            });
            this.editorView.focus();
        } else {
            const start = this.editor.selectionStart;
            const before = this.editor.value.substring(0, start);
            const after = this.editor.value.substring(start);

            const heading = (before.endsWith('\n') || before === '') ? '= Heading\n' : '\n= Heading\n';
            this.editor.value = before + heading + after;
            this.editor.selectionStart = this.editor.selectionEnd = start + heading.length - 1;
            this.editor.focus();
            this.onInput();
        }
    }

    /**
     * Get content for saving (called by page-editor).
     */
    async getContent() {
        // Sync CodeMirror content to textarea before returning
        this.syncContentToTextarea();

        return {
            tinymist: this.editorView
                ? this.editorView.state.doc.toString()
                : this.editor.value
        };
    }

    /**
     * Set editor content.
     */
    setText(content: string) {
        if (this.editorView) {
            this.editorView.dispatch({
                changes: {from: 0, to: this.editorView.state.doc.length, insert: content}
            });
        } else {
            this.editor.value = content;
        }
        this.currentSource = content;
        this.compile();
    }

    /**
     * Get current text.
     */
    getText() {
        return this.editorView
            ? this.editorView.state.doc.toString()
            : this.editor.value;
    }

    /**
     * Focus editor.
     */
    focus() {
        if (this.editorView) {
            this.editorView.focus();
        } else {
            this.editor.focus();
        }
    }
}
