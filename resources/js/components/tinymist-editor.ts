import {Component} from './component';
import {EditorView} from '@codemirror/view';
import {StateEffect} from '@codemirror/state';
import {linter, Diagnostic, forceLinting, setDiagnostics} from '@codemirror/lint';
import { TinymistControl } from './tinymist-lsp-client';
import { TinymistPreviewRenderer } from './tinymist-preview-renderer-fixed';

type OutlineItem = any;

export class TinymistEditor extends Component {
    elem!: HTMLElement;
    editor!: HTMLTextAreaElement;
    editorView!: EditorView | null;
    preview!: HTMLElement;
    console!: HTMLElement;
    currentSource: any;
    compileTimer: ReturnType<typeof setTimeout> | null = null;
    compileDelay!: number;
    // documentVersion: number = 0;

    previousContent: string = '';
    lastCompiledSource: string = ''; // Track source that diagnostics are for
    lastGoodSvg: string = ''; // Store last successful SVG to preserve on errors
    cachedDiagnostics: Diagnostic[] = []; // Store diagnostics from last compilation
    rawDiagnostics: any[] = []; // Store raw diagnostics (line/column/message) for recalculation
    // diagnosticsSourceHash: string = ''; // Hash of source that diagnostics are for
    diagnosticsLogged: boolean = false; // Track if current diagnostics have been logged to console
    compilationSequence: number = 0; // Track compilation order to ignore stale responses
    lastProcessedSequence: number = 0; // Track last successfully processed compilation

    private controlClient: TinymistControl | null = null;
    private previewRenderer: TinymistPreviewRenderer | null = null;
    private previewServerInfo: {controlPort: number, dataPort: number, host: string} | null = null;

    private fileSyncSocket: WebSocket | null = null;
    private docVersion: number = 0;
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts: number = 0;

