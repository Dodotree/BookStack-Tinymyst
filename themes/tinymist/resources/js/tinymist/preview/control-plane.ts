import { tmEvents } from "../constants";

type OutlineItem = {
    title: string;
    level: number;
    line: number;
    character: number;
    children: OutlineItem[];
};

type RenderVersion = {
    type: string;
    timestamp: number;
    fileName: string;
    docVersion: number;
};

type PendingCursorRequest = {
    request: {
        event: string;
        fileName: string;
        line: number;
        character: number;
    };
    docVersion: number;
    timestamp: number;
};

export class PreviewControlPlane {
    private cursorSpotlightEnabled = true;
    private static readonly FILEPATH_PLACEHOLDER = "__TINYMIST_FILE__";

    private static readonly maxWaitForRenderMs = 60_000; // 1 minute
    private pendingRenders: RenderVersion[] = [];
    private currentRender: RenderVersion | null = null;
    private confirmedRenderVersion : RenderVersion | null = null;
    private pendingCursorRequests: Map<number, PendingCursorRequest> = new Map();

    private debugOn = false;
    private debugLog: (...args: any[]) => void;

    constructor() {
        this.sendControlMessage = this.sendControlMessage.bind(this);
        this.handleControlMessage = this.handleControlMessage.bind(this);

        this.trackRenderVersion = this.trackRenderVersion.bind(this);
        this.shiftPendingRenders = this.shiftPendingRenders.bind(this);
        this.pushCursorBlankDiff = this.pushCursorBlankDiff.bind(this);
        this.clarifyRenderVersion = this.clarifyRenderVersion.bind(this);
        this.addPendingCursorRequest = this.addPendingCursorRequest.bind(this);
        this.prunePendingRenders = this.prunePendingRenders.bind(this);

        this.debugLog = this.debugOn ? console.debug : () => {};

        window.$tmEventBus.listen(
            tmEvents.PreviewControlMessage,
            this.handleControlMessage,
        );
        window.$tmEventBus.listen(tmEvents.Control, this.sendControlMessage);
        window.$tmEventBus.listen(
            tmEvents.CursorSpotlightToggle,
            ({ enabled }: { enabled?: boolean }) => {
                this.cursorSpotlightEnabled = Boolean(enabled);
            },
        );

        // Ack or SyncRemote are diffs that went through (Ack repeats diff if it goes through)
        // window.$tmEventBus.listen(tmEvents.TextDiff, this.trackRenderVersion);
        window.$tmEventBus.listen(
            tmEvents.FileSyncAck,
            this.trackRenderVersion,
        );
        window.$tmEventBus.listen(
            tmEvents.SyncRemoteChanges,
            this.trackRenderVersion,
        );

        // Not sure if full sync means renderer initiated, but it clarifies docVersion on connection
        window.$tmEventBus.listen(
            tmEvents.SyncFullState,
            this.clarifyRenderVersion,
        );

        window.$tmEventBus.listen(
            tmEvents.DataBinary,
            this.shiftPendingRenders,
        );
        window.$tmEventBus.listen(
            tmEvents.VersionedCursorRequest,
            this.addPendingCursorRequest,
        );

        window.$tmEventBus.listen(
            tmEvents.RenderVersion,
            (payload: RenderVersion) =>  {
                this.prunePendingRenders(payload.docVersion);
                this.pruneCursorRequests(payload.docVersion);
                this.confirmedRenderVersion = payload;
                if(!this.currentRender || payload.docVersion >= this.currentRender.docVersion) {
                    this.currentRender = payload;
                }
            },
        );
    }

    private addPendingCursorRequest(payload: PendingCursorRequest): void {
        if (
            this.confirmedRenderVersion && this.confirmedRenderVersion.docVersion >= payload.docVersion ||
            (this.currentRender && payload.docVersion <= this.currentRender.docVersion)
        ) {
            // If the requested docVersion is already rendered, we can send the cursor position immediately
            this.sendControlMessage(payload.request);
            return;
        }
        this.pendingCursorRequests.set(payload.docVersion, payload);
    }

