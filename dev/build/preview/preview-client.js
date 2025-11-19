"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TinymistPreviewClient = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const fs_1 = require("fs");
const net_1 = require("net");
const path_1 = require("path");
const promises_1 = require("timers/promises");
const ws_1 = __importDefault(require("ws"));
function ensureDir(path) {
    if (!(0, fs_1.existsSync)(path)) {
        (0, fs_1.mkdirSync)(path, { recursive: true });
    }
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
const usedPorts = new Set();
function reservePortPair(pair) {
    usedPorts.add(pair.controlPort);
    usedPorts.add(pair.dataPort);
}
function releasePortPair(pair) {
    if (!pair) {
        return;
    }
    usedPorts.delete(pair.controlPort);
    usedPorts.delete(pair.dataPort);
}
async function isPortAvailable(host, port) {
    return new Promise((resolvePort) => {
        const server = new net_1.Socket();
        const cleanup = () => {
            server.removeAllListeners();
            server.destroy();
        };
        server.setTimeout(200, () => {
            cleanup();
            resolvePort(true);
        });
        server.once("error", () => {
            cleanup();
            resolvePort(true);
        });
        server.once("connect", () => {
            cleanup();
            resolvePort(false);
        });
        server.connect(port, host);
    });
}
class TinymistPreviewClient extends events_1.EventEmitter {
    pageId;
    filePath;
    options;
    process = null;
    logStream = null;
    controlSocket = null;
    dataSocket = null;
    ports = null;
    controlUrl = null;
    dataUrl = null;
    stopping = false;
    constructor(pageId, filePath, options) {
        super();
        this.pageId = pageId;
        this.filePath = (0, path_1.resolve)(filePath);
        this.options = {
            projectRoot: options.projectRoot ?? process.cwd(),
            storageRoot: options.storageRoot ?? (0, path_1.resolve)(process.cwd(), "storage", "app", "tinymist"),
            logDir: options.logDir ?? (0, path_1.resolve)(process.cwd(), "storage", "logs"),
            host: options.host ?? "127.0.0.1",
            controlBasePort: options.controlBasePort,
            portScanAttempts: options.portScanAttempts ?? 100,
            tinymistExecutable: options.tinymistExecutable,
            partialRendering: options.partialRendering ?? true,
            retryAttempts: options.retryAttempts ?? 25,
            retryDelayMs: options.retryDelayMs ?? 250,
            autoCurrentRequest: options.autoCurrentRequest ?? true,
            autoCursorUpdates: options.autoCursorUpdates ?? true,
        };
    }
    on(event, listener) {
        return super.on(event, listener);
    }
    once(event, listener) {
        return super.once(event, listener);
    }
    off(event, listener) {
        return super.off(event, listener);
    }
    async start() {
        if (this.process) {
            return this.ensureSockets();
        }
        this.emit("status", "starting", { pageId: this.pageId });
        // Validate typst file exists
        if (!(0, fs_1.existsSync)(this.filePath)) {
            throw new Error(`Typst source file not found: ${this.filePath}`);
        }
        const ports = await this.findAvailablePortPair();
        this.ports = ports;
        try {
            await this.spawnTinymistProcess(ports);
            await this.ensureSockets();
        }
        catch (error) {
            this.cleanupProcess();
            throw error;
        }
        this.emit("status", "ready", { pageId: this.pageId, ports });
        return ports;
    }
    async ensureSockets() {
        if (!this.ports) {
            throw new Error("Preview sockets not initialized");
        }
        const { host, retryAttempts, retryDelayMs } = this.options;
        this.controlUrl = `ws://${host}:${this.ports.controlPort}`;
        this.dataUrl = `ws://${host}:${this.ports.dataPort}`;
        await Promise.all([
            this.connectSocket("control", this.controlUrl, retryAttempts, retryDelayMs),
            this.connectSocket("data", this.dataUrl, retryAttempts, retryDelayMs),
        ]);
        return this.ports;
    }
    async connectSocket(kind, url, maxAttempts, delayMs) {
        const existing = kind === "control" ? this.controlSocket : this.dataSocket;
        if (existing && existing.readyState === ws_1.default.OPEN) {
            return;
        }
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const socket = new ws_1.default(url);
                if (kind === "data") {
                    socket.binaryType = "arraybuffer";
                }
                await new Promise((resolveSocket, rejectSocket) => {
                    socket.once("error", rejectSocket);
                    socket.once("open", () => resolveSocket());
                });
                if (kind === "control") {
                    socket.on("message", (data) => {
                        this.emit("control-message", data);
                    });
                }
                else {
                    if (this.options.autoCurrentRequest) {
                        socket.on("open", () => {
                            socket.send('current');
                        });
                    }
                    socket.on("message", (data) => {
                        this.emit("data-message", data);
                        if (this.options.autoCursorUpdates && data instanceof Uint8Array && this.isNewOrDiff(data)) {
                            // Check if it's 'diff-v1' or 'new' and request cursor update
                            // Problematic empty values for now
                            const msg = {
                                event: "changeCursorPosition",
                                filepath: '',
                                line: 0,
                                character: 0,
                            };
                            socket.send(JSON.stringify(msg));
                        }
                    });
                }
                socket.on("error", (error) => {
                    this.emit(`${kind}-error`, error);
                });
                socket.on("close", (code, reason) => {
                    this.emit("status", `${kind}-socket-closed`, {
                        code,
                        reason: reason.toString(),
                    });
                });
                if (kind === "control") {
                    this.controlSocket = socket;
                }
                else {
                    this.dataSocket = socket;
                }
                this.emit("status", `${kind}-socket-open`, { attempt });
                return;
            }
            catch (error) {
                this.emit("status", `${kind}-socket-retry`, {
                    attempt,
                    maxAttempts,
                    error: error instanceof Error ? error.message : String(error),
                });
                await (0, promises_1.setTimeout)(delayMs);
            }
        }
        throw new Error(`Failed to connect ${kind} socket at ${url} after ${maxAttempts} attempts`);
    }
    async spawnTinymistProcess(ports) {
        const { host, tinymistExecutable, projectRoot, partialRendering, logDir, } = this.options;
        ensureDir(logDir);
        const logFilePath = (0, path_1.join)(logDir, `tinymist_preview_${this.pageId}.log`);
        this.logStream = (0, fs_1.createWriteStream)(logFilePath, { flags: "a" });
        const controlHost = `${host}:${ports.controlPort}`;
        const dataHost = `${host}:${ports.dataPort}`;
        const relativeFilePath = (0, path_1.relative)(projectRoot, this.filePath);
        const args = [
            "preview",
            "--no-open",
            "--control-plane-host",
            controlHost,
            "--data-plane-host",
            dataHost,
        ];
        if (partialRendering) {
            args.push("--partial-rendering", "true");
        }
        args.push(relativeFilePath);
        const child = (0, child_process_1.spawn)(tinymistExecutable, args, {
            cwd: projectRoot,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (!child.stdout || !child.stderr) {
            throw new Error("Failed to capture tinymist process output streams");
        }
        this.process = child;
        child.stdout.pipe(this.logStream, { end: false });
        child.stderr.pipe(this.logStream, { end: false });
        child.once("exit", (code, signal) => {
            this.emit("exit", code, signal);
            this.cleanupProcess();
        });
        this.emit("status", "process-spawned", {
            pid: child.pid,
            args,
        });
    }
    async findAvailablePortPair() {
        const { host, controlBasePort, portScanAttempts } = this.options;
        let controlCandidate = controlBasePort;
        if (controlCandidate % 2 !== 0) {
            controlCandidate -= 1;
        }
        for (let i = 0; i < portScanAttempts; i++) {
            // They don't have to be consecutive
            // But it helps to know that found ports are not the same one
            const controlPort = controlCandidate + i * 2;
            const dataPort = controlPort + 1;
            if (usedPorts.has(controlPort) || usedPorts.has(dataPort)) {
                continue;
            }
            const controlFree = await isPortAvailable(host, controlPort);
            const dataFree = await isPortAvailable(host, dataPort);
            if (controlFree && dataFree) {
                const pair = { controlPort, dataPort };
                reservePortPair(pair);
                return pair;
            }
        }
        throw new Error(`Unable to find available port pair after ${portScanAttempts} attempts (starting at ${controlBasePort}; data port is control+1)`);
    }
    sendControl(message) {
        if (!this.controlSocket || this.controlSocket.readyState !== ws_1.default.OPEN) {
            throw new Error("Control socket is not ready");
        }
        this.controlSocket.send(message);
    }
    sendData(message) {
        if (!this.dataSocket || this.dataSocket.readyState !== ws_1.default.OPEN) {
            throw new Error("Data socket is not ready");
        }
        this.dataSocket.send(message);
    }
    // Automating cursor requests on successful data messages
    isNewOrDiff(msg) {
        // Parse message format: "type,payload"
        const commaIndex = msg.indexOf(44); // ASCII for ','
        if (commaIndex === -1) {
            return false;
        }
        const command = new TextDecoder().decode(msg.slice(0, commaIndex));
        return command === 'new' || command === 'diff-v1';
    }
    async stop() {
        if (this.stopping) {
            return;
        }
        this.stopping = true;
        if (this.controlSocket) {
            this.controlSocket.terminate();
            this.controlSocket = null;
        }
        if (this.dataSocket) {
            this.dataSocket.terminate();
            this.dataSocket = null;
        }
        if (this.process) {
            this.process.removeAllListeners("exit");
            const pid = this.process.pid;
            this.process.kill();
            this.emit("status", "process-stopped", { pid });
        }
        this.cleanupProcess();
    }
    cleanupProcess() {
        if (this.controlSocket) {
            this.controlSocket.terminate();
            this.controlSocket = null;
        }
        if (this.dataSocket) {
            this.dataSocket.terminate();
            this.dataSocket = null;
        }
        if (this.process) {
            if (!this.process.killed) {
                this.process.kill();
            }
            this.process = null;
        }
        if (this.logStream) {
            this.logStream.end();
            this.logStream = null;
        }
        if (this.ports) {
            releasePortPair(this.ports);
            this.ports = null;
        }
    }
    getInfo() {
        return {
            pageId: this.pageId,
            ports: this.ports,
            pid: this.process?.pid,
            controlUrl: this.controlUrl,
            dataUrl: this.dataUrl,
        };
    }
}
exports.TinymistPreviewClient = TinymistPreviewClient;
