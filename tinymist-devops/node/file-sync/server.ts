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
    uniqueTabId: string;
    lastSeen: number;
    lastFileName: string;
};

type IncomingMessagePayload =
    | { type: "ping" }
    | {
        type: "updateToken";
        token: string;
    }
    | {
        type: "openFile";
        pageId: number;
        fileName: string;
    }
    | {
        type: "changes";
        pageId: number;
        fileName: string;
        docVersion: number;
        changes: unknown; // serialized ChangeSet
    };

type OutgoingMessagePayload =
    | { type: "pong" }
    | {
        type: "ack";
        pageId: number;
        fileName: string;
        docVersion: number;
    }
    | {
        type: "fullState";
        pageId: number;
        fileName: string;
        docVersion: number;
        content: string;
        fromDifferentTab?: boolean;
        lastSeen?: number;
    }
    | {
        type: "semanticTokens";
        pageId: number;
        fileName: string;
        docVersion: number;
        resultId?: string;
        tokens: number[];
    }
    | {
        type: "semanticTokensDelta";
        pageId: number;
        fileName: string;
        docVersion: number;
        previousResultId?: string;
        resultId?: string;
        edits: Array<{ start: number; deleteCount: number; data?: number[] }>;
    }
    | {
        type: "diagnostics";
        pageId: number;
        fileName: string;
        docVersion: number;
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

const defaultFileName = "entry.typ";

function normalizeFileName(fileName: string): string {
    if (!fileName || fileName.trim().length === 0 || fileName.includes("\\") || fileName.includes("/") || fileName.includes("..")) {
        throw new Error("INVALID_FILE_NAME");
    }
    return fileName.trim();
}

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

    const session = new PageSession(pageId, () => {
        sessions.delete(pageId);
    });
    sessions.set(pageId, session);
    return session;
}

function findNotificationSession(params: unknown): { session: PageSession; fileName: string } | null {
    if (params && typeof params === "object" && "uri" in params && typeof params.uri === "string") {

        // we have to identify the session based on the file URI, which contains the pageId and fileName
        const decodedUri = decodeURIComponent(params.uri);
        const match = decodedUri.match(/page_(\d+)\/([^/]+)$/);
        const pageId = match?.[1];
        const fileName = match?.[2];
        if (!pageId || isNaN(Number(pageId))) {
            console.warn("Received LSP notification with invalid or missing pageId in URI:", params.uri);
            return null;
        }
        const session = sessions.get(Number(pageId)) || null;
        if (!session || !fileName) {
            console.warn("Received LSP notification with invalid or missing fileName in URI, or no session found:", params.uri);
            return null;
        }
        let normalized;
        try {
            normalized = normalizeFileName(fileName);
        } catch (err) {
            console.warn("Received LSP notification for invalid file name in URI:", params.uri);
            return null;
        }
        return { session, fileName: normalized };
    }
    return null;
}

type FileSessionState = {
    fileName: string;
    uri: string;
    docVersion: number;
    semanticTokenResultId?: string;
    semanticTokenTimer?: NodeJS.Timeout;
    lspOpen: boolean;
};

class PageSession {
    private readonly browsers: Set<ConnectionContext> = new Set();
    private readonly fileStates: Map<string, FileSessionState> = new Map();
    private idleTimer: NodeJS.Timeout | null = null;
    private destroyed = false;

    constructor(
        private readonly pageId: number,
        private readonly remove: () => void
    ) {}


