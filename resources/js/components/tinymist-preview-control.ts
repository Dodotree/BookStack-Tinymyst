type OutlineItem = {
    title: string;
    level: number;
    line: number;
    character: number;
    children: OutlineItem[];
};

export class PreviewControlPlane {
    private controlWs: WebSocket | null = null;
    private pageId: number;
    private fileUri: string;
    private maxReconnectAttempts: number = 5;
    private reconnectAttempts: number = 0;
    private reconnectAllowed: boolean = true;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
    private controlPort: number;
    private host: string;

    constructor(
        pageId: number,
        content: string,
        host: string = "127.0.0.1", // provided directly from php template
        controlPort: number = 23627, // provided directly from php template
    ) {
        this.pageId = pageId;
        // TODO: replace on the server side with proper storage path
        this.fileUri =`C:\\Users\\Ooo\\Desktop\\GitWork\\BookStack\\storage\\app\\tinymist\\page_${pageId}.typ`;
        this.host = host;
        this.controlPort = controlPort;

        this.handleSyncConnect = this.handleSyncConnect.bind(this);
        this.sendControlMessage = this.sendControlMessage.bind(this);
        this.disconnect = this.disconnect.bind(this);
        window.$events.listen("tinymist-control-connect", this.handleSyncConnect)
        window.$events.listen("tinymist-control", this.sendControlMessage);
        window.$events.listen("tinymist-control-disconnect", this.disconnect)
    }

    private async handleSyncConnect(): Promise<void> {
        try {
            await this.connect();
        } catch (err) {
            console.error("[Preview Control] Failed to connect:", err);
            window.$events.emit("tinymist-console-log",{ type: "error", message: "[Preview Control] connection failed", details: err });
        }
    }

    connect(): Promise<void> {
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

                    window.$events.emit("tinymist-status", { what: "control-plane-ws", connected: true });
                    window.$events.emit("tinymist-console-log", { type: "success", message: "[Preview Control] connected" });
                    resolve();
                };

                this.controlWs.onmessage = (socketEvent) => {
                    const msg = JSON.parse(socketEvent.data);
                    if (msg.event === 'compileStatus') {
                        console.log(`[Preview Control] Compile status event:`, socketEvent);
                        this.onCompileStatus(msg.kind, msg);
                    } else if (msg.event === 'outline') {
                        this.onOutline(msg.items);
                    } else if (msg.event === 'syncEditorChanges') {
                        this.onSyncChanges(msg);
                    } else {
                        console.warn(`[Preview Control] Unknown message: ${socketEvent.data}`);
                        window.$events.emit("tinymist-console-log", { type: "warning", message: `[Preview Control] Unknown message: ${socketEvent.data}` });
                    }
                };

                this.controlWs.onerror = (error) => {
                    console.error("[Preview Control] WS error:", error);
                    window.$events.emit("tinymist-status", { what: "control-plane-ws", connected: false });
                    window.$events.emit("tinymist-console-log", { type: "error", message: "[Preview Control] Socket error", details: error });
                    reject(error);
                };

                this.controlWs.onclose = (event) => {
                    console.warn(
                        `[Preview Control] WS disconnected: code=${event.code}, reason=${event.reason}`
                    );
                    window.$events.emit("tinymist-status", { what: "control-plane-ws", connected: false });
                    window.$events.emit("tinymist-console-log", { type: "error", message: "[Preview Control] disconnected" });

                    const errCodes: Record<number, string> = {
                        1000: "Normal closure",
                        1001: "Going away",
                        1006: "Abnormal closure (no close frame)",
                        1011: "Internal server error",
                    };
                    if (event.code !== 1000) {
                        this.handleReconnect();
                    }
                    reject(new Error(`Connection closed: ${event.code} - ${event.reason || errCodes[event.code] || 'Unknown reason'}`));
                };
            } catch (error) {
                window.$events.emit("tinymist-status", { what: "control-plane-ws", connected: false });
                reject(error);
            }
        });
    }

    private onCompileStatus (kind: string, msg?: any) {
        if (kind === "Compiling") {
            window.$events.emit("tinymist-console-log",
                { type: "info", message: "[Preview Control] Compiling..." });
        } else if (kind === "CompileSuccess") {
            window.$events.emit("tinymist-console-log",
                { type: "success", message: "[Preview Control] Compilation successful" });
        } else if (kind === "CompileError") {
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "[Preview Control] Compilation failed" });
            console.log("[Preview Control] Error:", msg);
        }
    }

    private onSyncChanges(msg: any) {
        // Handle synchronization
        console.log('[Preview Control] Syncing changes:', msg);
    }

    private onOutline(items: OutlineItem[]) {
        // Update table of contents
        console.log('[Preview Control] Document outline:', items);
    }

    public sendControlMessage(message: any) {
        if (!this.controlWs || this.controlWs.readyState !== WebSocket.OPEN) {
            return;
        }

        let msg;

        switch (message.event) {
            case "UpdateMemoryFiles":
            case "SyncMemoryFiles":
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
                    filepath: this.fileUri, // absolute path unless memory file is
                    line: message.line,
                    character: message.character,
                };
                console.log('[Preview Control] Sending cursor position:', msg);
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
                return;
        }

        console.log(`[Preview Control] Sending Control Plane ${message.event}:`, msg);
        this.controlWs.send(JSON.stringify(msg));
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
            console.log("[Preview Control] Intentionally disconnected");
            window.$events.emit("tinymist-status", { what: "control-plane-ws", connected: false });
        }
    }

    reconnect() {
        this.reconnectAllowed = true;
        this.handleReconnect();
    }
}
