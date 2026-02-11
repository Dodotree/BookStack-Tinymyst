import { config } from "dotenv";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { createServer, IncomingMessage } from "http";
import { join } from "path";
import { FileManager, LspContentChange } from "./file-manager";
import { LSPClient } from "./lsp-client";
import { verifyRequestToken, verifyNewToken, AuthToken } from "../token-helper";

// Load .env file from project root
config({ path: join(process.cwd(), ".env") });

type ConnectionContext = {
    socket: WebSocket;
    pageId: number;
    tabToken: string;
    lastSeen: number;
};

type IncomingMessagePayload =
    | { type: "ping" }
    | {
        type: "changes";
        pageId: number;
        docVersion: number;
        changes: unknown; // serialized ChangeSet
    }
    | {
        type: "updateToken";
        token: string;
    };

type OutgoingMessagePayload =
    | { type: "pong" }
    | {
        type: "ack";
        pageId: number;
        docVersion: number;
    }
    | {
        type: "fullState";
        pageId: number;
        docVersion: number;
        content: string;
        someoneElse?: boolean;
        lastSeen?: number;
    }
    | {
        type: "semanticTokens";
        pageId: number;
        docVersion: number;
        resultId?: string;
        tokens: number[];
    }
    | {
        type: "semanticTokensDelta";
        pageId: number;
        docVersion: number;
        previousResultId?: string;
        resultId?: string;
        edits: Array<{ start: number; deleteCount: number; data?: number[] }>;
    }
    | {
        type: "diagnostics";
        pageId: number;
        docVersion: number;
        uri: string;
        diagnostics: Array<unknown>;
    }
    | {
        type: "error";
        code: string;
        message: string;
    };

const PORT = Number(process.env.FILE_WS_PORT) ?? 4000;
const HOST = process.env.FILE_WS_HOST ?? "127.0.0.1";
const STORAGE_ROOT =
    process.env.TYPST_STORAGE_ROOT ??
    join(process.cwd(), "storage", "app", "tinymist");

const HEARTBEAT_INTERVAL_MS = 20_000;
const STALE_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_MS = 5 * 60_000; // 5 minutes
const SEMANTIC_TOKEN_DEBOUNCE_MS = 300;

// LSP client globals
const connections = new Map<WebSocket, ConnectionContext>();
const sessions = new Map<number, PageSession>();
const fileManager = new FileManager(STORAGE_ROOT);
let lspClient: LSPClient | null = null;

function broadcastToAllSessions(payload: OutgoingMessagePayload): void {
    for (const session of sessions.values()) {
        session.broadcast(payload);
    }
}

function notifyAllLspStatus(status: "down" | "restarting", details?: unknown): void {
    const code = status === "down" ? "LSP_DOWN" : "LSP_RESTARTING";
    const message =
        status === "down"
            ? "LSP server unavailable"
            : "LSP server restarting";
    broadcastToAllSessions({
        type: "error",
        code,
        message: details ? `${message}: ${String(details)}` : message,
    });
}

function getSession(pageId: number): PageSession {
    const existing = sessions.get(pageId);
    if (existing) {
        return existing;
    }

    const uri = `file:///${join(STORAGE_ROOT, `page_${pageId}.typ`)}`
    const session = new PageSession(pageId, uri, () => {
        sessions.delete(pageId);
    });
    sessions.set(pageId, session);
    return session;
}

function getNotificationSession(params: unknown): PageSession | null {
    if (params && typeof params === "object" && "uri" in params && typeof params.uri === "string") {
        const pageId = params.uri
            .split("/")
            .pop()
            ?.split(".")[0]
            .replace("page_", "");
        // pageId is 1-based (not zero-based)
        if (!pageId || isNaN(Number(pageId))) {
            return null;
        }
        return sessions.get(Number(pageId)) || null;
    }
    return null;
}

class PageSession {
    private readonly browsers: Set<ConnectionContext> = new Set();
    private idleTimer: NodeJS.Timeout | null = null;
    private destroyed = false;
    private docVersion = 0;
    private semanticTokenResultId?: string;
    private semanticTokenTimer?: NodeJS.Timeout;
    private lspOpen = false;

    constructor(
        private readonly pageId: number,
        private readonly uri: string,
        private readonly remove: () => void
    ) {}


