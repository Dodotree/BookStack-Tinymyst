// Connects to node server that syncs files and holds LSP stdin/stdout pipes
// Authenticates via signed tokens, updates them in time
// Tracks connection state of the socket with ping/pongs and reports the state of LSP pipes

// Initial state of the file comes from db to both front and back ends
// Subsequent changes are synced via incremental updates with version tracking
// On page load first ws connection verifies if front and back ends have the same version

// sent: ping
// sent: verify versions -> server verifies and responds with current version or requests full sync
// sent: (gets from editor) {full sync, forceReset -?} -> server applies full content (version N)
// sent: initial request for full semanticTokens -> server -> LSP -> server -> tokens
// sent: editor {change increment} -> server updates file (if version is > server version)
// sent: request for semanticTokens delta -> server -> LSP -> server -> tokens delta (not tried yet)

// receive: pong
// receive: 'ack' acknowledged token on update
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
import {TinymistWebSocketClient} from './ws-base';

export class TinymistFileSyncClient extends TinymistWebSocketClient {
    constructor(
        pageId: number,
        token: string,
        uniqueTabId: string,
    ) {
        super(pageId, token, uniqueTabId, {
            name: 'File Sync / LSP',
            statusKey: 'file-lsp-ws',
            connectEvent: 'tinymist-sync-connect',
            disconnectEvent: 'tinymist-sync-disconnect',
            localPort: 4000,
            remotePath: '/ws/tinymist/file-sync/',
        });

        this.sendChanges = this.sendChanges.bind(this);
        window.$events.listen("tinymist-text-diff", this.sendChanges);
    }

    /**
     * Send changes to the server
     */
    sendChanges(payload: { changes: any; docVersion: number }): void {
        const message = {
            type: 'changes',
            pageId: this.pageId,
            docVersion: payload.docVersion,
            changes: payload.changes.toJSON(),
        };

        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            console.warn('[File Sync / LSP] WebSocket not connected, changes not synced');
            return;
        }

        this.sendJson(message);
    }

    protected handleMessage(data: string): void {
        try {
            const msg = JSON.parse(data);
            const docVersion = "docVersion" in msg ? Number(msg.docVersion) : undefined;

            switch (msg.type) {
                case 'pong':
                    console.log('[File Sync / LSP] Received pong');
                    break;

                case 'ack':
                    console.log('[File Sync / LSP] Change acknowledged', { docVersion });
                    break;

                case 'fullState':
                    console.log('[File Sync / LSP] Received full state from server', { docVersion });
                    window.$events.emit("tinymist-sync-full-state", {
                        content: msg.content,
                        docVersion,
                    });
                    break;

                case 'semanticTokens':
                    console.log('[File Sync / LSP] Received semantic tokens from server', { docVersion, resultId: msg.resultId, tokenCount: msg.tokens?.length || 0 });
                    window.$events.emit("tinymist-lsp-semantic-tokens", {
                        tokens: msg.tokens || [],
                        resultId: msg.resultId,
                        docVersion,
                    });
                    window.$events.emit("tinymist-prune-snapshots", docVersion);
                    break;

                case 'semanticTokensDelta':
                    console.log('[File Sync / LSP] Received semantic tokens delta from server', { docVersion, editCount: msg.edits?.length || 0 });
                    window.$events.emit("tinymist-lsp-semantic-tokens-delta", {
                        edits: msg.edits || [],
                        resultId: msg.resultId,
                        previousResultId: msg.previousResultId,
                        docVersion,
                    });
                    window.$events.emit("tinymist-prune-snapshots", docVersion);
                    break;

                case 'diagnostics':
                    console.log('[File Sync / LSP] Received diagnostics from server', { docVersion, diagnosticCount: msg.diagnostics?.length || 0 });
                    window.$events.emit("tinymist-lsp-diagnostics", {
                        diagnostics: msg.diagnostics || [],
                        docVersion,
                    });
                    window.$events.emit("tinymist-prune-snapshots", docVersion);
                    break;

                case 'error':
                    console.error('[File Sync / LSP] Server error:', msg);
                    window.$events.emit("tinymist-console-log",{ type: "error", message: "[File Sync / LSP] Server error", details: msg });
                    break;

                default:
                    console.warn('[File Sync / LSP] Unknown message type:', msg);
            }

        } catch (error) {
            console.error('[File Sync / LSP] Failed to parse WebSocket message:', error);
        }
    }

    // Token updates are handled by the shared base.

    /**
     * Disconnect from the WebSocket server
     */
    disconnect(): void {
        this.stopHeartbeat();
        this.clearReconnectTimeout();
        this.clearConnectionTimeout();

        if (this.socket) {
            this.socket.close(1000, 'Client disconnected');
            this.socket = null;
            console.log("[File Sync / LSP] Intentionally disconnected");
            window.$events.emit("tinymist-status", { what: "file-lsp-ws", connected: false });
        }

    }
}

