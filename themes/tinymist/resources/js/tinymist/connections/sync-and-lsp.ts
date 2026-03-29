// Connects to node server that syncs files and holds LSP stdin/stdout pipes
// Authenticates via signed tokens, updates them in time

// Initial state of the file comes from db to both front and back ends
// Subsequent changes are synced via incremental updates with version tracking
// On page load first ws connection verifies if front and back ends have the same version

// sent: verify versions -> server verifies and responds with current version or requests full sync
// sent: (gets from editor) {full sync, forceReset -?} -> server applies full content (version N)
// sent: initial request for full semanticTokens -> server -> LSP -> server -> tokens
// sent: editor {change increment} -> server updates file (if version is > server version)
// sent: request for semanticTokens delta -> server -> LSP -> server -> tokens delta (not tried yet)

// receive: "ack" acknowledged token on update
// receive: server {full sync to version N} (if server version > client version) -> here -> editor applies full content
// receive: LSP pushes diagnostics when file updates -> server -> here -> diagnostics.ts
// if LSP is down, "LSPdown" message sent from server upon file update (and following diagnostics push expected)
// receive: encoded semanticTokens here -> semantic_tokens.ts -> editor applies tokens
// receive: semanticTokens delta here -> semantic_tokens.ts -> editor applies token edits
// receive: Error, see list below

// Errors:
// page mismatch
// version mismatch
// can not apply change (most likely cursor drift)
// failed to write the file
// LSP request failed

/**
 * WebSocket client for real-time Typst file synchronization
 * Handles connection, authentication, token renewal, and change streaming
 */
import { TinymistWebSocketClient } from "./ws-base";
import {
    SYNC_AND_LSP_PORT,
    SYNC_AND_LSP_URI,
    SYNC_AND_LSP_STATUS_KEY,
    tmEvents,
} from "../constants";

export class TinymistFileSyncClient extends TinymistWebSocketClient {
    constructor(pageId: number, token: string, uniqueTabId: string) {
        super(pageId, token, uniqueTabId, {
            name: "File Sync / LSP",
            statusKey: SYNC_AND_LSP_STATUS_KEY,
            connectEvent: tmEvents.SyncConnect,
            disconnectEvent: tmEvents.SyncDisconnect,
            localPort: SYNC_AND_LSP_PORT,
            remotePath: SYNC_AND_LSP_URI,
        });

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

    /**
     * Send changes to the server
     */
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
            console.debug("[FilesLSP WS] Received message:", msg);

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
                    // For tokens and successful file updates
                    if (fileName != 'authTokenAck') {
                        window.$tmEventBus.emit(tmEvents.FileSyncAck, {
                            timestamp: Date.now(),
                            fileName: fileName!,
                            docVersion: docVersion!,
                        });
                    }
                    break;

                case "fullState":
                    console.debug(
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
                    console.debug(
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
                    console.debug(
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
                    console.debug(
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
                    console.debug(
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
