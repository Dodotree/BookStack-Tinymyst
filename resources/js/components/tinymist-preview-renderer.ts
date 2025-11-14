import {
    rendererBuildInfo,
    createTypstRenderer,
    RenderSession,
    TypstRenderer,
} from "@myriaddreamin/typst.ts/dist/esm/renderer.mjs";

// Import WASM binary to trigger esbuild plugin (embeds as base64)
import renderModule from "@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm";

import { TypstDomDocument as TypstDocument } from '@myriaddreamin/typst.ts/dist/esm/dom.mjs';
import { PreviewMode } from "@myriaddreamin/typst.ts/dist/esm/contrib/dom/typst-doc.mjs";

type CursorParams = {
    textSelector: string;
    charIndex: number;
    cx: number;
    radius: number;
};


export class PreviewDataPlane {
    private renderer: TypstRenderer | null = null;
    private session: RenderSession | null = null;
    private sessionPromise: Promise<RenderSession> | null = null;
    private sessionResolve: (() => void) | null = null;
    private dataWs: WebSocket | null = null;
    private previewElement: HTMLElement;
    private dataPort: number;
    private host: string;
    private maxReconnectAttempts: number = 5;
    private reconnectAttempts: number = 0;
    private reconnectAllowed: boolean = true;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
    private hasInitialDocument: boolean = false; // Track if we've received initial document
    private processingQueue: Promise<void> = Promise.resolve();
    // private lastSvg: string | null = null;
    private cursorCircle: SVGCircleElement | null = null;
    private cursorParams: CursorParams = { textSelector: 'svg.typst-doc>g.typst-group', charIndex: 0, cx: 0, radius: 0 };

    private onConnectionStateChange?: (connected: boolean) => void;
    private onError?: (error: string) => void;

    constructor(
        previewElement: HTMLElement,
        host: string = "127.0.0.1", // provided directly from php template
        dataPort: number = 23625,    // provided directly from php template
        options?: {
            onConnectionStateChange?: (connected: boolean) => void;
            onError?: (error: string) => void;
        }
    ) {
        this.previewElement = previewElement;
        this.host = host;
        this.dataPort = dataPort;
        if (options) {
            this.onConnectionStateChange = options.onConnectionStateChange;
            this.onError = options.onError;
        }
    }

    async initialize() {
        try {
            // Initialize WASM renderer
            this.renderer = createTypstRenderer();

            // Provide WASM binary explicitly (loaded via esbuild plugin)
            await this.renderer.init({
                getModule: () => renderModule, // Returns Uint8Array from esbuild WASM plugin
            });

            console.log("[Preview Data] typst-ts-renderer initialized");

            await this.connectDataPlane();

        } catch (error) {
            console.error("[Preview Data] Failed to initialize typst-ts-renderer:", error);
            throw error;
        }
    }

