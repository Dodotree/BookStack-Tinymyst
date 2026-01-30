// preview element initially gets filled from database
// that saves ready to insert svg in html field if it's not empty

// receives 'new' or 'diff-v1' binary messages from preview_ws
// or ready to insert svg from fallback compiler
// WASM module renders binary  to svg

// in any case preview element updates
// cursor should be alerted upon update and try to reinsert itself
// (if svg structure didn't change former cursor paths)

import {
    rendererBuildInfo,
    createTypstRenderer,
    RenderSession,
    TypstRenderer,
} from "@myriaddreamin/typst.ts/dist/esm/renderer.mjs";

// Import WASM binary to trigger esbuild plugin (embeds as base64)
import renderModule from "@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm";
import { PreviewCursor } from "./cursor";

export class PreviewRenderer {
    private renderer: TypstRenderer | null = null;
    private session: RenderSession | null = null;
    private sessionPromise: Promise<RenderSession> | null = null;
    private sessionResolve: (() => void) | null = null;
    private previewElement: HTMLElement;
    private hasInitialDocument: boolean = false; // Track if we've received initial document
    private processingQueue: Promise<void> = Promise.resolve();
    private cursorInitialized: boolean = false;
    private recovering: boolean = false;
    private recoveryAttempts: number = 0;


    constructor(
        previewElement: HTMLElement,
    ) {
        this.previewElement = previewElement;

        this.handleSyncInit = this.handleSyncInit.bind(this);
        this.dispose = this.dispose.bind(this);
        this.handleSyncMessage = this.handleSyncMessage.bind(this);
        window.$events.listen("tinymist-wasm-init", this.handleSyncInit)
        window.$events.listen("tinymist-wasm-dispose", this.dispose);

        window.$events.listen("tinymist-data-binary", this.handleSyncMessage);
    }

    private async handleSyncInit(): Promise<void> {
        try {
            await this.initialize();
        } catch (err) {
            console.error("[Preview WASM] Failed to initialize:", err);
            window.$events.emit("tinymist-console-log", { type: "error", message: "[Preview WASM] init failed", details: err });
        }
    }

    private async handleSyncMessage({command, payload} : {command: string, payload: Uint8Array}): Promise<void> {
            // Queue processing to maintain order
            this.processingQueue = this.processingQueue.then(() =>
                this.handleBinaryMessage(command, payload)
            ).catch((err) => {
                console.error('[Preview WASM] Error processing binary message:', err);
            });
        }

    async initialize() {
        try {
            // Initialize WASM renderer
            this.renderer = createTypstRenderer();

            // Provide WASM binary explicitly (loaded via esbuild plugin)
            await this.renderer.init({
                getModule: () => renderModule, // Returns Uint8Array from esbuild WASM plugin
            });

            if (!this.cursorInitialized) {
                new PreviewCursor(this.previewElement);
                this.cursorInitialized = true;
            }

            console.log("[Preview WASM] typst-ts-renderer initialized");

        } catch (error) {
            console.error("[Preview WASM] Failed to initialize typst-ts-renderer:", error);
            throw error;
        }
    }

    private async ensureSession(): Promise<RenderSession> {
        if (!this.renderer) {
            throw new Error('Renderer not initialized');
        }

        if (this.session) {
            return this.session;
        }

        if (!this.sessionPromise) {
            console.log('[Preview WASM] Creating persistent session');
            this.sessionPromise = new Promise<RenderSession>((resolve, reject) => {
                this.renderer!.runWithSession(async (session) => {
                    this.session = session;
                    this.hasInitialDocument = false;
                    resolve(session);

                    await new Promise<void>((res) => {
                        this.sessionResolve = res;
                    });
                }).catch((err) => {
                    this.session = null;
                    this.sessionPromise = null;
                    this.sessionResolve = null;
                    reject(err);
                });
            });
        }

        return this.sessionPromise;
    }

