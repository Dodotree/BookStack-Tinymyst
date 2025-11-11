import { config } from "dotenv";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { createServer, IncomingMessage } from "http";
import { join } from "path";
import { URL } from "url";
import jwt from "jsonwebtoken";
import { FileManager } from "./file-manager";
import { LSPClient } from "./lsp-client";

// Load .env file from project root
config({ path: join(process.cwd(), ".env") });

type ConnectionContext = {
  socket: WebSocket;
  pageId: number;
  userId: number;
  docVersion: number;
  lastSeen: number;
};

type AuthToken = {
  user_id: number;
  page_id: number;
  exp: number;
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

const PORT = Number(process.env.FILE_WS_PORT ?? 4000);
const HOST = process.env.FILE_WS_HOST ?? "127.0.0.1";
const JWT_SECRET = process.env.TINYMIST_WS_SECRET ?? "dev-secret";
const STORAGE_ROOT =
  process.env.TYPST_STORAGE_ROOT ??
  join(process.cwd(), "storage", "app", "tinymist");
const HEARTBEAT_INTERVAL_MS = 20_000;
const STALE_TIMEOUT_MS = 45_000;

const connections = new Map<WebSocket, ConnectionContext>();
const fileManager = new FileManager(STORAGE_ROOT);

// LSP client globals
let lspClient: LSPClient | null = null;
const openDocuments = new Map<number, string>(); // pageId -> docUri

function verifyToken(token: string): AuthToken {
  try {
    console.log("Verifying token:", {
      token: token.substring(0, 20) + "...",
      secretLength: JWT_SECRET.length,
    });
    const decoded = jwt.verify(token, JWT_SECRET) as AuthToken;
    console.log("Token verified successfully:", {
      user_id: decoded.user_id,
      page_id: decoded.page_id,
      exp: decoded.exp,
    });
    return decoded;
  } catch (err) {
    console.error("Token verification failed:", err);
    throw new Error("INVALID_TOKEN");
  }
}

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
    const { content } = fileManager.loadDocument(ctx.pageId);
    send(ctx.socket, {
      type: "fullState",
      pageId: ctx.pageId,
      docVersion: ctx.docVersion,
      content,
    });
    return;
  }

  const { content: currentContent } = fileManager.loadDocument(ctx.pageId);

  let updated: string;
  try {
    updated = fileManager.applyChanges(ctx.pageId, currentContent, msg.changes);
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
async function requestSemanticTokens(pageId: number, content: string): Promise<void> {
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
    const tokensResult = await lspClient.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri: docUri },
    });

    if (tokensResult?.data) {

      // TODO: decode client-side to reduce payload size
      const decodedTokens = lspClient.decodeSemanticTokens(tokensResult.data);

      // Broadcast to all clients viewing this page
      const message: Extract<OutgoingMessagePayload, { type: "semanticTokens" }> = {
        type: "semanticTokens",
        pageId,
        tokens: decodedTokens,
      };

      for (const [socket, ctx] of connections.entries()) {
        if (ctx.pageId === pageId) {
          send(socket, message);
        }
      }

      console.log(`[LSP] Sent ${decodedTokens.length} semantic tokens for page ${pageId}`);
    }
  } catch (err) {
    console.error("[LSP] Error requesting semantic tokens:", err);
  }
}

function handleTokenUpdate(
  ctx: ConnectionContext,
  msg: Extract<IncomingMessagePayload, { type: "updateToken" }>
) {
  try {
    console.log("[File Sync] Token update request", {
      pageId: ctx.pageId,
      userId: ctx.userId,
    });
    const payload = verifyToken(msg.token);

    // Verify it's for the same page
    if (payload.page_id !== ctx.pageId) {
      console.error("[File Sync] Token update failed: page mismatch", {
        contextPageId: ctx.pageId,
        tokenPageId: payload.page_id,
      });
      send(ctx.socket, {
        type: "error",
        code: "PAGE_MISMATCH",
        message: "Token is for different page",
      });
      return;
    }

    // Update context with new user ID (in case user changed)
    ctx.userId = payload.user_id;
    console.log("[File Sync] Token updated successfully", {
      pageId: ctx.pageId,
      userId: ctx.userId,
    });

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

function performHandshake(request: IncomingMessage): {
  token: string;
  pageId: number;
} {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`
  );
  const token =
    url.searchParams.get("token") || request.headers["sec-websocket-protocol"];
  if (!token) {
    throw new Error("MISSING_TOKEN");
  }

  const parsed = verifyToken(Array.isArray(token) ? token[0] : token);
  return {
    token: Array.isArray(token) ? token[0] : token,
    pageId: parsed.page_id,
  };
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

/**
 * Initialize LSP client
 */
async function initializeLSPClient(): Promise<void> {
  const logFile = join(process.cwd(), "storage", "logs", `tinymist-lsp-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`);
  console.log(`[LSP] Starting LSP client, logging to: ${logFile}`);

  lspClient = new LSPClient({
    command: "",
    args: ["lsp"],
    cwd: process.cwd(),
    stderrLogFile: logFile,
    onNotification: (method, params) => {
      if (method === "textDocument/publishDiagnostics") {
        console.log("[LSP] Diagnostics:", params.uri, params.diagnostics.length);
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

async function bootstrap() {
  // Initialize LSP client first
  await initializeLSPClient();

  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket, request) => {
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`
      );
      const tokenParam =
        url.searchParams.get("token") ||
        request.headers["sec-websocket-protocol"];
      console.log("Connection attempt:", {
        url: request.url,
        hasToken: !!tokenParam,
      });

      if (!tokenParam) {
        console.error("No token provided");
        socket.close(4401, "Missing token");
        return;
      }

      const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
      console.log("Extracted token:", token.substring(0, 30) + "...");
      const payload = verifyToken(token);
      const { content } = fileManager.loadDocument(payload.page_id);
      const ctx = createContext(socket, payload, 0);
      connections.set(socket, ctx);

      send(socket, {
        type: "fullState",
        pageId: payload.page_id,
        docVersion: ctx.docVersion,
        content,
      });

      // Request initial semantic tokens
      requestSemanticTokens(payload.page_id, content).catch((err) => {
        console.error("[LSP] Failed to get initial semantic tokens:", err);
      });

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

  setInterval(pruneStaleConnections, HEARTBEAT_INTERVAL_MS);
}

bootstrap();
