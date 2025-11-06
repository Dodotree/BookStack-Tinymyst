import { Component } from './component';
import { EditorView } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { linter, Diagnostic, forceLinting, setDiagnostics } from '@codemirror/lint';
import { PreviewControlPlane } from './tinymist-preview-control';
import { PreviewDataPlane } from './tinymist-preview-renderer';
import { TinymistFileSyncClient } from './tinymist-file-sync-client';
import { TinymistFallbackCompiler } from './tinymist-fallback-compiler';

export class TinymistEditor extends Component {
    elem!: HTMLElement;
    editor!: HTMLTextAreaElement;
    editorView!: EditorView | null;
    preview!: HTMLElement;
    console!: HTMLElement;
    currentSource: any;

    previousContent: string = '';

    private controlClient: PreviewControlPlane | null = null;
    private previewRenderer: PreviewDataPlane | null = null;
    private previewServerInfo: { controlPort: number, dataPort: number, host: string } | null = null;

    private fileSyncClient: TinymistFileSyncClient | null = null;
    private fallbackCompiler: TinymistFallbackCompiler | null = null;
    private fallbackMode: boolean = false;
    private wsConnectionTimeout: ReturnType<typeof setTimeout> | null = null;

    // Connection health monitoring
    private controlConnected: boolean = false;
    private dataConnected: boolean = false;
    private fileSyncConnected: boolean = false;
    private previewServerDownTime: number = 0;
    private previewServerDownTimer: ReturnType<typeof setTimeout> | null = null;
    private restartingPreviewServer: boolean = false;

    async startPreviewServer() {
        // Check if preview was already started server-side
        if (this.$opts.previewStarted === 'true' && this.$opts.controlPort && this.$opts.dataPort) {
            this.previewServerInfo = {
                controlPort: parseInt(this.$opts.controlPort as string, 10),
                dataPort: parseInt(this.$opts.dataPort as string, 10),
                host: this.$opts.host as string || '127.0.0.1',
            };
            console.log('[Preview Server] pre-started:', this.previewServerInfo);
            this.logSuccess(`[Preview Server] already started on ports ${this.previewServerInfo.controlPort}/${this.previewServerInfo.dataPort}`);
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

            console.log('[Preview Server] response:', response);

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
                console.log('[Preview Server] started:', this.previewServerInfo);
                this.logSuccess(`[Preview Server] started on ports ${data.control_port}/${data.data_port}`);
            } else if (data.success === false) {
                throw new Error(data.error || '[Preview Server] Failed to start');
            } else {
                throw new Error(' [Preview Server] Invalid response from server: missing port information');
            }
        } catch (error) {
            console.error('[Preview Server] Failed to start:', error);
            console.error('[Preview Server] Error details:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logError('⚠ [Preview Server] Failed to start: ' + errorMessage);
            throw error;
        }
    }

