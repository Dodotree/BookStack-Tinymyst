import {Component} from './component';
import {EditorView} from '@codemirror/view';

export class TinymystEditor extends Component {
    elem!: HTMLElement;
    editor!: HTMLTextAreaElement;
    editorView!: EditorView | null;
    preview!: HTMLElement;
    console!: HTMLElement;
    currentSource: any;
    compileTimer!: null;
    compileDelay!: number;

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
        window.$events.emit('editor-tinymyst-change', '');
    }

    async compile() {
        // Get source from CodeMirror if available, otherwise from textarea
        const source = this.editorView
            ? this.editorView.state.doc.toString()
            : this.editor.value;
        this.currentSource = source;

        // Show loading state
        this.preview.classList.add('loading');
        this.logInfo('Compiling...');

        try {
            const response = await window.$http.post('/ajax/tinymyst/compile', {
                source: source
            });

            if (response.data.success) {
                this.showSvg(response.data.svg);
                this.logSuccess(`Compiled successfully (${source.length} chars)`);
            } else {
                this.logErrors(response.data.errors);
            }
        } catch (error) {
            console.error('Tinymyst compilation failed:', error);
            this.logError('Compilation failed. Check console for details.');
        } finally {
            this.preview.classList.remove('loading');
        }
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
        this.preview.innerHTML = '<div class="text-muted p-m">Fix errors to see preview</div>';
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
            tinymyst: this.editorView
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