    send(ws: WebSocket, payload: OutgoingMessagePayload) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }

    sendAck(ws: WebSocket) {
        this.send(ws, {
            type: "ack",
            pageId: this.pageId,
            docVersion: this.docVersion,
        });
    }

    addConnection(ctx: ConnectionContext): void {
        if (this.destroyed) {
            throw new Error("Session has been destroyed");
        }

        const content = fileManager.loadDocument(this.pageId);
        const { someoneElse, lastSeen } = this.getLatestConnectionInfo(ctx.tabToken);

        this.browsers.add(ctx);
        this.clearIdleTimer();

        this.send(ctx.socket, {
            type: "fullState",
            pageId: this.pageId,
            docVersion: this.docVersion,
            content,
            someoneElse,
            lastSeen,
        });

        this.scheduleSemanticTokens(true);
    }

    removeConnection(ctx: ConnectionContext): void {
        this.browsers.delete(ctx);
        if (!this.destroyed && this.browsers.size === 0) {
            this.scheduleIdleStop();
        }
    }

    handleMessage(ctx: ConnectionContext, raw: RawData): void {
        let msg: IncomingMessagePayload;
        try {
            msg = JSON.parse(raw.toString());
        } catch (err) {
            this.send(ctx.socket, {
                type: "error",
                code: "BAD_JSON",
                message: "Invalid JSON",
            });
            return;
        }

        ctx.lastSeen = Date.now();

        switch (msg.type) {
            case "ping":
                this.send(ctx.socket, { type: "pong" });
                return;
            case "changes":
                this.handleChanges(ctx, msg);
                return;
            case "updateToken":
                this.handleTokenUpdate(ctx, msg);
                return;
            default:
                this.send(ctx.socket, {
                    type: "error",
                    code: "UNKNOWN_TYPE",
                    message: "Unsupported message type",
                });
                return;
        }
    }

    handleLspNotification(method: string, params: any): void {
        if (method === "textDocument/publishDiagnostics") {
            console.log(
                "[LSP] Diagnostics:",
                params.uri,
                params.diagnostics?.length ?? 0
            );

            this.broadcastDiagnostics(
                params.uri,
                Array.isArray(params.diagnostics) ? params.diagnostics : []
            );
        }
    }

    handleTokenUpdate( // Token renewal from single browser
        ctx: ConnectionContext,
        msg: Extract<IncomingMessagePayload, { type: "updateToken" }>
    ) {
        try {
            verifyNewToken(msg.token, ctx.pageId);
            // Send acknowledgment
            this.sendAck(ctx.socket);
        } catch (err) {
            console.error("[File Sync] Token update failed:", err);
            this.send(ctx.socket, {
                type: "error",
                code: "INVALID_TOKEN",
                message: "Token verification failed",
            });
        }
    }

    broadcast(payload: OutgoingMessagePayload): void {
        for (const browser of this.browsers) {
            this.send(browser.socket, payload);
        }
    }

    broadcastDiagnostics(uri: string, diagnostics: Array<unknown>): void {
        this.broadcast({
            type: "diagnostics",
            pageId: this.pageId,
            docVersion: this.docVersion,
            uri,
            diagnostics,
        });
    }

    handleLspRestart(): void {
        this.lspOpen = false;
        this.semanticTokenResultId = undefined;
        if (this.browsers.size > 0) {
            const content = fileManager.loadDocument(this.pageId);
            this.openLspDocument(content, true);
            this.scheduleSemanticTokens(true);
        }
    }

    private handleChanges(
        ctx: ConnectionContext,
        msg: Extract<IncomingMessagePayload, { type: "changes" }>
    ): void {
        if (msg.pageId !== ctx.pageId) {
            this.send(ctx.socket, {
                type: "error",
                code: "PAGE_MISMATCH",
                message: "Page mismatch",
            });
            return;
        }

        if (msg.docVersion <= this.docVersion) {
            this.send(ctx.socket, {
                type: "error",
                code: "VERSION_OUTDATED",
                message: "Client version outdated, request full resync",
            });
            const content = fileManager.loadDocument(this.pageId);
            this.send(ctx.socket, {
                type: "fullState",
                pageId: this.pageId,
                docVersion: this.docVersion,
                content,
            });
            return;
        }

        let updated: string;
        let contentChanges: LspContentChange[];
        try {
            ({ updated, contentChanges } = fileManager.applyChanges(
                this.pageId,
                msg.changes
            ));
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            this.send(ctx.socket, {
                type: "error",
                code: errorMessage,
                message: `Failed to apply changes: ${msg.changes}`,
            });
            return;
        }

        try {
            fileManager.persistDocument(this.pageId, updated);
        } catch (err) {
            this.send(ctx.socket, {
                type: "error",
                code: "WRITE_FAILED",
                message: "Failed to persist document",
            });
            return;
        }

        this.docVersion = msg.docVersion;
        this.sendAck(ctx.socket);

        if (!lspClient) {
            notifyAllLspStatus("down", "client not initialized");
            return;
        }

        try {
            if (!this.lspOpen) {
                this.openLspDocument(updated, false);
            } else {
                lspClient.sendNotification("textDocument/didChange", {
                    textDocument: {
                        uri: this.uri,
                        version: this.docVersion,
                    },
                    contentChanges,
                });
            }
        } catch (err) {
            console.error("[LSP] Failed to send document change notification:", err);
        }

        this.scheduleSemanticTokens(false);
    }

    private openLspDocument(text: string, force: boolean): void {
        if (!lspClient) {
            return;
        }
        if (this.lspOpen && !force) {
            return;
        }
        lspClient.sendNotification("textDocument/didOpen", {
            textDocument: {
                uri: this.uri,
                languageId: "typst",
                version: this.docVersion,
                text,
            },
        });
        this.lspOpen = true;
    }

    private scheduleSemanticTokens(forceFull: boolean): void {
        if (this.semanticTokenTimer) {
            clearTimeout(this.semanticTokenTimer);
        }

        this.semanticTokenTimer = setTimeout(() => {
            this.requestSemanticTokens(forceFull).catch((err) => {
                console.error("[LSP] Failed to get semantic tokens:", err);
            });
        }, SEMANTIC_TOKEN_DEBOUNCE_MS);
    }

    private async requestSemanticTokens(forceFull: boolean): Promise<void> {
        if (!lspClient) {
            notifyAllLspStatus("down", "client not initialized");
            return;
        }

        if (forceFull) {
            this.semanticTokenResultId = undefined;
        }

        const previousResultId = this.semanticTokenResultId;
        const method = previousResultId
            ? "textDocument/semanticTokens/full/delta"
            : "textDocument/semanticTokens/full";

        console.log(
            `[LSP] Requesting semantic tokens for page ${this.pageId} (${method})`
        );
        let tokensResult:
            | {
                  resultId?: string;
                  data?: number[];
                  edits?: Array<{ start: number; deleteCount: number; data?: number[] }>;
              }
            | undefined;
        try {
            tokensResult = await lspClient.sendRequest(method, {
                textDocument: { uri: this.uri },
                ...(previousResultId ? { previousResultId } : {}),
            });
        } catch (err) {
            console.error("[LSP] Error requesting semantic tokens:", err);
            return;
        }

        if (tokensResult?.resultId) {
            this.semanticTokenResultId = tokensResult.resultId;
        }

        if (tokensResult?.edits && tokensResult.edits.length) {
            this.broadcast({
                type: "semanticTokensDelta",
                pageId: this.pageId,
                docVersion: this.docVersion,
                previousResultId,
                resultId: tokensResult.resultId,
                edits: tokensResult.edits,
            });
            return;
        }

        if (tokensResult?.data) {
            this.broadcast({
                type: "semanticTokens",
                pageId: this.pageId,
                docVersion: this.docVersion,
                resultId: tokensResult.resultId,
                tokens: tokensResult.data,
            });
        } else {
            console.warn(`[LSP] No semantic tokens returned for page ${this.pageId}`);
        }
    }

    private getLatestConnectionInfo(newTabToken: string): {
        someoneElse: boolean;
        lastSeen: number;
    } {
        let someoneElse = false;
        let lastSeen = 0;
        for (const ctx of this.browsers) {
            if (ctx.tabToken !== newTabToken) {
                someoneElse = true;
            }
            lastSeen = Math.max(lastSeen, ctx.lastSeen);
        }

        return { someoneElse, lastSeen };
    }

    private scheduleIdleStop(): void {
        if (IDLE_TIMEOUT_MS <= 0) {
            return;
        }
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.stop().catch((error) => console.error("Idle stop failed", error));
        }, IDLE_TIMEOUT_MS).unref();
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    async stop(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.clearIdleTimer();
        if (this.semanticTokenTimer) {
            clearTimeout(this.semanticTokenTimer);
            this.semanticTokenTimer = undefined;
        }
        this.browsers.clear();
        if (this.lspOpen && lspClient) {
            try {
                lspClient.sendNotification("textDocument/didClose", {
                    textDocument: { uri: this.uri },
                });
            } catch (err) {
                console.error("[LSP] Failed to close document:", err);
            }
        }
        this.lspOpen = false;
        this.remove();
    }
}


