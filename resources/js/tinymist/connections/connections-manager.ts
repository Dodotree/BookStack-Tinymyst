import {TinymistTokenManager} from './token-manager';
import {TinymistFileSyncClient} from './sync-and-lsp';
import {PreviewBridgeClient} from './preview-ws';
import {PreviewControlPlane} from '../preview/control-plane';
import {PreviewDataPlane} from '../preview/data-plane';

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
    private restartAllowed: boolean = true;

    constructor(options: TinymistConnectionsManagerOptions) {
        this.pageId = options.pageId;
        this.wsToken = options.wsToken;
        this.uniqueTabId = options.uniqueTabId;

        this.updateStatus = this.updateStatus.bind(this);
        this.updateToken = this.updateToken.bind(this);
        window.$events.listen('tinymist-status', this.updateStatus);
        window.$events.listen('tinymist-token-renewed', this.updateToken);

        this.tokenManager = new TinymistTokenManager(this.pageId, this.wsToken);
    }

    start(): void {
        if (!this.wsToken) {
            window.$events.emit("tinymist-invalid-token");
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

    destroy(): void {
        this.restartAllowed = false;

        window.$events.emit('tinymist-fallback-enable', false);
        window.$events.emit('tinymist-sync-disconnect');
        window.$events.emit('tinymist-preview-disconnect');
    }

    private setupPreviewSockets(): void {
        try {
            if (!this.previewBridgeClient) {
                this.previewBridgeClient = new PreviewBridgeClient(
                    this.pageId,
                    this.wsToken || '',
                    this.uniqueTabId
                );
            }

            if (!this.previewControlPlane) {
                this.previewControlPlane = new PreviewControlPlane();
                new PreviewDataPlane();
            }

            window.$events.emit('tinymist-preview-connect');
        } catch (error) {
            window.$events.emit('tinymist-console-log', {
                type: 'error',
                message: 'Failed to initialize preview sockets',
                details: error,
            });
        }
    }

    private setupFileSyncLSP(): void {
        try {
            if (!this.fileSyncClient) {
                this.fileSyncClient = new TinymistFileSyncClient(
                    this.pageId,
                    this.wsToken || '',
                    this.uniqueTabId
                );
            }
            window.$events.emit('tinymist-sync-connect');
        } catch (error) {
            window.$events.emit('tinymist-console-log', {
                type: 'error',
                message: 'Failed to initialize file sync LSP',
                details: error,
            });
        }
    }

    private updateStatus(status: { what: string; connected: boolean }): void {
        switch (status.what) {
            case 'file-lsp-ws':
                this.fileSyncConnected = status.connected;
                break;
            case 'preview-ws':
                this.bridgeConnected = status.connected;
                if (status.connected) {
                    window.$events.emit('tinymist-preview-send-data', 'current');
                }
                break;
        }
        this.checkConnectionHealth();
    }

    private checkConnectionHealth(): void {
        if (!this.bridgeConnected || !this.fileSyncConnected) {
            window.$events.emit('tinymist-console-log', {
                type: 'warning',
                message: this.restartAllowed ? '⚠ Entering fallback mode' : '⚠ Disconnected and restart disabled',
            });
            window.$events.emit('tinymist-fallback-enable', this.restartAllowed);
        } else {
            window.$events.emit('tinymist-fallback-enable', false);
            window.$events.emit('tinymist-console-log', {
                type: 'success',
                message: '[WS manager] connections active, fallback off',
            });
        }
    }

}
