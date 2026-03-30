import { DEFAULT_WS_TIMINGS, LOCAL_WS_HOSTNAMES, tmEvents } from "../constants";
import type { TinymistEventPayloads } from "../constants/custom-events";

export interface TinymistWebSocketClientConfig {
    name: string;
    statusKey: string;
    connectEvent: keyof TinymistEventPayloads;
    disconnectEvent: keyof TinymistEventPayloads;
    localPort: number;
    remotePath: string;
    binaryType?: BinaryType;

    heartbeatMs?: number;
    connectionTimeoutMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    reconnectFactor?: number;
}

export abstract class TinymistWebSocketClient {
    protected socket: WebSocket | null = null;
    protected token: string = "";
    protected uniqueTabId: string = "";
    protected pageId: number;
    protected config: TinymistWebSocketClientConfig & typeof DEFAULT_WS_TIMINGS;

    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private pongLength: number = '{"type":"pong"}'.length;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;

    private reconnectAllowed: boolean = true;
    private reconnectAttempts: number = 0;
    private waitingForTokenRenewal: boolean = false;

    constructor(
        pageId: number,
        token: string,
        uniqueTabId: string | undefined,
        config: TinymistWebSocketClientConfig,
    ) {
        this.pageId = pageId;
        this.token = token;
        this.uniqueTabId = uniqueTabId || "";
        this.config = {
            ...DEFAULT_WS_TIMINGS,
            ...config,
        };

        this.handleSyncConnect = this.handleSyncConnect.bind(this);
        this.disconnect = this.disconnect.bind(this);
        this.updateTokenOnNode = this.updateTokenOnNode.bind(this);

        window.$tmEventBus.listen(
            this.config.connectEvent,
            this.handleSyncConnect,
        );
        window.$tmEventBus.listen(tmEvents.TokenRenewed, this.updateTokenOnNode);
        window.$tmEventBus.listen(this.config.disconnectEvent, this.disconnect);
        window.$tmEventBus.listen(tmEvents.AllDisconnect, this.disconnect);
        window.$tmEventBus.listen(tmEvents.Destroy, this.disconnect);
        window.$tmEventBus.listen(tmEvents.ReconnectAllowed, () => {
            this.reconnectAllowed = true;
        });
    }

