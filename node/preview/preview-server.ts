import { config } from "dotenv";
import { createServer } from "http";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { URL } from "url";
import { WebSocketServer, WebSocket, RawData } from "ws";

import { verifyRequestToken, verifyNewToken, AuthToken } from "../token-helper";
import { TinymistPreviewClient, PreviewClientOptions } from "./preview-client";

config({ path: join(process.cwd(), ".env") });

interface BridgeSocket extends WebSocket {
    pageId?: number;
    isAlive: boolean;
}

// pageId -> PreviewSession
type SessionMap = Map<number, PreviewSession>;

type IncomingMessagePayload =
    | { type: "ping" }
    | {
        type: "updateToken";
        token: string;
    }
    | {
        type: "current";
        pageId: number;
    };

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
const STORAGE_ROOT = resolve(PROJECT_ROOT, "storage", "app", "tinymist");
const LOG_DIRECTORY = resolve(PROJECT_ROOT, "storage", "logs");

const CONTROL_TAG = 0x43; // 'C'
const DATA_TAG = 0x44; // 'D'

const managerOptions: PreviewClientOptions = {
    tinymistExecutable: TINYMIST_CLI_PATH,
    projectRoot: PROJECT_ROOT,
    storageRoot: STORAGE_ROOT,
    logDir: LOG_DIRECTORY,
    host: PREVIEW_HOST,
    controlBasePort: CONTROL_BASE_PORT,
    portScanAttempts: 200,
    partialRendering: PARTIAL_RENDERING,
    retryAttempts: 40,
    retryDelayMs: 250,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
};

function defaultTinymistPath(): string {
    const executable = process.platform === "win32" ? "tinymist.exe" : "tinymist";
    return resolve(process.cwd(), "vendor", "bin", executable);
}

function rawDataToBuffer(data: RawData): Buffer {
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
        const view = data as ArrayBufferView;
        return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    }
    return Buffer.from(String(data));
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

class PreviewSession {
    private readonly client: TinymistPreviewClient;
    private readonly browsers: Set<BridgeSocket> = new Set();
    private readonly readyPromise: Promise<void>;
    private idleTimer: NodeJS.Timeout | null = null;
    private destroyed = false;

    constructor(
        private readonly pageId: number,
        private readonly options: PreviewClientOptions,
        private readonly remove: (pageId: number) => void
    ) {
        const filePath = join(options.storageRoot, `page_${pageId}.typ`);
        if (!existsSync(filePath)) {
            throw new Error(`Typst document not found for page ${pageId} at ${filePath}`);
        }

        this.client = new TinymistPreviewClient(pageId, filePath, { ...managerOptions });

        this.client.on("control-message", (payload) => this.broadcastPreview(payload));
        this.client.on("data-message", (payload) => this.broadcastPreview(payload));
        this.client.on("control-error", (details) => this.broadcastStatus("control-error", details));
        this.client.on("data-error", (details) => this.broadcastStatus("data-error", details));
        this.client.on("status", (status, details) => this.broadcastStatus(status, details));
        this.client.on("exit", (code, signal) => this.handleClientExit(code, signal));

        this.readyPromise = this.client.start().then(() => undefined);
    }

    async ready(timeoutMs: number): Promise<void> {
        if (timeoutMs <= 0) {
            await this.readyPromise;
            return;
        }

        let timeoutHandle: NodeJS.Timeout | null = null;
        try {
            await Promise.race([
                this.readyPromise,
                new Promise<never>((_, reject) => {
                    timeoutHandle = setTimeout(() => {
                        reject(new Error(`Preview session ${this.pageId} readiness timeout`));
                    }, timeoutMs);
                }),
            ]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    addBrowser(socket: BridgeSocket): void {
        if (this.destroyed) {
            throw new Error("Session has been destroyed");
        }

        this.browsers.add(socket);
        this.clearIdleTimer();

        if (socket.readyState === WebSocket.OPEN) {
            const payload = JSON.stringify({ type: "bridge:connected", pageId: this.pageId });
            socket.send(Buffer.concat([Buffer.from([CONTROL_TAG]), Buffer.from(payload, "utf8")]));
        }
    }

    removeBrowser(socket: BridgeSocket): void {
        this.browsers.delete(socket);
        if (!this.destroyed && this.browsers.size === 0) {
            this.scheduleIdleStop();
        }
    }

    handleBrowserMessage(socket: BridgeSocket, data: RawData, isBinary: boolean): void {
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
            } else {
                this.client.sendData(buffer);
            }
        } else {
            this.client.sendData(text);
        }
    }

    async stop(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.clearIdleTimer();

        for (const browser of this.browsers) {
            if (browser.readyState === WebSocket.OPEN) {
                browser.close(1012, "Preview session shutting down");
            }
        }
        this.browsers.clear();

        await this.client.stop().catch((error) => {
            console.error(`[Preview Session ${this.pageId}] Failed to stop cleanly`, error);
        });

        this.remove(this.pageId);
    }


    private broadcastPreview(payload: RawData | string): void {
        for (const browser of this.browsers) {
            if (browser.readyState === WebSocket.OPEN) {
                browser.send(payload);
            }
        }
    }

    private broadcastStatus(status: string, details: any): void {
        console.log(`[Preview Session ${this.pageId}] ${status}`, details ?? "");
        const payload = JSON.stringify({ type: `bridge:${status}`, pageId: this.pageId, details });
        for (const browser of this.browsers) {
            if (browser.readyState === WebSocket.OPEN) {
                browser.send(payload);
            }
        }
    }

    private handleClientExit(code: number | null, signal: NodeJS.Signals | null): void {
        const details = { code, signal };
        console.warn(`[Preview Session ${this.pageId}] Tinymist exited ${details}`);
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
}

class PreviewSessionManager {
    private readonly sessions: SessionMap = new Map();
    private readonly pending: Map<number, Promise<PreviewSession>> = new Map();

    constructor(private readonly options: PreviewClientOptions) {}

    async getSession(pageId: number): Promise<PreviewSession> {
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
        } finally {
            this.pending.delete(pageId);
        }
    }

    removeSession(pageId: number): void {
        this.sessions.delete(pageId);
    }

    private async createSession(pageId: number): Promise<PreviewSession> {
        const session = new PreviewSession(pageId, this.options, (id) => this.removeSession(id));
        await session.ready(SESSION_READY_TIMEOUT_MS);
        return session;
    }
}

async function bootstrap() {

    const sessionManager = new PreviewSessionManager(managerOptions);

    const server = createServer();
    const wss = new WebSocketServer({ server });

    wss.on("connection", async (socket: WebSocket, request) => {
        const client = socket as BridgeSocket;
        client.isAlive = true;

        client.on("pong", () => {
            client.isAlive = true;
        });

        try {
            const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
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
                } catch (error) {
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
        } catch (error) {
            console.error("[Preview Bridge] Connection error", error);
            socket.close(1011, "Bridge error");
        }
    });

    const heartbeat = setInterval(() => {
        for (const socket of wss.clients) {
            const client = socket as BridgeSocket;
            if (!client.isAlive) {
                socket.terminate();
                continue;
            }
            client.isAlive = false;
            try {
                socket.ping();
            } catch (error) {
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
}

bootstrap().catch((error) => {
    console.error("Failed to start preview bridge:", error);
    process.exit(1);
});