    private shiftFailedRender() {
        // since failed compile status only received on diffs
        if (
            this.pendingRenders.length === 0 ||
            this.pendingRenders[0].type !== "merge"
        ) {
            return;
        }

        this.pendingRenders.shift();
    }

    private shiftPendingRenders(payload: {
        command: string;
        payload: Uint8Array;
    }): void {
        const pending = this.pendingRenders.shift();
        if (!pending) {
            return;
        }

        // "diff-v1" comes either after compile (with statuses) or after cursor path
        // "new" comes after "current"

        if (payload.command === "diff-v1" && pending.type === "merge") {
            this.setCurrentRender(pending);
        } else if (payload.command === "new" && pending.type === "reset") {
            this.setCurrentRender(pending);
        } else {
            // If the message is not what we expected, we put the pending back and wait for the next one
            this.pendingRenders.unshift(pending);
            this.debugLog(
                `[Preview Control:queue] Received "${payload.command}" but expected "${pending.type}". Keeping pending in queue.`,
                this.pendingRenders,
            );
        }

        // it's ok to have some pending renders left while typing,
        // but if the queue is not empty after a pause - the version drifted
        // we can send "upcoming" to data plane to help it distinguish merge vs reset
    }

    setCurrentRender(pending: RenderVersion): void {
        this.currentRender = pending;
        const pendingCursor = this.pendingCursorRequests.get(
            pending.docVersion,
        );
        if (pendingCursor) {
            this.sendControlMessage(pendingCursor.request);
            this.pruneCursorRequests(pending.docVersion);
        }
    }

    // for maintaining balance in the queue (diff-v1 after cursor paths)
    // Cursor path are not provided all all nodes, if they are: outline, cursorPaths, diff-v1
    // but the message still will trigger: outline, diff-v1
    private pushCursorBlankDiff(docVersion: number): void {
        this.pendingRenders.push({
            type: "merge",
            timestamp: Date.now(),
            fileName: "entry.typ",
            docVersion,
        });
    }

    pruneCursorRequests(olderThan: number): void {
        for (const [docVersion, request] of this.pendingCursorRequests) {
            if (request.docVersion <= olderThan || Date.now() - request.timestamp > PreviewControlPlane.maxWaitForRenderMs) {
                this.pendingCursorRequests.delete(docVersion);
            }
        }
    }

    prunePendingRenders(renderVersion: number): void {
        this.pendingRenders = this.pendingRenders.filter(
            (pending) =>
                (!pending.docVersion || pending.docVersion > renderVersion) &&
                (!pending.timestamp || Date.now() - pending.timestamp <= PreviewControlPlane.maxWaitForRenderMs),
        );
    }

    clarifyRenderVersion(payload: {
        fileName: string;
        docVersion: number;
    }): void {
        this.debugLog(
            `\x1b[31m[Preview Control:track]\x1b[0m "${payload.fileName}" docVersion: \x1b[94m${payload.docVersion}\x1b[0m`,
            this.pendingRenders,
        );
        if (
            this.pendingRenders.length === 0 ||
            this.pendingRenders[this.pendingRenders.length - 1].fileName !==
                payload.fileName
        ) {
            return;
        }
        this.pendingRenders[this.pendingRenders.length - 1].docVersion =
            payload.docVersion;
    }

    trackRenderVersion(payload: {
        docVersion: number;
        fileName: string;
    }): void {
        this.debugLog(
            `\x1b[31m[Preview Control:clarify]\x1b[0m "${payload.fileName}" docVersion: \x1b[94m${payload.docVersion}\x1b[0m`,
            this.pendingRenders,
        );
        // docVersion comes from ack or remote sync
        this.pendingRenders.push({
            type: "merge",
            timestamp: Date.now(),
            fileName: payload.fileName,
            docVersion: payload.docVersion,
        });
    }

