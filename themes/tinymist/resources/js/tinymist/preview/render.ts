// preview element initially gets filled with svg from database

// receives 'new' or 'diff-v1' binary messages from preview_ws
// or ready to insert svg from fallback compiler
// WASM module renders binary to svg

import {
    rendererBuildInfo,
    createTypstRenderer,
    RenderSession,
    TypstRenderer,
} from "@myriaddreamin/typst.ts/dist/esm/renderer.mjs";

// Import WASM binary to trigger esbuild plugin (embeds as base64)
import renderModule from "@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm";
import { PreviewCursor } from "./cursor";

import {
    ENTRY_FILE_NAME,
    tmClassNames,
    tmEvents,
    tmSelectors,
} from "../constants";

export class PreviewRenderer {
    private paneSelector: string;
    private previewElement: HTMLElement;

    private renderer: TypstRenderer | null = null;
    private session: RenderSession | null = null;
    private sessionPromise: Promise<RenderSession> | null = null;
    private sessionResolve: (() => void) | null = null;
    private hasInitialDocument: boolean = false; // Track to decide if "reset" instead of "merge" is needed
    private processingQueue: Promise<void> = Promise.resolve();

    private recovering: boolean = false;
    private recoveryAttempts: number = 0;

    // Poor mans Exponential Moving Weighted Average counted per tick counted as 0.4*collected +0.6*incoming
    private pmewmaNew: number = 0;
    private pmewmaDiff: number = 0;

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

    private activeFileName = ENTRY_FILE_NAME;
    private cursorSpotlightUserEnabled = true;
    private scrollIntoViewUserEnabled = true;

    constructor(uniqueTabId?: string) {
        this.paneSelector = `${tmSelectors.Root} ${tmSelectors.PreviewPane}`;
        this.previewElement = document.querySelector(`${tmSelectors.Root} ${tmSelectors.PreviewContent}`) as HTMLElement;

        new PreviewCursor(this.previewElement, uniqueTabId);

        this.handleSyncInit = this.handleSyncInit.bind(this);
        this.dispose = this.dispose.bind(this);
        this.updateSVG = this.updateSVG.bind(this);
        this.handleSyncMessage = this.handleSyncMessage.bind(this);
        this.handleZoomIn = this.handleZoomIn.bind(this);
        this.handleZoomOut = this.handleZoomOut.bind(this);
        this.handleZoomReset = this.handleZoomReset.bind(this);
        this.handlePreviewPaneClick = this.handlePreviewPaneClick.bind(this);
        this.handlePanMouseDown = this.handlePanMouseDown.bind(this);
        this.handlePanMouseMove = this.handlePanMouseMove.bind(this);
        this.handlePanMouseUp = this.handlePanMouseUp.bind(this);
        this.handleCursorPosition = this.handleCursorPosition.bind(this);

        window.$tmEventBus.listen(tmEvents.WasmInit, this.handleSyncInit);
        window.$tmEventBus.listen(tmEvents.WasmDispose, this.dispose);

        window.$tmEventBus.listen(
            tmEvents.FallbackCompiledSvg,
            ({ svg, docVersion }) => this.updateSVG(svg),
        );

        window.$tmEventBus.listen(tmEvents.DataBinary, this.handleSyncMessage);
        window.$tmEventBus.listen(
            tmEvents.PreviewCursorPosition,
            this.handleCursorPosition,
        );

        window.$tmEventBus.listen(
            tmEvents.ActiveFileChange,
            (payload: { fileName: string; url: string }) => {
                this.activeFileName = payload.fileName || ENTRY_FILE_NAME;
                this.applyCursorSpotlightState();
                this.applyScrollIntoViewState();
            },
        );

        this.addRemoveListeners(true);
        this.applyCursorSpotlightState();
        this.applyScrollIntoViewState();
        this.applyPanButtonState();
    }

    private addRemoveListeners(adding: boolean = true): void {
        const method = adding ? "addEventListener" : "removeEventListener";

        document.querySelector(this.paneSelector)
            ?.[method]("click", this.handlePreviewPaneClick);

        this.previewElement[method]("mousedown", this.handlePanMouseDown);
        this.previewElement[method]("mousemove", this.handlePanMouseMove);
        this.previewElement[method]("mouseup", this.handlePanMouseUp);
        this.previewElement[method]("mouseleave", this.handlePanMouseUp);
    }

