export interface TinymistWebSocketClientConfig {
    name: string;
    statusKey: string;
    connectEvent: string;
    disconnectEvent: string;
    localPort: number;
    remotePath: string;
    binaryType?: BinaryType;

    heartbeatMs?: number;
    connectionTimeoutMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    reconnectFactor?: number;
}

const defaultTimings = {
    heartbeatMs: 20000,
    connectionTimeoutMs: 1000,
    reconnectBaseMs: 5000,
    reconnectMaxMs: 30000,
    reconnectFactor: 1.5,
};

export abstract class TinymistWebSocketClient {
    protected socket: WebSocket | null = null;
    protected token: string = '';
    protected uniqueTabId: string = '';
    protected pageId: number;
    protected config: TinymistWebSocketClientConfig & typeof defaultTimings;

    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;

    private reconnectAllowed: boolean = true;
    private reconnectAttempts: number = 0;

    constructor(pageId: number, token: string, uniqueTabId: string | undefined, config: TinymistWebSocketClientConfig) {
        this.pageId = pageId;
        this.token = token;
        this.uniqueTabId = uniqueTabId || '';
        this.config = {
            ...defaultTimings,
            ...config,
        };

        this.handleSyncConnect = this.handleSyncConnect.bind(this);
        this.disconnect = this.disconnect.bind(this);
        this.updateTokenOnNode = this.updateTokenOnNode.bind(this);

        window.$tmEventBus.listen(this.config.connectEvent, this.handleSyncConnect);
        window.$tmEventBus.listen(this.config.disconnectEvent, this.disconnect);
        window.$tmEventBus.listen('tinymist-all-disconnect', this.disconnect);
        window.$tmEventBus.listen('tinymist-token-renewed', this.updateTokenOnNode);
    }

