import { TinymistTokenManager } from "./token-manager";
import { TinymistFileSyncClient } from "./sync-and-lsp";
import { PreviewBridgeClient } from "./preview-ws";
import { TinymistFallbackCompiler } from "./fallback";
import { PreviewControlPlane } from "../preview/control-plane";
import { PreviewDataPlane } from "../preview/data-plane";
import { tmEvents } from "../constants";

export type TinymistConnectionsManagerOptions = {
    pageId: number;
    uniqueTabId: string;
    wsToken?: string;
    httpService: any;
};

export class TinymistConnectionsManager {
    private wsToken?: string;
    private readonly pageId: number;
    private readonly uniqueTabId: string;

    private fileSyncClient: TinymistFileSyncClient | null = null;
    private previewBridgeClient: PreviewBridgeClient | null = null;
    private previewControlPlane: PreviewControlPlane | null = null;

    private bridgeConnected: boolean = false;
    private fileSyncConnected: boolean = false;
    private fallbackMode: boolean = false;
    private previewPaused: boolean = false;
    private restartAllowed: boolean = true;

    constructor(options: TinymistConnectionsManagerOptions) {
        this.pageId = options.pageId;
        this.wsToken = options.wsToken;
        this.uniqueTabId = options.uniqueTabId;

        this.updateStatus = this.updateStatus.bind(this);
        this.updateToken = this.updateToken.bind(this);
        this.handlePreviewConnectionToggle =
            this.handlePreviewConnectionToggle.bind(this);
        this.destroy = this.destroy.bind(this);
        window.$tmEventBus.listen(tmEvents.Status, this.updateStatus);
        window.$tmEventBus.listen(tmEvents.TokenRenewed, this.updateToken);
        window.$tmEventBus.listen(
            tmEvents.PreviewConnectionToggle,
            this.handlePreviewConnectionToggle,
        );
        window.$tmEventBus.listen(tmEvents.Destroy, this.destroy);

        new TinymistFallbackCompiler(this.pageId, options.httpService);
        new TinymistTokenManager(this.pageId, this.wsToken, options.httpService);
    }

    start(): void {
        if (!this.wsToken) {
            window.$tmEventBus.emit(tmEvents.InvalidToken);
            return;
        }
        this.setupPreviewSockets();
        this.setupFileSyncLSP();
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
            // initial "connecting"
            this.setPreviewConnectionState();
            window.$tmEventBus.emit(tmEvents.PreviewConnect);
        } catch (error) {
            this.setPreviewConnectionState();
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
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
            window.$tmEventBus.emit(tmEvents.SyncConnect);
        } catch (error) {
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "error",
                message: "Failed to initialize file sync LSP",
                details: error,
            });
        }
    }

    private handlePreviewConnectionToggle(): void {
        if (this.previewPaused) {
            this.previewPaused = false;
            window.$tmEventBus.emit(tmEvents.ReconnectAllowed);
            this.setupPreviewSockets();
            return;
        }

        this.previewPaused = true;
        this.previewBridgeClient?.disconnect();
        window.$tmEventBus.emit(tmEvents.ConsoleLog, {
            type: "info",
            message: "[WS manager] Preview connection paused",
        });
    }

    private setPreviewConnectionState(): void {
        const status = this.previewPaused
            ? "paused"
            : !this.bridgeConnected
              ? "connecting"
              : "running";

        window.$tmEventBus.emit(tmEvents.PreviewConnectionState, {
            label: status,
        });
    }

    private updateStatus(status: { what: string; connected: boolean }): void {
        switch (status.what) {
            case "file-lsp-ws":
                this.fileSyncConnected = status.connected;
                break;
            case "preview-ws":
                this.bridgeConnected = status.connected;
                if (status.connected) {
                    window.$tmEventBus.emit(tmEvents.PreviewSendData, "current");
                }
                this.setPreviewConnectionState();
                break;
        }
        this.checkConnectionHealth();
    }

    private checkConnectionHealth(): void {
        const previewHealthy = this.previewPaused || this.bridgeConnected;
        if (!previewHealthy || !this.fileSyncConnected) {
            if (this.fallbackMode) {
                return;
            }
            this.fallbackMode = true;
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "warning",
                message: this.restartAllowed
                    ? "⚠ Entering fallback mode"
                    : "⚠ Disconnected and restart disabled",
            });
            window.$tmEventBus.emit(tmEvents.FallbackEnable, this.restartAllowed);
        } else {
            this.fallbackMode = false;
            window.$tmEventBus.emit(tmEvents.FallbackEnable, false);
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "success",
                message: "[WS manager] connections active, fallback off",
            });
        }
    }

    destroy(): void {
        this.restartAllowed = false;
        this.fileSyncClient = null;
        this.previewBridgeClient = null;
        this.previewControlPlane = null;
    }
}
