import { config } from "dotenv";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { createServer, IncomingMessage } from "http";
import { join } from "path";
import { FileManager } from "./file-manager";
import { LSPClient } from "./lsp-client";
import { verifyRequestToken, verifyNewToken, AuthToken } from "../token-helper";

// Load .env file from project root
config({ path: join(process.cwd(), ".env") });

type ConnectionContext = {
    socket: WebSocket;
    pageId: number;
    userId: number;
    docVersion: number;
    lastSeen: number;
};

// pageId -> TabSession
type SessionMap = Map<number, TabSession>;
interface TabSocket extends WebSocket {
    pageId: number;
    userId: number;
    tabToken: string;
    docVersion: number;
    lastSeen: number;
    isAlive: boolean;
}

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
        tokens: Array<{
            line: number;
            startChar: number;
            length: number;
            tokenType: string;
            tokenModifiers: string[];
        }>;
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

const connections = new Map<WebSocket, ConnectionContext>();
const fileManager = new FileManager(STORAGE_ROOT);

// LSP client globals
let lspClient: LSPClient | null = null;
const openDocuments = new Map<number, string>(); // pageId -> docUri

function send(ws: WebSocket, payload: OutgoingMessagePayload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function handleChanges(
    ctx: ConnectionContext,
    msg: Extract<IncomingMessagePayload, { type: "changes" }>
) {
    if (msg.pageId !== ctx.pageId) {
        send(ctx.socket, {
            type: "error",
            code: "PAGE_MISMATCH",
            message: "Page mismatch",
        });
        return;
    }

    if (msg.docVersion <= ctx.docVersion) {
        send(ctx.socket, {
            type: "error",
            code: "VERSION_OUTDATED",
            message: "Client version outdated, request full resync",
        });
        const content = fileManager.loadDocument(ctx.pageId);
        send(ctx.socket, {
            type: "fullState",
            pageId: ctx.pageId,
            docVersion: ctx.docVersion,
            content,
        });
        return;
    }

    let updated: string;
    try {
        updated = fileManager.applyChanges(ctx.pageId, msg.changes);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        send(ctx.socket, {
            type: "error",
            code: errorMessage,
            message: "Failed to apply changes",
        });
        return;
    }

    try {
        fileManager.persistDocument(ctx.pageId, updated);
    } catch (err) {
        send(ctx.socket, {
            type: "error",
            code: "WRITE_FAILED",
            message: "Failed to persist document",
        });
        return;
    }

    ctx.docVersion = msg.docVersion;
    send(ctx.socket, {
        type: "ack",
        pageId: ctx.pageId,
        docVersion: ctx.docVersion,
    });

    // Request semantic tokens after successful change
    requestSemanticTokens(ctx.pageId, updated).catch((err) => {
        console.error("[LSP] Failed to get semantic tokens:", err);
    });
}

/**
 * Request semantic tokens from LSP and broadcast to connected clients
 */
async function requestSemanticTokens(
    pageId: number,
    content: string
): Promise<void> {
    if (!lspClient) {
        console.warn("[LSP] LSP client not initialized");
        return;
    }

    try {
        const docUri = `file:///${join(STORAGE_ROOT, `page_${pageId}.typ`)}`;

        // If document isn't open in LSP yet, open it
        if (!openDocuments.has(pageId)) {
            lspClient.sendNotification("textDocument/didOpen", {
                textDocument: {
                    uri: docUri,
                    languageId: "typst",
                    version: 1,
                    text: content,
                },
            });
            openDocuments.set(pageId, docUri);
        } else {
            // Send didChange notification for already open documents
            // lspClient.sendNotification("textDocument/didChange", {
            //   textDocument: {
            //     uri: docUri,
            //     version: Date.now(), // Use timestamp as version
            //   },
            //   contentChanges: [
            //     {
            //       text: content, // Full document sync
            //     },
            //   ],
            // });
        }

        // Request semantic tokens
        const tokensResult = await lspClient.sendRequest(
            "textDocument/semanticTokens/full",
            {
                textDocument: { uri: docUri },
            }
        );

        if (tokensResult?.data) {
            // TODO: decode client-side to reduce payload size
            // const decodedTokens = lspClient.decodeSemanticTokens(tokensResult.data);

            // Broadcast to all clients viewing this page
            const message: Extract<
                OutgoingMessagePayload,
                { type: "semanticTokens" }
            > = {
                type: "semanticTokens",
                pageId,
                tokens: tokensResult.data,
            };

            for (const [socket, ctx] of connections.entries()) {
                if (ctx.pageId === pageId) {
                    send(socket, message);
                }
            }
        }
    } catch (err) {
        console.error("[LSP] Error requesting semantic tokens:", err);
    }
}

function processMessage(ctx: ConnectionContext, raw: RawData) {
    let msg: IncomingMessagePayload;
    try {
        msg = JSON.parse(raw.toString());
    } catch (err) {
        send(ctx.socket, {
            type: "error",
            code: "BAD_JSON",
            message: "Invalid JSON",
        });
        return;
    }

    ctx.lastSeen = Date.now();

    switch (msg.type) {
        case "ping":
            send(ctx.socket, { type: "pong" });
            return;
        case "changes":
            handleChanges(ctx, msg);
            return;
        case "updateToken":
            handleTokenUpdate(ctx, msg);
            return;
        default:
            send(ctx.socket, {
                type: "error",
                code: "UNKNOWN_TYPE",
                message: "Unsupported message type",
            });
            return;
    }
}

function handleTokenUpdate(
    ctx: ConnectionContext,
    msg: Extract<IncomingMessagePayload, { type: "updateToken" }>
) {
    try {
        const payload = verifyNewToken(msg.token, ctx.pageId);
        // Update context with new user ID (in case user changed)
        ctx.userId = payload.user_id;
        // Send acknowledgment
        send(ctx.socket, {
            type: "ack",
            pageId: ctx.pageId,
            docVersion: ctx.docVersion,
        });
    } catch (err) {
        console.error("[File Sync] Token update failed:", err);
        send(ctx.socket, {
            type: "error",
            code: "INVALID_TOKEN",
            message: "Token verification failed",
        });
    }
}

function createContext(
    socket: WebSocket,
    tokenPayload: AuthToken,
    initialVersion: number
): ConnectionContext {
    return {
        socket,
        pageId: tokenPayload.page_id,
        userId: tokenPayload.user_id,
        docVersion: initialVersion,
        lastSeen: Date.now(),
    };
}

function initSocketContext(
    socket: WebSocket,
    request: IncomingMessage
): ConnectionContext {

    let payload: AuthToken;
    try {
        payload = verifyRequestToken(request);
    } catch (err) {
        console.error("Invalid token during connection", { err });
        socket.close(4401, "INVALID_TOKEN");
        throw new Error("INVALID_TOKEN", {cause: err});
    }

    const latestContext = Array.from(connections.values()).reduce(
        (acc, c) =>
            c.pageId === payload.page_id && c.docVersion > acc.version
                ? {
                    version: c.docVersion,
                    someoneElse: payload.user_id !== c.userId,
                    lastSeen: c.lastSeen,
                }
                : acc,
        { version: 0, someoneElse: false, lastSeen: 0 }
    );

    const content = fileManager.loadDocument(payload.page_id);
    const ctx = createContext(socket, payload, latestContext.version);
    connections.set(socket, ctx);

    send(socket, {
        type: "fullState",
        pageId: payload.page_id,
        docVersion: ctx.docVersion,
        content,
        someoneElse: latestContext.someoneElse,
        lastSeen: latestContext.lastSeen,
    });

    // Request initial semantic tokens
    requestSemanticTokens(payload.page_id, content).catch((err) => {
        console.error("[LSP] Failed to get initial semantic tokens:", err);
    });

    return ctx;
}

function pruneStaleConnections() {
    const now = Date.now();
    for (const [ws, ctx] of connections.entries()) {
        if (now - ctx.lastSeen > STALE_TIMEOUT_MS) {
            console.warn("Closing stale connection", {
                pageId: ctx.pageId,
                userId: ctx.userId,
            });
            ws.close(4000, "Idle timeout");
            connections.delete(ws);
        }
    }
}

function rawDataToString(data: RawData): string {
    if (typeof data === "string") {
        return data;
    }
    if (data instanceof Buffer) {
        return data.toString();
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString();
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data).toString();
    }
    if (ArrayBuffer.isView(data)) {
        const view = data as ArrayBufferView;
        return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString();
    }
    return String(data);
}