    protected async handleSyncConnect(): Promise<void> {
        try {
            await this.connect();
        } catch (err) {
            console.error(`[${this.config.name}] Failed to connect:`, err);
            window.$tmEventBus.emit("tinymist-console-log", {
                type: "error",
                message: `[${this.config.name}] connection failed`,
                details: err,
            });
        }
    }

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.reconnectAllowed) {
                reject(new Error(`[${this.config.name}] Connect: Reconnection not allowed`));
                return;
            }
            if (!this.token) {
                reject(new Error(`[${this.config.name}] No token available`));
                return;
            }

            let settled = false;

            try {
                const wsUrl = this.buildUrl();
                console.log(`[${this.config.name}] Connecting to:`, wsUrl.replace(this.token, 'TOKEN_HIDDEN'));

                this.scheduleConnectionTimeout();

                this.socket = new WebSocket(wsUrl);
                if (this.config.binaryType) {
                    this.socket.binaryType = this.config.binaryType;
                }

                console.log(`[${this.config.name}] Socket created`, { wsUrl: wsUrl.replace(this.token, 'TOKEN_HIDDEN') });

                this.socket.onopen = () => {
                    settled = true;
                    this.reconnectAttempts = 0;
                    this.clearConnectionTimeout();
                    this.startHeartbeat();

                    console.log(`[${this.config.name}] WebSocket connected`);
                    window.$tmEventBus.emit("tinymist-status", { what: this.config.statusKey, connected: true });
                    window.$tmEventBus.emit("tinymist-console-log", { type: "success", message: `[${this.config.name}] connected` });

                    this.onOpen();
                    resolve();
                };

                this.socket.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.socket.onerror = (error) => {
                    console.error(`[${this.config.name}] WebSocket error:`, error);
                    window.$tmEventBus.emit("tinymist-status", { what: this.config.statusKey, connected: false });
                    this.onError(error);
                    if (!settled) {
                        settled = true;
                        reject(new Error(`[${this.config.name}] WebSocket error before open`));
                    }
                };

                this.socket.onclose = (event) => {
                    console.log(`[${this.config.name}] WebSocket closed`, { code: event.code, reason: event.reason });
                    this.stopHeartbeat();
                    window.$tmEventBus.emit("tinymist-status", { what: this.config.statusKey, connected: false });

                    const errCodes: Record<number, string> = {
                        1000: "Normal closure",
                        1001: "Going away",
                        1006: "Abnormal closure (no close frame)",
                        1011: "Internal server error",
                    };

                    if (event.reason === 'INVALID_TOKEN') {
                        console.warn(`[${this.config.name}] Invalid token, requesting renewal`);
                        window.$tmEventBus.emit('tinymist-invalid-token');
                    }

                    if (event.code !== 1000) {
                        this.scheduleReconnect();
                    }

                    this.onClose(event);
                    if (!settled) {
                        settled = true;
                        reject(new Error(`Connection closed: ${event.code} - ${event.reason || errCodes[event.code] || 'Unknown reason'}`));
                    }
                };
            } catch (error) {
                window.$tmEventBus.emit("tinymist-status", { what: this.config.statusKey, connected: false });
                reject(error);
            }
        });
    }

    protected buildUrl(): string {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const hostname = window.location.hostname;
        const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
        const hostWithPort = window.location.host;
        const baseUrl = isLocal
            ? `${protocol}//${hostname}:${this.config.localPort}`
            : `${protocol}//${hostWithPort}${this.config.remotePath}`;
        const token = encodeURIComponent(this.token);
        const uniqueTabId = encodeURIComponent(this.uniqueTabId || '');
        const query = `?token=${token}&uniqueTabId=${uniqueTabId}`;

        return `${baseUrl}${query}`;
    }

    protected startHeartbeat(): void {
        if (!this.reconnectAllowed) {
            console.log(`[${this.config.name}] Heartbeat: Reconnection not allowed`);
            return;
        }

        this.stopHeartbeat();
        this.pingInterval = setInterval(() => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'ping' }));
            }
        }, this.config.heartbeatMs);
    }

    protected stopHeartbeat(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    protected scheduleReconnect(): void {
        if (this.reconnectTimeout) {
            return;
        }

        if (!this.reconnectAllowed) {
            console.log(`[${this.config.name}] scheduleReconnect: Reconnection not allowed`);
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(
            this.config.reconnectBaseMs * Math.pow(this.config.reconnectFactor, this.reconnectAttempts - 1),
            this.config.reconnectMaxMs
        );

        console.log(`[${this.config.name}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            void this.connect().catch((err) => {
                console.warn(`[${this.config.name}] Reconnect attempt failed:`, err);
            });
        }, delay);
    }

    protected scheduleConnectionTimeout(): void {
        this.clearConnectionTimeout();
        this.connectionTimeout = setTimeout(() => {
            if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
                console.warn(`[${this.config.name}] WebSocket connection timeout`);
                window.$tmEventBus.emit("tinymist-status", { what: this.config.statusKey, connected: false });
            }
        }, this.config.connectionTimeoutMs);
    }

    protected clearReconnectTimeout(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
    }

    protected clearConnectionTimeout(): void {
        if (this.connectionTimeout) {
            clearTimeout(this.connectionTimeout);
            this.connectionTimeout = null;
        }
    }

    protected updateTokenOnNode(token: string): void {
        if (!token) {
            return;
        }
        this.token = token;
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            console.log(`[${this.config.name}] Sending token update to node server`);
            this.sendJson({
                type: 'updateToken',
                token: token,
            });
        }
    }

    protected sendRaw(message: string | ArrayBuffer | Uint8Array): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        this.socket.send(message as any);
    }

    protected sendJson(payload: Record<string, unknown>): void {
        this.sendRaw(JSON.stringify(payload));
    }

    public disconnect(): void {
        this.reconnectAllowed = false;

        this.stopHeartbeat();
        this.clearReconnectTimeout();
        this.clearConnectionTimeout();

        if (this.socket) {
            this.socket.close(1000, 'Client disconnected');
            this.socket = null;
            console.log(`[${this.config.name}] Intentionally disconnected`);
            window.$tmEventBus.emit("tinymist-status", { what: this.config.statusKey, connected: false });
        }
    }

    protected onOpen(): void {
        // Intended to be overridden.
    }

    protected onClose(_event: CloseEvent): void {
        // Intended to be overridden.
    }

    protected onError(_error: Event): void {
        // Intended to be overridden.
    }

    protected abstract handleMessage(data: any): void;
}