    async setupControl() {
        try {
            const pageId = this.$opts.pageId;
            if (!pageId) {
                throw new Error('[Preview Control Plane] Page ID not found, exiting setup');
            }

            if (!this.previewServerInfo) {
                throw new Error('[Preview Control Plane] not started');
            }

            // Get initial content from textarea (before CodeMirror is created)
            const content = this.editor.value || '';

            // Initialize Control client with custom port and message handler
            this.controlClient = new PreviewControlPlane(
                parseInt(pageId, 10),
                content,
                this.previewServerInfo.host,
                this.previewServerInfo.controlPort,
                {
                    onConnectionStateChange: (connected) => {
                        this.controlConnected = connected;
                        if (connected) {
                            this.logSuccess('[Preview Control Plane] connected');
                            this.checkPreviewServerHealth();
                        } else {
                            this.logError('[Preview Control Plane] disconnected');
                            this.checkPreviewServerHealth();
                        }
                    },
                    onCompileStatus: (kind: string, msg?: any) => {
                        // Update compilation status UI
                        if (kind === 'Compiling') {
                            this.preview.classList.add('loading');
                            this.logInfo('[Preview Control Plane] Compiling...');
                        } else if (kind === 'CompileSuccess') {
                            this.preview.classList.remove('loading');
                            this.logSuccess('[Preview Control Plane] Compilation successful');
                        } else if (kind === 'CompileError') {
                            this.preview.classList.remove('loading');
                            this.logError('[Preview Control Plane] Compilation failed');
                            console.log(msg);
                        }
                    },
                    onMessage: (msg) => {
                        this.logInfo(msg);
                    },
                    onError: (error) => {
                        this.logError(error);
                    }
                }
            );
            const controlExtension = await this.controlClient.connect();

            // Add Control extension to editor view (not textarea)
            if (this.editorView) {
                this.editorView.dispatch({
                    effects: StateEffect.appendConfig.of(controlExtension)
                });
            }

        } catch (error) {
            console.error('[Preview Control Plane] setup failed:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logError('⚠ [Preview Control Plane] connection failed: ' + errorMessage);
        }
    }

    async setupPreview() {
        try {
            const previewElement = this.$refs.preview as HTMLElement;
            if (!previewElement) {
                console.warn('[Preview Data Plane] Preview element not found, skipping preview setup');
                return;
            }

            if (!this.previewServerInfo) {
                throw new Error('[Preview Data Plane] not started');
            }

            // Initialize preview renderer with custom port
            this.previewRenderer = new PreviewDataPlane(
                previewElement,
                this.previewServerInfo.host,
                this.previewServerInfo.dataPort,
                {
                    onConnectionStateChange: (connected) => {
                        this.dataConnected = connected;
                        if (connected) {
                            this.logSuccess('[Preview Data Plane] connected');
                            this.checkPreviewServerHealth();
                        } else {
                            this.logError('[Preview Data Plane] disconnected');
                            this.checkPreviewServerHealth();
                        }
                    },
                    onError: (error) => {
                        this.logError(error);
                    }
                }
            );
            await this.previewRenderer.initialize();

        } catch (error) {
            console.error('[Preview Data Plane] setup failed:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logError('⚠ [Preview Data Plane] initialization failed: ' + errorMessage);
        }
    }

    async initializeFileSyncClient() {
        const wsToken = this.$opts.wsToken as string;
        const pageId = this.$opts.pageId;

        if (!wsToken) {
            console.warn('[File Sync Module] No WS token available, enabling fallback mode');
            this.scheduleFallbackMode();
            return;
        }

        if (!pageId) {
            console.error('[File Sync Module] No page ID for WebSocket connection');
            return;
        }

        // Schedule fallback mode if connection doesn't succeed within 1 second
        this.scheduleFallbackMode();

        // Create file sync client
        this.fileSyncClient = new TinymistFileSyncClient(
            parseInt(pageId, 10),
            wsToken,
            {
                onConnectionStateChange: (connected) => {
                    this.fileSyncConnected = connected;
                    if (connected) {
                        this.logSuccess('[File Sync Module] connected');
                        this.disableFallbackMode();
                    } else {
                        this.enableFallbackMode();
                    }
                },
                onMessage: (msg) => {
                    this.handleFileSyncMessage(msg);
                },
                onError: (error) => {
                    this.logError(error);
                }
            }
        );

        await this.fileSyncClient.connect();
    }

    private initializeFallbackCompiler() {
        this.fallbackCompiler = new TinymistFallbackCompiler(800, {
            onCompileStart: () => {
                console.log('[Typst Compiler] Fallback compilation started');
                if (this.preview) {
                    this.preview.classList.add('loading');
                }
            },
            onCompileSuccess: (svg: string, diagnostics?: any[]) => {
                console.log('[Typst Compiler] Fallback compilation succeeded');
                this.showSvg(svg);
                if (this.preview) {
                    this.preview.classList.remove('loading');
                }
                this.triggerLinting();
            },
            onCompileError: (errors: string[], diagnostics?: any[]) => {
                console.error('[Typst Compiler] Fallback compilation errors:', errors);
                if (this.preview) {
                    this.preview.classList.remove('loading');
                }
                errors.forEach(error => this.logMessage(error, 'error'));
            },
            onMessage: (message: string, type: 'info' | 'success' | 'error' | 'warning') => {
                this.logMessage(message, type);
            }
        });
    }

    setup() {
        console.log('[Tinymist Editor] setup() called');

        this.elem = this.$el;
        this.editor = this.$refs.editor as HTMLTextAreaElement;
        this.preview = this.$refs.preview;
        this.console = this.$refs.console;

        console.log('[Tinymist Editor] Elements found:', {
            elem: !!this.elem,
            editor: !!this.editor,
            preview: !!this.preview,
            console: !!this.console
        });

        this.currentSource = this.editor.value;
        this.editorView = null;

        console.log('[Tinymist Editor] Initial content length:', this.currentSource.length);

        // Initialize fallback compiler
        this.initializeFallbackCompiler();

        // Setup CodeMirror editor
        this.setupCodeMirror();

        // Setup event listeners
        this.setupListeners();

        // Setup form submit handler to sync CodeMirror content to textarea
        this.setupFormSubmitHandler();

        // Initial compilation
        console.log('[Tinymist Editor] Triggering initial compile...');
        this.compile();
    }

    async setupCodeMirror() {
        try {
            // Start [Preview Server] first to get ports
            await this.startPreviewServer();

            // Import CodeMirror modules
            const { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine } = await import('@codemirror/view');
            const { EditorState } = await import('@codemirror/state');
            const { defaultKeymap } = await import('@codemirror/commands');

            // Add Control and preview (now that server is running)
            await this.setupControl();
            console.log('Control client initialized');
            await this.setupPreview();
            console.log('Preview client initialized');

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
            await this.initializeFileSyncClient();
        } catch (error) {
            console.error('Failed to initialize CodeMirror:', error);
            this.logError(`Failed to initialize CodeMirror editor: ${error}`);
            // Fall back to textarea if CodeMirror fails
            this.editor.style.display = 'block';
            this.editor.addEventListener('input', () => this.onInput());
        }
    }

    // Cleanup on destroy
    async destroy() {
        // Clear preview server monitoring timers
        if (this.previewServerDownTimer) {
            clearTimeout(this.previewServerDownTimer);
            this.previewServerDownTimer = null;
        }

        // Close WebSocket connection
        if (this.fileSyncClient) {
            this.fileSyncClient.disconnect();
            this.fileSyncClient = null;
        }

        // Clean up fallback compiler
        if (this.fallbackCompiler) {
            this.fallbackCompiler.clear();
            this.fallbackCompiler = null;
        }

        if (this.wsConnectionTimeout) {
            clearTimeout(this.wsConnectionTimeout);
        }

        if (this.controlClient) {
            this.controlClient.disconnect();
        }
        if (this.previewRenderer) {
            this.previewRenderer.dispose();
        }

        try {
            // Stop [Preview Server]
            await fetch('/ajax/tinymist/stop-preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ page_id: this.$opts.pageId })
            });
            this.logInfo('🛑 [Preview Server] stopped');
        } catch (error) {
            console.error('Failed to stop [Preview Server]:', error);
        }
    }

    handleFileSyncMessage(msg: any) {
        switch (msg.type) {
            case 'fullState':
                // Update editor content if needed
                if (this.editorView && msg.content !== this.editorView.state.doc.toString()) {
                    this.setText(msg.content);
                    this.logInfo('[File Sync Module] Document synchronized from server');
                }
                break;

            case 'error':
                this.logError(`[File Sync Module] Server error: ${msg.message}`);
                break;
        }
    }

    scheduleFallbackMode() {
        // Clear any existing timeout
        if (this.wsConnectionTimeout) {
            clearTimeout(this.wsConnectionTimeout);
        }

        // Enable fallback mode after 1 second if WebSocket hasn't connected
        this.wsConnectionTimeout = setTimeout(() => {
            if (!this.fileSyncClient || !this.fileSyncClient.connected()) {
                this.enableFallbackMode();
            }
        }, 1000);
    }

    enableFallbackMode() {
        if (this.fallbackMode) {
            return; // Already in fallback mode
        }

        this.fallbackMode = true;
        console.log('⚠ Entering fallback mode');
        this.logWarning('Using fallback mode');

        // Clear the connection timeout
        if (this.wsConnectionTimeout) {
            clearTimeout(this.wsConnectionTimeout);
            this.wsConnectionTimeout = null;
        }
    }

    disableFallbackMode() {
        if (!this.fallbackMode) {
            return; // Already disabled
        }

        this.fallbackMode = false;
        console.log('Exiting fallback mode (using [File Sync Module])');
        this.logSuccess('[File Sync Module] active');

        // Clear any pending fallback compilation since WebSocket handles changes
        if (this.fallbackCompiler) {
            this.fallbackCompiler.clear();
        }

        // Clear the connection timeout
        if (this.wsConnectionTimeout) {
            clearTimeout(this.wsConnectionTimeout);
            this.wsConnectionTimeout = null;
        }
    }

    /**
     * Check preview server health and initiate restart if needed
     * Called whenever Control or Data plane connection state changes
     */
    checkPreviewServerHealth() {
        // Enable fallback mode if ANY socket is down
        if (!this.controlConnected || !this.dataConnected || !this.fileSyncConnected) {
            this.enableFallbackMode();
        }

        // If both Control AND Data planes are down, start monitoring for restart
        const previewServerDown = !this.controlConnected && !this.dataConnected;

        if (previewServerDown) {
            // Start countdown if not already running
            if (!this.previewServerDownTimer) {
                this.previewServerDownTime = Date.now();
                this.logWarning('[Preview Server] Both Control and Data planes down. Will attempt restart in 60 seconds...');

                this.previewServerDownTimer = setTimeout(() => {
                    this.attemptPreviewServerRestart();
                }, 60000); // 60 seconds
            }
        } else {
            // At least one plane is up - cancel restart timer
            if (this.previewServerDownTimer) {
                clearTimeout(this.previewServerDownTimer);
                this.previewServerDownTimer = null;
                this.previewServerDownTime = 0;
                console.log('[Preview Server] Health recovered, restart cancelled');
            }
        }
    }

    /**
     * Attempt to restart the preview server with dynamically allocated ports
     */
    async attemptPreviewServerRestart() {
        if (this.restartingPreviewServer) {
            console.log('[Preview Server] Restart already in progress');
            return;
        }

        this.restartingPreviewServer = true;
        this.logInfo('[Preview Server] Attempting restart with new ports...');

        try {
            const pageId = this.$opts.pageId;
            if (!pageId) {
                throw new Error('Page ID not found');
            }

            // Get current content
            const content = this.editorView?.state.doc.toString() || this.editor.value;

            // Call restart endpoint
            const response = await window.$http.post('/ajax/tinymist/restart-preview', {
                page_id: pageId,
                content: content,
            }) as any;

            const data = response.data || response;

            if (data && typeof data === 'object' && 'success' in data) {
                const result = data as { success: boolean; control_port?: number; data_port?: number; host?: string; error?: string };

                if (result.success && result.control_port && result.data_port && result.host) {
                    this.logSuccess(`[Preview Server] Restarted on ports ${result.control_port}/${result.data_port}`);

                    // Update port configuration
                    this.previewServerInfo = {
                        controlPort: result.control_port,
                        dataPort: result.data_port,
                        host: result.host,
                    };

                    // Reconnect Control and Data planes with new ports
                    await this.reconnectPreviewClients();
                } else {
                    throw new Error(result.error || 'Failed to restart preview server');
                }
            } else {
                throw new Error('Invalid response from server');
            }

        } catch (error) {
            console.error('[Preview Server] Restart failed:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logError(`[Preview Server] Restart failed: ${errorMessage}`);
            this.logWarning('[Preview Server] Continuing in fallback mode');

        } finally {
            this.restartingPreviewServer = false;
            this.previewServerDownTimer = null;
            this.previewServerDownTime = 0;
        }
    }

    /**
     * Reconnect Control and Data plane clients with new port configuration
     */
    async reconnectPreviewClients() {
        if (!this.previewServerInfo) {
            return;
        }

        this.logInfo('[Preview Server] Reconnecting clients with new ports...');

        try {
            // Disconnect old clients
            if (this.controlClient) {
                this.controlClient.disconnect();
                this.controlClient = null;
            }

            if (this.previewRenderer) {
                this.previewRenderer.dispose();
                this.previewRenderer = null;
            }

            // Wait for cleanup
            await new Promise(resolve => setTimeout(resolve, 500));

            // Reconnect with new ports
            await this.setupControl();
            await this.setupPreview();

            this.logSuccess('[Preview Server] Clients reconnected');

        } catch (error) {
            console.error('[Preview Server] Failed to reconnect clients:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logError(`[Preview Server] Reconnection failed: ${errorMessage}`);
        }
    }

    sendChangesToServer(changes: any) {
        if (!this.fileSyncClient || !this.fileSyncClient.connected()) {
            console.warn('[File Sync Module] not connected, file changes not synced');
            return;
        }

        this.fileSyncClient.sendChanges(changes);
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
        // Only compile in fallback mode (WebSocket handles changes otherwise)
        if (this.fallbackMode && this.fallbackCompiler) {
            const source = this.editorView?.state.doc.toString() || this.editor.value;
            this.fallbackCompiler.scheduleCompile(source);
        }

        // Notify page editor of changes
        window.$events.emit('editor-tinymist-change', '');
    }

    async compile() {
        // Only compile in fallback mode (WebSocket + Tinymist preview handles compilation otherwise)
        if (!this.fallbackMode) {
            console.log('[Tinymist] Skipping compile() - WebSocket sync active');
            return;
        }

        if (!this.fallbackCompiler) {
            console.error('[Tinymist] Fallback compiler not initialized');
            return;
        }

        // Get source from CodeMirror if available, otherwise from textarea
        const source = this.editorView
            ? this.editorView.state.doc.toString()
            : this.editor.value;
        this.currentSource = source;

        // Delegate to fallback compiler
        await this.fallbackCompiler.compile(source);
    }


    /**
     * Trigger linter update in CodeMirror
     */
    triggerLinting(): void {
        if (this.editorView && this.fallbackCompiler) {
            const diagnostics = this.fallbackCompiler.getDiagnostics();
            this.editorView.dispatch(setDiagnostics(this.editorView.state, diagnostics));
        }
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
                changes: { from: selection.from, to: selection.to, insert: replacement },
                selection: { anchor: selection.from + before.length, head: selection.from + before.length + selectedText.length }
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
                changes: { from: selection.from, insert: heading },
                selection: { anchor: selection.from + heading.length - 1 }
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
                changes: { from: 0, to: this.editorView.state.doc.length, insert: content }
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
