/**
 * Manages JWT token decoding and renewal for WebSocket connections
 * Handles automatic renewal before token expiry
 * Emits events on renewal success or failure
 * */

import { AUTH_TOKEN_RENEWAL_URL, tmEvents } from "../constants";

export class TinymistTokenManager {
    private pageId: number|string = "";
    private token: string | null = null;
    private tokenExpiry: number = 0; // Unix timestamp in ms
    private httpService: any;

    private isOnline: boolean = navigator.onLine;
    private tokenRenewalTimeout: ReturnType<typeof setTimeout> | null = null;

    private debugOn = false;
    private debugLog: (...args: any[]) => void;

    constructor(pageId: number|string, token?: string, httpService?: any) {
        this.token = token ?? null;
        this.pageId = pageId;
        this.httpService = httpService;

        this.debugLog = this.debugOn ? console.debug : () => {};

        this.renewToken = this.renewToken.bind(this);
        this.disconnect = this.disconnect.bind(this);
        this.destroy = this.destroy.bind(this);
        window.$tmEventBus.listen(tmEvents.InvalidToken, this.renewToken);
        window.$tmEventBus.listen(tmEvents.AllDisconnect, this.disconnect);
        window.$tmEventBus.listen(tmEvents.Destroy, this.destroy);

        window.$tmEventBus.listen(tmEvents.OnlineStatus, (isOnline: boolean) => {
            this.isOnline = isOnline;
        });

        if (token) {
            this.decodeAndStoreTokenExpiry(token);
            this.scheduleTokenRenewal();
        }
    }

    public setToken(token: string): void {
        if (!token) {
            return;
        }
        this.token = token;
        this.decodeAndStoreTokenExpiry(token);
        this.scheduleTokenRenewal();
        window.$tmEventBus.emit(tmEvents.TokenRenewed, this.token as string);
    }

    private decodeAndStoreTokenExpiry(token: string): void {
        try {
            // JWT format: header.payload.signature
            const parts = token.split(".");
            if (parts.length !== 3) {
                console.warn("[Auth Token] Invalid JWT token format");
                return;
            }

            // Decode payload (base64url decode)
            const payload = parts[1];
            const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
            const payloadObj = JSON.parse(decoded);

            if (payloadObj.exp) {
                this.tokenExpiry = payloadObj.exp;
                const expiresIn = this.tokenExpiry - Math.floor(Date.now() / 1000);
                this.debugLog(
                    `[Auth Token] Token expires in ${expiresIn} seconds (${new Date(this.tokenExpiry * 1000).toLocaleTimeString()})`,
                );
            }
        } catch (error) {
            console.error(
                `[Auth Token] Failed to decode token:${token}`,
                error,
            );
        }
    }

    private scheduleTokenRenewal(): void {
        this.clearTokenRenewalTimeout();

        if (!this.tokenExpiry) {
            this.debugLog(
                "[Auth Token] Token expiry not set, skipping renewal schedule",
            );
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const expiresIn = this.tokenExpiry - now;

        // Renew 60 seconds before expiry (or halfway through if token has less than 120s lifetime)
        const renewalBuffer = Math.min(60, Math.floor(expiresIn / 2));
        const renewIn = Math.max(0, expiresIn - renewalBuffer);

        if (renewIn <= 0) {
            this.debugLog(
                "[Auth Token] Token already expired or about to expire, renewing immediately",
            );
            this.renewToken();
            return;
        }

        this.debugLog(
            `[Auth Token] Scheduling token renewal in ${renewIn} seconds`,
        );
        this.tokenRenewalTimeout = setTimeout(() => {
            this.renewToken();
        }, renewIn * 1000);
    }

    private async renewToken(): Promise<void> {

        if (!this.isOnline) {
            this.debugLog("[Auth Token] Offline, rescheduling token renewal");
            this.clearTokenRenewalTimeout();
            this.tokenRenewalTimeout = setTimeout(() => {
                this.renewToken();
            }, 2000);
            return;
        }

        try {
            this.debugLog("[Auth Token] Renewing WebSocket token...");
            const response = (await this.httpService.post(AUTH_TOKEN_RENEWAL_URL, {
                page_id: this.pageId,
            })) as any;

            const data = response.data || response;

            if (data.success && data.token) {
                this.debugLog("[Auth Token] Token renewed successfully");

                // Update token locally
                this.token = data.token;
                this.tokenExpiry = data.expires_at;

                window.$tmEventBus.emit(
                    tmEvents.TokenRenewed,
                    this.token as string,
                );

                // Schedule next renewal
                this.scheduleTokenRenewal();
            } else {
                console.error(
                    "[Auth Token] Token renewal failed:",
                    data.error || "Unknown error",
                );
                window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                    type: "error",
                    message: "[Auth Token] token renewal failed",
                    details: data,
                });
            }
        } catch (error) {
            console.error("[Auth Token] Token renewal request failed:", error);
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "error",
                message: "[Auth Token] token renewal failed",
                details: error,
            });
        }
    }

    private clearTokenRenewalTimeout(): void {
        if (this.tokenRenewalTimeout) {
            clearTimeout(this.tokenRenewalTimeout);
            this.tokenRenewalTimeout = null;
        }
    }

    disconnect(): void {
        this.clearTokenRenewalTimeout();
        this.token = null;
        this.tokenExpiry = 0;
    }

    destroy(): void {
        this.disconnect();
        this.httpService = null;
    }
}
