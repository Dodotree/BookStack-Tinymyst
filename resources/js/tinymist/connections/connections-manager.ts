import { TinymistTokenManager } from "./token-manager";
import { TinymistFileSyncClient } from "./sync-and-lsp";
import { PreviewBridgeClient } from "./preview-ws";
import { PreviewControlPlane } from "../preview/control-plane";
import { PreviewDataPlane } from "../preview/data-plane";

export type TinymistConnectionsManagerOptions = {
    pageId: number;
    wsToken?: string;
    uniqueTabId: string;
};

export class TinymistConnectionsManager {
    private wsToken?: string;
    private readonly pageId: number;
    private readonly uniqueTabId: string;

    private previewBridgeClient: PreviewBridgeClient | null = null;
    private previewControlPlane: PreviewControlPlane | null = null;
    private tokenManager: TinymistTokenManager | null = null;
    private fileSyncClient: TinymistFileSyncClient | null = null;

    private bridgeConnected: boolean = false;
    private fileSyncConnected: boolean = false;
    private fallbackMode: boolean = false;
    private restartAllowed: boolean = true;

    constructor(options: TinymistConnectionsManagerOptions) {
        this.pageId = options.pageId;
        this.wsToken = options.wsToken;
        this.uniqueTabId = options.uniqueTabId;

        this.updateStatus = this.updateStatus.bind(this);
        this.updateToken = this.updateToken.bind(this);
        this.destroy = this.destroy.bind(this);
        window.$tmEventBus.listen("status", this.updateStatus);
        window.$tmEventBus.listen("token-renewed", this.updateToken);
        window.$tmEventBus.listen("destroy", this.destroy);

        this.tokenManager = new TinymistTokenManager(this.pageId, this.wsToken);
    }

    start(): void {
        if (!this.wsToken) {
            window.$tmEventBus.emit("invalid-token");
            return;
        }
        void this.setupPreviewSockets();
        void this.setupFileSyncLSP();
    }

    updateToken(newToken: string): void {
        this.wsToken = newToken;
        // In case the start was delayed due to missing token, try starting the connections now
        if (!this.previewBridgeClient || !this.fileSyncClient) {
            this.start();
        }
    }

    private setupPreviewSockets(): void {
        try {
            if (!this.previewBridgeClient) {
                this.previewBridgeClient = new PreviewBridgeClient(
                    this.pageId,
                    this.wsToken || "",
                    this.uniqueTabId,
                );
            }

            if (!this.previewControlPlane) {
                this.previewControlPlane = new PreviewControlPlane();
                new PreviewDataPlane();
            }

            window.$tmEventBus.emit("preview-connect");
        } catch (error) {
            window.$tmEventBus.emit("console-log", {
                type: "error",
                message: "Failed to initialize preview sockets",
                details: error,
            });
        }
    }

    private setupFileSyncLSP(): void {
        try {
            if (!this.fileSyncClient) {
                this.fileSyncClient = new TinymistFileSyncClient(
                    this.pageId,
                    this.wsToken || "",
                    this.uniqueTabId,
                );
            }
            window.$tmEventBus.emit("sync-connect");
        } catch (error) {
            window.$tmEventBus.emit("console-log", {
                type: "error",
                message: "Failed to initialize file sync LSP",
                details: error,
            });
        }
    }

    private updateStatus(status: { what: string; connected: boolean }): void {
        switch (status.what) {
            case "file-lsp-ws":
                this.fileSyncConnected = status.connected;
                break;
            case "preview-ws":
                this.bridgeConnected = status.connected;
                if (status.connected) {
                    window.$tmEventBus.emit("preview-send-data", "current");
                }
                break;
        }
        this.checkConnectionHealth();
    }

    private checkConnectionHealth(): void {
        if (!this.bridgeConnected || !this.fileSyncConnected) {
            if (this.fallbackMode) {
                return;
            }
            this.fallbackMode = true;
            window.$tmEventBus.emit("console-log", {
                type: "warning",
                message: this.restartAllowed
                    ? "⚠ Entering fallback mode"
                    : "⚠ Disconnected and restart disabled",
            });
            window.$tmEventBus.emit("fallback-enable", this.restartAllowed);
        } else {
            this.fallbackMode = false;
            window.$tmEventBus.emit("fallback-enable", false);
            window.$tmEventBus.emit("console-log", {
                type: "success",
                message: "[WS manager] connections active, fallback off",
            });
        }
    }

    destroy(): void {
        this.restartAllowed = false;
    }
}