    private handleControlMessage(raw: string): void {
        this.debugLog(
            `[Preview Control:in] Control message length: ${raw.length}`,
            raw.length < 60 ? raw : "too long to display",
        );
        try {
            const msg = JSON.parse(raw);

            if (msg.event === "compileStatus") {
                this.onCompileStatus(msg.kind, msg);
            } else if (msg.event === "outline") {
                this.onOutline(msg.items);
            } else if (msg.event === "syncEditorChanges") {
                this.onSyncChanges(msg);
            } else if (msg.status) {
                window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                    type: "info",
                    message: `[Preview Control:in] Status: ${msg.status}`,
                });

                // first "compiling" status of opened preview is always lost (happens before the established connection to browser)
                // standard "current" will not trigger compile and it's status, it flushes last successful render
                // in any case "current" implies "reset" ("new" payload is expected)
                if (msg.status === "current-requested") {
                    this.pendingRenders.push({
                        type: "reset",
                        timestamp: Date.now(),
                        fileName: "entry.typ", // "current" is for "entry.typ" but edited file can be different, preview doesn't know what is being edited
                        docVersion: 0, // "current" docVersion is unknown until svg with the marker is rendered
                    });
                    this.debugLog(
                        `\x1b[31m[Preview Control:current]\x1b[0m`,
                        this.pendingRenders,
                    );
                }

                if (msg.status === "cursor-requested") {
                    window.$tmEventBus.emit(tmEvents.PreviewCursorRequest, {
                        uniqueTabId: msg.details?.uniqueTabId,
                    });
                    this.debugLog(
                        `[Preview Control:in] Cursor position requested by ${msg.details.uniqueTabId}`,
                        msg,
                    );
                    this.pushCursorBlankDiff(this.confirmedRenderVersion?.docVersion || 0);
                }
            } else {
                console.warn(`[Preview Control:in] Unknown message: ${raw}`);
                window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                    type: "warning",
                    message: `[Preview Control:in] Unknown message: ${raw}`,
                });
            }
        } catch (error) {
            console.warn(
                `[Preview Control:in] Failed to parse message: ${raw}`,
            );
        }
    }

    private onCompileStatus(kind: string, msg?: any) {
        if (kind === "Compiling") {
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "info",
                message: "[Preview Control:in] Compiling...",
            });
            this.debugLog(this.currentRender, this.pendingRenders);
        } else if (kind === "CompileSuccess") {
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "success",
                message: `[Preview Control:in] Compilation successful for "${this.currentRender?.fileName}" docVersion: ${this.currentRender?.docVersion}. Pending ${this.pendingRenders.length} render(s) in queue.`,
            });
        } else if (kind === "CompileError") {
            this.shiftFailedRender();
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "error",
                message: `[Preview Control:in] Compilation failed for "${this.currentRender?.fileName}" docVersion: ${this.currentRender?.docVersion}. Pending ${this.pendingRenders.length} render(s) in queue.`,
            });
            console.error("[Preview Control:in] Compile Error:", msg);
        }
    }

    private onSyncChanges(msg: any) {
        // Handle synchronization
        this.debugLog(
            "[Preview Control:in] Syncing changes received but not used:",
            msg,
        );
    }

    private onOutline(items: OutlineItem[]) {
        // Update table of contents
        this.debugLog(
            "[Preview Control:in] Document outline received but not used",
        );
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
                this.debugLog(
                    "[Preview Control:out] Sending cursor position:",
                    msg,
                );
                break;

            case "sourceScrollBySpan":
                msg = {
                    event: "sourceScrollBySpan",
                    span: message.span, // string
                };
                break;
            case "panelScrollByPosition":
                msg = {
                    event: "panelScrollByPosition",
                    position: message.position,
                };
                break;
            default:
                console.warn(
                    `[Preview Control:out] Unknown control message event: ${message.event}`,
                );
                return;
        }

        this.debugLog(
            `[Preview Control:out] Sending Control Plane ${message.event}:`,
            msg,
        );
        window.$tmEventBus.emit(
            tmEvents.PreviewSendControl,
            JSON.stringify(msg),
        );
    }
}
