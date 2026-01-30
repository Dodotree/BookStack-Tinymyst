/**
 * Manages JWT token decoding and renewal for WebSocket connections
 * Handles automatic renewal before token expiry
 * Emits events on renewal success or failure
 * */

export class TinymistTokenManager {
    private token: string | null = null;
    private tokenExpiry: number = 0; // Unix timestamp in ms
    private pageId: number = 0;

    private tokenRenewalTimeout: ReturnType<typeof setTimeout> | null = null;

    constructor(pageId: number, token: string) {
        this.token = token;
        this.pageId = pageId;
        this.decodeAndStoreTokenExpiry(token);

        this.disconnect = this.disconnect.bind(this);
        window.$events.listen("tinymist-all-disconnect", this.disconnect);

        this.scheduleTokenRenewal();
    }

    private decodeAndStoreTokenExpiry(token: string): void {
        try {
            // JWT format: header.payload.signature
            const parts = token.split('.');
            if (parts.length !== 3) {
                console.warn('[Auth Token] Invalid JWT token format');
                return;
            }

            // Decode payload (base64url decode)
            const payload = parts[1];
            const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
            const payloadObj = JSON.parse(decoded);

            if (payloadObj.exp) {
                this.tokenExpiry = payloadObj.exp;
                const expiresIn = this.tokenExpiry - Math.floor(Date.now() / 1000);
                console.log(`[Auth Token] Token expires in ${expiresIn} seconds (${new Date(this.tokenExpiry * 1000).toLocaleTimeString()})`);
            }
        } catch (error) {
            console.error(`[Auth Token] Failed to decode token:${token}`, error);
        }
    }

    private scheduleTokenRenewal(): void {
        this.clearTokenRenewalTimeout();

        if (!this.tokenExpiry) {
            console.warn('[Auth Token] Token expiry not set, skipping renewal schedule');
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const expiresIn = this.tokenExpiry - now;

        // Renew 60 seconds before expiry (or halfway through if token has less than 120s lifetime)
        const renewalBuffer = Math.min(60, Math.floor(expiresIn / 2));
        const renewIn = Math.max(0, expiresIn - renewalBuffer);

        if (renewIn <= 0) {
            console.warn('[Auth Token] Token already expired or about to expire, renewing immediately');
            this.renewToken();
            return;
        }

        console.log(`[Auth Token] Scheduling token renewal in ${renewIn} seconds`);
        this.tokenRenewalTimeout = setTimeout(() => {
            this.renewToken();
        }, renewIn * 1000);
    }

    private async renewToken(): Promise<void> {

        try {
            console.log('[Auth Token] Renewing WebSocket token...');
            const response = await window.$http.post('/ajax/tinymist/renew-ws-token', {
                page_id: this.pageId
            }) as any;

            const data = response.data || response;

            if (data.success && data.token) {
                console.log('[Auth Token] Token renewed successfully');

                // Update token locally
                this.token = data.token;
                this.tokenExpiry = data.expires_at;

                window.$events.emit("tinymist-token-renewed", this.token as string);

                // Schedule next renewal
                this.scheduleTokenRenewal();
            } else {
                console.error('[Auth Token] Token renewal failed:', data.error || 'Unknown error');
                window.$events.emit("tinymist-console-log",{ type: "error", message: "[Auth Token] token renewal failed", details: data });
            }
        } catch (error) {
            console.error('[Auth Token] Token renewal request failed:', error);
            window.$events.emit("tinymist-console-log",{ type: "error", message: "[Auth Token] token renewal failed", details: error });
        }
    }

    private clearTokenRenewalTimeout(): void {
        if (this.tokenRenewalTimeout) {
            clearTimeout(this.tokenRenewalTimeout);
            this.tokenRenewalTimeout = null;
        }
    }

    /**
     * Disconnect from the WebSocket server
     */
    disconnect(): void {
        this.clearTokenRenewalTimeout();
        this.token = null;
        this.tokenExpiry = 0;
    }
}
