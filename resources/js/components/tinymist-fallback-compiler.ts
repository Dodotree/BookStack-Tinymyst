import { Diagnostic } from '@codemirror/lint';

/**
 * Fallback compiler for Typst when WebSocket sync is unavailable
 * Handles compilation via AJAX endpoint and diagnostic processing
 */
export class TinymistFallbackCompiler {
    private enabled: boolean = true;
    private compileTimer: ReturnType<typeof setTimeout> | null = null;
    private compileDelay: number;
    private compilationSequence: number = 0;
    private lastProcessedSequence: number = 0;
    private lastCompiledSource: string = '';
    private cachedDiagnostics: Diagnostic[] = [];

    // Callbacks
    private getText: () => string;

    constructor(
        compileDelay: number = 800,
        callbacks: {
            getText: () => string;
        }
    ) {
        this.compileDelay = compileDelay;
        this.getText = callbacks.getText;

        this.clear = this.clear.bind(this);
        this.scheduleCompile = this.scheduleCompile.bind(this);
        window.$events.listen("tinymist-fallback-clear", this.clear);
        window.$events.listen("tinymist-fallback-enable", (enabled: boolean) => this.enabled = enabled);
        window.$events.listen("editor-tinymist-change", this.scheduleCompile);
    }

    /**
     * Schedule a compilation with debouncing
     * gets hammered on every input
     */
    scheduleCompile(): void {
        if (!this.enabled) {
            return;
        }
        if (this.compileTimer) {
            clearTimeout(this.compileTimer);
        }
        this.compileTimer = setTimeout(() => {
            this.compile();
        }, this.compileDelay);
    }

    /**
     * Cancel any pending compilation
     */
    cancelPending(): void {
        if (this.compileTimer) {
            clearTimeout(this.compileTimer);
            this.compileTimer = null;
        }
    }

    /**
     * Clear all cached data
     */
    clear(): void {
        this.enabled = false;
        if (this.compileTimer) {
            clearTimeout(this.compileTimer);
            this.compileTimer = null;
        }
        this.lastCompiledSource = '';
        this.cachedDiagnostics = [];
        this.compilationSequence = 0;
        this.lastProcessedSequence = 0;
    }

    /**
     * Compile Typst source to SVG
     */
    async compile(): Promise<void> {
        if (!this.enabled) {
            return;
        }
        // Increment compilation sequence to track order
        this.compilationSequence++;
        const thisCompilationSequence = this.compilationSequence;
        const source = this.getText();

        console.log(`[Typst] Starting Typst compilation #${thisCompilationSequence} (fallback mode)`);
        window.$events.emit("tinymist-console-log",{ type: "info", message: "[Typst] Compiling..." });

        try {
            const response = await window.$http.post('/ajax/tinymist/compile', {source});

            // Check if this response is stale (newer compilation already started OR finished)
            if (thisCompilationSequence <= this.lastProcessedSequence) {
                console.log(`[Typst] Ignoring stale compilation #${thisCompilationSequence} (last processed: #${this.lastProcessedSequence})`);
                return; // Ignore stale response
            }

            console.log(`[Typst] Compilation #${thisCompilationSequence} completed (processing...)`);

            // Mark this as the last processed compilation
            this.lastProcessedSequence = thisCompilationSequence;

            // Store the source that was compiled (for diagnostic position calculation)
            this.lastCompiledSource = source;

            const respData = response && response.data;

            // Guard the shape of respData before accessing properties to avoid errors
            if (respData && typeof respData === 'object' && 'success' in respData) {
                const data = respData as { success: boolean; svg?: string; errors?: string[]; diagnostics?: any[] };

                if (data.success) {
                    // Store and show SVG
                    window.$events.emit("tinymist-console-log",{ type: "success", message: `[Typst] Compiled successfully (${source.length} chars)` });

                    // Update cached diagnostics
                    if (data.diagnostics && data.diagnostics.length > 0) {
                        this.updateDiagnostics(data.diagnostics, source);
                    } else {
                        // Clear diagnostics on successful compilation with no errors
                        console.log('[Typst] Clearing diagnostics (success with no errors)');
                        this.cachedDiagnostics = [];
                        window.$events.emit("tinymist-diagnostics", []);
                    }
                } else {
                    if (data.diagnostics && Array.isArray(data.diagnostics) && data.diagnostics.length > 0) {
                        this.updateDiagnostics(data.diagnostics, source);
                    } else {
                        // No diagnostics parsed - log raw errors as fallback
                        this.cachedDiagnostics = [];
                        data.errors?.forEach((error) =>  window.$events.emit("tinymist-console-log",{ type: "error", message: "[Typst] Compile Error", details: error }))
                    }
                }
            } else if (typeof respData === 'string') {
                // Server returned a plain string error/message
                window.$events.emit("tinymist-console-log",{ type: "error", message: "[Typst] Server response", details: respData });
            } else {
                // Unexpected response shape
                console.error('[Typst] Unexpected compile response:', response);
                window.$events.emit("tinymist-console-log",{ type: "error", message: "[Typst] Unexpected server response.", details: response });
            }
        } catch (error) {
            console.error('[Typst] Compilation failed:', error);
            window.$events.emit("tinymist-console-log",{ type: "error", message: "[Typst] Compilation failed. Check console for details.", details: error });
        }
    }

    /**
     * Update diagnostics from compilation response
     */
    updateDiagnostics(diagnostics: any[], sourceText: string): void {
        if (!Array.isArray(diagnostics)) {
            this.cachedDiagnostics = [];
            return;
        }

        // Calculate positions for CodeMirror
        this.cachedDiagnostics = diagnostics.map((diag: any) => {
            const from = this.positionToOffsetInText(sourceText, diag.line - 1, diag.column - 1);
            const to = this.positionToOffsetInText(sourceText, diag.line - 1, Math.max(diag.column - 1, diag.column));

            return {
                from: from,
                to: Math.max(from + 1, to),
                severity: this.mapSeverity(diag.severity),
                message: diag.message,
            };
        });

        console.log('[Typst] Cached diagnostics:', this.cachedDiagnostics);
        window.$events.emit("tinymist-diagnostics", this.cachedDiagnostics);

        // Log diagnostics to console
        diagnostics.forEach(diag => {
            if (diag.severity === 'error') {
                window.$events.emit("tinymist-console-log",{ type: "error", message: `[Typst]Line ${diag.line}, Col ${diag.column}: ${diag.message}` });
            } else if (diag.severity === 'warning') {
                window.$events.emit("tinymist-console-log",{ type: "warning", message: `[Typst] Line ${diag.line}, Col ${diag.column}: ${diag.message}` });
            }
        });
    }

    // Private helper methods

    private mapSeverity(severity: string): 'error' | 'warning' | 'info' {
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

    private positionToOffsetInText(text: string, line: number, column: number): number {
        const lines = text.split('\n');
        if (line < 0 || line >= lines.length) return 0;

        let offset = 0;
        for (let i = 0; i < line; i++) {
            offset += lines[i].length + 1; // +1 for newline
        }
        offset += Math.min(column, lines[line].length);
        return offset;
    }

}