class TabSession {
    // private readonly client: TinymistPreviewClient;
    private readonly browsers: Set<TabSocket> = new Set();
    private idleTimer: NodeJS.Timeout | null = null;
    private destroyed = false;

    constructor(
        private readonly pageId: number,
        // private readonly options: PreviewClientOptions,
        private readonly remove: (pageId: number) => void
    ) {
        // this.client = new TinymistPreviewClient(pageId, filePath, { ...managerOptions });
        // this.readyPromise = this.client.start().then(() => undefined);
    }

    addBrowser(socket: TabSocket): void {
        if (this.destroyed) {
            throw new Error("Session has been destroyed");
        }

        this.browsers.add(socket);
        this.clearIdleTimer();

        if (socket.readyState === WebSocket.OPEN) {
            // const payload = JSON.stringify({ type: "bridge:connected", pageId: this.pageId });
            // socket.send(Buffer.concat([Buffer.from([CONTROL_TAG]), Buffer.from(payload, "utf8")]));
        }
    }

    removeBrowser(socket: TabSocket): void {
        this.browsers.delete(socket);
        if (!this.destroyed && this.browsers.size === 0) {
            this.scheduleIdleStop();
        }
    }

    handleBrowserMessage(socket: TabSocket, data: RawData, isBinary: boolean): void {
        try {
            const json = rawDataToString(data);
            const msg: IncomingMessagePayload = JSON.parse(json);
            // Handle message...
        } catch (err) {
            send(socket, {
                type: "error",
                code: "BAD_JSON",
                message: "Invalid JSON",
            });
        }
    }

