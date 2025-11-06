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
    private reconnectAttempts: number = 0;
    private isConnected: boolean = false;

    // Callbacks
    private onConnectionStateChange?: (connected: boolean) => void;
    private onMessage?: (message: any) => void;
    private onError?: (error: string) => void;

    constructor(
        pageId: number,
        token: string,
        options?: {
            onConnectionStateChange?: (connected: boolean) => void;
            onMessage?: (message: any) => void;
            onError?: (error: string) => void;
        }
    ) {
        this.pageId = pageId;
        this.token = token;

        if (options) {
            this.onConnectionStateChange = options.onConnectionStateChange;
            this.onMessage = options.onMessage;
            this.onError = options.onError;
        }
    }

    /**
     * Connect to the WebSocket server
     */
    async connect(token?: string): Promise<boolean> {
        if (token) {
            this.token = token;
        }

        if (!this.token) {
            this.notifyError('No WebSocket token available');
            return false;
        }

        // Decode JWT to get expiration time
        this.decodeAndStoreTokenExpiry(this.token);

        try {
            // Construct WebSocket URL from current page URL
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const host = window.location.hostname;
            const port = 4000; // WebSocket server port
            const wsUrl = `${protocol}//${host}:${port}?token=${encodeURIComponent(this.token)}`;

            console.log('[File Sync Module] Connecting to:', wsUrl.replace(this.token, 'TOKEN_HIDDEN'));

            // Schedule connection timeout (1 second)
            this.scheduleConnectionTimeout();

            this.socket = new WebSocket(wsUrl);

            this.socket.onopen = () => {
                console.log('[File Sync Module] WebSocket connected');
                this.reconnectAttempts = 0;
                this.isConnected = true;

                this.clearConnectionTimeout();
                this.notifyConnectionState(true);

                // Start heartbeat
                this.startHeartbeat();

                // Schedule token renewal before expiry
                this.scheduleTokenRenewal();
            };

            this.socket.onmessage = (event) => {
                this.handleMessage(event.data);
            };

            this.socket.onerror = (error) => {
                console.error('[File Sync Module] WebSocket error:', error);
                this.notifyError('[File Sync Module] connection error');
            };

            this.socket.onclose = (event) => {
                console.log('[File Sync Module] WebSocket closed', { code: event.code, reason: event.reason });
                this.isConnected = false;
                this.stopHeartbeat();
                this.notifyConnectionState(false);

                if (event.code !== 1000) {
                    // Abnormal close, attempt reconnect
                    this.scheduleReconnect();
                }
            };

            return true;
        } catch (error) {
            console.error('[File Sync Module] Failed to connect WebSocket:', error);
            this.notifyError(`[File Sync Module] connection failed: ${error}`);
            return false;
        }
    }

    /**
     * Disconnect from the WebSocket server
     */
    disconnect(): void {
        this.stopHeartbeat();
        this.clearReconnectTimeout();
        this.clearConnectionTimeout();
        this.clearTokenRenewalTimeout();

        if (this.socket) {
            this.socket.close(1000, 'Client disconnected');
            this.socket = null;
        }

        this.isConnected = false;
        this.notifyConnectionState(false);
    }

    /**
     * Send changes to the server
     */
    sendChanges(changes: any): void {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            console.warn('[File Sync Module] WebSocket not connected, changes not synced');
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

    /**
     * Check if connected
     */
    connected(): boolean {
        return this.isConnected && this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    }

    /**
     * Get current document version
     */
    getDocVersion(): number {
        return this.docVersion;
    }

    /**
     * Set document version (e.g., after receiving fullState from server)
     */
    setDocVersion(version: number): void {
        this.docVersion = version;
    }

    // Private methods

    private handleMessage(data: string): void {
        try {
            const msg = JSON.parse(data);

            switch (msg.type) {
                case 'pong':
                    // Heartbeat response
                    break;

                case 'ack':
                    console.log('[File Sync Module] Change acknowledged', { docVersion: msg.docVersion });
                    break;

                case 'fullState':
                    console.log('[File Sync Module] Received full state from server', { docVersion: msg.docVersion });
                    this.docVersion = msg.docVersion;
                    break;

                case 'error':
                    console.error('[File Sync Module] Server error:', msg);
                    this.notifyError(`[File Sync Module] Server error: ${msg.message}`);
                    break;

                default:
                    console.warn('[File Sync Module] Unknown message type:', msg.type);
            }

            // Notify parent component
            if (this.onMessage) {
                this.onMessage(msg);
            }
        } catch (error) {
            console.error('[File Sync Module] Failed to parse WebSocket message:', error);
        }
    }

    private startHeartbeat(): void {
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

        this.reconnectAttempts++;
        const delay = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);

        console.log(`[File Sync Module] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect(this.token);
        }, delay);
    }

    private clearReconnectTimeout(): void {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
    }

    private scheduleConnectionTimeout(): void {
        this.clearConnectionTimeout();

        // Timeout after 1 second if connection doesn't succeed
        this.connectionTimeout = setTimeout(() => {
            if (!this.isConnected) {
                console.warn('[File Sync Module] WebSocket connection timeout');
                this.notifyConnectionState(false);
            }
        }, 1000);
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
                console.warn('[File Sync Module] Invalid JWT token format');
                return;
            }

            // Decode payload (base64url decode)
            const payload = parts[1];
            const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
            const payloadObj = JSON.parse(decoded);

            if (payloadObj.exp) {
                this.tokenExpiry = payloadObj.exp;
                const expiresIn = this.tokenExpiry - Math.floor(Date.now() / 1000);
                console.log(`[File Sync Module] Token expires in ${expiresIn} seconds (${new Date(this.tokenExpiry * 1000).toLocaleTimeString()})`);
            }
        } catch (error) {
            console.error('[File Sync Module] Failed to decode token:', error);
        }
    }

    private scheduleTokenRenewal(): void {
        this.clearTokenRenewalTimeout();

        if (!this.tokenExpiry) {
            console.warn('[File Sync Module] Token expiry not set, skipping renewal schedule');
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const expiresIn = this.tokenExpiry - now;

        // Renew 60 seconds before expiry (or halfway through if token has less than 120s lifetime)
        const renewalBuffer = Math.min(60, Math.floor(expiresIn / 2));
        const renewIn = Math.max(0, expiresIn - renewalBuffer);

        if (renewIn <= 0) {
            console.warn('[File Sync Module] Token already expired or about to expire, renewing immediately');
            this.renewToken();
            return;
        }

        console.log(`[File Sync Module] Scheduling token renewal in ${renewIn} seconds`);
        this.tokenRenewalTimeout = setTimeout(() => {
            this.renewToken();
        }, renewIn * 1000);
    }

    private clearTokenRenewalTimeout(): void {
        if (this.tokenRenewalTimeout) {
            clearTimeout(this.tokenRenewalTimeout);
            this.tokenRenewalTimeout = null;
        }
    }

    private async renewToken(): Promise<void> {
        try {
            console.log('[File Sync Module] Renewing WebSocket token...');
            const response = await window.$http.post('/ajax/tinymist/renew-ws-token', {
                page_id: this.pageId
            }) as any;

            const data = response.data || response;

            if (data.success && data.token) {
                console.log('[File Sync Module] Token renewed successfully');
                this.token = data.token;
                this.tokenExpiry = data.expires_at;

                // Reconnect WebSocket with new token
                if (this.socket) {
                    console.log('[File Sync Module] Reconnecting with new token...');
                    this.socket.close(1000, 'Token renewed');
                    // onclose handler will trigger reconnect with new token
                } else {
                    // Not currently connected, just update the token
                    this.connect(data.token);
                }

                // Schedule next renewal
                this.scheduleTokenRenewal();
            } else {
                console.error('[File Sync Module] Token renewal failed:', data.error || 'Unknown error');
                this.notifyError('[File Sync Module] Failed to renew authentication token');
            }
        } catch (error) {
            console.error('[File Sync Module] Token renewal request failed:', error);
            this.notifyError('[File Sync Module] Failed to renew authentication token');
        }
    }

    private notifyConnectionState(connected: boolean): void {
        if (this.onConnectionStateChange) {
            this.onConnectionStateChange(connected);
        }
    }

    private notifyError(message: string): void {
        if (this.onError) {
            this.onError(message);
        }
    }
}
