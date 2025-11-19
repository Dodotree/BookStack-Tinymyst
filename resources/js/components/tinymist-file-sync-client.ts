import { c } from "../code/legacy-modes.mjs";

/**
 * WebSocket client for real-time Typst file synchronization
 * Handles connection, authentication, token renewal, and change streaming
 */
export class TinymistFileSyncClient {
    private socket: WebSocket | null = null;
    private token: string = '';
    private tokenExpiry: number = 0;
    private pageId: number;
    private docVersion: number = 0;

    // Timers and intervals
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private tokenRenewalTimeout: ReturnType<typeof setTimeout> | null = null;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;

    // State tracking
    private reconnectAllowed: boolean = true;
    private reconnectAttempts: number = 0;

    // Callbacks
    private onMessage?: (message: any) => void;

    constructor(
        pageId: number,
        token: string,
        options?: {
            onMessage?: (message: any) => void;
        }
    ) {
        this.pageId = pageId;
        this.token = token;

        if (options) {
            this.onMessage = options.onMessage;
        }

        this.handleSyncConnect = this.handleSyncConnect.bind(this);
        this.sendChanges = this.sendChanges.bind(this);
        this.disconnect = this.disconnect.bind(this);
        window.$events.listen("tinymist-sync-connect", this.handleSyncConnect);
        window.$events.listen("tinymist-text-diff", this.sendChanges);
        window.$events.listen("tinymist-sync-disconnect", this.disconnect);
    }

    private async handleSyncConnect(token?: string): Promise<void> {
        try {
            await this.connect(token);
        } catch (err) {
            console.error("[File Sync / LSP] Failed to connect:", err);
            window.$events.emit("tinymist-console-log",{ type: "error", message: "[File Sync / LSP] connection failed", details: err });
        }
    }

    /**
     * Connect to the WebSocket server
     */
    async connect(token?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.reconnectAllowed) {
                reject("[File Sync / LSP] Connect: Reconnection not allowed");
            }

            if (token) {
                this.token = token;
            }
            if (!this.token) {
                reject("[File Sync / LSP] No token available");
            }
            // Decode JWT to get expiration time
            this.decodeAndStoreTokenExpiry(this.token);