    private broadcastSync(payload: RawData | string): void {
        for (const browser of this.browsers) {
            if (browser.readyState === WebSocket.OPEN) {
                browser.send(payload);
            }
        }
    }

    private broadcastStatus(status: string, details: any): void {
        console.log(`[Tab Session ${this.pageId}] ${status}`, details ?? "");
        const payload = JSON.stringify({ type: `bridge:${status}`, pageId: this.pageId, details });
        for (const browser of this.browsers) {
            if (browser.readyState === WebSocket.OPEN) {
                browser.send(payload);
            }
        }
    }

    private handleClientExit(code: number | null, signal: NodeJS.Signals | null): void {
        const details = { code, signal };
        console.warn(`[Tab Session ${this.pageId}] Tinymist exited ${details}`);
        this.broadcastStatus('exit', details);
        this.stop().catch((error) => console.error("Failed to stop after exit", error));
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

        // remove file?

        this.remove(this.pageId);
    }
}

async function bootstrap() {
    // Initialize LSP client first
    await initializeLSPClient();

    const server = createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", (socket, request) => {
        try {
            const ctx = initSocketContext(socket, request);

            socket.on("message", (raw) => processMessage(ctx, raw));

            socket.on("close", (code, reason) => {
                console.log("Socket closed", {
                    code,
                    reason: reason.toString(),
                    pageId: ctx.pageId,
                    userId: ctx.userId,
                });
                connections.delete(socket);

                // Close document in LSP if no other clients are viewing it
                const hasOtherClients = Array.from(connections.values()).some(
                    (c) => c.pageId === ctx.pageId
                );
                if (!hasOtherClients && openDocuments.has(ctx.pageId)) {
                    const docUri = openDocuments.get(ctx.pageId)!;
                    lspClient?.sendNotification("textDocument/didClose", {
                        textDocument: { uri: docUri },
                    });
                    openDocuments.delete(ctx.pageId);
                    console.log(`[LSP] Closed document for page ${ctx.pageId}`);
                }
            });

            socket.on("error", (err) => {
                console.error("Socket error", {
                    err,
                    pageId: ctx.pageId,
                    userId: ctx.userId,
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
            if (method === "textDocument/publishDiagnostics") {
                console.log(
                    "[LSP] Diagnostics:",
                    params.uri,
                    params.diagnostics.length
                );
                // TODO: Broadcast diagnostics to clients
            }
        },
        onError: (error) => {
            console.error("[LSP] Error:", error);
        },
        onRestart: () => {
            console.log("[LSP] Server restarted, re-initializing...");
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
    }
}


bootstrap();
