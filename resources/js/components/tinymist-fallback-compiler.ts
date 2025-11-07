import { Diagnostic } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';

/**
 * Fallback compiler for Typst when WebSocket sync is unavailable
 * Handles compilation via AJAX endpoint and diagnostic processing
 */
export class TinymistFallbackCompiler {
    private compileTimer: ReturnType<typeof setTimeout> | null = null;
    private compileDelay: number;
    private compilationSequence: number = 0;
    private lastProcessedSequence: number = 0;
    private lastCompiledSource: string = '';
    private lastGoodSvg: string = '';
    private rawDiagnostics: any[] = [];
    private cachedDiagnostics: Diagnostic[] = [];

    // Callbacks
    private onCompileStart?: () => void;
    private onCompileSuccess?: (svg: string, diagnostics?: any[]) => void;
    private onCompileError?: (errors: string[], diagnostics?: any[]) => void;
    private onMessage?: (message: string, type: 'info' | 'success' | 'error' | 'warning') => void;

    constructor(
        compileDelay: number = 800,
        callbacks?: {
            onCompileStart?: () => void;
            onCompileSuccess?: (svg: string, diagnostics?: any[]) => void;
            onCompileError?: (errors: string[], diagnostics?: any[]) => void;
            onMessage?: (message: string, type: 'info' | 'success' | 'error' | 'warning') => void;
        }
    ) {
        this.compileDelay = compileDelay;

        if (callbacks) {
            this.onCompileStart = callbacks.onCompileStart;
            this.onCompileSuccess = callbacks.onCompileSuccess;
            this.onCompileError = callbacks.onCompileError;
            this.onMessage = callbacks.onMessage;
        }
    }

    /**
     * Schedule a compilation with debouncing
     */
    scheduleCompile(source: string): void {
        if (this.compileTimer) {
            clearTimeout(this.compileTimer);
        }

        this.compileTimer = setTimeout(() => {
            this.compile(source);
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
     * Compile Typst source to SVG
     */
    async compile(source: string): Promise<void> {
        // Increment compilation sequence to track order
        this.compilationSequence++;
        const thisCompilationSequence = this.compilationSequence;
        console.log(`[Typst] Starting Typst compilation #${thisCompilationSequence} (fallback mode)`);

        this.notifyMessage('[Typst] Compiling...', 'info');
        this.notifyCompileStart();

        try {
            const response = await window.$http.post('/ajax/tinymist/compile', {
                source: source
            });

            // Check if this response is stale (newer compilation already started OR finished)
            if (thisCompilationSequence <= this.lastProcessedSequence) {
                console.log(`[Typst] Ignoring stale compilation #${thisCompilationSequence} (last processed: #${this.lastProcessedSequence})`);
                return; // Ignore stale response
            }

            console.log(`[Typst] Compilation #${thisCompilationSequence} completed (processing...)`);

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
                    this.notifyMessage(`[Typst] Compiled successfully (${source.length} chars)`, 'success');
                    this.notifyCompileSuccess(this.lastGoodSvg, data.diagnostics);

                    // Update cached diagnostics
                    if (data.diagnostics && data.diagnostics.length > 0) {
                        this.updateDiagnostics(data.diagnostics, source);
                    } else {
                        // Clear diagnostics on successful compilation with no errors
                        console.log('[Typst] Clearing diagnostics (success with no errors)');
                        this.rawDiagnostics = [];
                        this.cachedDiagnostics = [];
                    }
                } else {
                    // Keep last good SVG visible, update diagnostics
                    if (data.diagnostics && Array.isArray(data.diagnostics) && data.diagnostics.length > 0) {
                        this.updateDiagnostics(data.diagnostics, source);
                        this.notifyCompileError([], data.diagnostics);
                    } else {
                        // No diagnostics parsed - log raw errors as fallback
                        this.rawDiagnostics = [];
                        this.cachedDiagnostics = [];
                        this.notifyCompileError(data.errors || []);
                    }
                }
            } else if (typeof respData === 'string') {
                // Server returned a plain string error/message
                this.notifyMessage(respData, 'error');
                this.notifyCompileError([respData]);
            } else {
                // Unexpected response shape
                console.error('[Typst] Unexpected compile response:', response);
                this.notifyMessage('[Typst] Compilation failed: unexpected server response.', 'error');
                this.notifyCompileError(['Unexpected server response']);
            }
        } catch (error) {
            console.error('[Typst] Compilation failed:', error);
            this.notifyMessage('[Typst] Compilation failed. Check console for details.', 'error');
            this.notifyCompileError([error instanceof Error ? error.message : String(error)]);
        }
    }

    /**
     * Update diagnostics from compilation response
     */
    updateDiagnostics(diagnostics: any[], sourceText: string): void {
        if (!Array.isArray(diagnostics)) {
            this.rawDiagnostics = [];
            this.cachedDiagnostics = [];
            return;
        }

        console.log('[Typst] Updating diagnostics:', diagnostics);

        // Store raw diagnostics (line/column) for position recalculation
        this.rawDiagnostics = diagnostics;

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

        // Log diagnostics to console
        diagnostics.forEach(diag => {
            if (diag.severity === 'error') {
                this.notifyMessage(`[Typst]Line ${diag.line}, Col ${diag.column}: ${diag.message}`, 'error');
            } else if (diag.severity === 'warning') {
                this.notifyMessage(`[Typst] Line ${diag.line}, Col ${diag.column}: ${diag.message}`, 'warning');
            }
        });
    }

    /**
     * Get cached diagnostics for CodeMirror
     */
    getDiagnostics(): Diagnostic[] {
        return this.cachedDiagnostics;
    }

    /**
     * Get last successfully compiled SVG
     */
    getLastGoodSvg(): string {
        return this.lastGoodSvg;
    }

    /**
     * Clear all cached data
     */
    clear(): void {
        this.cancelPending();
        this.lastCompiledSource = '';
        this.lastGoodSvg = '';
        this.rawDiagnostics = [];
        this.cachedDiagnostics = [];
        this.compilationSequence = 0;
        this.lastProcessedSequence = 0;
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

    private notifyCompileStart(): void {
        if (this.onCompileStart) {
            this.onCompileStart();
        }
    }

    private notifyCompileSuccess(svg: string, diagnostics?: any[]): void {
        if (this.onCompileSuccess) {
            this.onCompileSuccess(svg, diagnostics);
        }
    }

    private notifyCompileError(errors: string[], diagnostics?: any[]): void {
        if (this.onCompileError) {
            this.onCompileError(errors, diagnostics);
        }
    }

    private notifyMessage(message: string, type: 'info' | 'success' | 'error' | 'warning'): void {
        if (this.onMessage) {
            this.onMessage(message, type);
        }
    }
}