    send(ws: WebSocket, payload: OutgoingMessagePayload) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }

    private sendAck(ws: WebSocket, fileName: string, docVersion: number) {
        this.send(ws, {
            type: "ack",
            pageId: this.pageId,
            fileName,
            docVersion,
        });
    }

    private getFileUri(fileName: string): string {
        const absolutePath = join(STORAGE_ROOT, `page_${this.pageId}`, fileName).replace(/\\/g, "/");
        return encodeURI(`file:///${absolutePath}`);
    }

    private isTypFile(fileName: string): boolean {
        return fileName.toLowerCase().endsWith(".typ");
    }

    private getFileState(fileName: string): FileSessionState {
        const existing = this.fileStates.get(fileName);
        if (existing) {
            return existing;
        }

        const created: FileSessionState = {
            fileName: fileName,
            uri: this.getFileUri(fileName),
            docVersion: 1,
            lspOpen: false,
        };
        this.fileStates.set(fileName, created);
        return created;
    }

    private sendFullState(
        ws: WebSocket,
        fileName: string,
        fromDifferentTab?: boolean, // only on connection/reconnection
        lastSeen?: number      // only on connection/reconnection
    ): void {
        const state = this.getFileState(fileName);
        const content = fileManager.loadDocument(this.pageId, state.fileName);

        if (lspClient && this.isTypFile(state.fileName) && !state.lspOpen) {
            this.openLspDocument(state, content, false);
        }

        this.send(ws, {
            type: "fullState",
            pageId: this.pageId,
            fileName: state.fileName,
            docVersion: state.docVersion,
            content,
            fromDifferentTab,
            lastSeen,
        });
    }

    addConnection(ctx: ConnectionContext): void {
        if (this.destroyed) {
            throw new Error("Session has been destroyed");
        }
        const { fromDifferentTab, lastSeen } = this.getLatestConnectionInfo(ctx.uniqueTabId);

        this.browsers.add(ctx);
        this.clearIdleTimer();

        this.sendFullState(ctx.socket, defaultFileName, fromDifferentTab, lastSeen);
        this.scheduleSemanticTokens(defaultFileName, true);
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
            case "openFile":
                this.handleOpenFile(ctx, msg);
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

    handleLspNotification(method: string, params: any, fileName: string): void {
        if (method === "textDocument/publishDiagnostics") {
            console.log(
                "[LSP] Diagnostics:",
                params.uri,
                params.diagnostics?.length ?? 0
            );

            this.broadcastDiagnostics(
                fileName,
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
            this.sendAck(ctx.socket, defaultFileName, this.getFileState(defaultFileName).docVersion);
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

    broadcastDiagnostics(fileName: string, diagnostics: Array<unknown>): void {
        const state = this.getFileState(fileName);
        this.broadcast({
            type: "diagnostics",
            pageId: this.pageId,
            fileName: state.fileName,
            docVersion: state.docVersion,
            diagnostics,
        });
    }

    handleLspRestart(): void {
        for (const state of this.fileStates.values()) {
            state.lspOpen = false;
            state.semanticTokenResultId = undefined;
            if (this.browsers.size > 0 && this.isTypFile(state.fileName)) {
                // TODO: we have to make sure there's some tab that actually has this file open
                const content = fileManager.loadDocument(this.pageId, state.fileName);
                this.openLspDocument(state, content, true);
                this.scheduleSemanticTokens(state.fileName, true);
            }
        }
    }

    private handleOpenFile(
        ctx: ConnectionContext,
        msg: Extract<IncomingMessagePayload, { type: "openFile" }>
    ): void {
        if (msg.pageId !== ctx.pageId) {
            this.send(ctx.socket, {
                type: "error",
                code: "PAGE_MISMATCH",
                message: "Page mismatch",
            });
            return;
        }

        let fileName;
        try {
            fileName = normalizeFileName(msg.fileName);
        } catch (err) {
            this.send(ctx.socket, {
                type: "error",
                code: "INVALID_FILE_NAME",
                message: "Invalid file name",
            });
            return;
        }
        console.log(`[LSP] Opening file ${fileName} for page ${ctx.pageId}`);
        this.sendFullState(ctx.socket, fileName);
        this.scheduleSemanticTokens(fileName, true);
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

        let fileName;
        try {
            fileName = normalizeFileName(msg.fileName);
        } catch (err) {
            this.send(ctx.socket, {
                type: "error",
                code: "INVALID_FILE_NAME",
                message: "Invalid file name",
            });
            return;
        }

        const state = this.getFileState(fileName);

        if (msg.docVersion <= state.docVersion) {
            this.send(ctx.socket, {
                type: "error",
                code: "VERSION_OUTDATED",
                message: `Client version outdated (current: ${state.docVersion}, requested: ${msg.docVersion}), request full resync`,
            });
            this.sendFullState(ctx.socket, state.fileName);
            return;
        }

        let updated: string;
        let contentChanges: LspContentChange[];
        try {
            ({ updated, contentChanges } = fileManager.applyChanges(
                this.pageId,
                state.fileName,
                msg.changes
            ));
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            this.send(ctx.socket, {
                type: "error",
                code: errorMessage,
                message: `Failed to apply changes: ${msg.changes}`,
            });
            this.sendFullState(ctx.socket, state.fileName);
            return;
        }

        try {
            fileManager.persistDocument(this.pageId, updated, state.fileName);
        } catch (err) {
            this.send(ctx.socket, {
                type: "error",
                code: "WRITE_FAILED",
                message: "Failed to persist document",
            });
            return;
        }

        state.docVersion = msg.docVersion;
        this.sendAck(ctx.socket, state.fileName, state.docVersion);

        if (!lspClient) {
            notifyAllLspStatus("down", "client not initialized");
            return;
        }

        if (!this.isTypFile(state.fileName)) {
            return;
        }

        try {
            if (!state.lspOpen) {
                this.openLspDocument(state, updated, false);
            } else {
                lspClient.sendNotification("textDocument/didChange", {
                    textDocument: {
                        uri: state.uri,
                        version: state.docVersion,
                    },
                    contentChanges,
                });
            }
        } catch (err) {
            console.error("[LSP] Failed to send document change notification:", err);
        }

        this.scheduleSemanticTokens(state.fileName, false);
    }

    private openLspDocument(state: FileSessionState, text: string, force: boolean): void {
        if (!lspClient) {
            return;
        }
        if (!this.isTypFile(state.fileName)) {
            return;
        }
        if (state.lspOpen && !force) {
            return;
        }
        lspClient.sendNotification("textDocument/didOpen", {
            textDocument: {
                uri: state.uri,
                languageId: "typst", // don't need any other language support from the back end
                version: state.docVersion,
                text,
            },
        });
        state.lspOpen = true;
    }

    private scheduleSemanticTokens(fileName: string, forceFull: boolean): void {
        const state = this.getFileState(fileName);
        if (!this.isTypFile(state.fileName)) {
            return;
        }

        if (state.semanticTokenTimer) {
            clearTimeout(state.semanticTokenTimer);
        }

        console.log(`[LSP] Scheduling semantic token request for page ${this.pageId} file ${state.fileName} (forceFull=${forceFull})`);

        state.semanticTokenTimer = setTimeout(() => {
            this.requestSemanticTokens(state.fileName, forceFull).catch((err) => {
                console.error("[LSP] Failed to get semantic tokens:", err);
            });
        }, SEMANTIC_TOKEN_DEBOUNCE_MS);
    }

    private async requestSemanticTokens(fileName: string, forceFull: boolean): Promise<void> {
        if (!lspClient) {
            notifyAllLspStatus("down", "client not initialized");
            return;
        }

        const state = this.getFileState(fileName);

        if (forceFull) {
            state.semanticTokenResultId = undefined;
        }

        const previousResultId = state.semanticTokenResultId;
        const method = previousResultId
            ? "textDocument/semanticTokens/full/delta"
            : "textDocument/semanticTokens/full";

        console.log(
            `[LSP] Requesting semantic tokens for page ${this.pageId} file ${state.fileName} (${method})`
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
                textDocument: { uri: state.uri },
                ...(previousResultId ? { previousResultId } : {}),
            });
            // console.log(
            //     `[LSP] Received semantic tokens response for page ${this.pageId} file ${state.fileName}`,
            //     tokensResult
            // );
        } catch (err) {
            console.error("[LSP] Error requesting semantic tokens:", err);
            return;
        }

        if (tokensResult?.resultId) {
            state.semanticTokenResultId = tokensResult.resultId;
        }

        if (tokensResult?.edits && tokensResult.edits.length) {
            this.broadcast({
                type: "semanticTokensDelta",
                pageId: this.pageId,
                fileName: state.fileName,
                docVersion: state.docVersion,
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
                fileName: state.fileName,
                docVersion: state.docVersion,
                resultId: tokensResult.resultId,
                tokens: tokensResult.data,
            });
        } else {
            console.warn(`[LSP] No semantic tokens returned for page ${this.pageId}`);
        }
    }

    private getLatestConnectionInfo(newUniqueTabId: string): {
        fromDifferentTab: boolean;
        lastSeen: number;
    } {
        let fromDifferentTab = false;
        let lastSeen = 0;
        for (const ctx of this.browsers) {
            if (ctx.uniqueTabId !== newUniqueTabId) {
                fromDifferentTab = true;
            }
            lastSeen = Math.max(lastSeen, ctx.lastSeen);
        }

        return { fromDifferentTab, lastSeen };
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
        this.browsers.clear();

        if (lspClient) {
            for (const state of this.fileStates.values()) {
                if (state.semanticTokenTimer) {
                    clearTimeout(state.semanticTokenTimer);
                    state.semanticTokenTimer = undefined;
                }

                if (state.lspOpen) {
                    try {
                        lspClient.sendNotification("textDocument/didClose", {
                            textDocument: { uri: state.uri },
                        });
                    } catch (err) {
                        console.error("[LSP] Failed to close document:", err);
                    }
                }
            }
        }

        this.fileStates.clear();
        this.remove();
    }
}


function pruneStaleConnections() {
    const now = Date.now();
    for (const [ws, ctx] of connections.entries()) {
        if (now - ctx.lastSeen > STALE_TIMEOUT_MS) {
            console.warn("Closing stale connection", {
                pageId: ctx.pageId,
                uniqueTabId: ctx.uniqueTabId,
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
                uniqueTabId: payload.uniqueTabId ?? "",
                lastSeen: Date.now(),
                lastFileName: defaultFileName,
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
            const resolved = findNotificationSession(params);
            resolved?.session.handleLspNotification(method, params, resolved.fileName);
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
