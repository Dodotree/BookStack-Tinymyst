"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ws_1 = require("ws");
const http_1 = require("http");
const fs_1 = require("fs");
const path_1 = require("path");
const url_1 = require("url");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const state_1 = require("@codemirror/state");
const PORT = Number(process.env.WS_PORT ?? 4000);
const HOST = process.env.WS_HOST ?? '127.0.0.1';
const JWT_SECRET = process.env.TINYMIST_WS_SECRET ?? 'dev-secret';
const STORAGE_ROOT = process.env.TYPST_STORAGE_ROOT ?? (0, path_1.join)(process.cwd(), 'storage', 'app', 'tinymist');
const HEARTBEAT_INTERVAL_MS = 20_000;
const STALE_TIMEOUT_MS = 45_000;
const connections = new Map();
function verifyToken(token) {
    try {
        return jsonwebtoken_1.default.verify(token, JWT_SECRET);
    }
    catch (err) {
        throw new Error('INVALID_TOKEN');
    }
}
function loadDocument(pageId) {
    const filePath = (0, path_1.join)(STORAGE_ROOT, `page_${pageId}.typ`);
    try {
        const content = (0, fs_1.existsSync)(filePath) ? (0, fs_1.readFileSync)(filePath, 'utf8') : '';
        return { content, docVersion: 0 };
    }
    catch (err) {
        console.error('Failed to read document', { pageId, err });
        throw new Error('DOC_READ_FAILED');
    }
}
function persistDocument(pageId, content) {
    const filePath = (0, path_1.join)(STORAGE_ROOT, `page_${pageId}.typ`);
    try {
        (0, fs_1.mkdirSync)((0, path_1.dirname)(filePath), { recursive: true });
        (0, fs_1.writeFileSync)(filePath, content, 'utf8');
    }
    catch (err) {
        console.error('Failed to write document', { pageId, err });
        throw new Error('DOC_WRITE_FAILED');
    }
}
function send(ws, payload) {
    if (ws.readyState === ws_1.WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}
function handleChanges(ctx, msg) {
    if (msg.pageId !== ctx.pageId) {
        send(ctx.socket, { type: 'error', code: 'PAGE_MISMATCH', message: 'Page mismatch' });
        return;
    }
    if (msg.docVersion <= ctx.docVersion) {
        send(ctx.socket, {
            type: 'error',
            code: 'VERSION_OUTDATED',
            message: 'Client version outdated, request full resync',
        });
        const { content } = loadDocument(ctx.pageId);
        send(ctx.socket, {
            type: 'fullState',
            pageId: ctx.pageId,
            docVersion: ctx.docVersion,
            content,
        });
        return;
    }
    const { content: currentContent } = loadDocument(ctx.pageId);
    const text = state_1.Text.of(currentContent.split('\n'));
    let changeSet;
    try {
        changeSet = state_1.ChangeSet.fromJSON(msg.changes);
    }
    catch (err) {
        console.error('Failed to parse changeset', { pageId: ctx.pageId, err });
        send(ctx.socket, { type: 'error', code: 'INVALID_CHANGESET', message: 'Failed to parse changeset' });
        return;
    }
    const updated = changeSet.apply(text).toString();
    try {
        persistDocument(ctx.pageId, updated);
    }
    catch (err) {
        send(ctx.socket, { type: 'error', code: 'WRITE_FAILED', message: 'Failed to persist document' });
        return;
    }
    ctx.docVersion = msg.docVersion;
    send(ctx.socket, { type: 'ack', pageId: ctx.pageId, docVersion: ctx.docVersion });
}
function processMessage(ctx, raw) {
    let msg;
    try {
        msg = JSON.parse(raw.toString());
    }
    catch (err) {
        send(ctx.socket, { type: 'error', code: 'BAD_JSON', message: 'Invalid JSON' });
        return;
    }
    ctx.lastSeen = Date.now();
    switch (msg.type) {
        case 'ping':
            send(ctx.socket, { type: 'pong' });
            return;
        case 'changes':
            handleChanges(ctx, msg);
            return;
        default:
            send(ctx.socket, { type: 'error', code: 'UNKNOWN_TYPE', message: 'Unsupported message type' });
            return;
    }
}
function performHandshake(request) {
    const url = new url_1.URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const token = url.searchParams.get('token') || request.headers['sec-websocket-protocol'];
    if (!token) {
        throw new Error('MISSING_TOKEN');
    }
    const parsed = verifyToken(Array.isArray(token) ? token[0] : token);
    return { token: Array.isArray(token) ? token[0] : token, pageId: parsed.page_id };
}
function createContext(socket, tokenPayload, initialVersion) {
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
            console.warn('Closing stale connection', { pageId: ctx.pageId, userId: ctx.userId });
            ws.close(4000, 'Idle timeout');
            connections.delete(ws);
        }
    }
}
function bootstrap() {
    const server = (0, http_1.createServer)();
    const wss = new ws_1.WebSocketServer({ server });
    wss.on('connection', (socket, request) => {
        try {
            const url = new url_1.URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
            const tokenParam = url.searchParams.get('token') || request.headers['sec-websocket-protocol'];
            if (!tokenParam) {
                socket.close(4401, 'Missing token');
                return;
            }
            const token = Array.isArray(tokenParam) ? tokenParam[0] : tokenParam;
            const payload = verifyToken(token);
            const { content } = loadDocument(payload.page_id);
            const ctx = createContext(socket, payload, 0);
            connections.set(socket, ctx);
            send(socket, {
                type: 'fullState',
                pageId: payload.page_id,
                docVersion: ctx.docVersion,
                content,
            });
            socket.on('message', (raw) => processMessage(ctx, raw));
            socket.on('close', (code, reason) => {
                console.log('Socket closed', { code, reason: reason.toString(), pageId: ctx.pageId, userId: ctx.userId });
                connections.delete(socket);
            });
            socket.on('error', (err) => {
                console.error('Socket error', { err, pageId: ctx.pageId, userId: ctx.userId });
            });
        }
        catch (err) {
            console.error('Failed handshake', { err });
            socket.close(4403, 'Unauthorized');
        }
    });
    server.listen(PORT, HOST, () => {
        console.log(`Typst file-sync WebSocket listening on ${HOST}:${PORT}`);
    });
    setInterval(pruneStaleConnections, HEARTBEAT_INTERVAL_MS);
}
bootstrap();
