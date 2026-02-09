import { Component } from "./component";


import { TinymistTokenManager } from "../tinymist/connections/token-manager";
import { TinymistFileSyncClient } from "../tinymist/connections/sync-and-lsp";
import { PreviewBridgeClient } from "../tinymist/connections/preview-ws";
import { PreviewControlPlane } from "../tinymist/preview/control-plane";
import { PreviewDataPlane } from "../tinymist/preview/data-plane";
import { TinymistFallbackCompiler } from "../tinymist/connections/fallback";
import { TinymistEditorUI } from "../tinymist/editor/editor";
import { TinymistConsole } from "../tinymist/console";
import { PreviewRenderer } from "../tinymist/preview/render";


export class TinymistEditor extends Component {
    elem!: HTMLElement;
    editor!: HTMLTextAreaElement;
    preview!: HTMLElement;
    console!: HTMLElement;
    getText!: () => string;
    syncContentToTextarea!: () => string;

    private tabToken: string = this.createTabToken();

    private previewBridgeClient: PreviewBridgeClient | null = null;
    private previewControlPlane: PreviewControlPlane | null = null;
    private tokenManager: TinymistTokenManager | null = null;
    private fileSyncClient: TinymistFileSyncClient | null = null;

    // Connection health monitoring
    private bridgeConnected: boolean = false;
    private fileSyncConnected: boolean = false;
    private previewServerDownTime: number = 0;
    private previewServerDownTimer: ReturnType<typeof setTimeout> | null = null;
    private restartAllowed: boolean = true;
    private restartingPreviewServer: boolean = false;