function pruneStaleConnections() {
    const now = Date.now();
    for (const [ws, ctx] of connections.entries()) {
        if (now - ctx.lastSeen > STALE_TIMEOUT_MS) {
            console.warn("Closing stale connection", {
                pageId: ctx.pageId,
                tabToken: ctx.tabToken,
            });
            ws.close(4000, "Idle timeout");
            connections.delete(ws);
            const session = sessions.get(ctx.pageId);
            session?.removeConnection(ctx);
        }
    }
}

async function bootstrap() {
    // Initialize LSP client first
    await initializeLSPClient();

    const server = createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (socket, request) => {
        try {

            let payload: AuthToken;
            try {
                payload = verifyRequestToken(request);
            } catch (err) {
                console.error("Invalid token during connection", { err });
                socket.close(4401, "INVALID_TOKEN");
                throw new Error("INVALID_TOKEN", {cause: err});
            }

            const ctx = {
                socket,
                pageId: payload.page_id,
                tabToken: payload.tabToken ?? "",
                lastSeen: Date.now(),
            };
            connections.set(socket, ctx);
            const session = getSession(ctx.pageId);
            session.addConnection(ctx);

            socket.on("message", (raw) => session.handleMessage(ctx, raw));

            socket.on("close", (code, reason) => {
                console.log("Socket closed", {
                    code,
                    reason: reason.toString(),
                    pageId: ctx.pageId,
                });
                connections.delete(socket);
                session.removeConnection(ctx);
            });

            socket.on("error", (err) => {
                console.error("Socket error", {
                    err,
                    pageId: ctx.pageId,
                });
            });
        } catch (err) {
            console.error("Failed handshake", { err });
            socket.close(4403, "Unauthorized");
        }
    });

    server.listen(PORT, HOST, () => {
        console.log(`Typst file-sync WebSocket listening on ${HOST}:${PORT}`);
    });

    const heartbeat = setInterval(pruneStaleConnections, HEARTBEAT_INTERVAL_MS).unref();

    process.on("SIGINT", async () => {
        console.log("\n[File sync LSP] Caught SIGINT, shutting down...");
        heartbeat && clearInterval(heartbeat);
        for (const socket of wss.clients) {
            socket.terminate();
        }
        server.close();
        process.exit(0);
    });
}

