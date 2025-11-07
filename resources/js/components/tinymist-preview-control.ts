import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";

type OutlineItem = {
    title: string;
    level: number;
    line: number;
    character: number;
    children: OutlineItem[];
};

export class PreviewControlPlane {
    private controlWs: WebSocket | null = null;
    private fileUri: string;
    private maxReconnectAttempts: number = 5;
    private reconnectAttempts: number = 0;
    private reconnectAllowed: boolean = true;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
    private controlPort: number;
    private host: string;

    private onConnectionStateChange?: (connected: boolean) => void;
    private onCompileStatus: (kind: string, msg?: any) => void = () => {};
    private onMessage?: (message: any) => void;
    private onError?: (error: string) => void;

    constructor(
        pageId: number,
        content: string,
        host: string = "127.0.0.1", // provided directly from php template
        controlPort: number = 23627, // provided directly from php template
        options?: {
            onConnectionStateChange?: (connected: boolean) => void;
            onCompileStatus: (kind: string, msg?: any) => void;
            onMessage?: (message: any) => void;
            onError?: (error: string) => void;
        }
    ) {
        this.fileUri = `file:///virtual/${pageId}.typ`;
        this.host = host;
        this.controlPort = controlPort;
        this.onConnectionStateChange = options?.onConnectionStateChange;
        this.onCompileStatus = options?.onCompileStatus ?? (() => {});
        this.onMessage = options?.onMessage;
        this.onError = options?.onError;
    }

    connect(): Promise<Extension> {
        return new Promise((resolve, reject) => {
            if (!this.reconnectAllowed) {
                reject("[Preview Control] Reconnection not allowed");
            }
            try {
                // Connect to Tinymist control plane WebSocket
                const wsUrl = `ws://${this.host}:${this.controlPort}`;
                this.controlWs = new WebSocket(wsUrl);

                this.controlWs.onopen = () => {
                    console.log(
                        `[Preview Control] WS connected to Tinymist Preview at ${wsUrl}`
                    );
                    this.reconnectAttempts = 0;
                    if (this.connectionTimeout) {
                        clearTimeout(this.connectionTimeout);
                        this.connectionTimeout = null;
                    }
                    this.onConnectionStateChange?.(true);
                    resolve([]);
                };

                this.controlWs.onmessage = (event) => {
                    const msg = JSON.parse(event.data);
                    if (msg.event === 'compileStatus') {
                        console.log(`[Preview Control] Debug status event:`, event);
                        this.onCompileStatus(msg.kind, msg);
                    } else if (msg.event === 'outline') {
                        this.onOutline(msg.items);
                    } else if (msg.event === 'syncEditorChanges') {
                        this.onSyncChanges(msg);
                    } else {
                        this.onMessage?.(msg);
                        console.warn(
                            `[Preview Control] Unknown message event: ${msg.event}`
                        );
                    }
                };

                this.controlWs.onerror = (error) => {
                    console.error("[Preview Control] WS error:", error);
                    this.onError?.(error.toString());
                    reject(error);
                };

                this.controlWs.onclose = (event) => {
                    console.warn(
                        `[Preview Control] WS disconnected: code=${event.code}, reason=${event.reason}`
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
        console.log('Syncing changes:', msg);
    }

    private onOutline(items: OutlineItem[]) {
        // Update table of contents
        console.log('Document outline:', items);
    }

    public sendControlMessage(message: any) {
        if (!this.controlWs || this.controlWs.readyState !== WebSocket.OPEN) {
            return;
        }

        //    "changeCursorPosition"
        //    "panelScrollTo"
        //    "panelScrollByPosition"
        //    "sourceScrollBySpan"
        //    "syncMemoryFiles"
        //    "updateMemoryFiles"
        //    "removeMemoryFiles"
        let msg;

        switch (message.event) {
            case "UpdateMemoryFiles":
            case "SyncMemoryFiles":
                msg = {
                    event: message.event,
                    files: {
                        // [filePath] is a virtual label, content is the *whole* file content
                        [message.filePath]: message.content,
                    },
                };
                break;

            case "removeMemoryFiles":
                msg = {
                    event: "removeMemoryFiles",
                    files: [[message.filePath]],
                };
                break;

            case "changeCursorPosition":
            case "panelScrollTo":
                msg = {
                    event: message.event,
                    filepath: message.filePath,
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
                console.warn(`[Preview Control] Unknown control message event: ${message.event}`);
        }
        this.controlWs.send(JSON.stringify(msg));
    }

    private handleReconnect() {
        if (!this.reconnectAllowed) {
            return;
        }
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(
                `[Preview Control] Reconnecting... Attempt ${this.reconnectAttempts}`
            );

            this.connectionTimeout = setTimeout(() => {
                this.connect().catch((err) => {
                    console.error("[Preview Control] Reconnection failed:", err);
                });
            }, 1000 * this.reconnectAttempts);
        } else {
            console.error(
                "[Preview Control] Max reconnection attempts reached"
            );
        }
    }

    disconnect() {
        this.reconnectAllowed = false;
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
        if (this.controlWs) {
            this.controlWs.close();
        }
    }

    reconnect() {
        this.reconnectAllowed = true;
        this.handleReconnect();
    }
}
