import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { createWriteStream, existsSync, mkdirSync, WriteStream } from "fs";
import { Socket } from "net";
import { join, relative, resolve } from "path";
import { setTimeout as delay } from "timers/promises";
import WebSocket, { RawData } from "ws";

export type PreviewClientOptions = {
    tinymistExecutable: string;
    projectRoot: string;
    storageRoot: string;
    logDir?: string;
    host?: string;
    controlBasePort: number;
    portScanAttempts?: number;
    partialRendering?: boolean;
    retryAttempts?: number;
    retryDelayMs?: number;
    idleTimeoutMs?: number;
    autoCurrentRequest?: boolean;
    autoCursorUpdates?: boolean;
};

export type PortPair = {
    controlPort: number;
    dataPort: number;
};

export type PreviewClientEvents = {
    "control-message": (payload: string) => void;
    "control-error": (error: Error) => void;
    "data-message": (payload: RawData) => void;
    "data-error": (error: Error) => void;
    "status": (status: string, details?: Record<string, unknown>) => void;
    "exit": (code: number | null, signal: NodeJS.Signals | null) => void;
};

type EventKeys = keyof PreviewClientEvents;
type Listener<K extends EventKeys> = PreviewClientEvents[K];

function ensureDir(path: string): void {
    if (!existsSync(path)) {
        mkdirSync(path, { recursive: true });
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

const usedPorts = new Set<number>();

function reservePortPair(pair: PortPair): void {
    usedPorts.add(pair.controlPort);
    usedPorts.add(pair.dataPort);
}

function releasePortPair(pair: PortPair | null | undefined): void {
    if (!pair) {
        return;
    }
    usedPorts.delete(pair.controlPort);
    usedPorts.delete(pair.dataPort);
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
    return new Promise<boolean>((resolvePort) => {
        const server = new Socket();

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

export class TinymistPreviewClient extends EventEmitter {
    readonly pageId: number;
    readonly filePath: string;

    private readonly options: Required<PreviewClientOptions>;
    private process: ChildProcess | null = null;
    private logStream: WriteStream | null = null;
    private controlSocket: WebSocket | null = null;
    private dataSocket: WebSocket | null = null;
    private ports: PortPair | null = null;
    private controlUrl: string | null = null;
    private dataUrl: string | null = null;
    private stopping = false;

    constructor(pageId: number, filePath: string, options: PreviewClientOptions) {
        super();
        this.pageId = pageId;
        this.filePath = resolve(filePath);
        this.options = {
            projectRoot: options.projectRoot ?? process.cwd(),
            storageRoot: options.storageRoot ?? resolve(process.cwd(), "storage", "app", "tinymist"),
            logDir: options.logDir ?? resolve(process.cwd(), "storage", "logs"),
            host: options.host ?? "127.0.0.1",
            controlBasePort: options.controlBasePort,
            portScanAttempts: options.portScanAttempts ?? 100,
            tinymistExecutable: options.tinymistExecutable,
            partialRendering: options.partialRendering ?? true,
            retryAttempts: options.retryAttempts ?? 25,
            retryDelayMs: options.retryDelayMs ?? 250,
            autoCurrentRequest: options.autoCurrentRequest ?? true,
            autoCursorUpdates: options.autoCursorUpdates ?? true,
            idleTimeoutMs: options.idleTimeoutMs ?? 300000,
        };
    }

    override on<K extends EventKeys>(event: K, listener: Listener<K>): this {
        return super.on(event, listener as (...args: unknown[]) => void);
    }

    override once<K extends EventKeys>(event: K, listener: Listener<K>): this {
        return super.once(event, listener as (...args: unknown[]) => void);
    }

    override off<K extends EventKeys>(event: K, listener: Listener<K>): this {
        return super.off(event, listener as (...args: unknown[]) => void);
    }

    async start(): Promise<PortPair> {
        if (this.process) {
            return this.ensureSockets();
        }

        this.emit("status", "starting", { pageId: this.pageId });

        // Validate typst file exists
        if (!existsSync(this.filePath)) {
            throw new Error(`Typst source file not found: ${this.filePath}`);
        }

        const ports = await this.findAvailablePortPair();
        this.ports = ports;

        try {
            await this.spawnTinymistProcess(ports);
            await this.ensureSockets();
        } catch (error) {
            this.cleanupProcess();
            throw error;
        }

        this.emit("status", "ready", { pageId: this.pageId, ports });
        return ports;
    }

    private async ensureSockets(): Promise<PortPair> {
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

    private async connectSocket(
        kind: "control" | "data",
        url: string,
        maxAttempts: number,
        delayMs: number
    ): Promise<void> {
        const existing = kind === "control" ? this.controlSocket : this.dataSocket;
        if (existing && existing.readyState === WebSocket.OPEN) {
            return;
        }

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const socket = new WebSocket(url);
                if( kind === "data") {
                    socket.binaryType = "arraybuffer";
                }

                await new Promise<void>((resolveSocket, rejectSocket) => {
                    socket.once("error", rejectSocket);
                    socket.once("open", () => resolveSocket());
                });

                if (kind === "control") {
                    socket.on("message", (data) => {
                        this.emit("control-message", data);
                    });
                } else {
                    if (this.options.autoCurrentRequest) {
                        socket.on("open", () => {
                            socket.send('current');
                        });
                    }
                    socket.on("message", (data) => {
                        this.emit("data-message", data);
                        if (this.options.autoCursorUpdates && data instanceof Uint8Array && this.isNewOrDiff(data)) {
                            // Check if it's 'diff-v1' or 'new' and request cursor update
                            //
                            // We can keep track of cursors positions as they change in the editor
                            // For all tabs and users connected to this preview
                            // Position can change without editing, but editing likely to change position
                            // So, editing cursor updates position only and after successful data message
                            // we can request cursor path for each cursor
                            // Cursor without editing flag requests paths immediately and only for itself
                            // Currently there's no way to know which cursor got it's path from preview
                            // Only the order of queued requests (might fail)
                            // and reasonable time expectations might help here
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
                    this.emit("status", `${kind}-closed`, {
                        code,
                        reason: reason.toString(),
                    });
                });

                if (kind === "control") {
                    this.controlSocket = socket;
                } else {
                    this.dataSocket = socket;
                }

                this.emit("status", `${kind}-open`, { attempt });
                return;
            } catch (error) {
                this.emit("status", `${kind}-retry`, {
                    attempt,
                    maxAttempts,
                    error: error instanceof Error ? error.message : String(error),
                });
                await delay(delayMs);
            }
        }

        throw new Error(`Failed to connect ${kind} socket at ${url} after ${maxAttempts} attempts`);
    }

    private async spawnTinymistProcess(ports: PortPair): Promise<void> {
        const {
            host,
            tinymistExecutable,
            projectRoot,
            partialRendering,
            logDir,
        } = this.options;

        ensureDir(logDir);
        const logFilePath = join(logDir, `tinymist_preview_${this.pageId}.log`);
        this.logStream = createWriteStream(logFilePath, { flags: "a" });

        const controlHost = `${host}:${ports.controlPort}`;
        const dataHost = `${host}:${ports.dataPort}`;
        const relativeFilePath = relative(projectRoot, this.filePath);

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

        const child = spawn(tinymistExecutable, args, {
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

    async findAvailablePortPair(): Promise<PortPair> {
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
                const pair: PortPair = { controlPort, dataPort };
                reservePortPair(pair);
                return pair;
            }
        }

        throw new Error(
            `Unable to find available port pair after ${portScanAttempts} attempts (starting at ${controlBasePort}; data port is control+1)`
        );
    }

    sendControl(message: string | Buffer): void {
        if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
            throw new Error("Control socket is not ready");
        }
        this.controlSocket.send(message);
    }

    isControlReady(): boolean {
        return !!this.controlSocket && this.controlSocket.readyState === WebSocket.OPEN;
    }

    sendData(message: string | Buffer): void {
        if (!this.dataSocket || this.dataSocket.readyState !== WebSocket.OPEN) {
            throw new Error("Data socket is not ready");
        }
        this.dataSocket.send(message);
    }

    isDataReady(): boolean {
        return !!this.dataSocket && this.dataSocket.readyState === WebSocket.OPEN;
    }

    // Automating cursor requests on successful data messages
    private isNewOrDiff(msg: Uint8Array) {

        // Parse message format: "type,payload"
        const commaIndex = msg.indexOf(44); // ASCII for ','
        if (commaIndex === -1) {
            return false;
        }

        const command = new TextDecoder().decode(msg.slice(0, commaIndex));
        return command === 'new' || command === 'diff-v1';
    }

    async stop(): Promise<void> {
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

    private cleanupProcess(): void {
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

    getInfo(): {
        pageId: number;
        ports: PortPair | null;
        pid: number | undefined;
        controlUrl: string | null;
        dataUrl: string | null;
    } {
        return {
            pageId: this.pageId,
            ports: this.ports,
            pid: this.process?.pid,
            controlUrl: this.controlUrl,
            dataUrl: this.dataUrl,
        };
    }
}
