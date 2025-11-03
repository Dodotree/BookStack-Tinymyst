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


export class TinymistPreviewRenderer {
    private renderer: TypstRenderer | null = null;
    private session: RenderSession | null = null;
    private sessionResolve: ((value?: unknown) => void) | null = null; // To resolve the session promise on dispose
    private dataWs: WebSocket | null = null;
    private previewElement: HTMLElement;
    private dataPort: number;
    private host: string;
    private maxReconnectAttempts: number = 5;
    private reconnectAttempts: number = 0;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
    private hasInitialDocument: boolean = false; // Track if we've received initial document

    constructor(
        previewElement: HTMLElement,
        host: string = "127.0.0.1",
        dataPort: number = 23625
    ) {
        this.previewElement = previewElement;
        this.host = host;
        this.dataPort = dataPort;
    }

    async initialize() {
        try {
            // Initialize WASM renderer
            this.renderer = createTypstRenderer();

            // Provide WASM binary explicitly (loaded via esbuild plugin)
            await this.renderer.init({
                getModule: () => renderModule, // Returns Uint8Array from esbuild WASM plugin
            });

            console.log("✓ Data plane typst-ts-renderer initialized");

            await this.connectDataPlane();

        } catch (error) {
            console.error("Data plane failed to initialize typst-ts-renderer:", error);
            throw error;
        }
    }

    connectDataPlane(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const wsUrl = `ws://${this.host}:${this.dataPort}`;
                this.dataWs = new WebSocket(wsUrl);
                this.dataWs.binaryType = "arraybuffer";

                this.dataWs.onopen = () => {
                    this.reconnectAttempts = 0;
                    this.connectionTimeout = null;
                    console.log(`✓ Connected to Tinymist data plane at ${wsUrl}`);
                    // Request current document
                    this.dataWs?.send("current");
                    resolve();
                };

                this.dataWs.onmessage = async (event) => {
                    console.log("Data plane message received", event);

                    if (event.data instanceof ArrayBuffer) {
                        await this.handleBinaryMessage(new Uint8Array(event.data));
                    } else if (event.data instanceof Blob) {
                        // since we set binaryType to arraybuffer, this should not happen
                        console.log("Data plane message blob data:", event.data);
                        const buffer = await event.data.arrayBuffer();
                        await this.handleBinaryMessage(new Uint8Array(buffer));
                    } else if (typeof event.data === "string") {
                        console.log("Data plane message string data:", event.data);
                    }
                };

                this.dataWs.onerror = (error) => {
                    console.error("Data plane error:", error);
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
                        `Data plane closed: code=${event.code}(${errCodes[event.code] || "Unknown"}), reason=${event.reason}`
                    );
                    if (event.code !== 1000) {
                        this.handleReconnect();
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
                console.warn("Invalid data plane message format or svg(?)", msg);
                return;
            }

            const command = new TextDecoder().decode(msg.slice(0, commaIndex));
            const payload = msg.slice(commaIndex + 1);

            switch (command) {
                case 'diff-v1':
                    // PARTIAL RENDERING: Binary diff (1-3 KB)
                    console.log(`📦 Received diff-v1 (${payload.length} bytes)`);
                    break;

                case 'new':
                    // FULL RENDERING: Complete document (10+ KB)
                    console.log(`📦 Received new document (${payload.length} bytes)`);
                    break;

                case 'partial-rendering':
                    // Configuration message
                    const enabled = new TextDecoder().decode(payload) === 'true';
                    console.log(`⚙️ Partial rendering: ${enabled}`);
                    break;

                case 'jump':
                    // Configuration message
                    const coords = new TextDecoder().decode(payload).split(" ");
                    const [page, x, y] = coords.map(Number);
                    console.log(`Jump to page ${page}, x: ${x}, y: ${y}`);
                    break;
            }

            if (command === 'diff-v1' || command === 'new') {

                if (!this.renderer) {
                    console.warn("Data plane: renderer not ready");
                    return;
                }

                console.log(`🔍 Payload info:`, {
                    length: payload.length,
                    first20: Array.from(payload.slice(0, 20)),
                    last20: Array.from(payload.slice(-20))
                });

                // Try multiple approaches to render something

                // Approach 1: Try as UTF-8 SVG string
                try {
                    const svgString = new TextDecoder('utf-8').decode(payload);
                    if (svgString.includes('<svg')) {
                        console.log('✅ Found SVG in payload, rendering as string');
                        this.previewElement.innerHTML = svgString;
                        return;
                    }
                    console.log('❌ No SVG tags found in UTF-8 decode');
                } catch (e) {
                    console.log('❌ UTF-8 decode failed:', e);
                }

                // Approach 2: Try renderToSvg with vector format
                try {
                    console.log('🔄 Attempting renderToSvg with vector format...');
                    await this.renderer.renderToSvg({
                        format: 'vector',
                        container: this.previewElement,
                        artifactContent: payload,
                    });
                    console.log('✅ renderToSvg succeeded');
                    return;
                } catch (e) {
                    console.log('❌ renderToSvg failed:', e);
                }

                // Approach 3: Try creating session and rendering
                try {
                    console.log('🔄 Attempting session-based render...');
                    await this.renderer.runWithSession({
                        format: 'vector',
                        artifactContent: payload,
                    }, async (session) => {
                        await this.renderer!.renderToSvg({
                            renderSession: session,
                            container: this.previewElement,
                        });
                        console.log('✅ Session-based render succeeded');
                    });
                    return;
                } catch (e) {
                    console.log('❌ Session-based render failed:', e);
                }

                // Approach 4: Show hex dump for debugging
                console.log('📊 Payload hex dump (first 100 bytes):');
                console.log(Array.from(payload.slice(0, 100)).map(b => b.toString(16).padStart(2, '0')).join(' '));

                // Show error in preview
                this.previewElement.innerHTML = `
                    <div style="padding: 20px; color: #721c24; background-color: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px;">
                        <h4>Preview Rendering Failed</h4>
                        <p>Payload size: ${payload.length} bytes</p>
                        <p>Command: ${command}</p>
                        <p>Check console for details</p>
                    </div>
                `;

            }

        } catch (error) {
            console.error("Data Plane: Failed to handle binary message:", error);
        }
    }

    private handleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(
                `Data Plane WebSocket Reconnecting... Attempt ${this.reconnectAttempts}`
            );

            this.connectionTimeout = setTimeout(() => {
                this.connectDataPlane().catch((err) => {
                    console.error("Data Plane WebSocket Reconnection failed:", err);
                });
            }, 1000 * this.reconnectAttempts);
        } else {
            console.error(
                "Data Plane WebSocket Max reconnection attempts reached"
            );
        }
    }

    dispose() {
        // Prevent reconnect attempts
        this.maxReconnectAttempts = 0;

        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }

        if (this.dataWs) {
            this.dataWs.close();
            this.dataWs = null;
        }

        // Resolve the session promise to allow cleanup
        if (this.sessionResolve) {
            this.sessionResolve();
            this.sessionResolve = null;
        }

        this.session = null;
        this.renderer = null;

        console.log("✓ Preview renderer disposed");
    }
}
