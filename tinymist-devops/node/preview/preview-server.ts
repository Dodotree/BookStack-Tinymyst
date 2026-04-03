import { config } from "dotenv";
import { createServer } from "http";
import { existsSync } from "fs";
import { isAbsolute, join, resolve } from "path";
import { URL } from "url";
import { exec } from "child_process";
import { WebSocketServer, WebSocket, RawData } from "ws";

import { verifyRequestToken, verifyNewToken, AuthToken } from "../token-helper";
import { PROJECT_ROOT, getTinymistCliPath, getTypstPackagePath } from "../shared/path-config";
import { TinymistPreviewClient, PreviewClientOptions } from "./preview-client";

config({ path: join(process.cwd(), ".env") });

interface BridgeSocket extends WebSocket {
    pageId?: number;
    uniqueTabId?: string;
    authToken?: AuthToken;
    isAlive: boolean;
}

// pageId -> PreviewSession
type SessionMap = Map<number, PreviewSession>;

// Messages from browser to bridge server, not forwarded to preview client directly
// Preview client only receives the raw text or binary data, like "current" from data channel or stringified JSON from control channel
type IncomingMessagePayload =
    | { type: "ping" }
    | {
        type: "updateToken";
        token: string;
    };

const BRIDGE_HOST = process.env.TINYMIST_PREVIEW_BRIDGE_HOST ?? "127.0.0.1";
const BRIDGE_PORT = Number(process.env.TINYMIST_PREVIEW_BRIDGE_PORT ?? 4020);
const PREVIEW_HOST = process.env.TINYMIST_PREVIEW_HOST ?? "127.0.0.1";
const CONTROL_BASE_PORT = Number(process.env.TINYMIST_CONTROL_BASE_PORT ?? 33626);
const TINYMIST_CLI_PATH = getTinymistCliPath();
const TYPST_PACKAGE_PATH = getTypstPackagePath();

const IDLE_TIMEOUT_MINUTES = Number(process.env.TINYMIST_PREVIEW_IDLE_TIMEOUT ?? 5);
const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES > 0 ? IDLE_TIMEOUT_MINUTES * 60_000 : 0;
const SESSION_READY_TIMEOUT_MS = Number(process.env.TINYMIST_PREVIEW_READY_TIMEOUT ?? 30_000);
const PING_INTERVAL_MS = Number(process.env.TINYMIST_BRIDGE_PING_INTERVAL ?? 20_000);

const PARTIAL_RENDERING = process.env.TINYMIST_PARTIAL_RENDERING !== "false";
const CLEANUP_COMMAND_TIMEOUT_MS = Number(process.env.TINYMIST_PREVIEW_CLEANUP_TIMEOUT ?? 8_000);
const MAX_PREVIEW_SERVERS_ENV = Number(process.env.TINYMIST_MAX_PREVIEW_SERVERS ?? 20);
const MAX_PREVIEW_SERVERS = Number.isFinite(MAX_PREVIEW_SERVERS_ENV) && MAX_PREVIEW_SERVERS_ENV > 0
    ? Math.floor(MAX_PREVIEW_SERVERS_ENV)
    : 20;

const STORAGE_ROOT = resolve(PROJECT_ROOT, "storage", "app", "tinymist");
const LOG_DIRECTORY = resolve(PROJECT_ROOT, "storage", "logs");

const FILEPATH_PLACEHOLDER = "__TINYMIST_FILE__";

function buildHttpOrigin(host: string, port?: number): string {
    const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const portSegment = typeof port === "number" && Number.isFinite(port) ? `:${port}` : "";
    return `http://${normalizedHost}${portSegment}`;
}

const managerOptions: PreviewClientOptions = {
    tinymistExecutable: TINYMIST_CLI_PATH,
    packagePath: TYPST_PACKAGE_PATH,
    projectRoot: PROJECT_ROOT,
    storageRoot: STORAGE_ROOT,
    logDir: LOG_DIRECTORY,
    host: PREVIEW_HOST,
    websocketOrigin: process.env.TINYMIST_PREVIEW_ORIGIN ?? buildHttpOrigin(BRIDGE_HOST, BRIDGE_PORT),
    controlBasePort: CONTROL_BASE_PORT,
    portScanAttempts: 200,
    partialRendering: PARTIAL_RENDERING,
    retryAttempts: 40,
    retryDelayMs: 250,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
};

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