    async setupBridge() {
        try {
            const pageId = this.$opts.pageId;
            if (!pageId) {
                throw new Error("[Preview Control] Page ID not found, exiting setup");
            }

            const wsToken = this.$opts.wsToken as string;
            if (!wsToken) {
                throw new Error("[Preview Control] WS token not found, cannot connect preview bridge");
            }
            if (!this.previewBridgeClient) {
                this.previewBridgeClient = new PreviewBridgeClient(
                    parseInt(pageId, 10),
                    wsToken
                );
            }

            if (!this.previewControlPlane) {
                this.previewControlPlane = new PreviewControlPlane();
            }
            new PreviewDataPlane();

            window.$events.emit("tinymist-preview-connect", wsToken);

        } catch (error) {
            console.error("[Preview Control] setup failed:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "⚠ [Preview Control] connection failed: ", details: error });
        }
    }

    async setupWasm() {
        try {
            const previewElement = this.$refs.preview as HTMLElement;
            if (!previewElement) {
                console.warn("[Preview Data] Preview element not found, skipping preview setup");
                return;
            }

            new PreviewRenderer(previewElement);
            window.$events.emit("tinymist-wasm-init");

        } catch (error) {
            console.error("[Preview Data] renderer setup failed:", error);
            window.$events.emit("tinymist-console-log", {
                type: "error", message: "⚠ [Preview Data] initialization failed: ", details: error
            });
        }
    }

    async initializeFileSyncClient() {
        const wsToken = this.$opts.wsToken as string;
        const pageId = this.$opts.pageId;

        if (!pageId) {
            console.error("[File Sync / LSP] No page ID for WebSocket connection");
            return;
        }

        if (!wsToken) {
            console.warn("[File Sync / LSP] No WS token available, deferring connection");
            return;
        }

        if (this.fileSyncClient) {
            return;
        }

        // Create file sync client
        this.fileSyncClient = new TinymistFileSyncClient(
            parseInt(pageId, 10),
            wsToken,
            this.tabToken
        );

        window.$events.emit("tinymist-sync-connect", wsToken);
    }

    private createTabToken(): string {
        const rand = crypto.getRandomValues(new Uint32Array(2));
        return [
            this.$opts.pageId,
            Date.now().toString(36),
            rand[0].toString(36),
            rand[1].toString(36).slice(0, 4),
        ].join("-");
    }

    setup() {
        console.log("[Tinymist Editor] setup() called");

        this.elem = this.$el;
        this.editor = this.$refs.editor as HTMLTextAreaElement;

        console.log("[Tinymist Editor] Elements found:", {
            elem: !!this.elem,
            editor: !!this.editor,
            console: !!this.$refs.console,
        });
        console.log(
            "[Tinymist Editor] Initial content length:",
            this.editor.value.length
        );

        const editorUI = new TinymistEditorUI(this.elem, this.editor);
        // Since all Bookstack editors require getText()
        this.getText = editorUI.getText.bind(editorUI);
        this.syncContentToTextarea = editorUI.syncContentToTextarea.bind(editorUI);

        new TinymistConsole(this.$refs.console);
        new TinymistFallbackCompiler();
        this.tokenManager = new TinymistTokenManager(this.$opts.pageId, this.$opts.wsToken as string | undefined);

        this.updateStatus = this.updateStatus.bind(this);
        window.$events.listen("tinymist-status", this.updateStatus);

        this.setupPreviewSockets();
        this.setupFileSyncLSP();
    }

    async setupPreviewSockets() {
        try {
            // First initiates ws socket to bridge, second initializes preview renderer
            await this.setupBridge();
            await this.setupWasm();
        } catch (error) {
            console.error("Failed to initialize sockets:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "Failed to initialize sockets", details: error });
        }
    }

    async setupFileSyncLSP() {
        try {
            // ws socket to file sync server and bridge to running lsp server for diagnostics and semantic highlighting
            await this.initializeFileSyncClient();
        } catch (error) {
            console.error("Failed to initialize file sync LSP:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "Failed to initialize file sync LSP", details: error });
        }
    }

    updateStatus = (status: { what: string; connected: boolean }) => {
        switch (status.what) {
            case "file-lsp-ws":
                this.fileSyncConnected = status.connected;
                break;
            case "preview-ws":
                this.bridgeConnected = status.connected;
                if (status.connected) {
                    window.$events.emit("tinymist-preview-send-data", "current");
                }
                break;
        }
        this.checkConnectionHealth();
    };

    /**
     * Check preview server health and initiate restart if needed
     * Called whenever Control or Data plane connection state changes
     */
    checkConnectionHealth() {
        // Enable fallback mode if ANY socket is down
        if (
            !this.bridgeConnected ||
            !this.fileSyncConnected
        ) {
            window.$events.emit("tinymist-fallback-enable", this.restartAllowed);
            window.$events.emit("tinymist-console-log", {
                type: "warning",
                message: this.restartAllowed ? "⚠ Entering fallback mode" : "⚠ Disconnected and restart disabled"
            });
        } else {
            window.$events.emit("tinymist-fallback-enable", false);
            console.log("Exiting fallback mode (using [File Sync / LSP])");
            window.$events.emit("tinymist-console-log", { type: "success", message: "[File Sync / LSP] active, fallback off" });
        }

        // If both Control AND Data planes are down, start monitoring for restart
        const previewServerDown = !this.bridgeConnected;

        if (previewServerDown) {
            // Start countdown if not already running
            if (!this.previewServerDownTimer && this.restartAllowed) {
                this.previewServerDownTime = Date.now();
                window.$events.emit("tinymist-console-log",
                    {
                        type: "warning", message:
                            "[Preview Server] Both Control and Data planes down. Will attempt restart in 60 seconds..."
                    });

                this.previewServerDownTimer = setTimeout(() => {
                    this.attemptPreviewServerRestart();
                }, 1000);
            }
        } else {
            // At least one plane is up - cancel restart timer
            if (this.previewServerDownTimer) {
                clearTimeout(this.previewServerDownTimer);
                this.previewServerDownTimer = null;
                this.previewServerDownTime = 0;
                console.log("[Preview Server] Health recovered, restart cancelled");
            }
        }
    }

    /**
     * Attempt to restart the preview server with dynamically allocated ports
     */
    async attemptPreviewServerRestart() {
        if (!this.restartAllowed) {
            return;
        }
        if (this.restartingPreviewServer) {
            console.log("[Preview Server] Restart already in progress");
            return;
        }

        this.restartingPreviewServer = true;
        window.$events.emit("tinymist-console-log",
            { type: "info", message: "[Preview Server] Attempting restart with new ports..." });

        try {
            window.$events.emit("tinymist-preview-send-control", JSON.stringify({ type: "restartPreview" }));
        } catch (error) {
            console.error("[Preview Server] Restart failed:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "[Preview Server] Restart failed", details: error });
        } finally {
            this.restartingPreviewServer = false;
            this.previewServerDownTimer = null;
            this.previewServerDownTime = 0;
        }
    }

    /**
     * Get content for saving (called by page-editor).
     */
    async getContent() {
        // Sync CodeMirror content to textarea before returning
        return this.syncContentToTextarea();
    }

    destroy() {
        // Let the page unload
        this.restartAllowed = false;

        // Clear preview server monitoring timers
        if (this.previewServerDownTimer) {
            clearTimeout(this.previewServerDownTimer);
            this.previewServerDownTimer = null;
        }

        // Close WebSocket connections
        window.$events.emit("tinymist-fallback-enable", false);
        window.$events.emit("tinymist-sync-disconnect");
        window.$events.emit("tinymist-preview-disconnect");
    }

}
