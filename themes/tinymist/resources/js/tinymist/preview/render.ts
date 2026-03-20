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
        this.previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;

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
        this.handlePreviewConnectionState =
            this.handlePreviewConnectionState.bind(this);

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
            tmEvents.PreviewConnectionState,
            this.handlePreviewConnectionState,
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
        this.handlePreviewConnectionState({ label: "connecting" });
    }

    private addRemoveListeners(adding: boolean = true): void {
        const method = adding ? "addEventListener" : "removeEventListener";

        document
            .querySelector(this.paneSelector)
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

        let svgText: string = "";
        let action: "reset" | "merge" =
            command === "new" ? "reset" : "merge"; // 'merge' or 'reset'

        try {
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
            const diffVsNewRatio =
                this.pmewmaDiff / Math.max(1, this.pmewmaNew);
            if (
                action === "merge" &&
                diffVsNewRatio > 0.7 &&
                diffVsNewRatio < 1 &&
                payload.length / Math.max(1, this.pmewmaNew) >
                    diffVsNewRatio * 5
            ) {
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
            // let svgText
            // if (action === "reset") {
            //     console.log(`[Preview WASM] Rendering full document to SVG...`);
            //     svgText = await session.renderSvg({
            //         data_selection: {
            //             body: true,
            //             defs: true,
            //             css: false,
            //             js: false,
            //         },
            //     });
            //     console.log(`[Preview WASM] full SVG generated ${svgText.length} chars`);
            // }
            console.log(`[Preview WASM] Rendering diff to SVG DIFF...`);
            // Since Incremental SVG state starts empty inside renderer and gets empty on reset
            // and gives full document on first render, we can count on it to cover both reset and merge actions and give us correct diff or full svg when needed without extra checks
            svgText = session.renderSvgDiff({
                data_selection: {
                    body: true,
                    defs: true,
                    css: false,
                    js: false,
                },
            });
            console.log(
                `[Preview WASM] SVG DIFF generated ${svgText.length} chars`,
            );

            if (command === "diff-v1") {
                this.pmewmaDiff = 0.4 * this.pmewmaDiff + 0.6 * payload.length;
            } else {
                this.pmewmaNew = 0.4 * this.pmewmaNew + 0.6 * payload.length;
            }

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
            return;
        }

        // Separate UI try/catch from WASM processing try/catch (don't need rendered recovery)
        try {
            if(action === "merge") {
                this.patchSVG(svgText);
            } else {
                this.updateSVG(svgText);
            }
            console.log(
                `[Preview WASM] Render "${command}" action "${action}" complete`,
            );

            const marker = this.previewElement.querySelector(
                '[data-typst-label^="doc-version-"]',
            );
            const version = marker
                ?.getAttribute("data-typst-label")
                ?.slice("doc-version-".length) as number | undefined;
            if (version) {
                window.$tmEventBus.emit(tmEvents.RenderVersion, {
                    type: command,
                    timestamp: Date.now(),
                    fileName: this.activeFileName,
                    docVersion: version,
                });
            }

            window.$tmEventBus.emit(tmEvents.DataCursorShow); // reinsert cursor if possible

        } catch (e: any) {
            console.error(`[Preview WASM] Failed to apply SVG:`, e);
        }
    }

    updateSVG(svg: string, docVersion?: number) {
        // Remove "Loading..." and error messages
        this.previewElement
            .querySelector(tmSelectors.PreviewMutedMessage)
            ?.remove();
        this.previewElement.querySelector(tmSelectors.PreviewError)?.remove();

        let svgHost = this.previewElement.querySelector(
            tmSelectors.PreviewDocumentHost,
        ) as HTMLElement | null;
        if (!svgHost) {
            svgHost = document.createElement("div");
            svgHost.className = tmClassNames.PreviewDocumentHost;
            this.previewElement.appendChild(svgHost);
        }

        svgHost.innerHTML = svg;
        this.baseSvgWidth = null;
        this.baseSvgHeight = null;
        this.applyZoomToSvg();

        console.log(
            `[Preview WASM] Page with not empty content is ${svgHost.querySelectorAll("g.typst-page:has(*)").length} and total ${svgHost.querySelectorAll("g.typst-page").length}`,
        );
    }

    private patchSVG(svgDiff: string) {
        let svgHost = this.previewElement.querySelector(
            tmSelectors.PreviewDocumentHost,
        ) as HTMLElement | null;
        if (!svgHost) {
            return;
        }

        // Detached container to parse incoming diff, diffs are smaller and manipulating detached DOM is usually faster
        const tempContainer = document.createElement("div");
        tempContainer.innerHTML = svgDiff;

        const prev = svgHost.querySelector("svg");
        const next = tempContainer.querySelector("svg");
        if (!prev || !next) {
            return;
        }

        this.patchAttributes(prev, next);
        this.patchSvgHeader(prev, next);
        this.patchSvgChildren(prev, next);
    }

    private patchSvgHeader(prev: SVGElement, next: SVGElement) {
        for (let i = 0; i < 3; i++) {
            // 3 because we only have glyph defs, clip-path defs and style
            const prevChild = prev.children[i];
            const nextChild = next.children[i];

            if (prevChild.tagName === "defs") {
                if (prevChild.getAttribute("class") === "glyph") {
                    prevChild.append(...nextChild.children);
                } else if (prevChild.getAttribute("class") === "clip-path") {
                    prevChild.append(...nextChild.children);
                }
            } else if (
                prevChild.tagName === "style" &&
                nextChild.getAttribute("data-reuse") !== "1"
            ) {
                // Hopefully styles are not what was changing, look into it later
            }
        }
    }

    // apply attribute patches to the `prev <svg or g>` element
    private patchAttributes(prev: Element, next: Element) {
        const prevAttrsSet = new Set(prev.attributes);
        const nextAttrsSet = new Set(next.attributes);
        const diffAttrsSet = prevAttrsSet.difference(nextAttrsSet);

        // Check if nothing changed: same size, same attrs, same values
        if (
            prevAttrsSet.size === nextAttrsSet.size &&
            diffAttrsSet.size === 0 &&
            Array.from(prevAttrsSet).every(
                (attr) => next.getAttribute(attr.name) === attr.value,
            )
        ) {
            return;
        }

        // Do changes to prev to match next, assuming we have to clear old ones
        for (let attr of diffAttrsSet) {
            prev.removeAttribute(attr.name);
        }
        for (let attr of nextAttrsSet) {
            prev.setAttribute(attr.name, attr.value);
        }
    }

    private patchSvgChildren(oldBranch: SVGElement, newBranch: SVGElement) {

        if ( !newBranch.hasChildNodes() ) {
            return; // reuse without changes placeholder
        }

        const oldNodes = Array.from(oldBranch.childNodes);
        const isSvgRoot = oldBranch.tagName.toLowerCase() === "svg";

        const reuseTids = Array.from(
            newBranch.querySelectorAll("g[data-reuse-from]"),
        ).map((n) => n.getAttribute("data-reuse-from") || "");

        // Old nodes: leave in DOM only <g> with data-tid from reuse pool of a diffSvg branch,
        // make array of tids while you are at it
        // SVG header has <defs> and <style> are not removable, patched separately
        const oldTids: string[] = [];
        const oldMap = new Map<string, Element>();
        for (const node of oldNodes) {
            const tid = (node as Element).getAttribute("data-tid");
            const tagName = (node as Element).tagName.toLowerCase();
            if (isSvgRoot && (tagName === "defs" || tagName === "style")) {
                continue;
            }
            if (
                node.nodeType !== Node.ELEMENT_NODE ||
                tagName !== "g" ||
                !tid ||
                reuseTids.indexOf(tid) === -1
            ) {
                node.remove();
                continue;
            }
            oldTids.push(tid);
            oldMap.set(tid, node as Element);
        }

        function getInsertFn(pinnedTid: string) {
            const pinnedNode = oldMap.get(pinnedTid) || null;
            return !pinnedNode
                ? (node: Node) => oldBranch.appendChild(node)
                : (node: Node) => oldBranch.insertBefore(node, pinnedNode);
        }

        // List of old tids that will not be moved (but still might need some patching)
        const preserve = this.esoteric(oldTids, reuseTids);
        let currentTid = preserve.shift();
        let insertFn = getInsertFn(currentTid || "");

        let newNodes = Array.from(newBranch.childNodes);
        if (isSvgRoot) {
            newNodes = newNodes.slice(3); // skip header, it is patched separately
        }

        // not preserved old nodes will be reattached, we have to make sure though
        // that if the old node is reused more than once, it's cloned and not moved
        const checkTids = new Set(oldTids);
        for (const newNode of newNodes) {
            const reuseFrom = (newNode as Element).getAttribute(
                "data-reuse-from",
            ) || '';
            if (!reuseFrom) {
                insertFn(newNode);
                continue;
            }
            if (currentTid && reuseFrom === currentTid) {
                checkTids.delete(currentTid);
                currentTid = preserve.shift();
                insertFn = getInsertFn(currentTid || "");

                const oldNode = oldMap.get(reuseFrom)!;
                this.patchAttributes(oldNode, newNode as Element,);
                this.patchSvgChildren(oldNode as SVGElement, newNode as SVGElement,);
                continue;
            }

            const oldNode = checkTids.has(reuseFrom)
                ? oldMap.get(reuseFrom)
                : oldMap.get(reuseFrom)?.cloneNode(true);
            checkTids.delete(reuseFrom);
            insertFn(oldNode!);

            this.patchAttributes(oldNode! as Element, newNode as Element);
            this.patchSvgChildren(oldNode! as SVGElement, newNode as SVGElement);
        }
    }

    // Finds longest common sparse subsequence, allowing to preserve maximum number of nodes without cloning or moving
    private esoteric(oldHashes: string[], newHashes: string[]) {
        let paths = oldHashes.map((n, i) => ({
            next: i,
            trail: [] as number[],
        }));

        newHashes.forEach((n, i) => {
            let expected_next: number[] = [];
            let removes: number[] = [];
            for (var j = 0; j < paths.length; j++) {
                if (n !== oldHashes[paths[j].next]) {
                    continue;
                }

                if (paths[j].trail.length === 0) {
                    // means that longer trail is at the same place waiting for the same node
                    if (expected_next.indexOf(paths[j].next) !== -1) {
                        removes.push(j);
                        continue;
                    }
                    // Copy the longest trail of preceding nodes
                    // Usually it means there was a missed node from sequence, like AB DE
                    // AB is waiting for C, you make ABD and go forward from there
                    const trl =
                        paths
                            .filter(
                                (p) =>
                                    p.trail[p.trail.length - 1] < paths[j].next,
                            )
                            .toSorted(
                                (a, b) => b?.trail.length - a?.trail.length,
                            )[0]?.trail || [];
                    paths[j].trail = Array.from(trl); // clone, not to tint the source trail
                }

                paths[j].trail.push(paths[j].next);
                expected_next.push(paths[j].next);
                paths[j].next++;
            }
            // Logically just one, but just in case
            for (let rm = removes.length - 1; rm > -1; rm--) {
                paths.splice(removes[rm], 1);
            }
        });

        const longest = paths.sort((a, b) => b.trail.length - a.trail.length)[0]
            ?.trail || [];

        return longest.map((t) => oldHashes[t]);
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
            case "previewConnectionToggle":
                window.$tmEventBus.emit(tmEvents.PreviewConnectionToggle);
                break;
            default:
                break;
        }
    }

    private handlePreviewConnectionState(payload: {
        label: "pause" | "run" | "connecting";
    }): void {
        const button = document.querySelector(
            `${this.paneSelector} ${tmSelectors.PreviewConnectionToggle}`,
        ) as HTMLButtonElement | null;
        if (!button) {
            return;
        }

        button.disabled = payload.label === "connecting";
        button.textContent = payload.label;
        button.setAttribute("title", payload.label);
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
        const maxVisibleX =
            this.previewElement.scrollLeft + viewportWidth - marginX;
        const minVisibleY = this.previewElement.scrollTop + marginY;
        const maxVisibleY =
            this.previewElement.scrollTop + viewportHeight - marginY;

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
        const svg = this.previewElement.querySelector(
            `${tmSelectors.PreviewDocumentHost} > svg`,
        ) as SVGElement | null;
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
