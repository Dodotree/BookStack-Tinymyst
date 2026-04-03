import { TinymistWebSocketClient } from "./ws-base";
import {
    SYNC_AND_LSP_PORT,
    SYNC_AND_LSP_URI,
    SYNC_AND_LSP_STATUS_KEY,
    tmEvents,
} from "../constants";

export class TinymistFileSyncClient extends TinymistWebSocketClient {
    private debugOn = false;
    private debugLog: (...args: any[]) => void;

    constructor(pageId: number, token: string, uniqueTabId: string) {
        super(pageId, token, uniqueTabId, {
            name: "File Sync / LSP",
            statusKey: SYNC_AND_LSP_STATUS_KEY,
            connectEvent: tmEvents.SyncConnect,
            disconnectEvent: tmEvents.SyncDisconnect,
            localPort: SYNC_AND_LSP_PORT,
            remotePath: SYNC_AND_LSP_URI,
        });

        this.debugLog = this.debugOn ? console.debug : () => {};

        this.sendChanges = this.sendChanges.bind(this);
        this.openFile = this.openFile.bind(this);
        window.$tmEventBus.listen(tmEvents.TextDiff, this.sendChanges);
        window.$tmEventBus.listen(tmEvents.SyncOpenFile, this.openFile);
        // connect/disconnect events handled by superclass, do not override here!
    }

    openFile(payload: { fileName: string }): void {
        this.sendJson({
            type: "openFile",
            pageId: this.pageId,
            fileName: payload.fileName,
        });
    }

    sendChanges(payload: {
        changes: any;
        docVersion: number;
        fileName: string;
    }): void {
        const message = {
            type: "changes",
            pageId: this.pageId,
            fileName: payload.fileName,
            docVersion: payload.docVersion,
            changes: payload.changes.toJSON(),
        };

        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            console.warn(
                "[FilesLSP WS] WebSocket not connected, changes not synced",
            );
            return;
        }

        this.sendJson(message);
    }

    protected handleMessage(data: string): void {
        try {
            const msg = JSON.parse(data);
            this.debugLog("[FilesLSP WS] Received message:", msg);

            const docVersion =
                "docVersion" in msg ? Number(msg.docVersion) : undefined;
            const fileName =
                typeof msg.fileName === "string" &&
                msg.fileName.trim().length > 0
                    ? msg.fileName.trim()
                    : undefined;

            if (
                (docVersion === undefined || !fileName) &&
                [
                    "fullState",
                    "semanticTokens",
                    "semanticTokensDelta",
                    "diagnostics",
                ].includes(msg.type)
            ) {
                console.warn(
                    `[FilesLSP WS] Missing docVersion ${docVersion} or fileName ${fileName} for message type: ${msg.type}`,
                    msg,
                );
                return;
            }

            switch (msg.type) {

                case "ack":
                    // fileName === 'authTokenAck' should not fall through to this point
                    window.$tmEventBus.emit(tmEvents.FileSyncAck, {
                        timestamp: Date.now(),
                        fileName: fileName!,
                        docVersion: docVersion!,
                    });
                    break;

                case "fullState":
                    this.debugLog(
                        `[FilesLSP WS] Received full state \x1b[31m${fileName}\x1b[0m, docVersion: \x1b[94m${docVersion}\x1b[0m`,
                    );
                    window.$tmEventBus.emit(tmEvents.SyncFullState, {
                        timestamp: Date.now(),
                        fileName,
                        content: msg.content,
                        docVersion: docVersion!,
                    });
                    break;

                case "remoteChanges":
                    this.debugLog(
                        `[FilesLSP WS] Received remote changes \x1b[31m${fileName}\x1b[0m, docVersion: \x1b[94m${docVersion}\x1b[0m`,
                    );
                    window.$tmEventBus.emit(tmEvents.SyncRemoteChanges, {
                        timestamp: Date.now(),
                        fileName,
                        docVersion: docVersion!,
                        changes: msg.changes,
                    });
                    break;

                case "semanticTokens":
                    this.debugLog(
                        `[FilesLSP WS] Received semantic tokens FULL \x1b[31m${fileName}\x1b[0m docVersion: \x1b[94m${docVersion}\x1b[0m, resultId: \x1b[32m${msg.resultId}\x1b[0m, tokenCount: ${msg.tokens?.length || 0}`,
                    );
                    window.$tmEventBus.emit(tmEvents.LspSemanticTokens, {
                        fileName,
                        tokens: msg.tokens || [],
                        resultId: msg.resultId,
                        docVersion: docVersion!,
                    });
                    window.$tmEventBus.emit(tmEvents.PruneSnapshots, {
                        fileName,
                        docVersion: docVersion!,
                    });
                    break;

                case "semanticTokensDelta":
                    this.debugLog(
                        `[FilesLSP WS] Received semantic tokens DELTA \x1b[31m${fileName}\x1b[0m docVersion: \x1b[94m${docVersion}\x1b[0m, editCount: ${msg.edits?.length || 0}, resultId: \x1b[32m${msg.resultId}\x1b[0m, previousResultId: \x1b[32m${msg.previousResultId}\x1b[0m`,
                    );
                    window.$tmEventBus.emit(tmEvents.LspSemanticTokensDelta, {
                        fileName,
                        edits: msg.edits || [],
                        resultId: msg.resultId,
                        previousResultId: msg.previousResultId,
                        docVersion: docVersion!,
                    });
                    window.$tmEventBus.emit(tmEvents.PruneSnapshots, {
                        fileName,
                        docVersion: docVersion!,
                    });
                    break;

                case "diagnostics":
                    this.debugLog(
                        `[FilesLSP WS] Received diagnostics \x1b[31m${fileName}\x1b[0m docVersion: \x1b[94m${docVersion}\x1b[0m, diagnosticCount: ${msg.diagnostics?.length || 0}`,
                    );
                    window.$tmEventBus.emit(tmEvents.Diagnostics, {
                        fileName,
                        diagnostics: msg.diagnostics || [],
                        docVersion: docVersion!,
                    });
                    window.$tmEventBus.emit(tmEvents.PruneSnapshots, {
                        fileName,
                        docVersion: docVersion!,
                    });
                    break;

                case "error":
                    console.error("[FilesLSP WS] Server error:", msg);
                    window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                        type: "error",
                        message: "[FilesLSP WS] Server error",
                        details: msg,
                    });
                    break;

                default:
                    console.warn("[FilesLSP WS] Unknown message type:", msg);
            }
        } catch (error) {
            console.error(
                "[FilesLSP WS] Failed to parse WebSocket message:",
                error,
            );
        }
    }
}