    async startPreviewServer() {
        // Check if preview was already started server-side
        if (this.$opts.previewStarted === 'true' && this.$opts.controlPort && this.$opts.dataPort) {
            this.previewServerInfo = {
                controlPort: parseInt(this.$opts.controlPort as string, 10),
                dataPort: parseInt(this.$opts.dataPort as string, 10),
                host: this.$opts.host as string || '127.0.0.1',
            };
            console.log('✓ Using pre-started preview server:', this.previewServerInfo);
            this.logSuccess(`Preview server already started on ports ${this.previewServerInfo.controlPort}/${this.previewServerInfo.dataPort}`);
            return;
        }

        // Otherwise start it via AJAX
        const pageId = this.$opts.pageId;
        if (!pageId) {
            throw new Error('Page ID not found');
        }

        const content = this.editor.value || '';

        try {
            const response = await window.$http.post('/ajax/tinymist/start-preview', {
                page_id: pageId,
                content: content,
            }) as any;

            console.log('Preview server response:', response);

            // BookStack's HTTP service wraps the response in a 'data' property
            const data = response.data || response;

            console.log('Response data:', data);
            console.log('Data.success:', data.success);
            console.log('Data.control_port:', data.control_port);
            console.log('Data.data_port:', data.data_port);

            // Check if we have the required fields
            if (data.control_port && data.data_port && data.host) {
                this.previewServerInfo = {
                    controlPort: data.control_port,
                    dataPort: data.data_port,
                    host: data.host,
                };
                console.log('✓ Preview server started:', this.previewServerInfo);
                this.logSuccess(`Preview server started on ports ${data.control_port}/${data.data_port}`);
            } else if (data.success === false) {
                throw new Error(data.error || 'Failed to start preview server');
            } else {
                throw new Error('Invalid response from server: missing port information');
            }
        } catch (error) {
            console.error('Failed to start preview server:', error);
            console.error('Error details:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logError('⚠ Failed to start preview server: ' + errorMessage);
            throw error;
        }
    }

    async setupControl() {
        try {
            const pageId = this.$opts.pageId;
            if (!pageId) {
                throw new Error('Page ID not found');
            }

            if (!this.previewServerInfo) {
                throw new Error('Preview server not started');
            }

            // Get initial content from textarea (before CodeMirror is created)
            const content = this.editor.value || '';

            // Initialize Control client with custom port and message handler
            this.controlClient = new TinymistControl(
                parseInt(pageId, 10),
                content,
                this.previewServerInfo.host,
                this.previewServerInfo.controlPort,
                this.handleControlMessage.bind(this) // Pass callback with bound context
            );
            console.log('Control client initiated');
            const controlExtension = await this.controlClient.connect();

            // Add Control extension to editor view (not textarea)
            if (this.editorView) {
                this.editorView.dispatch({
                    effects: StateEffect.appendConfig.of(controlExtension)
                });
            }

            console.log('✓ Control client connected');
        } catch (error) {
            console.error('Failed to setup Control:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logError('⚠ Control connection failed: ' + errorMessage);
        }
    }

    async setupPreview() {
        try {
            const previewElement = this.$refs.preview as HTMLElement;
            if (!previewElement) {
                console.warn('Preview element not found, skipping preview setup');
                return;
            }

            if (!this.previewServerInfo) {
                throw new Error('Preview server not started');
            }

            // Initialize preview renderer with custom port
            this.previewRenderer = new TinymistPreviewRenderer(
                previewElement,
                this.previewServerInfo.host,
                this.previewServerInfo.dataPort
            );
            await this.previewRenderer.initialize();

            console.log('✓ Preview renderer initialized');
        } catch (error) {
            console.error('Failed to setup preview:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logError('⚠ Preview initialization failed: ' + errorMessage);
        }
    }

    // Cleanup on destroy
    async destroy() {
        // Close WebSocket connection
        this.stopHeartbeat();
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        if (this.fileSyncSocket) {
            this.fileSyncSocket.close(1000, 'Editor closed');
            this.fileSyncSocket = null;
        }

        if (this.controlClient) {
            this.controlClient.disconnect();
        }
        if (this.previewRenderer) {
            this.previewRenderer.dispose();
        }

        try {
            // Stop preview server
            await fetch('/ajax/tinymist/stop-preview', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({page_id: this.$opts.pageId})
            });
            this.logInfo('🛑 Preview server stopped');
        } catch (error) {
            console.error('Failed to stop preview server:', error);
        }
    }

    setup() {
        console.log('🔧 Plain compile: TinymistEditor: setup() called');

        this.elem = this.$el;
        this.editor = this.$refs.editor as HTMLTextAreaElement;
        this.preview = this.$refs.preview;
        this.console = this.$refs.console;

        console.log('🔧 Plain compile: Elements found:', {
            elem: !!this.elem,
            editor: !!this.editor,
            preview: !!this.preview,
            console: !!this.console
        });

        this.currentSource = this.editor.value;
        this.compileTimer = null;
        this.compileDelay = 800; // ms - debounce delay for compilation
        this.editorView = null;

        console.log('🔧 Plain compile: Initial content length:', this.currentSource.length);

        // Setup CodeMirror editor
        this.setupCodeMirror();

        // Setup event listeners
        this.setupListeners();

        // Setup form submit handler to sync CodeMirror content to textarea
        this.setupFormSubmitHandler();

        // Initial compilation
        // console.log('🔧 Plain compile: Triggering initial compile...');
        // this.compile();
    }

    async setupCodeMirror() {
        try {
            // Start preview server first to get ports
            await this.startPreviewServer();

            // Import CodeMirror modules
            const {EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine} = await import('@codemirror/view');
            const {EditorState} = await import('@codemirror/state');
            const {defaultKeymap} = await import('@codemirror/commands');

            // Add Control and preview (now that server is running)
            await this.setupControl();
            console.log('✓ Control client initialized');
            await this.setupPreview();
            console.log('✓ Preview client initialized');

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
                            // Send changes to WebSocket server
                            if (update.transactions.some(tr => tr.docChanged)) {
                                update.transactions.forEach(tr => {
                                    if (tr.changes && !tr.changes.empty) {
                                        this.sendChangesToServer(tr.changes);
                                    }
                                });
                            }
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

            // Connect to file sync WebSocket if token is available
            await this.connectFileSyncSocket();
        } catch (error) {
            console.error('Failed to initialize CodeMirror:', error);
            this.logError(`Failed to initialize CodeMirror editor: ${error}`);
            // Fall back to textarea if CodeMirror fails
            this.editor.style.display = 'block';
            this.editor.addEventListener('input', () => this.onInput());
        }
    }

    async connectFileSyncSocket() {
        const wsToken = this.$opts.wsToken as string;
        if (!wsToken) {
            console.warn('No WebSocket token available, file sync disabled');
            return;
        }

        const pageId = this.$opts.pageId;
        if (!pageId) {
            console.error('No page ID for WebSocket connection');
            return;
        }

        try {
            // Connect to local dev server (adjust URL for production)
            const wsUrl = `ws://localhost:4000?token=${encodeURIComponent(wsToken)}`;

            this.fileSyncSocket = new WebSocket(wsUrl);

            this.fileSyncSocket.onopen = () => {
                console.log('✓ File sync WebSocket connected');
                this.logSuccess('File sync connected');
                this.reconnectAttempts = 0;

                // Start heartbeat
                this.startHeartbeat();
            };

            this.fileSyncSocket.onmessage = (event) => {
                this.handleFileSyncMessage(event.data);
            };

            this.fileSyncSocket.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.logError('File sync connection error');
            };

            this.fileSyncSocket.onclose = (event) => {
                console.log('WebSocket closed', { code: event.code, reason: event.reason });
                this.stopHeartbeat();

                if (event.code !== 1000) {
                    // Abnormal close, attempt reconnect
                    this.scheduleReconnect();
                }
            };
        } catch (error) {
            console.error('Failed to connect file sync WebSocket:', error);
            this.logError(`File sync connection failed: ${error}`);
        }
    }

    handleFileSyncMessage(data: string) {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case 'pong':
                    // Heartbeat response
                    break;

                case 'ack':
                    console.log('Change acknowledged', { docVersion: msg.docVersion });
                    break;

                case 'fullState':
                    console.log('Received full state from server', { docVersion: msg.docVersion });
                    this.docVersion = msg.docVersion;
                    // Update editor content if needed
                    if (this.editorView && msg.content !== this.editorView.state.doc.toString()) {
                        this.setText(msg.content);
                        this.logInfo('Document synchronized from server');
                    }
                    break;

                case 'error':
                    console.error('Server error:', msg);
                    this.logError(`Server error: ${msg.message}`);
                    break;

                default:
                    console.warn('Unknown message type:', msg.type);
            }
        } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
        }
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.pingInterval = setInterval(() => {
            if (this.fileSyncSocket && this.fileSyncSocket.readyState === WebSocket.OPEN) {
                this.fileSyncSocket.send(JSON.stringify({ type: 'ping' }));
            }
        }, 20000); // 20 seconds
    }

    stopHeartbeat() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimeout) {
            return; // Already scheduled
        }

        this.reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this.logInfo(`Reconnecting in ${Math.round(delay / 1000)}s...`);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connectFileSyncSocket();
        }, delay);
    }

    sendChangesToServer(changes: any) {
        if (!this.fileSyncSocket || this.fileSyncSocket.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket not connected, changes not synced');
            return;
        }

        const pageId = this.$opts.pageId;
        this.docVersion++;

        const message = {
            type: 'changes',
            pageId: parseInt(pageId as string, 10),
            docVersion: this.docVersion,
            changes: changes.toJSON(),
        };

        this.fileSyncSocket.send(JSON.stringify(message));
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

    handleControlMessage(msg: any) {
        if (msg.event === 'compileStatus') {
            this.onCompileStatus(msg.kind, msg);
        } else if (msg.event === 'outline') {
            this.onOutline(msg.items);
        } else if (msg.event === 'syncEditorChanges') {
            this.onSyncChanges(msg);
        }
    }

    private onCompileStatus(kind: string, msg?: any) {
        // Update compilation status UI
        if (kind === 'Compiling') {
            this.preview.classList.add('loading');
            this.logInfo('Compiling...');
        } else if (kind === 'CompileSuccess') {
            this.preview.classList.remove('loading');
            this.logSuccess('Compilation successful');
        } else if (kind === 'CompileError') {
            this.preview.classList.remove('loading');
            this.logError('Compilation failed');
            console.log(msg);
        }
    }

    private onSyncChanges(msg: any) {
        // Handle synchronization
        console.log('Syncing changes:', msg);
    }

    private onOutline(items: OutlineItem[]) {
        // Update table of contents
        console.log('Document outline:', items);
    }

    async compile() {
        // Get source from CodeMirror if available, otherwise from textarea
        const source = this.editorView
            ? this.editorView.state.doc.toString()
            : this.editor.value;
        this.currentSource = source;

        // TODO: Incremental changes through file socket which will trigger dataWc responses
        // Right now changes should happen during draft save
        // If no wc available -- fall back to full compile below

        // Increment compilation sequence to track order
        this.compilationSequence++;
        const thisCompilationSequence = this.compilationSequence;
        console.log(`[Tinymist] Plain compile: Starting Typst compilation #${thisCompilationSequence}`);

        // Show loading state
        this.preview.classList.add('loading');
        this.logInfo('Typst: Compiling...');

        try {
            let response;

            response = await window.$http.post('/ajax/tinymist/compile', {
                source: source
            });

            // Check if this response is stale (newer compilation already started OR finished)
            if (thisCompilationSequence <= this.lastProcessedSequence) {
                console.log(`[Tinymist] Plain compile: Ignoring stale compilation #${thisCompilationSequence} (last processed: #${this.lastProcessedSequence})`);
                return; // Ignore stale response
            }

            console.log(`[Tinymist] Plain compile: Compilation #${thisCompilationSequence} completed (processing...)`);

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
                    this.logSuccess(`Typst: Compiled successfully (${source.length} chars)`);

                    // Update cached diagnostics and trigger linter update
                    if (data.diagnostics && data.diagnostics.length > 0) {
                        this.updateDiagnostics(data.diagnostics, source);
                    } else {
                        // Clear diagnostics on successful compilation with no errors
                        console.log('[Tinymist] Plain compile: Clearing diagnostics (success with no errors)');
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
                console.error('Plain compile error: Unexpected compile response:', response);
                this.logError('Typst: Compilation failed: unexpected server response.');
            }
        } catch (error) {
            console.error('Plain compile error: Tinymist compilation failed:', error);
            this.logError('Typst: Compilation failed. Check console for details.');
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

        console.log('[Tinymist] Plain compile: Updating diagnostics:', diagnostics);

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

        console.log('[Tinymist] Plain compile: Cached diagnostics:', this.cachedDiagnostics);

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