            try {
                // Construct WebSocket URL from current page URL
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const host = window.location.hostname;
                const port = 4000; // WebSocket server port
                const wsUrl = `${protocol}//${host}:${port}?token=${encodeURIComponent(this.token)}`;

                console.log('[File Sync / LSP] Connecting to:', wsUrl.replace(this.token, 'TOKEN_HIDDEN'));

                this.scheduleConnectionTimeout();

                this.socket = new WebSocket(wsUrl);

                this.socket.onopen = () => {
                    this.reconnectAttempts = 0;
                    this.clearConnectionTimeout();
                    this.startHeartbeat();
                    this.scheduleTokenRenewal();

                    console.log('[File Sync / LSP] WebSocket connected');
                    window.$events.emit("tinymist-status", { what: "file-lsp-ws", connected: true });
                    window.$events.emit("tinymist-console-log",{ type: "success", message: "[File Sync / LSP] connected" });

                    resolve();
                };

                this.socket.onmessage = (event) => {
                    this.handleMessage(event.data);
                };

                this.socket.onerror = (error) => {
                    console.error('[File Sync / LSP] WebSocket error:', error);
                    window.$events.emit("tinymist-status", { what: "file-lsp-ws", connected: false });
                    reject(error);
                };

                this.socket.onclose = (event) => {
                    console.log('[File Sync / LSP] WebSocket closed', { code: event.code, reason: event.reason });
                    this.stopHeartbeat();
                    window.$events.emit("tinymist-status", { what: "file-lsp-ws", connected: false });

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
                window.$events.emit("tinymist-status", { what: "file-lsp-ws", connected: false });
                reject(error)
            }
        });
    }

    /**
     * Send changes to the server
     */
    sendChanges(changes: any): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            console.warn('[File Sync / LSP] WebSocket not connected, changes not synced');
            return;
        }

        this.docVersion++;

        const message = {
            type: 'changes',
            pageId: this.pageId,
            docVersion: this.docVersion,
            changes: changes.toJSON(),
        };

        this.socket.send(JSON.stringify(message));
    }

    private handleMessage(data: string): void {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case 'pong':
                    // Heartbeat response
                    console.log('[File Sync / LSP] Received pong');
                    break;

                case 'ack':
                    console.log('[File Sync / LSP] Change acknowledged', { docVersion: msg.docVersion });
                    break;

                case 'fullState':
                    console.log('[File Sync / LSP] Received full state from server', { docVersion: msg.docVersion });
                    this.docVersion = msg.docVersion;
                    this.notifyMessage(msg);
                    break;

                case 'semanticTokens':
                    this.notifyMessage(msg);
                    break;

                case 'error':
                    console.error('[File Sync / LSP] Server error:', msg);
                    window.$events.emit("tinymist-console-log",{ type: "error", message: "[File Sync / LSP] Server error", details: msg });
                    break;

                default:
                    console.warn('[File Sync / LSP] Unknown message type:', msg.type);
            }

        } catch (error) {
            console.error('[File Sync / LSP] Failed to parse WebSocket message:', error);
        }
    }

    private startHeartbeat(): void {
        if (!this.reconnectAllowed) {
            console.log("[File Sync / LSP] Heartbeat: Reconnection not allowed");
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
            console.log("[File Sync / LSP] scheduleReconnect: Reconnection not allowed");
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

        console.log(`[File Sync / LSP] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

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
                console.warn('[File Sync / LSP] WebSocket connection timeout');
                window.$events.emit("tinymist-status", { what: "file-lsp-ws", connected: false });
            }
        }, 1000);
    }

    private clearTokenRenewalTimeout(): void {
        if (this.tokenRenewalTimeout) {
            clearTimeout(this.tokenRenewalTimeout);
            this.tokenRenewalTimeout = null;
        }
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

    private decodeAndStoreTokenExpiry(token: string): void {
        try {
            // JWT format: header.payload.signature
            const parts = token.split('.');
            if (parts.length !== 3) {
                console.warn('[File Sync / LSP] Invalid JWT token format');
                return;
            }

            // Decode payload (base64url decode)
            const payload = parts[1];
            const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
            const payloadObj = JSON.parse(decoded);

            if (payloadObj.exp) {
                this.tokenExpiry = payloadObj.exp;
                const expiresIn = this.tokenExpiry - Math.floor(Date.now() / 1000);
                console.log(`[File Sync / LSP] Token expires in ${expiresIn} seconds (${new Date(this.tokenExpiry * 1000).toLocaleTimeString()})`);
            }
        } catch (error) {
            console.error('[File Sync / LSP] Failed to decode token:', error);
        }
    }

    private scheduleTokenRenewal(): void {
        this.clearTokenRenewalTimeout();

        if (!this.reconnectAllowed) {
            console.log("[File Sync / LSP] scheduleTokenRenewal: Token renewal not allowed");
            return;
        }

        if (!this.tokenExpiry) {
            console.warn('[File Sync / LSP] Token expiry not set, skipping renewal schedule');
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const expiresIn = this.tokenExpiry - now;

        // Renew 60 seconds before expiry (or halfway through if token has less than 120s lifetime)
        const renewalBuffer = Math.min(60, Math.floor(expiresIn / 2));
        const renewIn = Math.max(0, expiresIn - renewalBuffer);

        if (renewIn <= 0) {
            console.warn('[File Sync / LSP] Token already expired or about to expire, renewing immediately');
            this.renewToken();
            return;
        }

        console.log(`[File Sync / LSP] Scheduling token renewal in ${renewIn} seconds`);
        this.tokenRenewalTimeout = setTimeout(() => {
            this.renewToken();
        }, renewIn * 1000);
    }

    private async renewToken(): Promise<void> {

        if (!this.reconnectAllowed) {
            console.log("[File Sync / LSP] renewToken: Token renewal not allowed");
            return;
        }

        try {
            console.log('[File Sync / LSP] Renewing WebSocket token...');
            const response = await window.$http.post('/ajax/tinymist/renew-ws-token', {
                page_id: this.pageId
            }) as any;

            const data = response.data || response;

            if (data.success && data.token) {
                console.log('[File Sync / LSP] Token renewed successfully');

                // Update token locally
                this.token = data.token;
                this.tokenExpiry = data.expires_at;

                // Send token update to server if connected (no reconnection needed!)
                if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                    console.log('[File Sync / LSP] Sending token update to server');
                    this.socket.send(JSON.stringify({
                        type: 'updateToken',
                        token: data.token
                    }));
                }

                // Schedule next renewal
                this.scheduleTokenRenewal();
            } else {
                console.error('[File Sync / LSP] Token renewal failed:', data.error || 'Unknown error');
                window.$events.emit("tinymist-console-log",{ type: "error", message: "[File Sync / LSP] token renewal failed", details: data });
            }
        } catch (error) {
            console.error('[File Sync / LSP] Token renewal request failed:', error);
            window.$events.emit("tinymist-console-log",{ type: "error", message: "[File Sync / LSP] token renewal failed", details: error });
        }
    }

    private notifyMessage(message: any): void {
        if (this.onMessage) {
            this.onMessage(message);
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
        this.clearTokenRenewalTimeout();

        if (this.socket) {
            this.socket.close(1000, 'Client disconnected');
            this.socket = null;
            console.log("[File Sync / LSP] Intentionally disconnected");
            window.$events.emit("tinymist-status", { what: "file-lsp-ws", connected: false });
        }

    }
}