    protected async handleSyncConnect(): Promise<void> {
        try {
            await this.connect();
        } catch (err) {
            console.error(`[${this.config.name}] Failed to connect:`, err);
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "error",
                message: `[${this.config.name}] connection failed`,
                details: err,
            });
        }
    }

    public async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.reconnectAllowed) {
                reject(
                    new Error(
                        `[${this.config.name}] Connect: Reconnection not allowed`,
                    ),
                );
                return;
            }
            if (
                this.socket &&
                (this.socket.readyState === WebSocket.OPEN ||
                    this.socket.readyState === WebSocket.CONNECTING)
            ) {
                resolve();
                return;
            }
            if (!this.token) {
                reject(new Error(`[${this.config.name}] No token available`));
                return;
            }

            let settled = false;

            try {
                const wsUrl = this.buildUrl();

                // console.log(`[${this.config.name}] Connecting to:`,
                //     wsUrl.replace(this.token, "TOKEN_HIDDEN"),
                // );

                this.scheduleConnectionTimeout();

                this.socket = new WebSocket(wsUrl);
                if (this.config.binaryType) {
                    this.socket.binaryType = this.config.binaryType;
                }

                // console.log(`[${this.config.name}] Socket created`, {
                //     wsUrl: wsUrl.replace(this.token, "TOKEN_HIDDEN"),
                // });

                this.socket.onopen = () => {
                    settled = true;
                    this.reconnectAttempts = 0;
                    this.waitingForTokenRenewal = false;
                    this.clearConnectionTimeout();
                    this.startHeartbeat();

                    window.$tmEventBus.emit(tmEvents.Status, {
                        what: this.config.statusKey,
                        connected: true,
                    });
                    window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                        type: "success",
                        message: `[${this.config.name}] connected`,
                    });

                    this.onOpen();
                    resolve();
                };

                this.socket.onmessage = (event) => {
                    if (
                        event.data.length === this.pongLength &&
                        event.data.includes('"type":"pong"')
                    ) {
                        // console.log(`[${this.config.name}] Received pong`);
                        return;
                    }
                    this.handleMessage(event.data);
                };

                this.socket.onerror = (error) => {
                    console.error(
                        `[${this.config.name}] WebSocket error:`,
                        error,
                    );
                    window.$tmEventBus.emit(tmEvents.Status, {
                        what: this.config.statusKey,
                        connected: false,
                    });
                    this.onError(error);
                    if (!settled) {
                        settled = true;
                        reject(
                            new Error(
                                `[${this.config.name}] WebSocket error before open`,
                            ),
                        );
                    }
                };

                this.socket.onclose = (event) => {
                    console.warn(`[${this.config.name}] WebSocket closed`, {
                        code: event.code,
                        reason: event.reason,
                    });
                    this.stopHeartbeat();
                    window.$tmEventBus.emit(tmEvents.Status, {
                        what: this.config.statusKey,
                        connected: false,
                    });

                    const errCodes: Record<number, string> = {
                        1000: "Normal closure",
                        1001: "Going away",
                        1006: "Abnormal closure (no close frame)",
                        1011: "Internal server error",
                    };

                    if (event.reason === "INVALID_TOKEN") {
                        console.warn(
                            `[${this.config.name}] Invalid token, requesting renewal`,
                        );
                        this.waitingForTokenRenewal = true;
                        this.clearReconnectTimeout();
                        window.$tmEventBus.emit(tmEvents.InvalidToken);
                    }

                    if (event.code !== 1000 && !this.waitingForTokenRenewal) {
                        this.scheduleReconnect();
                    }

                    this.onClose(event);
                    if (!settled) {
                        settled = true;
                        reject(
                            new Error(
                                `Connection closed: ${event.code} - ${event.reason || errCodes[event.code] || "Unknown reason"}`,
                            ),
                        );
                    }
                };
            } catch (error) {
                window.$tmEventBus.emit(tmEvents.Status, {
                    what: this.config.statusKey,
                    connected: false,
                });
                reject(error);
            }
        });
    }

    protected buildUrl(): string {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const hostname = window.location.hostname;
        const isLocal = LOCAL_WS_HOSTNAMES.has(hostname);
        const hostWithPort = window.location.host;
        const baseUrl = isLocal
            ? `${protocol}//${hostname}:${this.config.localPort}`
            : `${protocol}//${hostWithPort}${this.config.remotePath}`;
        const token = encodeURIComponent(this.token);
        const uniqueTabId = encodeURIComponent(this.uniqueTabId || "");
        const query = `?token=${token}&uniqueTabId=${uniqueTabId}`;

        return `${baseUrl}${query}`;
    }

    protected startHeartbeat(): void {
        if (!this.reconnectAllowed) {
            console.warn(
                `[${this.config.name}] Heartbeat: Reconnection not allowed`,
            );
            return;
        }

        this.stopHeartbeat();
        this.pingInterval = setInterval(() => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: "ping" }));
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
        if (this.reconnectTimeout || this.waitingForTokenRenewal || !this.reconnectAllowed) {
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(
            this.config.reconnectBaseMs *
                Math.pow(
                    this.config.reconnectFactor,
                    this.reconnectAttempts - 1,
                ),
            this.config.reconnectMaxMs,
        );

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            void this.connect().catch((err) => {
                console.warn(
                    `[${this.config.name}] Reconnect attempt failed:`,
                    err,
                );
            });
        }, delay);
    }

    protected scheduleConnectionTimeout(): void {
        this.clearConnectionTimeout();
        this.connectionTimeout = setTimeout(() => {
            if (
                this.socket === null ||
                this.socket.readyState !== WebSocket.OPEN
            ) {
                console.warn(
                    `[${this.config.name}] WebSocket connection timeout`,
                );
                window.$tmEventBus.emit(tmEvents.Status, {
                    what: this.config.statusKey,
                    connected: false,
                });
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
        this.waitingForTokenRenewal = false;
        this.reconnectAttempts = 0;
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            this.sendJson({
                type: "updateToken",
                token: token,
            });
            return;
        }

        if (this.reconnectAllowed) {
            this.clearReconnectTimeout();
            void this.connect().catch((err) => {
                console.warn(
                    `[${this.config.name}] Reconnect after token renewal failed:`,
                    err,
                );
                this.scheduleReconnect();
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
            this.socket.close(1000, "Client disconnected");
            this.socket = null;
            console.warn(`[${this.config.name}] Intentionally disconnected`);
            window.$tmEventBus.emit(tmEvents.Status, {
                what: this.config.statusKey,
                connected: false,
            });
        }
    }

    public dispose(): void {
        this.disconnect();
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
