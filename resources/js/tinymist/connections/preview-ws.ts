// One websocket with both Control and Data Plane messages
// On the backend preview_server bridges both planes

export class PreviewBridgeClient {
    private socket: WebSocket | null = null;
    private token: string = '';
    private port: number = 4020;
    private pageId: number;
    private path: string = '/ws/tinymist/preview/';

    // Timers and intervals
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;

    // State tracking
    private reconnectAllowed: boolean = true;
    private reconnectAttempts: number = 0;
    private isDebugEnabled(): boolean {
        return Boolean((window as any)?.tinymistPreviewDebug);
    }

    constructor(
        pageId: number,
        token: string,
    ) {
        this.pageId = pageId;
        this.token = token;

        this.handleSyncConnect = this.handleSyncConnect.bind(this);
        this.disconnect = this.disconnect.bind(this);
        this.updateToken = this.updateToken.bind(this);
        this.handleOutgoingControl = this.handleOutgoingControl.bind(this);
        this.handleOutgoingData = this.handleOutgoingData.bind(this);
        window.$events.listen("tinymist-preview-connect", this.handleSyncConnect);
        window.$events.listen("tinymist-preview-disconnect", this.disconnect);
        window.$events.listen("tinymist-all-disconnect", this.disconnect);
        window.$events.listen("tinymist-token-renewed", this.updateToken);
        window.$events.listen("tinymist-preview-send-control", this.handleOutgoingControl);
        window.$events.listen("tinymist-preview-send-data", this.handleOutgoingData);
    }

    private async handleSyncConnect(token?: string): Promise<void> {
        try {
            await this.connect(token);
        } catch (err) {
            console.error("[Preview WS] Failed to connect:", err);
            window.$events.emit("tinymist-console-log",{ type: "error", message: "[Preview WS] connection failed", details: err });
        }
    }

    /**
     * Connect to the WebSocket server
     */
    async connect(token?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.reconnectAllowed) {
                reject("[Preview WS] Connect: Reconnection not allowed");
            }

            if (token) {
                this.token = token;
            }
            if (!this.token) {
                reject("[Preview WS] No token available");
            }