    connectDataPlane(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.reconnectAllowed) {
                reject("[Preview Data] Reconnection not allowed");
            }
            try {
                const wsUrl = `ws://${this.host}:${this.dataPort}`;
                this.dataWs = new WebSocket(wsUrl);
                this.dataWs.binaryType = "arraybuffer";

                this.dataWs.onopen = () => {
                    this.reconnectAttempts = 0;
                    if (this.connectionTimeout) {
                        clearTimeout(this.connectionTimeout);
                        this.connectionTimeout = null;
                    }
                    this.onConnectionStateChange?.(true);
                    console.log(`[Preview Data] Connected to Tinymist data plane at ${wsUrl}`);
                    // Request current document
                    this.dataWs?.send("current");
                    resolve();
                };

                this.dataWs.onmessage = (event) => {
                    const data = event.data;
                    this.processingQueue = this.processingQueue
                        .then(async () => {
                            console.log("[Preview Data] Data plane message received", event);

                            if (data instanceof ArrayBuffer) {
                                await this.handleBinaryMessage(new Uint8Array(data));
                            } else if (data instanceof Blob) {
                                console.log("[Preview Data] Data plane message blob data:", data);
                                const buffer = await data.arrayBuffer();
                                await this.handleBinaryMessage(new Uint8Array(buffer));
                            } else if (typeof data === "string") {
                                console.log("[Preview Data] Data plane message string data:", data);
                            }
                        })
                        .catch((err) => {
                            console.error("[Preview Data] Failed to process message:", err);
                        });
                };

                this.dataWs.onerror = (error) => {
                    console.error("[Preview Data] Data plane error:", error);
                    this.onError?.(error.toString());
                    reject(error);
                };

                this.dataWs.onclose = (event) => {
                    const errCodes: Record<number, string> = {
                        1000: "Normal closure",
                        1001: "Going away",
                        1006: "Abnormal closure (no close frame)",
                        1011: "Internal server error",
                    };
                    console.warn(
                        `[Preview Data] Data plane closed: code=${event.code}(${errCodes[event.code] || "Unknown"}), reason=${event.reason}`
                    );
                    this.onConnectionStateChange?.(false);
                    if (event.code !== 1000) {
                        this.handleReconnect();
                    } else {
                        reject(new Error(`Connection closed: ${event.code} - ${event.reason || errCodes[event.code] || 'Unknown reason'}`));
                    }
                };

            } catch (error) {
                reject(error);
            }
        });
    }

    createSvgDocument(kModule: RenderSession) {

        // originally "typst-app", maybe it should be let go and re-queried
        // this is the root element within wsMain, but above looks for "typst-doc"
        if (this.previewElement.firstElementChild?.tagName !== "svg") {
            this.previewElement.innerHTML = "";
        }
        // "typst-container-main" (div) > "typst-app" (div) > "typst-doc" (svg)
        // for now it's the same element
        const resizeTarget = this.previewElement;

        const svgDoc = new TypstDocument({
            hookedElem: this.previewElement,
            kModule, // session from WASM renderer
            previewMode: PreviewMode.Doc, // only other option is PreviewMode.Slide
            isContentPreview: false, // Whether it is content preview (embedded thumbnail)
            renderer: undefined as any, // Will be set by the class
            // Overwrites inherited function for scaling
            retrieveDOMState() {
                return {
                    // Reserving 1px to hide width border
                    width: resizeTarget.clientWidth + 1,
                    // Reserving 1px to hide width border
                    height: resizeTarget.offsetHeight,
                    boundingRect: resizeTarget.getBoundingClientRect(),
                    // Window element
                    window: {
                        innerWidth: window.innerWidth,
                        innerHeight: window.innerHeight,
                    },
                };
            },
        });

        return svgDoc;
    }

    private async handleBinaryMessage(msg: Uint8Array) {
        try {
            const rawLength = msg.length;
            console.log(`[Preview Data] Raw message length: ${rawLength} bytes`);
            // Parse message format: "type,payload"
            const commaIndex = msg.indexOf(44); // ASCII for ','
            if (commaIndex === -1) {
                console.warn("[Preview Data] Invalid data plane message format", msg);
                return;
            }

            const command = new TextDecoder().decode(msg.slice(0, commaIndex));
            const payload = msg.slice(commaIndex + 1);

            console.log(`[Preview Data] Message command "${command}" (payload ${payload.length} bytes, raw ${rawLength})`);

            switch (command) {
                case 'diff-v1':
                    console.log(`[Preview Data] Received diff-v1 (${payload.length} bytes)`);
                    // Try to peek at the diff content (it's binary, but might have readable parts)
                    try {
                        const sample = new TextDecoder('utf-8', { fatal: false }).decode(payload.slice(0, Math.min(200, payload.length)));
                        console.log('[Preview Data] Diff sample:', sample.substring(0, 100));
                    } catch (e) {
                        console.log('[Preview Data] Could not decode diff sample');
                    }
                    break;

                case 'new':
                    console.log(`[Preview Data] Received new document (${payload.length} bytes)`);
                    break;

                // Successful reply to Control Plane "changeCursorPosition" request
                case 'cursor-paths': {
                    const decoded = new TextDecoder().decode(payload);
                    console.log(`[Preview Data] Cursor paths payload (${payload.length} bytes):`, decoded);
                    try {
                        const parsed = JSON.parse(decoded);
                        console.info('[Preview Data] Cursor paths parsed:', parsed);
                        this.pathToSelector(parsed);
                    } catch (err) {
                        console.error('[Preview Data] Cursor paths not valid JSON:', err);
                    }
                    break;
                }

                case 'partial-rendering':
                    const enabled = new TextDecoder().decode(payload) === 'true';
                    console.log(`[Preview Data] Partial rendering: ${enabled}`);
                    break;

                case 'jump':
                    const coords = new TextDecoder().decode(payload).split(" ");
                    const [page, x, y] = coords.map(Number);
                    console.log(`[Preview Data] Jump to page ${page}, x: ${x}, y: ${y}`);
                    break;

                case 'viewport':
                    const decoded = new TextDecoder().decode(payload);
                    console.log(`[Preview Data] Viewport payload (${payload.length} bytes):`, decoded);
                    break;

                case 'cursor':
                    const cursorDecoded = new TextDecoder().decode(payload);
                    console.log(`[Preview Data] Cursor payload (${payload.length} bytes):`, cursorDecoded);
                    break;

                case 'invert-colors':
                    const invertColorsDecoded = new TextDecoder().decode(payload);
                    console.log(`[Preview Data] Invert colors payload (${payload.length} bytes):`, invertColorsDecoded);
                    break;

                // Not sure what kind of outline is that, usually Control Plane receives "outline" events
                case 'outline':
                    const outlineDecoded = new TextDecoder().decode(payload);
                    console.log(`[Preview Data] Outline payload (${payload.length} bytes):`, outlineDecoded);
                    break;

                default:
                    console.warn(`[Preview Data] Unknown data plane command: ${command}`);
                    break;
            }

            if (command === 'diff-v1' || command === 'new') {

                if (!this.renderer) {
                    console.warn("[Preview Data] Renderer not ready");
                    return;
                }

                console.log(`[Preview Data] Processing ${command} (${payload.length} bytes, raw ${rawLength})`);

                try {
                    const isDiff = command === 'diff-v1';
                    let action: 'reset' | 'merge' = command === 'new' ? 'reset' : 'merge';

                    const session = await this.ensureSession();

                    if (isDiff && !this.hasInitialDocument) {
                        console.warn('[Preview Data] Treating first diff as full reset');
                        action = 'reset';
                    }

                    console.log(`[Preview Data] Applying ${action} with ${payload.length} bytes (raw ${rawLength})...`);
                    // same as session.manipulateData
                    const diffResult = this.renderer!.manipulateData({
                        renderSession: session,
                        action,
                        data: payload,
                    });
                    console.log(`[Preview Data] Data applied successfully (raw ${rawLength})`, diffResult);

                    if (action === 'reset') {
                        this.hasInitialDocument = true;
                    }

                    // try {
                    //     const customData = await this.renderer!.getCustomV1({
                    //         renderSession: session,
                    //     });
                    //     console.log('[Preview Data] Custom data:', customData);
                    // } catch (e) {
                    //     console.log('[Preview Data] No custom data:', e);
                    // }

                    console.log('[Preview Data] Rendering to SVG...');
                    // const oldSvg = this.lastSvg ?? this.previewElement.innerHTML;
                    // const oldSvgLength = oldSvg ? oldSvg.length : 0;
                    // const svg = await session.renderSvg({});

                    // defaults are all true, right now have no use for inline helper script
                    // css needed to hide text overlays for copy/paste
                    const svg = await session.renderSvg({
                        data_selection: { body: true, defs: true, css: true, js: false },
                    });

                    // console.log('[Preview Data] SVG length:', svg.length, '(was:', oldSvgLength + ')');

                    // Compare old and new SVG - look for ALL significant changes
                    // if (oldSvg && oldSvg !== svg) {
                    //     const sizeDiff = svg.length - oldSvgLength;
                    //     console.log(`[Preview Data] SVG size changed by ${sizeDiff} bytes`);

                    //     const newGroups = (svg.match(/<g /g) || []).length;
                    //     const oldGroups = (oldSvg.match(/<g /g) || []).length;
                    //     if (newGroups !== oldGroups) {
                    //         console.log(`[Preview Data] Group count changed: ${oldGroups} → ${newGroups}`);
                    //     }
                    //     // Walk through character diffs to capture multiple change pockets
                    //     const maxDiffSegments = 5;
                    //     let diffSegments = 0;
                    //     const sharedLength = Math.min(oldSvg.length, svg.length);
                    //     for (let i = 0; i < sharedLength && diffSegments < maxDiffSegments; i++) {
                    //         if (oldSvg[i] !== svg[i]) {
                    //             const pos = i;
                    //             const oldSnippetStart = Math.max(0, pos - 120);
                    //             const newSnippetStart = Math.max(0, pos - 120);
                    //             const oldSnippetEnd = Math.min(oldSvg.length, pos + 120);
                    //             const newSnippetEnd = Math.min(svg.length, pos + 120);
                    //             console.log(`[Preview Data] Diff #${diffSegments + 1} near position ${pos}`);
                    //             console.log('[Preview Data] Old snippet:', oldSvg.substring(oldSnippetStart, oldSnippetEnd));
                    //             console.log('[Preview Data] New snippet:', svg.substring(newSnippetStart, newSnippetEnd));
                    //             diffSegments++;
                    //             i = pos + 120; // skip ahead to avoid spamming adjacent characters
                    //         }
                    //     }

                    //     if (diffSegments === 0 && oldSvg.length !== svg.length) {
                    //         console.log('[Preview Data] No character diff in shared range; change likely at tail segment.');
                    //     }
                    // }

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

                    this.showCursorAt();
                    // this.lastSvg = svg;
                    console.log('[Preview Data] Render complete');

                } catch (e: any) {
                    console.error(`[Preview Data] Rendering failed:`, e);
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
                }

            }

        } catch (error) {
            console.error("[Preview Data] Failed to handle binary message:", error);
        }
    }

    private handleReconnect() {
        if (!this.reconnectAllowed) {
            return;
        }
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(
                `[Preview Data] Reconnecting... Attempt ${this.reconnectAttempts}`
            );

            this.connectionTimeout = setTimeout(() => {
                this.connectDataPlane().catch((err) => {
                    console.error("[Preview Data] Reconnection failed:", err);
                });
            }, 1000 * this.reconnectAttempts);
        } else {
            console.error(
                "[Preview Data] Max reconnection attempts reached"
            );
        }
    }

    dispose() {
        // Prevent reconnect attempts
        this.reconnectAllowed = false;

        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }

        if (this.dataWs) {
            this.dataWs.close();
            this.dataWs = null;
            this.onConnectionStateChange?.(false);
        }

        if (this.sessionResolve) {
            this.sessionResolve();
            this.sessionResolve = null;
        }

        this.sessionPromise = null;
        this.session = null;
        this.renderer = null;

        console.log("[Preview Data] Renderer disposed");
    }

    private async ensureSession(): Promise<RenderSession> {
        if (!this.renderer) {
            throw new Error('Renderer not initialized');
        }

        if (this.session) {
            return this.session;
        }

        if (!this.sessionPromise) {
            console.log('[Preview Data] Creating persistent session');
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


    /**
     * * * * * CssClassToType
     * ["typst-text", SourceMappingType.Text],
     * ["typst-group", SourceMappingType.Group],
     * ["typst-image", SourceMappingType.Image],
     * ["typst-shape", SourceMappingType.Shape],
     * ["typst-page", SourceMappingType.Page],
     * ["tsel", SourceMappingType.CharIndex],
     *
     * SVG Structure Notes:
     * svg.typst-doc
     *  > g.typst-page (one per page)
     *    > g data-tid="..." (data-tid wrappers)
     *      > g.typst-group (frames, groups)
     *        > g data-tid="..." (data-tid wrappers)
     *          > g.typst-text (text blocks)
     *            > use (glyphs)
     * Every group except the first one is wrapped in a data-tid element.
     * Cursor paths count only mentioned below elements as children
     * ${n} is 1-based index
     * `svg.typst-doc > :nth-child(${n} of .typst-page)` is a starting point
     * `> :nth-child(${n} of :is(.typst-group,.typst-text))` first element in the page
     *  followed by data-tid wrapper for the 12th group and the group itself
     * :is() and :has() should have all allowed child types (except typst-page)
     * `> :nth-child(${n} of g:has(>g.typst-group,>g.typst-text, ...))>g`
     *  repeats for nested groups until text g.typst-text
     *  > :nth-child(${n} of g:has(>g.typst-group,>g.typst-text, ...))>g> :nth-child(${n} of use)
     *
     * The g.typst-text element is where we will append the cursor svg circle.
     * And we should copy "x" from "use" element to "cx" of the circle.
     *
     * Path format notes:
     *
     * Nested data-tid without class can throw off indexing, handled for 2 levels (for now)
     *
     * Usually cursor paths have only 1 path [[]]
     * Code blocks give extra paths [[],[],[],[],[]]
     * "occur when a single source-code cursor position maps to multiple rendered elements"
     * Put a circle at each resolved node of not 0 bounding box
     *
     * Cursor Paths are not provided for $infinity$ and functions like #datetime.today()
     */
    private pathToSelector(paths: any): void {
        const kindMap: Record<number, string> = {
            0: '.typst-text',  // g
            1: '.typst-group', // g
            2: '.typst-image', // ?
            3: '.typst-shape', // path
            4: '.typst-page',  // g
            5: 'use' // theoretically .tsel, but actually "use" tag
        };
        const validChildren = `>g.typst-group,>g.typst-text,>.typst-image,>.typst-shape,>g.typst-wrap`;

        this.cursorParams = paths.reduce((cursorMax: CursorParams, steps: any[]) => {

            let cx = 0;
            let radius = 0;

            const pairs: [string, number][] = steps.map((step: any) => [
                kindMap[Number(step.kind)] ?? '???',
                step.index + 1 // Convert to 1-based index for CSS
            ]);
            console.warn('[Preview Data] pathToSelector pairs:', pairs);

            const pageStep = pairs.shift();
            const topGroupStep = pairs.shift();

            if (!pageStep || !topGroupStep) {
                console.warn('[Preview Data] Invalid cursor path: insufficient steps');
                return cursorMax;
            }

            const topGroup = `svg.typst-doc > :nth-child(${pageStep[1]} of .typst-page)`
                + ` > :nth-child(${topGroupStep[1]} of :is(.typst-group,.typst-text,.typst-image,.typst-shape))`;

            let charStep = pairs.pop();
            if (!charStep || charStep[0] !== 'use') {
                if (charStep) {
                    pairs.push(charStep);
                }
                charStep = ['use', 1];
            }

            const textSelector = pairs.reduce((selector: string, [tag, child]: [string, number]) =>
                selector + `> :nth-child(${child} of :has(${validChildren}))>g`,
                topGroup);

            // For double data-tid wrappers not to get ignored / throw off indexing
            // Happens with rare shape paths
            document.querySelectorAll(`g[data-tid]:not([class])>[data-tid]:not([class]):has(${validChildren})`)
                .forEach(element => {
                    element.classList.add('typst-wrap');
                });
            console.debug('[Preview Data] selector of the text node:', textSelector);
            console.debug('[Preview Data] works?', document.querySelector(textSelector));

            const textNode = document.querySelector(textSelector);
            if (!textNode) {
                console.warn('[Preview Data] Text node not found for selector:', textSelector);
                return cursorMax;
            }
            // append cursor circle, since svg is redrawn on every update, circle must be re-added
            const glyphNode = textNode.querySelector(`:nth-child(${charStep[1]} of use)`);
            // set cursor 'cx' attribute to match glyph 'x' attribute
            if (glyphNode) {
                cx = Number(glyphNode.getAttribute('x') || 0);
                const bbox = (glyphNode as SVGGraphicsElement).getBBox();
                radius = 2 * Math.max(bbox.height, bbox.width);
            }
            if (radius > cursorMax.radius!) {
                return { textSelector, charIndex: charStep[1], cx, radius };
            }
            return cursorMax;

            // Default selector stays if no larger radius found
        }, { textSelector: this.cursorParams.textSelector, charIndex: 0, cx: 0, radius: 0 } as CursorParams);

        this.showCursorAt();
    }

    /**
     * Show cursor circle at the specified glyph position
     */
    private showCursorAt(): void {
        const textNode = document.querySelector(this.cursorParams.textSelector);
        if (!textNode) return;

        // Remove old circle if it's attached to a different text node
        if (this.cursorCircle) {
            this.cursorCircle.remove();
        }

        // Create new circle
        this.cursorCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        this.cursorCircle.setAttribute('fill', '#66bab7');
        this.cursorCircle.setAttribute('fill-opacity', '0.25');
        this.cursorCircle.setAttribute('stroke', '#66bab7');
        this.cursorCircle.setAttribute('stroke-opacity', '0.65');
        this.cursorCircle.setAttribute('stroke-width', '1.5');
        this.cursorCircle.dataset.cursorIndicator = 'true';
        this.cursorCircle.style.pointerEvents = 'none';
        this.cursorCircle.style.transition = 'cx 0.1s ease, cy 0.1s ease, r 0.1s ease';

        // Append to text node
        textNode.appendChild(this.cursorCircle);

        // Update circle position
        this.cursorCircle.setAttribute('cx', this.cursorParams.cx.toFixed(2));
        this.cursorCircle.setAttribute('r', Math.max(5, this.cursorParams.radius).toFixed(2));
    }

}