    private async handleSyncInit(): Promise<void> {
        try {
            await this.initialize();
        } catch (err) {
            console.error("[Preview WASM] Failed to initialize:", err);
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "error",
                message: "[Preview WASM] init failed",
                details: err,
            });
        }
    }

    private async handleSyncMessage({
        command,
        payload,
    }: {
        command: string;
        payload: Uint8Array;
    }): Promise<void> {
        // Queue processing to maintain order
        this.processingQueue = this.processingQueue
            .then(() => this.handleBinaryMessage(command, payload))
            .catch((err) => {
                console.error(
                    "[Preview WASM] Error processing binary message:",
                    err,
                );
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

            console.log("[Preview WASM] typst-ts-renderer initialized");
        } catch (error) {
            console.error(
                "[Preview WASM] Failed to initialize typst-ts-renderer:",
                error,
            );
            throw error;
        }
    }

    private async ensureSession(): Promise<RenderSession> {
        if (!this.renderer) {
            throw new Error("Renderer not initialized");
        }

        if (this.session) {
            return this.session;
        }

        if (!this.sessionPromise) {
            console.log("[Preview WASM] Creating persistent session");
            this.sessionPromise = new Promise<RenderSession>(
                (resolve, reject) => {
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
                },
            );
        }

        return this.sessionPromise;
    }

    private async handleBinaryMessage(command: string, payload: Uint8Array) {
        // console.log(`[Preview WASM] Message command "${command}" (payload ${payload.length} bytes)`);
        if (!this.renderer) {
            console.warn("[Preview WASM] Renderer not ready");
            return;
        }

        if (command !== "diff-v1" && command !== "new") {
            console.warn(`[Preview WASM] Unexpected command: ${command}`);
            return;
        }

        try {
            let action: "reset" | "merge" =
                command === "new" ? "reset" : "merge"; // 'merge' or 'reset'

            const session = await this.ensureSession();

            if (!this.hasInitialDocument) {
                console.warn(
                    "[Preview WASM] Treating first diff as full reset",
                );
                action = "reset";
            }

            // If average diff size in smaller than whole doc size ('new')
            // If new and diff sizes are noticeably different
            // If incoming diff is 5 times bigger than average diff size
            // We will bet on 'reset' instead of 'merge'
            // But it still leaves out huge copy-paste and similar, which can be improved on and tracked separately if needed
            const diffVsNewRatio = this.pmewmaDiff / Math.max(1, this.pmewmaNew);
            if( action === "merge" && diffVsNewRatio > 0.7 && diffVsNewRatio < 1 && payload.length / Math.max(1, this.pmewmaNew) > diffVsNewRatio * 5) {
                action = "reset";
            }

            console.log(
                `[Preview WASM] Applying "${command}" action "${action}" with ${payload.length} bytes`,
            );

            this.renderer!.manipulateData({
                renderSession: session,
                action,
                data: payload,
            });

            if (action === "reset") {
                this.hasInitialDocument = true;
            }

            // defaults are all true, right now have no use for inline helper script
            // could be simple session.renderSvg({});
            const svg = await session.renderSvg({
                data_selection: {
                    body: true,
                    defs: true,
                    css: false,
                    js: false,
                },
            });

            this.updateSVG(svg);

            if (command === "diff-v1") {
                this.pmewmaDiff = 0.4 * this.pmewmaDiff + 0.6 * payload.length;
            } else {
                this.pmewmaNew = 0.4 * this.pmewmaNew + 0.6 * payload.length;
            }

            console.log(`[Preview WASM] Render "${command}" action "${action}" complete`);
            window.$tmEventBus.emit(tmEvents.DataCursorShow); // reinsert cursor if possible

        } catch (e: any) {
            console.error(`[Preview WASM] Rendering failed:`, e);

            this.previewElement.innerHTML = `
                <div class="${tmClassNames.PreviewError}">
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
        this.previewElement.querySelector(tmSelectors.PreviewMutedMessage)
            ?.remove();
        this.previewElement.querySelector(tmSelectors.PreviewError)
            ?.remove();

        let svgHost = this.previewElement.querySelector(tmSelectors.PreviewDocumentHost,) as HTMLElement | null;
        if (!svgHost) {
            svgHost = document.createElement("div");
            svgHost.className = tmClassNames.PreviewDocumentHost;
            this.previewElement.appendChild(svgHost);
        }

        svgHost.innerHTML = svg;
        this.baseSvgWidth = null;
        this.baseSvgHeight = null;
        this.applyZoomToSvg();

        const marker = document.querySelector('[data-typst-label^="doc-version-"]');
        const version = marker?.getAttribute('data-typst-label')?.slice('doc-version-'.length) as number | undefined;
        if (version) {
            window.$tmEventBus.emit(tmEvents.RenderVersion, {
                version,
            });
        }
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

        this.previewElement.classList.toggle(
            tmClassNames.PreviewPanEnabled,
            enabled,
        );
        this.applyPanButtonState();
    }

    private handlePreviewPaneClick(event: Event): void {
        const button = (event.target as Element | null)?.closest(
            tmSelectors.ActionButton,
        ) as HTMLButtonElement | null;
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
                this.scrollIntoViewUserEnabled =
                    !this.scrollIntoViewUserEnabled;
                this.applyScrollIntoViewState();
                break;
            case "previewCursorSpotlightToggle":
                this.cursorSpotlightUserEnabled =
                    !this.cursorSpotlightUserEnabled;
                this.applyCursorSpotlightState();
                break;
            default:
                break;
        }
    }

    private applyPanButtonState(): void {
        const button = document.querySelector(
            `${this.paneSelector} ${tmSelectors.PreviewPan}`,
        ) as HTMLButtonElement | null;

        if (!button) {
            return;
        }
        button.setAttribute("aria-pressed", this.panEnabled.toString());
        button.setAttribute(
            "title",
            this.panEnabled ? "Disable Hand Tool" : "Enable Hand Tool",
        );
    }

    private applyCursorSpotlightState(): void {
        const enabled =
            this.cursorSpotlightUserEnabled &&
            this.activeFileName === ENTRY_FILE_NAME;

        const button = document.querySelector(
            `${this.paneSelector} ${tmSelectors.PreviewCursorSpotlight}`,
        ) as HTMLButtonElement | null;
        if (button) {
            button.setAttribute("aria-pressed", enabled.toString());
            button.setAttribute(
                "title",
                enabled ? "Disable Caret Spotlight" : "Enable Caret Spotlight",
            );
        }

        window.$tmEventBus.emit(tmEvents.CursorSpotlightToggle, {
            enabled,
            activeFile: this.activeFileName,
            userEnabled: this.cursorSpotlightUserEnabled,
        });
    }

    private applyScrollIntoViewState(): void {
        const enabled =
            this.scrollIntoViewUserEnabled &&
            this.activeFileName === ENTRY_FILE_NAME;

        const button = document.querySelector(
            `${this.paneSelector} ${tmSelectors.PreviewScrollIntoView}`,
        ) as HTMLButtonElement | null;
        if (button) {
            button.setAttribute("aria-pressed", enabled.toString());
            button.setAttribute(
                "title",
                enabled
                    ? "Disable Scroll Into View"
                    : "Enable Scroll Into View",
            );
        }

        window.$tmEventBus.emit(tmEvents.CursorScrollIntoViewToggle, {
            enabled,
            activeFile: this.activeFileName,
            userEnabled: this.scrollIntoViewUserEnabled,
        });
    }

    private handleCursorPosition(payload: {
        contentX?: number;
        contentY?: number;
        width?: number;
        height?: number;
    }): void {
        const enabled =
            this.scrollIntoViewUserEnabled &&
            this.activeFileName === ENTRY_FILE_NAME;
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

        this.scrollPreviewToClosestVisibleArea(
            contentX,
            contentY,
            width,
            height,
        );
    }

    private scrollPreviewToClosestVisibleArea(
        contentX: number,
        contentY: number,
        width: number,
        height: number,
    ): void {

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

        if (
            Math.abs(nextScrollLeft - this.previewElement.scrollLeft) < 1 &&
            Math.abs(nextScrollTop - this.previewElement.scrollTop) < 1
        ) {
            return;
        }

        this.previewElement.scrollTo({
            left: nextScrollLeft,
            top: nextScrollTop,
            behavior: "smooth",
        });
    }

    private setZoom(level: number): void {
        const clamped = Math.min(
            this.zoomMax,
            Math.max(this.zoomMin, Number(level)),
        );
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

    private handlePanMouseDown(event: Event): void {
        const mouseEvent = event as MouseEvent;
        if (!this.panEnabled || mouseEvent.button !== 0) {
            return;
        }

        this.isPanning = true;
        this.panStartX = mouseEvent.clientX;
        this.panStartY = mouseEvent.clientY;
        this.panStartScrollLeft = this.previewElement.scrollLeft;
        this.panStartScrollTop = this.previewElement.scrollTop;
        this.previewElement.classList.add(tmClassNames.PreviewPanning);
        event.preventDefault();
    }

    private handlePanMouseMove(event: Event): void {
        if (!this.isPanning) {
            return;
        }

        const mouseEvent = event as MouseEvent;
        const dx = mouseEvent.clientX - this.panStartX;
        const dy = mouseEvent.clientY - this.panStartY;
        this.previewElement.scrollLeft = this.panStartScrollLeft - dx;
        this.previewElement.scrollTop = this.panStartScrollTop - dy;

        event.preventDefault();
    }

    private handlePanMouseUp(event: Event): void {
        if (!this.isPanning) {
            return;
        }

        this.stopPanning();
    }

    private stopPanning(): void {
        this.isPanning = false;
        this.previewElement.classList.remove(tmClassNames.PreviewPanning);
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

    destroy() {
        this.dispose();
        this.addRemoveListeners(false);
        this.previewElement.remove();
        this.previewElement = null as any;
    }

    private async recoverRenderer(error: Error): Promise<void> {
        if (this.recovering) {
            console.warn(
                "[Preview WASM] Recovery already in progress, skipping additional request",
            );
            return;
        }

        this.recovering = true;
        this.recoveryAttempts += 1;

        window.$tmEventBus.emit(tmEvents.ConsoleLog, {
            type: "warning",
            message: `[Preview WASM] Renderer failed (${error.message ?? error}). Restarting session...`,
        });

        try {
            this.dispose();
            await this.initialize();
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "success",
                message: "[Preview WASM] Renderer session restarted",
            });
            window.$tmEventBus.emit(tmEvents.PreviewSendData, "current");
        } catch (restartError) {
            console.error("[Preview WASM] Recovery failed:", restartError);
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "error",
                message: "[Preview WASM] Renderer recovery failed",
                details: restartError,
            });
        } finally {
            this.recovering = false;
        }
    }
}
