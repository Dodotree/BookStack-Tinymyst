// One websocket with both Control and Data Plane messages
// On the backend preview_server bridges both planes

import { Extension } from "@codemirror/state";

type OutlineItem = {
    title: string;
    level: number;
    line: number;
    character: number;
    children: OutlineItem[];
};

export class PreviewControlPlane {
    private previewWs: WebSocket | null = null;
    private maxReconnectAttempts: number = 5;
    private reconnectAttempts: number = 0;
    private reconnectAllowed: boolean = true;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
    private host: string;
    private port: number;

    constructor(
        pageId: number,
        host: string = "127.0.0.1", // provided directly from php template
        port: number = 4020, // provided directly from php template
    ) {
        this.host = host;
        this.port = port;
    }

    connect(): Promise<Extension> {
        return new Promise((resolve, reject) => {
            if (!this.reconnectAllowed) {
                reject("[Preview ws:] Reconnection not allowed");
            }
            try {
                // Connect to Tinymist control plane WebSocket
                const wsUrl = `ws://${this.host}:${this.port}`;
                this.previewWs = new WebSocket(wsUrl);

                this.previewWs.onopen = () => {
                    console.log(
                        `[Preview ws:] WS connected to Tinymist Preview at ${wsUrl}`
                    );

                    this.reconnectAttempts = 0;
                    if (this.connectionTimeout) {
                        clearTimeout(this.connectionTimeout);
                        this.connectionTimeout = null;
                    }

                    this.onConnectionStateChange?.(true);
                    resolve([]);
                };

                this.previewWs.onmessage = (event) => {
                    const data = event.data;

                    if (data instanceof ArrayBuffer) {
                        console.log("[Preview ws:] Data plane ArrayBuffer", data);
                        // await this.handleBinaryMessage(new Uint8Array(data));
                    } else if (data instanceof Blob) {
                        console.log("[Preview ws:] Data plane Blob", data);
                        // const buffer = await data.arrayBuffer();
                        // await this.handleBinaryMessage(new Uint8Array(buffer));
                    } else if (typeof data === "string" && !data.startsWith('{')) {
                        console.log("[Preview ws:] Data plane message string data:", data);
                    } else {
                        const msg = JSON.parse(event.data);
                        if (msg.event === 'compileStatus') {
                            console.log(`[Preview ws:] Debug status event:`, event);
                            this.onCompileStatus(msg.kind, msg);
                        } else if (msg.event === 'outline') {
                            this.onOutline(msg.items);
                        } else if (msg.event === 'syncEditorChanges') {
                            this.onSyncChanges(msg);
                        } else {
                            console.warn(
                                `[Preview ws:] Unknown message: ${event.data}`
                            );
                            this.onMessage?.(event.data);
                        }
                    }
                };

                this.previewWs.onerror = (error) => {
                    console.error("[Preview ws:] WS error:", error);
                    this.onError?.(error.toString());
                    reject(error);
                };

                this.previewWs.onclose = (event) => {
                    console.warn(
                        `[Preview ws:] WS disconnected: code=${event.code}, reason=${event.reason}`
                    );
                    this.onConnectionStateChange?.(false);
                    const errCodes: Record<number, string> = {
                        1000: "Normal closure",
                        1001: "Going away",
                        1006: "Abnormal closure (no close frame)",
                        1011: "Internal server error",
                    };
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

    private onSyncChanges(msg: any) {
        // Handle synchronization
        console.log('[Preview ws:] Syncing changes:', msg);
    }

    private onOutline(items: OutlineItem[]) {
        // Update table of contents
        console.log('[Preview ws:] Document outline:', items);
    }

    public sendDataMessage(message: any) {
        if (!this.previewWs || this.previewWs.readyState !== WebSocket.OPEN) {
            return;
        }

        let msg;

        console.log(`[Preview ws:] Sending Data Plane ${message.event}:`, msg);

        switch (message.event) {
            case "current":
                this.previewWs.send("current");
                break;
        }
    }

    public sendControlMessage(message: any) {
        if (!this.previewWs || this.previewWs.readyState !== WebSocket.OPEN) {
            return;
        }

        let msg;

        console.log(`[Preview ws:] Sending Control Plane ${message.event}:`, msg);

        switch (message.event) {
            case "updateMemoryFiles":
            case "syncMemoryFiles":
                msg = {
                    event: message.event,
                    files: {
                        // [filepath] is a virtual label, content is the *whole* file content
                        // `file:///virtual/${pageId}.typ`,
                        // or full path
                        [message.filepath]: message.content,
                    },
                };
                break;

            case "removeMemoryFiles":
                msg = {
                    event: "removeMemoryFiles",
                    files: [[message.filepath]],
                };
                break;

            case "changeCursorPosition":
            case "panelScrollTo":
                msg = {
                    event: message.event,
                    filepath: message.filepath,
                    line: message.line,
                    character: message.character,
                };
                break;

            case "sourceScrollBySpan":
                msg = {
                    event: "sourceScrollBySpan",
                    span: message.span, // string
                };

            case "panelScrollByPosition":
                msg = {
                    event: "panelScrollByPosition",
                    position: message.position,
                };
                break;
            default:
                console.warn(`[Preview ws:] Unknown control message event: ${message.event}`);
        }
        this.previewWs.send(JSON.stringify(msg));
    }

    private handleReconnect() {
        if (!this.reconnectAllowed) {
            return;
        }
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(
                `[Preview ws:] Reconnecting... Attempt ${this.reconnectAttempts}`
            );

            this.connectionTimeout = setTimeout(() => {
                this.connect().catch((err) => {
                    console.error("[Preview ws:] Reconnection failed:", err);
                });
            }, 1000 * this.reconnectAttempts);
        } else {
            console.error(
                "[Preview ws:] Max reconnection attempts reached"
            );
        }
    }

    disconnect() {
        this.reconnectAllowed = false;
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
        if (this.previewWs) {
            this.previewWs.close();
        }
        console.log("[Preview ws:] Intentionally disconnected");
    }

    reconnect() {
        this.reconnectAllowed = true;
        this.handleReconnect();
    }
}
