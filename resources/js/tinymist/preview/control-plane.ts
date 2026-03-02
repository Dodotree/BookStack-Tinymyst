type OutlineItem = {
    title: string;
    level: number;
    line: number;
    character: number;
    children: OutlineItem[];
};

export class PreviewControlPlane {
    private static readonly FILEPATH_PLACEHOLDER = "__TINYMIST_FILE__";
    private cursorSpotlightEnabled = true;

    constructor() {
        this.sendControlMessage = this.sendControlMessage.bind(this);
        this.handleControlMessage = this.handleControlMessage.bind(this);
        window.$tmEventBus.listen("tinymist-preview-control-message", this.handleControlMessage);
        window.$tmEventBus.listen("tinymist-control", this.sendControlMessage);
        window.$tmEventBus.listen("tinymist-cursor-spotlight-toggle", ({ enabled }: { enabled?: boolean }) => {
            this.cursorSpotlightEnabled = Boolean(enabled);
        });
        // this.disconnect = this.disconnect.bind(this);
        // window.$tmEventBus.listen("tinymist-control-disconnect", this.disconnect);
    }

    private handleControlMessage(raw: string): void {
        console.log(`[Preview Control] Control message length: ${raw.length}`, raw.length < 40 ? raw : 'too long to display');
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'pong' || msg.type === 'tokenUpdated' || msg.type === 'previewRestarted') {
                return;
            }
            if (msg.event === 'compileStatus') {
                this.onCompileStatus(msg.kind, msg);
            } else if (msg.event === 'outline') {
                this.onOutline(msg.items);
            } else if (msg.event === 'syncEditorChanges') {
                this.onSyncChanges(msg);
            } else if (msg.status) {
                // Generic status message
                window.$tmEventBus.emit("tinymist-console-log", { type: "info", message: `[Preview Bridge (via Control)] Status: ${msg.status}` });
            } else {
                console.warn(`[Preview Control] Unknown message: ${raw}`);
                window.$tmEventBus.emit("tinymist-console-log", { type: "warning", message: `[Preview Bridge (via Control)] Unknown message: ${raw}` });
            }
        } catch (error) {
            console.warn(`[Preview Control] Failed to parse message: ${raw}`);
        }
    }

    private onCompileStatus (kind: string, msg?: any) {
        if (kind === "Compiling") {
            window.$tmEventBus.emit("tinymist-console-log",
                { type: "info", message: "[Preview Control] Compiling..." });
        } else if (kind === "CompileSuccess") {
            window.$tmEventBus.emit("tinymist-console-log",
                { type: "success", message: "[Preview Control] Compilation successful" });
        } else if (kind === "CompileError") {
            window.$tmEventBus.emit("tinymist-console-log",
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
                if (!this.cursorSpotlightEnabled) {
                    return;
                }
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
        window.$tmEventBus.emit("tinymist-preview-send-control", JSON.stringify(msg));
    }
}
