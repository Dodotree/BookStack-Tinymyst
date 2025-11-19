"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = require("dotenv");
const http_1 = require("http");
const fs_1 = require("fs");
const path_1 = require("path");
const url_1 = require("url");
const ws_1 = require("ws");
const preview_client_1 = require("./preview-client");
(0, dotenv_1.config)({ path: (0, path_1.join)(process.cwd(), ".env") });
const BRIDGE_HOST = process.env.TINYMIST_PREVIEW_BRIDGE_HOST ?? "127.0.0.1";
const BRIDGE_PORT = Number(process.env.TINYMIST_PREVIEW_BRIDGE_PORT ?? 4020);
const PREVIEW_HOST = process.env.TINYMIST_PREVIEW_HOST ?? "127.0.0.1";
const CONTROL_BASE_PORT = Number(process.env.TINYMIST_CONTROL_BASE_PORT ?? 33626);
const TINYMIST_CLI_PATH = process.env.TINYMIST_CLI_PATH ?? defaultTinymistPath();
const IDLE_TIMEOUT_MINUTES = Number(process.env.TINYMIST_PREVIEW_IDLE_TIMEOUT ?? 5);
const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES > 0 ? IDLE_TIMEOUT_MINUTES * 60_000 : 0;
const SESSION_READY_TIMEOUT_MS = Number(process.env.TINYMIST_PREVIEW_READY_TIMEOUT ?? 30_000);
const PING_INTERVAL_MS = Number(process.env.TINYMIST_BRIDGE_PING_INTERVAL ?? 20_000);
const PARTIAL_RENDERING = process.env.TINYMIST_PARTIAL_RENDERING !== "false";
const PROJECT_ROOT = process.cwd();
const STORAGE_ROOT = (0, path_1.resolve)(PROJECT_ROOT, "storage", "app", "tinymist");
const LOG_DIRECTORY = (0, path_1.resolve)(PROJECT_ROOT, "storage", "logs");
const CONTROL_TAG = 0x43; // 'C'
const DATA_TAG = 0x44; // 'D'
function defaultTinymistPath() {
    const executable = process.platform === "win32" ? "tinymist.exe" : "tinymist";
    return (0, path_1.resolve)(process.cwd(), "vendor", "bin", executable);
}
function rawDataToBuffer(data) {
    if (typeof data === "string") {
        return Buffer.from(data, "utf8");
    }
    if (data instanceof Buffer) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
    }
    if (Array.isArray(data)) {
        return Buffer.concat(data);
    }
    if (ArrayBuffer.isView(data)) {
        const view = data;
        return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    }
    return Buffer.from(String(data));
}
function rawDataToString(data) {
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
        const view = data;
        return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString();
    }
    return String(data);
}
class PreviewSession {
    pageId;
    options;
    remove;
    client;
    browsers = new Set();
    readyPromise;
    idleTimer = null;
    destroyed = false;
    constructor(pageId, options, remove) {
        this.pageId = pageId;
        this.options = options;
        this.remove = remove;
        const filePath = (0, path_1.join)(options.storageRoot, `page_${pageId}.typ`);
        if (!(0, fs_1.existsSync)(filePath)) {
            throw new Error(`Typst document not found for page ${pageId} at ${filePath}`);
        }
        const clientOptions = {
            projectRoot: PROJECT_ROOT,
            storageRoot: options.storageRoot,
            logDir: LOG_DIRECTORY,
            host: PREVIEW_HOST,
            controlBasePort: options.controlBasePort,
            tinymistExecutable: options.tinymistExecutable,
            partialRendering: options.partialRendering,
            portScanAttempts: options.portScanAttempts,
            retryAttempts: options.retryAttempts,
            retryDelayMs: options.retryDelayMs,
        };
        this.client = new preview_client_1.TinymistPreviewClient(pageId, filePath, clientOptions);
        this.client.on("control-message", (payload) => this.broadcastPreview(payload));
        this.client.on("data-message", (payload) => this.broadcastPreview(payload));
        this.client.on("status", (status, details) => this.broadcastStatus(status, details));
        this.client.on("exit", (code, signal) => this.handleClientExit(code, signal));
        this.readyPromise = this.client.start().then(() => undefined);
    }
    async ready(timeoutMs) {
        if (timeoutMs <= 0) {
            await this.readyPromise;
            return;
        }
        let timeoutHandle = null;
        try {
            await Promise.race([
                this.readyPromise,
                new Promise((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        reject(new Error(`Preview session ${this.pageId} readiness timeout`));
                    }, timeoutMs);
                }),
            ]);
        }
        finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }
    addBrowser(socket) {
        if (this.destroyed) {
            throw new Error("Session has been destroyed");
        }
        this.browsers.add(socket);
        this.clearIdleTimer();
        if (socket.readyState === ws_1.WebSocket.OPEN) {
            const payload = JSON.stringify({ type: "bridge:connected", pageId: this.pageId });
            socket.send(Buffer.concat([Buffer.from([CONTROL_TAG]), Buffer.from(payload, "utf8")]));
        }
    }
    removeBrowser(socket) {
        this.browsers.delete(socket);
        if (!this.destroyed && this.browsers.size === 0) {
            this.scheduleIdleStop();
        }
    }
    handleBrowserMessage(socket, data, isBinary) {
        const buffer = rawDataToBuffer(data);
        if (buffer.length === 0) {
            return;
        }
        const text = buffer.toString();
        if (!isBinary && (buffer[0] === 0x7b || text.trim().startsWith("{"))) {
            this.client.sendControl(text);
            return;
        }
        if (isBinary) {
            if (Buffer.isBuffer(data)) {
                this.client.sendData(data);
            }
            else {
                this.client.sendData(buffer);
            }
        }
        else {
            this.client.sendData(text);
        }
    }
    async stop() {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.clearIdleTimer();
        for (const browser of this.browsers) {
            if (browser.readyState === ws_1.WebSocket.OPEN) {
                browser.close(1012, "Preview session shutting down");
            }
        }
        this.browsers.clear();
        await this.client.stop().catch((error) => {
            console.error(`[Preview Session ${this.pageId}] Failed to stop cleanly`, error);
        });
        this.remove(this.pageId);
    }
    broadcastStatus(status, details) {
        console.log(`[Preview Session ${this.pageId}] ${status}`, details ?? "");
        const payload = JSON.stringify({ type: "bridge:preview-exit", pageId: this.pageId, details });
        for (const browser of this.browsers) {
            if (browser.readyState === ws_1.WebSocket.OPEN) {
                browser.send(payload);
            }
        }
    }
    broadcastPreview(payload) {
        for (const browser of this.browsers) {
            if (browser.readyState === ws_1.WebSocket.OPEN) {
                browser.send(payload);
            }
        }
    }
    handleClientExit(code, signal) {
        const details = { code, signal };
        console.warn(`[Preview Session ${this.pageId}] Tinymist exited ${details}`);
        this.broadcastStatus('exit', details);
        this.stop().catch((error) => console.error("Failed to stop after exit", error));
    }
    scheduleIdleStop() {
        if (IDLE_TIMEOUT_MS <= 0) {
            return;
        }
        this.clearIdleTimer();
        this.idleTimer = setTimeout(() => {
            this.stop().catch((error) => console.error("Idle stop failed", error));
        }, IDLE_TIMEOUT_MS).unref();
    }
    clearIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }
}
class PreviewSessionManager {
    options;
    sessions = new Map();
    pending = new Map();
    constructor(options) {
        this.options = options;
    }
    async getSession(pageId) {
        const existing = this.sessions.get(pageId);
        if (existing) {
            return existing;
        }
        const pending = this.pending.get(pageId);
        if (pending) {
            return pending;
        }
        const creation = this.createSession(pageId);
        this.pending.set(pageId, creation);
        try {
            const session = await creation;
            this.sessions.set(pageId, session);
            return session;
        }
        finally {
            this.pending.delete(pageId);
        }
    }
    removeSession(pageId) {
        this.sessions.delete(pageId);
    }
    async createSession(pageId) {
        const session = new PreviewSession(pageId, this.options, (id) => this.removeSession(id));
        await session.ready(SESSION_READY_TIMEOUT_MS);
        return session;
    }
}
const managerOptions = {
    storageRoot: STORAGE_ROOT,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    projectRoot: PROJECT_ROOT,
    logDir: LOG_DIRECTORY,
    host: PREVIEW_HOST,
    controlBasePort: CONTROL_BASE_PORT,
    tinymistExecutable: TINYMIST_CLI_PATH,
    partialRendering: PARTIAL_RENDERING,
    portScanAttempts: 200,
    retryAttempts: 40,
    retryDelayMs: 250,
};
const sessionManager = new PreviewSessionManager(managerOptions);
const server = (0, http_1.createServer)();
const wss = new ws_1.WebSocketServer({ server });
wss.on("connection", async (socket, request) => {
    const client = socket;
    client.isAlive = true;
    client.on("pong", () => {
        client.isAlive = true;
    });
    try {
        const requestUrl = new url_1.URL(request.url ?? "/", `http://${request.headers.host}`);
        const pageParam = requestUrl.searchParams.get("pageId");
        if (!pageParam) {
            socket.close(1008, "Missing pageId");
            return;
        }
        const pageId = Number(pageParam);
        if (!Number.isFinite(pageId) || pageId <= 0) {
            socket.close(1008, "Invalid pageId");
            return;
        }
        client.pageId = pageId;
        const session = await sessionManager.getSession(pageId);
        session.addBrowser(client);
        socket.on("message", (data, isBinary) => {
            try {
                session.handleBrowserMessage(client, data, isBinary);
            }
            catch (error) {
                console.error(`[Preview Bridge] Failed to handle message for page ${pageId}`, error);
            }
        });
        socket.on("close", () => {
            session.removeBrowser(client);
        });
        socket.on("error", (error) => {
            console.error(`[Preview Bridge] WebSocket error for page ${pageId}`, error);
            session.removeBrowser(client);
        });
    }
    catch (error) {
        console.error("[Preview Bridge] Connection error", error);
        socket.close(1011, "Bridge error");
    }
});
const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        const client = socket;
        if (!client.isAlive) {
            socket.terminate();
            continue;
        }
        client.isAlive = false;
        try {
            socket.ping();
        }
        catch (error) {
            console.error("[Preview Bridge] Failed to ping client", error);
            socket.terminate();
        }
    }
}, PING_INTERVAL_MS).unref();
server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    console.log(`Tinymist preview bridge listening on ${BRIDGE_HOST}:${BRIDGE_PORT}`);
});
process.on("SIGINT", async () => {
    console.log("\n[Preview Bridge] Caught SIGINT, shutting down...");
    heartbeat && clearInterval(heartbeat);
    for (const socket of wss.clients) {
        socket.terminate();
    }
    server.close();
    process.exit(0);
});
