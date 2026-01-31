type OutlineItem = {
    title: string;
    level: number;
    line: number;
    character: number;
    children: OutlineItem[];
};

export class PreviewControlPlane {
    private pageId: number;
    private controlPort: number;
    private host: string;
    private static readonly FILEPATH_PLACEHOLDER = "__TINYMIST_FILE__";

    constructor(
        pageId: number,
        content: string,
        host: string = "127.0.0.1", // provided directly from php template
        controlPort: number = 23627, // provided directly from php template
    ) {
        this.pageId = pageId;
        this.host = host;
        this.controlPort = controlPort;

        this.sendControlMessage = this.sendControlMessage.bind(this);
        this.disconnect = this.disconnect.bind(this);
        this.handleControlMessage = this.handleControlMessage.bind(this);
        this.handleConnected = this.handleConnected.bind(this);
        this.handleDisconnected = this.handleDisconnected.bind(this);
        window.$events.listen("tinymist-preview-control-message", this.handleControlMessage);
        window.$events.listen("tinymist-preview-control-connected", this.handleConnected);
        window.$events.listen("tinymist-preview-control-disconnected", this.handleDisconnected);
        window.$events.listen("tinymist-control", this.sendControlMessage);
        window.$events.listen("tinymist-control-disconnect", this.disconnect);
    }

    private handleConnected(): void {
        window.$events.emit("tinymist-status", { what: "control-plane-ws", connected: true });
        window.$events.emit("tinymist-console-log", { type: "success", message: "[Preview Control] connected" });
    }

    private handleDisconnected(): void {
        window.$events.emit("tinymist-status", { what: "control-plane-ws", connected: false });
        window.$events.emit("tinymist-console-log", { type: "error", message: "[Preview Control] disconnected" });
    }

    private handleControlMessage(raw: string): void {
        if (Boolean((window as any)?.tinymistPreviewDebug)) {
            console.log("[Preview Control] Control message", { length: raw.length });
        }
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'pong' || msg.type === 'tokenUpdated') {
                return;
            }
            if (msg.event === 'compileStatus') {
                this.onCompileStatus(msg.kind, msg);
            } else if (msg.event === 'outline') {
                this.onOutline(msg.items);
            } else if (msg.event === 'syncEditorChanges') {
                this.onSyncChanges(msg);
            } else {
                console.warn(`[Preview Control] Unknown message: ${raw}`);
                window.$events.emit("tinymist-console-log", { type: "warning", message: `[Preview Control] Unknown message: ${raw}` });
            }
        } catch (error) {
            console.warn(`[Preview Control] Failed to parse message: ${raw}`);
        }
    }

    private onCompileStatus (kind: string, msg?: any) {
        if (kind === "Compiling") {
            window.$events.emit("tinymist-console-log",
                { type: "info", message: "[Preview Control] Compiling..." });
        } else if (kind === "CompileSuccess") {
            window.$events.emit("tinymist-console-log",
                { type: "success", message: "[Preview Control] Compilation successful" });
        } else if (kind === "CompileError") {
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "[Preview Control] Compilation failed" });
            console.log("[Preview Control] Error:", msg);
        }
    }

    private onSyncChanges(msg: any) {
        // Handle synchronization
        console.log('[Preview Control] Syncing changes:', msg);
    }

    private onOutline(items: OutlineItem[]) {
        // Update table of contents
        console.log('[Preview Control] Document outline:', items);
    }

    public sendControlMessage(message: any) {
        let msg;

        switch (message.event) {
            case "UpdateMemoryFiles":
            case "SyncMemoryFiles":
                msg = {
                    event: message.event,
                    files: {
                        // [filepath] is a virtual label, content is the *whole* file content
                        // `file:///virtual/${pageId}.typ`,
                        // or full path
                        [message.filepath]: message.content,
                    },
                };
                break;

            case "removeMemoryFiles":
                msg = {
                    event: "removeMemoryFiles",
                    files: [[message.filepath]],
                };
                break;

            case "changeCursorPosition":
            case "panelScrollTo":
                msg = {
                    event: message.event,
                    filepath: PreviewControlPlane.FILEPATH_PLACEHOLDER,
                    line: message.line,
                    character: message.character,
                };
                console.log('[Preview Control] Sending cursor position:', msg);
                break;

            case "sourceScrollBySpan":
                msg = {
                    event: "sourceScrollBySpan",
                    span: message.span, // string
                };

            case "panelScrollByPosition":
                msg = {
                    event: "panelScrollByPosition",
                    position: message.position,
                };
                break;
            default:
                console.warn(`[Preview Control] Unknown control message event: ${message.event}`);
                return;
        }

        console.log(`[Preview Control] Sending Control Plane ${message.event}:`, msg);
        window.$events.emit("tinymist-preview-send-control", JSON.stringify(msg));
    }

    disconnect() {
        window.$events.emit("tinymist-preview-send-control", JSON.stringify({ type: "disconnect" }));
    }
}