            try {
                // Construct WebSocket URL from current page URL
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const hostname = window.location.hostname;
                const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
                const hostWithPort = window.location.host;
                const baseUrl = isLocal
                    ? `${protocol}//${hostname}:${this.port}`
                    : `${protocol}//${hostWithPort}${this.path}`;
                const wsUrl = `${baseUrl}?token=${encodeURIComponent(this.token)}`;

                console.log('[Preview WS] Connecting to:', wsUrl.replace(this.token, 'TOKEN_HIDDEN'));

                this.scheduleConnectionTimeout();

                this.socket = new WebSocket(wsUrl);
                // It only affects binary frames. text messages stay strings (double check?)
                this.socket.binaryType = "arraybuffer";
                if (this.isDebugEnabled()) {
                    console.log("[Preview WS] Socket created", { wsUrl: wsUrl.replace(this.token, "TOKEN_HIDDEN") });
                }

                this.socket.onopen = () => {
                    this.reconnectAttempts = 0;
                    this.clearConnectionTimeout();
                    this.startHeartbeat();

                    console.log('[Preview WS] WebSocket connected');
                    window.$events.emit("tinymist-status", { what: "preview-ws", connected: true });
                    window.$events.emit("tinymist-preview-control-connected");
                    window.$events.emit("tinymist-preview-data-connected");
                    window.$events.emit("tinymist-console-log",{ type: "success", message: "[Preview WS] connected" });

                    resolve();
                };

                this.socket.onmessage = (event) => {
                    this.handleMessage(event.data);
                                    if (this.isDebugEnabled()) {
                                        const kind = typeof event.data;
                                        const size = event.data instanceof ArrayBuffer ? event.data.byteLength : undefined;
                                        console.log("[Preview WS] Message received", { kind, size });
                                    }
                };

                this.socket.onerror = (error) => {
                    console.error('[Preview WS] WebSocket error:', error);
                    window.$events.emit("tinymist-status", { what: "preview-ws", connected: false });
                    window.$events.emit("tinymist-preview-control-disconnected");
                    window.$events.emit("tinymist-preview-data-disconnected");
                    reject(error);
                };

                this.socket.onclose = (event) => {
                    console.log('[Preview WS] WebSocket closed', { code: event.code, reason: event.reason });
                    this.stopHeartbeat();
                    window.$events.emit("tinymist-status", { what: "preview-ws", connected: false });

                    const errCodes: Record<number, string> = {
                        1000: "Normal closure",
                        1001: "Going away",
                        1006: "Abnormal closure (no close frame)",
                        1011: "Internal server error",
                    };
                    if (event.code !== 1000) {
                        this.scheduleReconnect()
                    }
                    reject(new Error(`Connection closed: ${event.code} - ${event.reason || errCodes[event.code] || 'Unknown reason'}`));
                };

                return true;
            } catch (error) {
                window.$events.emit("tinymist-status", { what: "preview-ws", connected: false });
                reject(error)
            }
        });
    }

    private handleMessage(data: any): void {
        const forwardControl = (payload: string) => {
            if (this.isDebugEnabled()) {
                console.log("[Preview WS] Forwarding control message", { length: payload.length });
            }
            window.$events.emit("tinymist-preview-control-message", payload);
        };

        const forwardData = (buffer: ArrayBuffer) => {
            if (this.isDebugEnabled()) {
                console.log("[Preview WS] Forwarding data message", { bytes: buffer.byteLength });
            }
            window.$events.emit("tinymist-preview-data-message", new Uint8Array(buffer));
        };

        // Check data type
        if (data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(data);
            if (bytes.length === 0) {
                return;
            }

            // Some control-plane messages arrive as binary buffers (JSON strings)
            if (bytes[0] === 0x7b) {
                const text = new TextDecoder().decode(bytes);
                forwardControl(text);
                return;
            }

            forwardData(data);
        } else if (data instanceof Blob) {
            data.arrayBuffer().then((buffer) => {
                const bytes = new Uint8Array(buffer);
                if (bytes.length === 0) {
                    return;
                }

                if (bytes[0] === 0x7b) {
                    const text = new TextDecoder().decode(bytes);
                    forwardControl(text);
                    return;
                }

                forwardData(buffer);
            });
        } else if (typeof data === "string") {
            forwardControl(data);
        } else {
            console.warn("[Preview WS] Message unknown type:", data);
        }
    }

    private startHeartbeat(): void {
        if (!this.reconnectAllowed) {
            console.log("[Preview WS] Heartbeat: Reconnection not allowed");
            return;
        }

        this.stopHeartbeat();
        this.pingInterval = setInterval(() => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'ping' }));
            }
        }, 20000); // 20 seconds
    }

    private stopHeartbeat(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimeout) {
            return; // Already scheduled
        }

        if (!this.reconnectAllowed) {
            console.log("[Preview WS] scheduleReconnect: Reconnection not allowed");
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

        console.log(`[Preview WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect(this.token);
        }, delay);
    }

    private scheduleConnectionTimeout(): void {
        this.clearConnectionTimeout();
        // Timeout after 1 second if connection doesn't succeed
        this.connectionTimeout = setTimeout(() => {
            if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
                console.warn('[Preview WS] WebSocket connection timeout');
                window.$events.emit("tinymist-status", { what: "preview-ws", connected: false });
            }
        }, 1000);
    }


    private updateToken(token: string): void {
        if (!token) return;
        this.token = token;
        // Send token update to server if connected (no reconnection needed!)
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            console.log('[Preview WS] Sending token update to node server');
            this.socket.send(JSON.stringify({
                type: 'updateToken',
                token: token
            }));
        }
    }

    private handleOutgoingControl(message: string): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        if (this.isDebugEnabled()) {
            console.log("[Preview WS] Sending control message", { length: message.length });
        }
        this.socket.send(message);
    }

    private handleOutgoingData(message: string | Uint8Array): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        if (this.isDebugEnabled()) {
            const bytes = typeof message === "string" ? message.length : message.byteLength;
            console.log("[Preview WS] Sending data message", { bytes });
        }
        this.socket.send(message);
    }

    private clearReconnectTimeout(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
    }

    private clearConnectionTimeout(): void {
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
    }

    /**
     * Disconnect from the WebSocket server
     */
    disconnect(): void {

        this.reconnectAllowed = false;

        this.stopHeartbeat();
        this.clearReconnectTimeout();
        this.clearConnectionTimeout();

        if (this.socket) {
            this.socket.close(1000, 'Client disconnected');
            this.socket = null;
            console.log("[Preview WS] Intentionally disconnected");
            window.$events.emit("tinymist-status", { what: "preview-ws", connected: false });
        }

    }
}
