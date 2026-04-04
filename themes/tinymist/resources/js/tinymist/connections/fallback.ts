// Gets svg and diagnostics from the typst compiler service
// via AJAX when editor_sync or preview_ws WebSocket connections are unavailable
// polls the compile endpoint with debouncing
// diagnostics output parsed on the backend
// when compilations succeed, provides SVG to fill the preview pane

/**
 * Fallback compiler for Typst when WebSocket sync is unavailable
 * Handles compilation via AJAX endpoint and diagnostic processing
 */

import { FALLBACK_COMPILE_URL, tmEvents } from "../constants";

export class TinymistFallbackCompiler {
    private enabled: boolean = false;
    private pageId: number|string = "";
    private httpService: any;

    constructor(pageId: number|string, httpService: any) {
        this.pageId = pageId;
        this.httpService = httpService;

        this.compile = this.compile.bind(this);
        this.destroy = this.destroy.bind(this);
        window.$tmEventBus.listen(
            tmEvents.FallbackEnable,
            (enabled: boolean) => (this.enabled = enabled),
        );
        window.$tmEventBus.listen(
            tmEvents.FallbackCompile,
            async ({
                docVersion,
                content,
            }: {
                docVersion: number;
                content: string;
            }) => {
                await this.compile(docVersion, content);
            },
        );
        window.$tmEventBus.listen(tmEvents.Destroy, this.destroy);
    }

    /**
     * Compile Typst source to SVG
     */
    async compile(
        docVersion: number,
        content: string,
    ): Promise<void> {
        if (!this.enabled) {
            return;
        }

        window.$tmEventBus.emit(tmEvents.ConsoleLog, {
            type: "info",
            message: "[Typst] Compiling...",
        });

        try {
            const response = await this.httpService.post(FALLBACK_COMPILE_URL, {
                content,
                docVersion,
                pageId: this.pageId,
            });

            const respData = response && response.data;

            // Guard the shape of respData before accessing properties to avoid errors
            if (
                respData &&
                typeof respData === "object" &&
                "success" in respData
            ) {
                const data = respData as {
                    success: boolean;
                    docVersion?: number;
                    svg?: string;
                    errors?: string[];
                    diagnostics?: any[];
                };

                if (data.success) {
                    // Store and show SVG
                    window.$tmEventBus.emit(tmEvents.FallbackCompiledSvg, {
                        svg: data.svg || "",
                        docVersion: data.docVersion,
                    });
                    window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                        type: "success",
                        message: `[Typst] Compiled successfully (${content.length} chars)`,
                    });

                    // Update cached diagnostics
                    if (data.diagnostics && data.diagnostics.length > 0) {
                        window.$tmEventBus.emit(tmEvents.Diagnostics, {
                            diagnostics: data.diagnostics,
                            docVersion: data.docVersion,
                        });
                    } else {
                        window.$tmEventBus.emit(tmEvents.Diagnostics, {
                            diagnostics: [],
                            docVersion: data.docVersion,
                        });
                    }
                } else {
                    if (
                        data.diagnostics &&
                        Array.isArray(data.diagnostics) &&
                        data.diagnostics.length > 0
                    ) {
                        window.$tmEventBus.emit(tmEvents.Diagnostics, {
                            diagnostics: data.diagnostics,
                            docVersion: data.docVersion,
                        });
                    } else {
                        // No diagnostics parsed - log raw errors as fallback
                        data.errors?.forEach((error) =>
                            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                                type: "error",
                                message: "[Typst] Compile Error",
                                details: error,
                            }),
                        );
                    }
                }
            } else if (typeof respData === "string") {
                // Server returned a plain string error/message
                window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                    type: "error",
                    message: "[Typst] Server response",
                    details: respData,
                });
            } else {
                // Unexpected response shape
                console.error("[Typst] Unexpected compile response:", response);
                window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                    type: "error",
                    message: "[Typst] Unexpected server response.",
                    details: response,
                });
            }
        } catch (error) {
            console.error("[Typst] Compilation failed:", error);
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "error",
                message:
                    "[Typst] Compilation failed. Check console for details.",
                details: error,
            });
        }
    }

    destroy(): void {
        this.enabled = false;
        this.httpService = null;
    }
}
