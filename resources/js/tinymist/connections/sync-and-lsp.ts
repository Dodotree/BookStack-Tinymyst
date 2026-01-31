// Connects to node server that syncs files and holds LSP stdin/stdout pipes
// Authenticates via signed tokens, updates them in time
// Tracks connection state of the socket with ping/pongs and reports the state of LSP pipes

// Initial state of the file comes from db to both front and back ends
// Subsequent changes are synced via incremental updates with version tracking
// On page load first ws connection verifies if front and back ends have the same version

// sent: ping
// sent: verify versions -> server verifies and responds with current version or requests full sync
// sent: (gets from editor) {full sync, forceReset -?} -> server applies full content (version N)
// sent: initial request for full semanticTokens -> server -> LSP -> server -> tokens
// sent: editor {change increment} -> server updates file (if version is > server version)
// sent: request for semanticTokens delta -> server -> LSP -> server -> tokens delta (not tried yet)

// receive: pong
// receive: 'ack' acknowledged token on update
// receive: server {full sync to version N} (if server version > client version) -> here -> editor applies full content
// receive: LSP pushes diagnostics when file updates -> server -> here -> diagnostics.ts
// if LSP is down, "LSPdown" message sent from server upon file update (and following diagnostics push expected)
// receive: encoded semanticTokens here -> semantic_tokens.ts -> editor applies tokens
// receive: semanticTokens delta here -> semantic_tokens.ts -> editor applies token edits
// receive: Error, see list below

// Errors
// page mismatch
// version mismatch
// can not apply change (most likely cursor drift)
// failed to write the file
// LSP request failed

/**
 * WebSocket client for real-time Typst file synchronization
 * Handles connection, authentication, token renewal, and change streaming
 */
export class TinymistFileSyncClient {
    private socket: WebSocket | null = null;
    private token: string = '';
    private tabToken: string = '';
    private port: number = 4000;
    private pageId: number;
    private docVersion: number = 0;

    // Timers and intervals
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;

    // State tracking
    private reconnectAllowed: boolean = true;
    private reconnectAttempts: number = 0;

    constructor(
        pageId: number,
        token: string,
        tabToken: string,
    ) {
        this.pageId = pageId;
        this.token = token;
        this.tabToken = tabToken;

        this.handleSyncConnect = this.handleSyncConnect.bind(this);
        this.sendChanges = this.sendChanges.bind(this);
        this.disconnect = this.disconnect.bind(this);
        this.updateToken = this.updateToken.bind(this);
        window.$events.listen("tinymist-sync-connect", this.handleSyncConnect);
        window.$events.listen("tinymist-text-diff", this.sendChanges);
        window.$events.listen("tinymist-sync-disconnect", this.disconnect);
        window.$events.listen("tinymist-all-disconnect", this.disconnect);
        window.$events.listen("tinymist-token-renewed", this.updateToken);
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

            try {
                // Construct WebSocket URL from current page URL
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const hostname = window.location.hostname;
                const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
                const hostWithPort = window.location.host;
                const baseUrl = isLocal
                    ? `${protocol}//${hostname}:${this.port}`
                    : `${protocol}//${hostWithPort}/ws/tinymist/file-sync/`;
                const wsUrl = `${baseUrl}?token=${encodeURIComponent(this.token)}&tabToken=${encodeURIComponent(this.tabToken)}`;

                console.log('[File Sync / LSP] Connecting to:', wsUrl.replace(this.token, 'TOKEN_HIDDEN'));

                this.scheduleConnectionTimeout();

                this.socket = new WebSocket(wsUrl);

                this.socket.onopen = () => {
                    this.reconnectAttempts = 0;
                    this.clearConnectionTimeout();
                    this.startHeartbeat();

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
                    window.$events.emit("tinymist-sync-full-state", msg.content);
                    break;

                case 'semanticTokens':
                    window.$events.emit("tinymist-lsp-semantic-tokens", msg.tokens || []);
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

    private updateToken(token: string): void {
        if (!token) return;
        this.token = token;
        // Send token update to server if connected (no reconnection needed!)
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            console.log('[File Sync / LSP] Sending token update to node server');
            this.socket.send(JSON.stringify({
                type: 'updateToken',
                token: token
            }));
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
            console.log("[File Sync / LSP] Intentionally disconnected");
            window.$events.emit("tinymist-status", { what: "file-lsp-ws", connected: false });
        }

    }
}