function execCommand(command: string, timeoutMs?: number): Promise<string> {
    return new Promise((resolveExec, rejectExec) => {
        exec(command, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
            if (error) {
                rejectExec(error);
                return;
            }
            if (stderr && stderr.trim().length > 0) {
                resolveExec(stdout);
                return;
            }
            resolveExec(stdout);
        });
    });
}

async function cleanupOrphanedPreviewProcesses(): Promise<void> {
    try {
        const selfPid = process.pid;
        const tinymistPath = TINYMIST_CLI_PATH.replace(/\\/g, "/").toLowerCase();

        // Windows part
        if (process.platform === "win32") {
            const output = await execCommand("wmic process where \"name='tinymist.exe'\" get ProcessId,CommandLine /FORMAT:CSV", CLEANUP_COMMAND_TIMEOUT_MS);
            if (!output.trim()) {
                return;
            }
            const lines = output
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .filter((line) => !line.startsWith("Node,"));

            for (const line of lines) {
                const lastCommaIndex = line.lastIndexOf(",");
                if (lastCommaIndex <= 0 || lastCommaIndex >= line.length - 1) {
                    continue;
                }
                const cmd = line.slice(line.indexOf(",") + 1, lastCommaIndex).trim();
                if (!cmd) {
                    continue;
                }
                if (!cmd.toLowerCase().includes("preview")) {
                    continue;
                }
                const pid = Number(line.slice(lastCommaIndex + 1).trim());
                if (Number.isFinite(pid) && pid > 0 && pid !== selfPid) {
                    try {
                        await execCommand(`taskkill /F /PID ${pid}`, CLEANUP_COMMAND_TIMEOUT_MS);
                        console.log(`[Preview Bridge] Cleaned orphan tinymist preview process ${pid}`);
                    } catch (error) {
                        console.warn(`[Preview Bridge] Failed to kill tinymist preview process ${pid}`, error);
                    }
                }
            }
            return;
        }

        // Unix-like part (windows finished/returned above)
        const output = await execCommand("ps -Ao pid=,args=", CLEANUP_COMMAND_TIMEOUT_MS);
        const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
            if (!line.includes("tinymist") || !line.includes("preview")) {
                continue;
            }
            const spaceIndex = line.indexOf(" ");
            if (spaceIndex === -1) {
                continue;
            }
            const pid = Number(line.slice(0, spaceIndex).trim());
            if (!Number.isFinite(pid) || pid <= 0 || pid === selfPid) {
                continue;
            }
            const cmd = line.slice(spaceIndex + 1).trim();
            if (isAbsolute(TINYMIST_CLI_PATH) && !cmd.replace(/\\/g, "/").toLowerCase().includes(tinymistPath)) {
                continue;
            }
            try {
                await execCommand(`kill -9 ${pid}`, CLEANUP_COMMAND_TIMEOUT_MS);
                console.log(`[Preview Bridge] Cleaned orphan tinymist preview process ${pid}`);
            } catch (error) {
                console.warn(`[Preview Bridge] Failed to kill tinymist preview process ${pid}`, error);
            }
        }
    } catch (error) {
        console.warn("[Preview Bridge] Failed to cleanup orphaned preview processes", error);
    }
}

class PreviewCapacityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PreviewCapacityError";
    }
}

class PreviewSession {
    private readonly client: TinymistPreviewClient;
    private readonly browsers: Set<BridgeSocket> = new Set();
    private readonly readyPromise: Promise<void>;
    private idleTimer: NodeJS.Timeout | null = null;
    private destroyed = false;


