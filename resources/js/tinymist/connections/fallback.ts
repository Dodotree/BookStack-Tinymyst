// Gets svg and diagnostics from the typst compiler service
// via AJAX when editor_sync or preview_ws WebSocket connections are unavailable
// polls the compile endpoint with debouncing
// diagnostics output parsed on the backend
// when compilations succeed, provides SVG to fill the preview pane

export class TinymistFallbackCompiler {
    private compileDelay: number;
    private compileTimeout: ReturnType<typeof setTimeout> | null = null;
    private sampleIdx: number = 0;
    private lastProcessedSampleIdx: number = 0;
    private lastTextSample: string = '';

    constructor(
        compileDelay: number = 800,
    ) {
        this.compileDelay = compileDelay;
    }

    /**
     * Schedule a compilation with debouncing
     */
    scheduleCompile(source: string): void {
        if (this.compileTimeout) {
            // the more you bang, the longer it takes to begin
            // so effectively it waits for a pause in typing
            clearTimeout(this.compileTimeout);
        }
        // but it guarantees that the last change will be included
        // (simple throttling would might not catch the last change)
        this.compileTimeout = setTimeout(() => {
            this.compile(source);
        }, this.compileDelay);
    }

    cancelPending(): void {
        if (this.compileTimeout) {
            clearTimeout(this.compileTimeout);
            this.compileTimeout = null;
        }
    }

    async compile(source: string): Promise<void> {
        // Increment compilation sequence to track order
        this.sampleIdx++;
        const thisSampleIdx = this.sampleIdx;
        console.log(`[Typst] Starting Typst compilation #${thisSampleIdx} (fallback mode)`);

        this.notifyMessage('[Typst] Compiling...', 'info');
        this.notifyCompileStart();

        try {
            // Store the source that was compiled since diagnostics is for that state
            this.lastTextSample = source;

            const response = await window.$http.post('/ajax/tinymist/compile', {
                source: source
            });

            // Ignore stale responses (newer compilation already started OR finished)
            if (thisSampleIdx <= this.lastProcessedSampleIdx) {
                console.log(`[Typst] Ignoring stale compilation #${thisSampleIdx} (last processed: #${this.lastProcessedSampleIdx})`);
                return;
            }

            console.log(`[Typst] Compilation #${thisSampleIdx} completed (processing...)`);

            this.lastProcessedSampleIdx = thisSampleIdx;

            const respData = response?.data;

            // Guard the shape of respData before accessing properties to avoid errors
            if (respData && typeof respData === 'object' && 'success' in respData) {

                const data = respData as { success: boolean; svg?: string; errors?: string[]; diagnostics?: any[] };

                if (data.success) {
                    this.notifyMessage(`[Typst] Compiled successfully (${source.length} chars)`, 'success');
                    this.notifyCompileSuccess(data.svg || '', data.diagnostics);
                } else {
                    this.notifyCompileError(data.errors || [], data.diagnostics || []);
                }
            } else if (typeof respData === 'string') {
                // Server returned a plain string error/message
                console.error('[Typst] Unexpected string response:', response);
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
     * Clear all cached data
     */
    clear(): void {
        this.cancelPending();
        this.lastTextSample = '';
        this.sampleIdx = 0;
        this.lastProcessedSampleIdx = 0;
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
