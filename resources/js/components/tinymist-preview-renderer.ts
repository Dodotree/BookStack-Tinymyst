export class PreviewDataPlane {
    private dataWs: WebSocket | null = null;
    private dataPort: number;
    private host: string;
    private maxReconnectAttempts: number = 5;
    private reconnectAttempts: number = 0;
    private reconnectAllowed: boolean = true;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
    private processingQueue: Promise<void> = Promise.resolve();

    constructor(
        // previewElement: HTMLElement,
        host: string = "127.0.0.1", // provided directly from php template
        dataPort: number = 23625,    // provided directly from php template
    ) {
        this.host = host;
        this.dataPort = dataPort;

        this.handleSyncConnect = this.handleSyncConnect.bind(this);
        this.dispose = this.dispose.bind(this);
        window.$events.listen("tinymist-data-connect", this.handleSyncConnect)
        window.$events.listen("tinymist-data-disconnect", this.dispose);
    }

    private async handleSyncConnect(): Promise<void> {
        try {
            await this.connectDataPlane();
        } catch (err) {
            console.error("[Preview Data] Failed to connect:", err);
            window.$events.emit("tinymist-console-log", { type: "error", message: "[Preview Data] connection failed", details: err });
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
                    console.log(`[Preview Data] Connected to Tinymist data plane at ${wsUrl}`);
                    window.$events.emit("tinymist-status", { what: "data-plane-ws", connected: true });
                    window.$events.emit("tinymist-console-log", { type: "success", message: "[Preview Data] connected" });
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
                                // should not happen if binaryType is specified as arraybuffer
                                console.log("[Preview Data] Data plane message blob data:", data);
                                const buffer = await data.arrayBuffer();
                                await this.handleBinaryMessage(new Uint8Array(buffer));
                            } else if (typeof data === "string") {
                                // should not happen if binaryType is specified as arraybuffer
                                console.log("[Preview Data] Data plane message string data:", data);
                            } else {
                                console.warn("[Preview Data] Data plane message unknown type:", data);
                            }
                        })
                        .catch((err) => {
                            console.error("[Preview Data] Failed to process message:", err);
                        });
                };

                this.dataWs.onerror = (error) => {
                    console.error("[Preview Data] Data plane error:", error);
                    window.$events.emit("tinymist-status", { what: "data-plane-ws", connected: false });
                    window.$events.emit("tinymist-console-log", { type: "error", message: "[Preview Data] Socket error", details: error });
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
                    window.$events.emit("tinymist-status", { what: "data-plane-ws", connected: false });
                    window.$events.emit("tinymist-console-log", { type: "error", message: "[Preview Data] disconnected" });
                    if (event.code !== 1000) {
                        this.handleReconnect();
                    }
                    reject(new Error(`Connection closed: ${event.code} - ${event.reason || errCodes[event.code] || 'Unknown reason'}`));
                };

            } catch (error) {
                reject(error);
            }
        });
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
                    window.$events.emit("tinymist-data-binary", { command, payload });
                    break;

                case 'new':
                    console.log(`[Preview Data] Received new document (${payload.length} bytes)`);
                    window.$events.emit("tinymist-data-binary", { command, payload });
                    break;

                // Successful reply to Control Plane "changeCursorPosition" request
                case 'cursor-paths': {
                    const decoded = new TextDecoder().decode(payload);
                    try {
                        const parsed = JSON.parse(decoded);
                        console.info('[Preview Data] Cursor paths parsed:', parsed);
                        window.$events.emit("tinymist-data-cursor-paths", parsed);
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
            }

        } catch (error) {
            console.error("[Preview Data] Failed to handle binary message:", error);
        }
    }

    private handleReconnect() {
        if (!this.reconnectAllowed) {
            return;
        }
        if (this.connectionTimeout) {
            return; // Already scheduled
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
            window.$events.emit("tinymist-status", { what: "data-plane-ws", connected: false });
        }

        console.log("[Preview Data] disposed");
    }

}