    private describePayload(data: RawData, isBinary?: boolean): string {
        const buffer = rawDataToBuffer(data);
        const length = buffer.length;

        if (isBinary || Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
            const commaIndex = buffer.indexOf(44);
            const command = buffer.toString("utf8");
            if (commaIndex !== -1) {
                const payloadLength = Math.max(0, length - (commaIndex + 1));
                return `binary command=${command} raw=${length} payload=${payloadLength}`;
            }
            return `binary command=${command} raw=${length}`;
        }

        const text = typeof data === "string" ? data : rawDataToString(data);
        return `text length=${text.length} value=${text}`;
    }

    private logMessage(direction: "incoming" | "outgoing", data: RawData, isBinary?: boolean): void {
        // const info = this.describePayload(data, isBinary);
        // console.log(`[Preview Session ${this.pageId}] ${direction}: ${info}`);
    }

    constructor(
        private readonly pageId: number,
        private readonly options: PreviewClientOptions,
        private readonly remove: (pageId: number) => void
    ) {
        const filePath = resolve(join(options.storageRoot, `page_${pageId}`, "entry.typ"));
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
            const payload = JSON.stringify({ status: "connected" });
            socket.send(payload);
        }
    }

    getPorts(): { controlPort: number; dataPort: number } | null {
        return this.client.getInfo().ports;
    }

    removeBrowser(socket: BridgeSocket): void {
        this.browsers.delete(socket);
        if (!this.destroyed && this.browsers.size === 0) {
            this.scheduleIdleStop();
        }
    }

    handleBrowserMessage(socket: BridgeSocket, data: RawData, isBinary: boolean): void {

        this.logMessage("incoming", data, isBinary);

        const buffer = rawDataToBuffer(data);
        if (buffer.length === 0) {
            return;
        }
        const text = buffer.toString();

        // Stringified control channel message
        if (!isBinary && text.trim().startsWith("{")) {
            if (!this.client.isControlReady()) {
                return;
            }
            const encodedPath = JSON.stringify(this.client.filePath).slice(1, -1);
            const updatedText = text.includes(FILEPATH_PLACEHOLDER)
                ? text.split(FILEPATH_PLACEHOLDER).join(encodedPath)
                : text;
            this.client.sendControl(updatedText);

            if (text.includes("changeCursorPosition") && socket.uniqueTabId) {
                this.broadcastStatus("cursor-requested", { uniqueTabId: socket.uniqueTabId });
            }
            return;
        }

        // That is most likely "current" for data plane
        if (!this.client.isDataReady()) {
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
            if (text === "current") {
                this.broadcastStatus("current-requested", {});
            }
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
        // this.logMessage("outgoing", payload);
        for (const browser of this.browsers) {
            if (browser.readyState === WebSocket.OPEN) {
                browser.send(payload);
            }
        }
    }

    private broadcastStatus(status: string, details: any): void {
        console.log(`[Preview Session ${this.pageId}] ${status}`, details ?? "");
        const payload = JSON.stringify({ status, details });
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

    constructor(
        private readonly options: PreviewClientOptions,
        private readonly maxPreviewServers: number,
    ) {}

    async getSession(pageId: number): Promise<PreviewSession> {
        const existing = this.sessions.get(pageId);
        if (existing) {
            return existing;
        }

        const pending = this.pending.get(pageId);
        if (pending) {
            return pending;
        }

        if (this.getTotalSessionCount() >= this.maxPreviewServers) {
            throw new PreviewCapacityError(`Maximum preview servers limit reached (${this.maxPreviewServers})`);
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

    async stopAll(): Promise<void> {
        const sessions = Array.from(this.sessions.values());
        for (const session of sessions) {
            await session.stop().catch((error) => {
                console.error("[Preview Bridge] Failed to stop session", error);
            });
        }
        this.sessions.clear();
    }

    async restartSession(pageId: number): Promise<PreviewSession> {
        const existing = this.sessions.get(pageId);
        let nextControlBase = this.options.controlBasePort;

        if (!existing && this.getTotalSessionCount() >= this.maxPreviewServers) {
            throw new PreviewCapacityError(`Maximum preview servers limit reached (${this.maxPreviewServers})`);
        }

        if (existing) {
            const ports = existing.getPorts();
            if (ports?.controlPort) {
                nextControlBase = ports.controlPort + 2;
            }
            await existing.stop();
        }

        const session = new PreviewSession(
            pageId,
            { ...this.options, controlBasePort: nextControlBase },
            (id) => this.removeSession(id)
        );
        await session.ready(SESSION_READY_TIMEOUT_MS);
        this.sessions.set(pageId, session);
        return session;
    }

    private async createSession(pageId: number): Promise<PreviewSession> {
        const session = new PreviewSession(pageId, this.options, (id) => this.removeSession(id));
        await session.ready(SESSION_READY_TIMEOUT_MS);
        return session;
    }

    private getTotalSessionCount(): number {
        return this.sessions.size + this.pending.size;
    }
}

async function bootstrap() {

    await cleanupOrphanedPreviewProcesses();

    const sessionManager = new PreviewSessionManager(managerOptions, MAX_PREVIEW_SERVERS);

    const server = createServer();
    const wss = new WebSocketServer({ server });

    server.on("error", (error) => {
        console.error("[Preview Bridge] HTTP server error", error);
    });

    wss.on("connection", async (socket: WebSocket, request) => {
        const client = socket as BridgeSocket;
        client.isAlive = true;

        client.on("pong", () => {
            client.isAlive = true;
        });

        try {

            let tokenPayload: AuthToken | null = null;
            let tokenError: Error | null = null;
            try {
                tokenPayload = verifyRequestToken(request);
            } catch (error) {
                tokenPayload = null;
                tokenError = error instanceof Error ? error : new Error(String(error));
            }

            const pageId = tokenPayload?.page_id;
            console.log(`[Preview Bridge] token payload`, tokenPayload);

            if (tokenError) {
                socket.close(1008, "INVALID_TOKEN");
                return;
            }

            if (!pageId || !Number.isFinite(pageId)) {
                socket.close(1008, `Missing pageId in token ${pageId}`);
                return;
            }

            client.pageId = pageId;
            client.uniqueTabId = tokenPayload?.uniqueTabId;
            client.authToken = tokenPayload ?? undefined;

            let session: PreviewSession;
            try {
                session = await sessionManager.getSession(pageId);
            } catch (error) {
                if (error instanceof PreviewCapacityError) {
                    console.warn(`[Preview Bridge] Rejecting page ${pageId}: ${error.message}`);
                    socket.close(1013, "MAX_PREVIEW_SERVERS_REACHED");
                    return;
                }
                throw error;
            }
            session.addBrowser(client);

            socket.on("message", async (data, isBinary) => {
                try {
                    if (!isBinary) {
                        const text = rawDataToString(data);
                        if (text.trim().startsWith("{")) {
                            const payload = JSON.parse(text) as IncomingMessagePayload;
                            if (payload.type === "ping") {
                                socket.send(JSON.stringify({ type: "pong" }));
                                return;
                            }
                            if (payload.type === "updateToken") {
                                const refreshed = verifyNewToken(payload.token, pageId);
                                client.authToken = refreshed;
                                socket.send(JSON.stringify({
                                    type: "ack",
                                    pageId: pageId,
                                    fileName: "authTokenAck",
                                    docVersion: 1,
                                }));
                                return;
                            }
                        }
                    }

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

    const shutdown = async (reason: string) => {
        console.log(`\n[Preview Bridge] Shutting down (${reason})...`);
        heartbeat && clearInterval(heartbeat);
        for (const socket of wss.clients) {
            socket.terminate();
        }
        await sessionManager.stopAll();
        server.close();
    };

    process.on("SIGINT", async () => {
        await shutdown("SIGINT");
        process.exit(0);
    });

    process.on("SIGTERM", async () => {
        await shutdown("SIGTERM");
        process.exit(0);
    });

    process.on("uncaughtException", async (error) => {
        console.error("[Preview Bridge] Uncaught exception", error);
        await shutdown("uncaughtException");
        process.exit(1);
    });

    process.on("unhandledRejection", async (reason) => {
        console.error("[Preview Bridge] Unhandled rejection", reason);
        await shutdown("unhandledRejection");
        process.exit(1);
    });
}

bootstrap().catch((error) => {
    console.error("Failed to start preview bridge:", error);
    process.exit(1);
});

