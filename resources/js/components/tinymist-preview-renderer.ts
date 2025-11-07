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
        if(options) {
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
            // Parse message format: "type,payload"
            const commaIndex = msg.indexOf(44); // ASCII for ','
            if (commaIndex === -1) {
                console.warn("[Preview Data] Invalid data plane message format", msg);
                return;
            }

            const command = new TextDecoder().decode(msg.slice(0, commaIndex));
            const payload = msg.slice(commaIndex + 1);

            switch (command) {
                case 'diff-v1':
                    console.log(`[Preview Data] Received diff-v1 (${payload.length} bytes)`);
                    break;

                case 'new':
                    console.log(`[Preview Data] Received new document (${payload.length} bytes)`);
                    break;

                case 'partial-rendering':
                    const enabled = new TextDecoder().decode(payload) === 'true';
                    console.log(`[Preview Data] Partial rendering: ${enabled}`);
                    break;

                case 'jump':
                    const coords = new TextDecoder().decode(payload).split(" ");
                    const [page, x, y] = coords.map(Number);
                    console.log(`[Preview Data] Jump to page ${page}, x: ${x}, y: ${y}`);
                    break;
            }

            if (command === 'diff-v1' || command === 'new') {

                if (!this.renderer) {
                    console.warn("[Preview Data] Renderer not ready");
                    return;
                }

                console.log(`[Preview Data] Processing ${command} (${payload.length} bytes)`);

                try {
                    const isDiff = command === 'diff-v1';
                    let action: 'reset' | 'merge' = command === 'new' ? 'reset' : 'merge';

                    const session = await this.ensureSession();

                    if (isDiff && !this.hasInitialDocument) {
                        console.warn('[Preview Data] Treating first diff as full reset');
                        action = 'reset';
                    }

                    console.log(`[Preview Data] Applying ${action} with ${payload.length} bytes...`);
                    this.renderer!.manipulateData({
                        renderSession: session,
                        action,
                        data: payload,
                    });
                    console.log('[Preview Data] Data applied successfully');

                    if (action === 'reset') {
                        this.hasInitialDocument = true;
                    }

                    try {
                        const customData = await this.renderer!.getCustomV1({
                            renderSession: session,
                        });
                        console.log('[Preview Data] Custom data:', customData);
                    } catch (e) {
                        console.log('[Preview Data] No custom data:', e);
                    }

                    console.log('[Preview Data] Rendering to SVG...');
                    const svg = await session.renderSvg({});
                    console.log('[Preview Data] SVG length:', svg.length);
                    this.previewElement.innerHTML = svg;
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
}
