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
    private hasInitialDocument: boolean = false; // Track if we've received initial document to decide if "reset" instead of "merge" is needed
    private processingQueue: Promise<void> = Promise.resolve();
    private cursorInitialized: boolean = false;
    private recovering: boolean = false;
    private recoveryAttempts: number = 0;
    private zoomLevel = 1;
    private readonly zoomStep = 0.1;
    private readonly zoomMin = 0.25;
    private readonly zoomMax = 3;
    private baseSvgWidth: number | null = null;
    private baseSvgHeight: number | null = null;
    private panEnabled = false;
    private isPanning = false;
    private panStartX = 0;
    private panStartY = 0;
    private panStartScrollLeft = 0;
    private panStartScrollTop = 0;
    private activeFileName = "entry.typ";
    private cursorSpotlightUserEnabled = true;
    private scrollIntoViewUserEnabled = true;


    constructor(
        previewElement: HTMLElement,
    ) {
        this.previewElement = previewElement;

        this.handleSyncInit = this.handleSyncInit.bind(this);
        this.dispose = this.dispose.bind(this);
        window.$events.listen("tinymist-wasm-init", this.handleSyncInit)
        window.$events.listen("tinymist-wasm-dispose", this.dispose);

        this.updateSVG = this.updateSVG.bind(this);
        window.$events.listen<{svg: string, docVersion:string}>("tinymist-fallback-compiled-svg", ({svg, docVersion}) => this.updateSVG(svg));

        this.handleSyncMessage = this.handleSyncMessage.bind(this);
        this.handleZoomIn = this.handleZoomIn.bind(this);
        this.handleZoomOut = this.handleZoomOut.bind(this);
        this.handleZoomReset = this.handleZoomReset.bind(this);
        this.handlePreviewPaneClick = this.handlePreviewPaneClick.bind(this);
        this.handlePanMouseDown = this.handlePanMouseDown.bind(this);
        this.handlePanMouseMove = this.handlePanMouseMove.bind(this);
        this.handlePanMouseUp = this.handlePanMouseUp.bind(this);
        this.handleCursorPosition = this.handleCursorPosition.bind(this);

        window.$events.listen("tinymist-data-binary", this.handleSyncMessage);
        window.$events.listen("tinymist-preview-cursor-position", this.handleCursorPosition);

        window.$events.listen("tinymist-active-file-change", (payload: { fileName: string; url: string }) => {
            this.activeFileName = payload.fileName;
            this.applyCursorSpotlightState();
            this.applyScrollIntoViewState();
        });
        this.previewElement.closest(".tinymist-preview-pane")?.addEventListener("click", this.handlePreviewPaneClick);

        this.previewElement.addEventListener("mousedown", this.handlePanMouseDown);
        this.previewElement.addEventListener("mousemove", this.handlePanMouseMove);
        this.previewElement.addEventListener("mouseup", this.handlePanMouseUp);
        this.previewElement.addEventListener("mouseleave", this.handlePanMouseUp);

        this.applyCursorSpotlightState();
        this.applyScrollIntoViewState();
        this.applyPanButtonState();
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

            // console.log(`[Preview WASM] Message command "${command}" (payload ${payload.length} bytes)`);
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
                let action: 'reset' | 'merge' = command === 'new' ? 'reset' : 'merge'; // 'merge' or 'reset'

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

                // Always comes as an empty array?
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

                // It comes as SVG string with data-reuse-from="data-tid hash" attributes
                // Probably it needs a morphing library
                // const svgDiff = session.renderSvgDiff({data_selection: { body: true, defs: true, css: false, js: false }});
                // console.log('[Preview WASM] SVG diff:', svgDiff);

                this.updateSVG(svg);

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

    updateSVG(svg: string, docVersion?: number) {
        // Remove "Loading..." and error messages
        // TODO: optimize so those shouldn't run on each change
        this.previewElement.querySelector(".text-muted.p-m")?.remove();
        this.previewElement.querySelector(".tinymist-error")?.remove();
        let svgHost = this.previewElement.querySelector(".tinymist-document") as HTMLElement | null;
        if (!svgHost) {
            svgHost = document.createElement("div");
            svgHost.className = "tinymist-document";
            this.previewElement.appendChild(svgHost);
        }

        svgHost.innerHTML = svg;
        this.baseSvgWidth = null;
        this.baseSvgHeight = null;
        this.applyZoomToSvg();
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

        this.previewElement.closest(".tinymist-preview-pane")?.removeEventListener("click", this.handlePreviewPaneClick);
        window.$events.remove("tinymist-preview-cursor-position", this.handleCursorPosition);

        console.log("[Preview WASM] Renderer disposed");
    }

    private handleZoomIn(): void {
        this.setZoom(this.zoomLevel + this.zoomStep);
    }

    private handleZoomOut(): void {
        this.setZoom(this.zoomLevel - this.zoomStep);
    }

    private handleZoomReset(): void {
        this.setZoom(1);
    }

    private handlePanToggle(enabled: boolean): void {
        this.panEnabled = enabled;
        if (!enabled) {
            this.stopPanning();
        }
        this.previewElement.classList.toggle("tinymist-preview-pan-enabled", enabled);
        this.applyPanButtonState();
    }

    private handlePreviewPaneClick(event: Event): void {
        const button = (event.target as Element | null)?.closest("button[data-action]") as HTMLButtonElement | null;
        if (!button) {
            return;
        }

        const action = button.getAttribute("data-action");
        switch (action) {
            case "previewZoomIn":
                this.handleZoomIn();
                break;
            case "previewZoomOut":
                this.handleZoomOut();
                break;
            case "previewZoomReset":
                this.handleZoomReset();
                break;
            case "previewPanToggle":
                this.handlePanToggle(!this.panEnabled);
                break;
            case "previewScrollIntoViewToggle":
                this.scrollIntoViewUserEnabled = !this.scrollIntoViewUserEnabled;
                this.applyScrollIntoViewState();
                break;
            case "previewCursorSpotlightToggle":
                this.cursorSpotlightUserEnabled = !this.cursorSpotlightUserEnabled;
                this.applyCursorSpotlightState();
                break;
            default:
                break;
        }
    }

    private applyPanButtonState(): void {
        const button = this.previewElement.closest(".tinymist-preview-pane")?.querySelector('button[data-action="previewPanToggle"]') as HTMLButtonElement | null;
        if (!button) {
            return;
        }
        button.setAttribute("aria-pressed", this.panEnabled.toString());
        button.setAttribute("title", this.panEnabled ? "Disable Hand Tool" : "Enable Hand Tool");
    }

    private applyCursorSpotlightState(): void {
        const enabled = this.cursorSpotlightUserEnabled && this.activeFileName === "entry.typ";

        const button = this.previewElement.closest(".tinymist-preview-pane")?.querySelector('button[data-action="previewCursorSpotlightToggle"]') as HTMLButtonElement | null;
        if (button) {
            button.setAttribute("aria-pressed", enabled.toString());
            button.setAttribute("title", enabled ? "Disable Caret Spotlight" : "Enable Caret Spotlight");
        }

        window.$events.emit("tinymist-cursor-spotlight-toggle", {
            enabled,
            activeFile: this.activeFileName,
            userEnabled: this.cursorSpotlightUserEnabled,
        });
    }

    private applyScrollIntoViewState(): void {
        const enabled = this.scrollIntoViewUserEnabled && this.activeFileName === "entry.typ";

        const button = this.previewElement.closest(".tinymist-preview-pane")?.querySelector('button[data-action="previewScrollIntoViewToggle"]') as HTMLButtonElement | null;
        if (button) {
            button.setAttribute("aria-pressed", enabled.toString());
            button.setAttribute("title", enabled ? "Disable Scroll Into View" : "Enable Scroll Into View");
        }

        window.$events.emit("tinymist-cursor-scroll-into-view-toggle", {
            enabled,
            activeFile: this.activeFileName,
            userEnabled: this.scrollIntoViewUserEnabled,
        });
    }

    private handleCursorPosition(payload: { contentX?: number; contentY?: number; width?: number; height?: number }): void {
        const enabled = this.scrollIntoViewUserEnabled && this.activeFileName === "entry.typ";
        if (!enabled) {
            return;
        }

        const contentX = Number(payload?.contentX);
        const contentY = Number(payload?.contentY);
        const width = Math.max(1, Number(payload?.width ?? 1));
        const height = Math.max(1, Number(payload?.height ?? 1));
        if (!Number.isFinite(contentX) || !Number.isFinite(contentY)) {
            return;
        }

        this.scrollPreviewToClosestVisibleArea(contentX, contentY, width, height);
    }

    private scrollPreviewToClosestVisibleArea(contentX: number, contentY: number, width: number, height: number): void {
        const viewportWidth = this.previewElement.clientWidth;
        const viewportHeight = this.previewElement.clientHeight;
        if (viewportWidth <= 0 || viewportHeight <= 0) {
            return;
        }

        const marginX = Math.max(24, Math.min(120, viewportWidth * 0.1));
        const marginY = Math.max(24, Math.min(120, viewportHeight * 0.1));

        const minVisibleX = this.previewElement.scrollLeft + marginX;
        const maxVisibleX = this.previewElement.scrollLeft + viewportWidth - marginX;
        const minVisibleY = this.previewElement.scrollTop + marginY;
        const maxVisibleY = this.previewElement.scrollTop + viewportHeight - marginY;

        const cursorLeft = contentX - width / 2;
        const cursorRight = contentX + width / 2;
        const cursorTop = contentY - height / 2;
        const cursorBottom = contentY + height / 2;

        let nextScrollLeft = this.previewElement.scrollLeft;
        let nextScrollTop = this.previewElement.scrollTop;

        if (cursorLeft < minVisibleX) {
            nextScrollLeft = cursorLeft - marginX;
        } else if (cursorRight > maxVisibleX) {
            nextScrollLeft = cursorRight - viewportWidth + marginX;
        }

        if (cursorTop < minVisibleY) {
            nextScrollTop = cursorTop - marginY;
        } else if (cursorBottom > maxVisibleY) {
            nextScrollTop = cursorBottom - viewportHeight + marginY;
        }

        nextScrollLeft = Math.max(0, nextScrollLeft);
        nextScrollTop = Math.max(0, nextScrollTop);

        if (Math.abs(nextScrollLeft - this.previewElement.scrollLeft) < 1 && Math.abs(nextScrollTop - this.previewElement.scrollTop) < 1) {
            return;
        }

        this.previewElement.scrollTo({
            left: nextScrollLeft,
            top: nextScrollTop,
            behavior: "smooth",
        });
    }

    private setZoom(level: number): void {
        const clamped = Math.min(this.zoomMax, Math.max(this.zoomMin, Number(level)));
        this.zoomLevel = Number(clamped.toFixed(2));
        this.applyZoomToSvg();
    }

    private applyZoomToSvg(): void {
        const svg = this.previewElement.querySelector("svg") as SVGElement | null;
        if (!svg) {
            return;
        }

        if (this.baseSvgWidth === null || this.baseSvgHeight === null) {
            const rect = svg.getBoundingClientRect();
            const fallbackWidth = svg.clientWidth || rect.width;
            const fallbackHeight = svg.clientHeight || rect.height;
            this.baseSvgWidth = fallbackWidth || 0;
            this.baseSvgHeight = fallbackHeight || 0;
        }

        const width = (this.baseSvgWidth || 0) * this.zoomLevel;
        const height = (this.baseSvgHeight || 0) * this.zoomLevel;
        svg.style.width = `${Math.max(1, width)}px`;
        svg.style.height = `${Math.max(1, height)}px`;
        svg.style.maxWidth = "none";
    }

    private handlePanMouseDown(event: MouseEvent): void {
        if (!this.panEnabled || event.button !== 0) {
            return;
        }

        this.isPanning = true;
        this.panStartX = event.clientX;
        this.panStartY = event.clientY;
        this.panStartScrollLeft = this.previewElement.scrollLeft;
        this.panStartScrollTop = this.previewElement.scrollTop;
        this.previewElement.classList.add("tinymist-preview-panning");
        event.preventDefault();
    }

    private handlePanMouseMove(event: MouseEvent): void {
        if (!this.isPanning) {
            return;
        }

        const dx = event.clientX - this.panStartX;
        const dy = event.clientY - this.panStartY;
        this.previewElement.scrollLeft = this.panStartScrollLeft - dx;
        this.previewElement.scrollTop = this.panStartScrollTop - dy;
        event.preventDefault();
    }

    private handlePanMouseUp(): void {
        if (!this.isPanning) {
            return;
        }

        this.stopPanning();
    }

    private stopPanning(): void {
        this.isPanning = false;
        this.previewElement.classList.remove("tinymist-preview-panning");
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