    private async handleBinaryMessage(command: string, payload: Uint8Array) {

            console.log(`[Preview WASM] Message command "${command}" (payload ${payload.length} bytes)`);
            if (!this.renderer) {
                console.warn("[Preview WASM] Renderer not ready");
                return;
            }

            if (command !== 'diff-v1' && command !== 'new') {
                console.warn(`[Preview WASM] Unexpected command: ${command}`);
                return;
            }

            try {
                const isDiff = command === 'diff-v1';
                let action: 'reset' | 'merge' = command === 'new' ? 'reset' : 'merge';

                const session = await this.ensureSession();

                if (isDiff && !this.hasInitialDocument) {
                    console.warn('[Preview WASM] Treating first diff as full reset');
                    action = 'reset';
                }

                console.log(`[Preview WASM] Applying ${action} with ${payload.length} bytes`);
                // same as session.manipulateData
                const diffResult = this.renderer!.manipulateData({
                    renderSession: session,
                    action,
                    data: payload,
                });
                console.log("[Preview WASM] Data applied successfully, diffResult:", diffResult);

                if (action === 'reset') {
                    this.hasInitialDocument = true;
                }

                // try {
                //     const customData = await this.renderer!.getCustomV1({
                //         renderSession: session,
                //     });
                //     console.log('[Preview WASM] Custom data:', customData);
                // } catch (e) {
                //     console.log('[Preview WASM] No custom data:', e);
                // }

                console.log('[Preview WASM] Rendering to SVG...');
                // defaults are all true, right now have no use for inline helper script
                // css needed to hide text overlays for copy/paste, now css included in page editor blade
                // could be simple session.renderSvg({});
                const svg = await session.renderSvg({
                    data_selection: { body: true, defs: true, css: false, js: false },
                });

                this.previewElement.innerHTML = svg;

                // const svgDoc = this.previewElement.querySelector('svg.typst-doc');
                // const helperCode = document.querySelector('svg.typst-doc script')?.textContent;
                // it contains handleTypstLocation function and adds location.hash #loc-page-x-y
                // if (helperCode && svgDoc) {
                //     const run = document.createElement("script");
                //     run.textContent = helperCode;
                //     // document.head.append(run);
                //     svgDoc.append(run);
                //     // window.typstProcessSvg(svgDoc as SVGElement);
                // }

                console.log('[Preview WASM] Render complete');
                window.$events.emit("tinymist-data-cursor-show"); // reinsert cursor if possible

            } catch (e: any) {
                console.error(`[Preview WASM] Rendering failed:`, e);
                this.previewElement.innerHTML = `
                    <div style="padding: 20px; color: #721c24; background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px;">
                        <h4>Preview Rendering Failed</h4>
                        <p><strong>Command:</strong> ${command}</p>
                        <p><strong>Payload size:</strong> ${payload.length} bytes</p>
                        <p><strong>Error:</strong> ${e.message || String(e)}</p>
                        <p style="margin-top: 10px; font-size: 0.9em;">
                            Check browser console for details
                        </p>
                    </div>
                `;
                await this.recoverRenderer(e);
            }

    }

    dispose() {
        this.hasInitialDocument = false;
        this.processingQueue = Promise.resolve();
        if (this.sessionResolve) {
            this.sessionResolve();
            this.sessionResolve = null;
        }

        this.sessionPromise = null;
        this.session = null;
        this.renderer = null;

        console.log("[Preview WASM] Renderer disposed");
    }

    private async recoverRenderer(error: Error): Promise<void> {
        if (this.recovering) {
            console.warn("[Preview WASM] Recovery already in progress, skipping additional request");
            return;
        }

        this.recovering = true;
        this.recoveryAttempts += 1;

        window.$events.emit("tinymist-console-log", {
            type: "warning",
            message: `[Preview WASM] Renderer failed (${error.message ?? error}). Restarting session...`,
        });

        try {
            this.dispose();
            await this.initialize();
            window.$events.emit("tinymist-console-log", {
                type: "success",
                message: "[Preview WASM] Renderer session restarted",
            });
        } catch (restartError) {
            console.error("[Preview WASM] Recovery failed:", restartError);
            window.$events.emit("tinymist-console-log", {
                type: "error",
                message: "[Preview WASM] Renderer recovery failed",
                details: restartError,
            });
        } finally {
            this.recovering = false;
        }
    }

}