/**
 * Initialize LSP client
 */
async function initializeLSPClient(): Promise<void> {
    const logFile = join(
        process.cwd(),
        "storage",
        "logs",
        `tinymist-lsp-${new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, 19)}.log`
    );
    console.log(`[LSP] Starting LSP client, logging to: ${logFile}`);

    lspClient = new LSPClient({
        command: "",
        args: ["lsp"],
        cwd: process.cwd(),
        stderrLogFile: logFile,
        onNotification: (method, params) => {
            console.log(`[LSP] Notification: ${method}`, params);
            const session = getNotificationSession(params);
            session?.handleLspNotification(method, params);
        },
        onError: (error) => {
            console.error("[LSP] Error:", error);
            notifyAllLspStatus("down", error);
        },
        onRestart: () => {
            console.log("[LSP] Server restarted, re-initializing...");
            notifyAllLspStatus("restarting");
            for (const session of sessions.values()) {
                session.handleLspRestart();
            }
            lspClient?.initializeLSP();
        },
    });

    try {
        await lspClient.start();
        console.log("[LSP] Server started");
        await lspClient.initializeLSP();
    } catch (err) {
        console.error("[LSP] Failed to initialize:", err);
        lspClient = null;
        notifyAllLspStatus("down", err);
    }
}


bootstrap();
