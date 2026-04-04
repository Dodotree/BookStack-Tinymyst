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

import {
    ENTRY_FILE_NAME,
    tmClassNames,
    tmEvents,
    tmSelectors,
} from "../constants";

import { PreviewToolbar } from "./preview-toolbar";
import { PreviewCursor } from "./cursor";

export class PreviewRenderer {
    private previewElement: HTMLElement;
    private activeFileName = ENTRY_FILE_NAME;

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

    private debugOn = false;
    private debugLog: (...args: any[]) => void;


    constructor(uniqueTabId?: string, pageId: number|string = "") {
        this.previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;
        this.debugLog = this.debugOn ? console.debug : () => {};

        new PreviewToolbar(pageId);
        new PreviewCursor(uniqueTabId);

        this.handleSyncInit = this.handleSyncInit.bind(this);
        this.dispose = this.dispose.bind(this);
        this.updateSVG = this.updateSVG.bind(this);
        this.handleSyncMessage = this.handleSyncMessage.bind(this);

        window.$tmEventBus.listen(tmEvents.WasmInit, this.handleSyncInit);
        window.$tmEventBus.listen(tmEvents.WasmDispose, this.dispose);

        window.$tmEventBus.listen(
            tmEvents.FallbackCompiledSvg,
            ({ svg, docVersion }) => this.updateSVG(svg),
        );
        window.$tmEventBus.listen(
            tmEvents.ActiveFileChange,
            (payload: { fileName: string; url: string }) => {
                this.activeFileName = payload.fileName || ENTRY_FILE_NAME;
            },
        );

        window.$tmEventBus.listen(tmEvents.DataBinary, this.handleSyncMessage);
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

            this.debugLog("[Preview WASM] typst-ts-renderer initialized");
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
            this.debugLog("[Preview WASM] Creating persistent session");
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

        if (!this.renderer) {
            console.warn("[Preview WASM] Renderer not ready");
            return;
        }

        if (command !== "diff-v1" && command !== "new") {
            console.warn(`[Preview WASM] Unexpected command: ${command}`);
            return;
        }

        let svgText: string = "";
        const fullSvgRender = this.pmewmaNew < 500_000;

        let action: "reset" | "merge" =
            command === "new" ? "reset" : "merge"; // 'merge' or 'reset'

        try {
            const session = await this.ensureSession();

            if (!this.hasInitialDocument) {
                this.debugLog(
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

            this.debugLog(
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

            this.debugLog(`[Preview WASM] Rendering diff to SVG DIFF...`);
            // Since Incremental SVG state starts empty inside renderer and gets empty on reset
            // and gives full document on first render, we can count on it to cover both reset and merge actions and give us correct diff or full svg when needed without extra checks

            if (fullSvgRender) {
            // defaults are all true, right now have no use for inline helper script
            // could be simple session.renderSvg({});
                svgText = await session.renderSvg({
                    data_selection: {
                        body: true,
                        defs: true,
                        css: false,
                        js: false,
                    },
                });
                console.warn(`[Preview WASM] Full SVG generated ${svgText.length} chars`);
            } else {
                svgText = session.renderSvgDiff({
                    data_selection: {
                        body: true,
                        defs: true,
                        css: false,
                        js: false,
                    },
                });
                this.debugLog(
                    `[Preview WASM] SVG DIFF generated ${svgText.length} chars`,
                );

                // Patch debug
                if (this.debugOn) {
                    const svgDebug = await session.renderSvg({
                        data_selection: {
                            body: true,
                            defs: true,
                            css: false,
                            js: false,
                        },
                    });
                    this.debugLog("Patch", svgText);
                    this.debugLog("Patch debug full SVG for comparison", svgDebug);
                }
            }

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
            // For 1 page documents full substitution is usually faster than patching, and it is more robust
            if(action === "merge" && !fullSvgRender) {
                this.patchSVG(svgText);
            } else {
                this.updateSVG(svgText);
            }
            this.debugLog(
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

        this.debugLog(
            `[Preview WASM] Pages with not empty content length is ${svgHost.querySelectorAll("g.typst-page:has(*)").length} and total ${svgHost.querySelectorAll("g.typst-page").length}`,
        );

        window.$tmEventBus.emit(tmEvents.PreviewDocumentUpdated, { pdfPagesCount: svgHost.querySelectorAll("g.typst-page").length });
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

        this.debugLog("Patched full SVG", prev.outerHTML);
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
        const nextAttrsSet = new Set(Array.from(next.attributes).filter((attr) => attr.name !== "data-reuse-from"));

        // Check if nothing changed: same size, same attrs, same values
        const diffAttrsSet = prevAttrsSet.symmetricDifference(nextAttrsSet);
        if (diffAttrsSet.size === 0) {
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

        const isSvgRoot = oldBranch.tagName.toLowerCase() === "svg";

        let oldNodes = Array.from(oldBranch.childNodes);

        let newNodes = Array.from(newBranch.childNodes);
        if (isSvgRoot) {
            newNodes = newNodes.slice(3); // skip header, it is patched separately
        }

        const reuseTids = Array.from(
            newBranch.querySelectorAll(":scope > g[data-reuse-from]"),
        ).map((n) => n.getAttribute("data-reuse-from") || "");

        const tally = reuseTids.reduce((acc, tid) => {
            acc[tid] = (acc[tid] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        // Old nodes: leave in DOM only <g> with data-tid from reuse pool of a diffSvg branch,
        // make array of tids while you are at it
        // SVG header has <defs> and <style> are not removable, patched separately
        const oldTids: string[] = [];
        const oldMap = new Map<string, Node>();
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
            oldMap.set(tid, node);
            tally[tid] = (tally[tid] || 0) - 1;
        }

        // reindex after removals
        oldNodes = Array.from(oldBranch.childNodes);

            // Problem with simple mappings tid->node is mostly related to initially copy-pasted texts:
            // 1) always points to the last node with the same tid,
            // so the change to random one will always go to the last one of former clones
            // 2) if we need to clone previous for extra node, the initial node might have changed already.
            // But still we want to avoid cloning and moving huge branches "just in case"
            // a) so we need to know in advance if we need a clean clone - and clone into map
            // b) and we need to match preservation pattern:
            // - remove old nodes into stack until we hit preserved one,
            // - insert before it nodes from patch
            //   (or if it calls for out of order reuse get it from stack/clone map + patch)
            //   until we hit reuse-from == preserved tid,
            // - patch preserved, repeat

        // List of old tids that will not be moved (but still might need some patching)
        const preserve = this.esoteric(oldTids, reuseTids);

        // not preserved old nodes will be reattached, we have to make sure though
        // that if the old node is reused more than once, it's cloned and not moved
        const moveTids = new Map<string, Node[]>();
        const extraClones = new Map<string, Node>();

        let oldTidsIndex = 0;
        const headSkip = isSvgRoot ? 3 : 0; // skip header nodes in svg root, they are patched separately

        let newNode  = newNodes.shift();
        let reuseFrom = (newNode as Element).getAttribute(
            "data-reuse-from",
        ) || '';

        const scrollOldNodesWhile = (ind: number, currentTid: string, all: boolean) => {
            while (oldTidsIndex < oldTids.length && (oldTids[oldTidsIndex] !== currentTid || all)) {
                const moveTid = oldTids[oldTidsIndex];
                if (tally[moveTid] > 0) {
                    extraClones.set(moveTid, oldNodes[oldTidsIndex + headSkip].cloneNode(true));
                    tally[moveTid] = 0; // no need for more clean clones
                }
                const tidNodeIndexes = moveTids.get(moveTid);
                if (!tidNodeIndexes) {
                    moveTids.set(moveTid, [oldNodes[oldTidsIndex + headSkip]]);
                } else {
                    tidNodeIndexes.push(oldNodes[oldTidsIndex + headSkip]);
                }
                oldTidsIndex++;
            }
        }

        const insertNewNodesWhile = (ind: number, currentTid: string, insertFn: (node: Node) => void, all: boolean) => {
            while (newNode && (reuseFrom !== currentTid || all) ) {
                if (!reuseFrom) {
                    insertFn(newNode);
                } else {
                    // means out of order reuse, get from moveTids or extraClones
                    const moveNode = moveTids.get(reuseFrom)?.shift();
                    let insertNode = moveNode || extraClones.get(reuseFrom)?.cloneNode(true);
                    if (!insertNode) {
                        // In this case we know that the node was not modified yet, so oldMap is good to get from
                        insertNode = tally[reuseFrom] > 0 ? oldMap.get(reuseFrom)?.cloneNode(true) : oldMap.get(reuseFrom);
                    }
                    insertFn(insertNode!);

                    this.debugLog(
                        `Reusing cloned/moved node with tid ${reuseFrom}`, all? "at the end": `before ${currentTid}`,
                        insertNode,
                        newNode,
                    );

                    this.patchAttributes(insertNode! as Element, newNode as Element);
                    this.patchSvgChildren(insertNode! as SVGElement, newNode as SVGElement);
                }
                newNode  = newNodes.shift();
                reuseFrom = (newNode as Element)?.getAttribute(
                    "data-reuse-from",
                ) || '';
            }
        }

        this.debugLog("Old branch, Old tids in DOM, tally", oldBranch, oldTids, oldMap, tally);
        this.debugLog("Preserve order of nodes with tids", preserve);
        this.debugLog("Move nodes with tids", Array.from(moveTids.entries()));
        this.debugLog("Extra clones for tids", Array.from(extraClones.entries()));

        for (const [ind, currentTid] of preserve.entries()) {
            scrollOldNodesWhile(ind, currentTid, false);

            const oldNode = oldTidsIndex < oldTids.length ? oldNodes[oldTidsIndex + headSkip] : null;
            const insertFn = oldTidsIndex < oldTids.length ?
                (node: Node) => oldNode!.before(node) : (node: Node) => oldBranch.appendChild(node);
            if (oldNode && tally[currentTid] > 0) {
                extraClones.set(currentTid, oldNode.cloneNode(true));
                tally[currentTid] = 0; // no need for more clean clones
            }

            insertNewNodesWhile(ind, currentTid, insertFn, false);

            if (oldNode && newNode) {

                this.debugLog(
                    `Expected reuse from ${reuseFrom} for current tid ${currentTid}`,
                    oldNode,
                    newNode,
                );

                this.patchAttributes(oldNode as Element, newNode as Element,);
                this.patchSvgChildren(oldNode as SVGElement, newNode as SVGElement,);

                oldTidsIndex++;
                newNode  = newNodes.shift();
                reuseFrom = (newNode as Element)?.getAttribute(
                    "data-reuse-from",
                ) || '';
            }
        }
        scrollOldNodesWhile(0, '', true);
        insertNewNodesWhile(0, "", (node: Node) => oldBranch.appendChild(node), true);
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
                                (a: { next: number; trail: number[] }, b: { next: number; trail: number[] }) => b?.trail.length - a?.trail.length,
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

        console.warn("[Preview WASM] Renderer disposed");
    }

    destroy() {
        this.dispose();
        this.previewElement.remove();
        this.previewElement = null as any;
    }
}
