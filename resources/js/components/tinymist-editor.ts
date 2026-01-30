import { Component } from "./component";


import { PreviewControlPlane } from "./tinymist-preview-control";
import { PreviewDataPlane } from "./tinymist-preview-renderer";
import { TinymistTokenManager } from "../tinymist/connections/token-manager";
import { TinymistFileSyncClient } from "../tinymist/connections/sync-and-lsp";
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

    private previewServerInfo: {
        controlPort: number;
        dataPort: number;
        host: string;
        pid: number;
    } | null = null;

    // Connection health monitoring
    private controlConnected: boolean = false;
    private dataConnected: boolean = false;
    private fileSyncConnected: boolean = false;
    private previewServerDownTime: number = 0;
    private previewServerDownTimer: ReturnType<typeof setTimeout> | null = null;
    private restartAllowed: boolean = true;
    private restartingPreviewServer: boolean = false;

    async setupControl() {
        try {
            const pageId = this.$opts.pageId;
            if (!pageId) {
                throw new Error(
                    "[Preview Control] Page ID not found, exiting setup"
                );
            }

            if (!this.previewServerInfo) {
                throw new Error("[Preview Control] not started");
            }

            // Get initial content from textarea (before CodeMirror is created)
            const content = this.editor.value || "";

            // Initialize Control client with custom port and message handler
            new PreviewControlPlane(
                parseInt(pageId, 10),
                content,
                this.previewServerInfo.host,
                this.previewServerInfo.controlPort
            );
            // await this.controlClient.connect();
            window.$events.emit("tinymist-control-connect");

        } catch (error) {
            console.error("[Preview Control] setup failed:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "⚠ [Preview Control] connection failed: ", details: error });
        }
    }

    async setupPreview() {
        try {
            const previewElement = this.$refs.preview as HTMLElement;
            if (!previewElement) {
                console.warn(
                    "[Preview Data] Preview element not found, skipping preview setup"
                );
                return;
            }

            if (!this.previewServerInfo) {
                throw new Error("[Preview Data] not started");
            }

            // Initialize preview renderer with custom port
            new PreviewDataPlane(
                this.previewServerInfo.host,
                this.previewServerInfo.dataPort
            );

            new PreviewRenderer(previewElement);

            window.$events.emit("tinymist-data-connect");
            window.$events.emit("tinymist-wasm-init");

        } catch (error) {
            console.error("[Preview Data] setup failed:", error);
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
            console.warn("[File Sync / LSP] No WS token available, enabling fallback mode");
            window.$events.emit("tinymist-fallback-enable", this.restartAllowed);
            window.$events.emit("tinymist-console-log", { type: "warning", message: "⚠ Entering fallback mode" });
            return;
        }

        // Create file sync client
        new TinymistFileSyncClient(
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
        this.getText = editorUI.getText.bind(editorUI);
        this.syncContentToTextarea = editorUI.syncContentToTextarea.bind(editorUI);

        new TinymistConsole(this.$refs.console);
        new TinymistFallbackCompiler(800, { getText: this.getText });
        new TinymistTokenManager(this.$opts.pageId, this.$opts.wsToken);

        this.updateStatus = this.updateStatus.bind(this);
        window.$events.listen("tinymist-status", this.updateStatus);

        this.setupPreviewSockets();
        this.setupFileSyncLSP();
    }

    async setupPreviewSockets() {
        try {
            // Start [Preview Server] first to get ports
            await this.startPreviewServer();
            // Add Control and preview (now that server is running)
            await this.setupControl();
            await this.setupPreview();
        } catch (error) {
            console.error("Failed to initialize sockets:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "Failed to initialize sockets", details: error });
        }
    }

    async setupFileSyncLSP() {
        try {
            await this.initializeFileSyncClient();
        } catch (error) {
            console.error("Failed to initialize file sync LSP:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "Failed to initialize file sync LSP", details: error });
        }
    }

    updateStatus = (status: { what: string; connected: boolean }) => {
        switch (status.what) {
            case "control-plane-ws":
                this.controlConnected = status.connected;
                break;
            case "data-plane-ws":
                this.dataConnected = status.connected;
                break;
            case "file-lsp-ws":
                this.fileSyncConnected = status.connected;
                break;
            case "preview-ws":
                this.fileSyncConnected = status.connected;
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
            !this.controlConnected ||
            !this.dataConnected ||
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
        const previewServerDown = !this.controlConnected && !this.dataConnected;

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

    async startPreviewServer() {
        // Check if preview was already started server-side
        if (
            this.$opts.previewStarted === "true" &&
            this.$opts.controlPort &&
            this.$opts.dataPort
        ) {
            this.previewServerInfo = {
                controlPort: parseInt(this.$opts.controlPort as string, 10),
                dataPort: parseInt(this.$opts.dataPort as string, 10),
                host: (this.$opts.host as string) || "127.0.0.1",
                pid: (this.$opts.pid as number) || 0,
            };
            console.log("[Preview Server] pre-started:", this.previewServerInfo);
            window.$events.emit("tinymist-console-log",
                { type: "success", message: `[Preview Server] already started on ports ${this.previewServerInfo.controlPort}/${this.previewServerInfo.dataPort}` }
            );
            return;
        }

        // Otherwise start it via AJAX
        const pageId = this.$opts.pageId;
        if (!pageId) {
            throw new Error("Page ID not found");
        }

        const content = this.editor.value || "";

        try {
            const response = (await window.$http.post(
                "/ajax/tinymist/start-preview",
                {
                    page_id: pageId,
                    content: content,
                    restart: false,
                    pid: (this.$opts.pid as number) || 0,
                }
            )) as any;

            console.log("[Preview Server] response:", response);

            // BookStack's HTTP service wraps the response in a 'data' property
            const data = response.data || response;

            console.log("Response data:", data);
            console.log("Data.success:", data.success);
            console.log("Data.control_port:", data.control_port);
            console.log("Data.data_port:", data.data_port);

            // Check if we have the required fields
            if (data.control_port && data.data_port && data.host) {
                this.previewServerInfo = {
                    controlPort: data.control_port,
                    dataPort: data.data_port,
                    host: data.host,
                    pid: data.pid || 0,
                };
                console.log("[Preview Server] started:", this.previewServerInfo);
                window.$events.emit("tinymist-console-log",
                    { type: "success", message: `[Preview Server] started on ports ${data.control_port}/${data.data_port}` });
            } else if (data.success === false) {
                throw new Error(data.error || "[Preview Server] Failed to start");
            } else {
                throw new Error(
                    "[Preview Server] Invalid response from server: missing host/ports information"
                );
            }
        } catch (error) {
            console.error("[Preview Server] Failed to start:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "⚠ [Preview Server] Failed to start", details: error });
            throw error;
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
            const pageId = this.$opts.pageId;
            if (!pageId) {
                throw new Error("Page ID not found");
            }

            // Call restart endpoint
            const response = (await window.$http.post(
                "/ajax/tinymist/start-preview",
                {
                    page_id: pageId,
                    content: this.getText(),
                    restart: true,
                    pid: this.previewServerInfo?.pid || 0,
                }
            )) as any;

            const data = response.data || response;

            if (data && typeof data === "object" && "success" in data) {
                const result = data as {
                    success: boolean;
                    control_port?: number;
                    data_port?: number;
                    host?: string;
                    error?: string;
                    pid?: number;
                };

                if (
                    result.success &&
                    result.control_port &&
                    result.data_port &&
                    result.host
                ) {
                    window.$events.emit("tinymist-console-log",
                        {
                            type: "success", message:
                                `[Preview Server] Restarted on ports ${result.control_port}/${result.data_port}`
                        });

                    // Update port configuration
                    this.previewServerInfo = {
                        controlPort: result.control_port,
                        dataPort: result.data_port,
                        host: result.host,
                        pid: result.pid || 0,
                    };

                    // Reconnect Control and Data planes with new ports
                    await this.reconnectPreviewClients();
                } else {
                    throw new Error(result.error || "Failed to restart preview server");
                }
            } else {
                throw new Error("Invalid response from server");
            }
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
     * Reconnect Control and Data plane clients with new port configuration
     */
    async reconnectPreviewClients() {
        if (!this.restartAllowed) {
            return;
        }
        if (!this.previewServerInfo) {
            return;
        }

        window.$events.emit("tinymist-console-log",
            { type: "info", message: "[Preview Server] Reconnecting clients with new ports..." });

        try {
            // TODO: Disconnect/reconnect old clients
            // But do not dispose/recreate completely
            // I doubt they can be garbage connected and this is unnecessary overhead

            window.$events.emit("tinymist-control-disconnect");
            window.$events.emit("tinymist-data-disconnect");

            // TODO: Many questions about this "wait for cleanup"
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Reconnect with new ports
            await this.setupControl();
            await this.setupPreview();

            window.$events.emit("tinymist-console-log",
                { type: "success", message: "[Preview Server] Clients reconnected" });
        } catch (error) {
            console.error("[Preview Server] Failed to reconnect clients:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "[Preview Server] Reconnection failed", details: error });
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
        // Send stop-preview request (use sendBeacon for reliability during unload)
        if (this.$opts.pageId) {
            const data = JSON.stringify({ pid: this.previewServerInfo?.pid || 0 });
            const blob = new Blob([data], { type: "application/json" });
            navigator.sendBeacon("/ajax/tinymist/stop-preview", blob);
        }

        // Close WebSocket connections
        window.$events.emit("tinymist-fallback-enable", false);
        window.$events.emit("tinymist-sync-disconnect");
        window.$events.emit("tinymist-control-disconnect");
        window.$events.emit("tinymist-data-disconnect");
    }

}
