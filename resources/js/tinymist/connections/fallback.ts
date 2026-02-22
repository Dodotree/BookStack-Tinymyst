// Gets svg and diagnostics from the typst compiler service
// via AJAX when editor_sync or preview_ws WebSocket connections are unavailable
// polls the compile endpoint with debouncing
// diagnostics output parsed on the backend
// when compilations succeed, provides SVG to fill the preview pane

/**
 * Fallback compiler for Typst when WebSocket sync is unavailable
 * Handles compilation via AJAX endpoint and diagnostic processing
 */
export class TinymistFallbackCompiler {
    private enabled: boolean = false;
    private pageId: number = 0;

    constructor(pageId: number) {
        this.pageId = pageId;
        window.$events.listen("tinymist-fallback-enable", (enabled: boolean) => this.enabled = enabled);
        window.$events.listen("tinymist-fallback-compile", async ({ docVersion, content }: { docVersion: number; content: string }) => {
            await this.compile(docVersion, content, this.pageId);
        });
    }

    /**
     * Compile Typst source to SVG
     */
    async compile(docVersion: number, content: string, pageId: number): Promise<void> {
        if (!this.enabled) {
            return;
        }

        console.log(`[Typst] Starting Typst compilation #${docVersion} (fallback mode)`);
        window.$events.emit("tinymist-console-log",{ type: "info", message: "[Typst] Compiling..." });

        try {
            const response = await window.$http.post('/ajax/tinymist/compile', { content, docVersion, pageId });

            console.log(`[Typst] Compilation #${docVersion} completed (processing...)`);

            const respData = response && response.data;

            // Guard the shape of respData before accessing properties to avoid errors
            if (respData && typeof respData === 'object' && 'success' in respData) {
                const data = respData as { success: boolean; docVersion?: number; svg?: string; errors?: string[]; diagnostics?: any[] };

                if (data.success) {
                    // Store and show SVG
                    window.$events.emit("tinymist-fallback-compiled-svg", { svg: data.svg || "", docVersion: data.docVersion });
                    window.$events.emit("tinymist-console-log",{ type: "success", message: `[Typst] Compiled successfully (${content.length} chars)` });

                    // Update cached diagnostics
                    if (data.diagnostics && data.diagnostics.length > 0) {
                        window.$events.emit("tinymist-diagnostics", { diagnostics: data.diagnostics, docVersion: data.docVersion });
                    } else {
                        // Clear diagnostics on successful compilation with no errors
                        console.log('[Typst] Clearing diagnostics (success with no errors)');
                        window.$events.emit("tinymist-diagnostics", { diagnostics: [], docVersion: data.docVersion });
                    }
                } else {
                    if (data.diagnostics && Array.isArray(data.diagnostics) && data.diagnostics.length > 0) {
                        window.$events.emit("tinymist-diagnostics", { diagnostics: data.diagnostics, docVersion: data.docVersion });
                    } else {
                        // No diagnostics parsed - log raw errors as fallback
                        data.errors?.forEach((error) =>  window.$events.emit("tinymist-console-log",{ type: "error", message: "[Typst] Compile Error", details: error }));
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

}
