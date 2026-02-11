import { spawn, ChildProcess } from "child_process";
import { platform } from "os";
import { join, resolve, isAbsolute } from "path";
import { existsSync, createWriteStream, WriteStream } from "fs";

interface LSPMessage {
    jsonrpc: "2.0";
    id?: number | string;
    method?: string;
    params?: any;
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
}

interface LSPClientOptions {
    command: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    onNotification?: (method: string, params: any) => void;
    onError?: (error: Error) => void;
    onRestart?: () => void;
    logStderr?: boolean; // Whether to log stderr output (default: false)
    stderrLogFile?: string; // Path to redirect stderr to (optional)
}

export class LSPClient {
    private process: ChildProcess | null = null;
    private buffer: string = "";
    private contentLength: number = 0;
    private nextId: number = 1;
    private pendingRequests: Map<number, {
        resolve: (value: any) => void;
        reject: (error: any) => void;
    }> = new Map();
    private options: LSPClientOptions;
    private isShuttingDown: boolean = false;
    private restartAttempts: number = 0;
    private maxRestartAttempts: number = 3;
    private stderrStream: WriteStream | null = null;
    private restartDelay: number = 1000;

    public tokenTypes = [
        "comment", "string", "keyword", "operator", "number",
        "function", "decorator", "type", "namespace", "bool",
        "punct", "escape", "link", "raw", "label", "ref",
        "heading", "marker", "term", "delim", "pol", "error", "text"
    ];
    public tokenModifiers = [
        "strong", "emph", "math", "readonly", "static", "defaultLibrary"
    ];

    constructor(options: LSPClientOptions) {
        this.options = {
            ...options,
            env: {
                ...process.env,
                ...options.env,
            } as Record<string, string>,
        };
    }

    /**
     * Start the LSP server process
     */
    async start(): Promise<void> {
        if (this.process) {
            console.warn("[LSP Client] Process already running");
            return;
        }

        this.options.command = getTinymistCommand();

        console.log("[LSP Client] Starting LSP server:", {
            command: this.options.command,
            args: this.options.args,
            cwd: this.options.cwd,
            platform: platform(),
        });

        try {
            this.process = spawn(this.options.command, this.options.args, {
                cwd: this.options.cwd,
                env: this.options.env,
                stdio: ["pipe", "pipe", this.options.stderrLogFile ? "pipe" : "inherit"],
                shell: false, // Don't use shell - we provide absolute paths
            });

            // Redirect stderr to log file if specified
            if (this.options.stderrLogFile && this.process.stderr) {
                this.stderrStream = createWriteStream(this.options.stderrLogFile, { flags: "a" });
                this.process.stderr.pipe(this.stderrStream);
            }

            this.setupStreams();
            this.setupErrorHandlers();

            // Wait for process to be ready
            await this.waitForReady();

            this.restartAttempts = 0;
            console.log("[LSP Client] LSP server started successfully");
        } catch (error) {
            console.error("[LSP Client] Failed to start LSP server:", error);
            throw error;
        }
    }


    async initializeLSP() {
        if (!this.process) {
            return;
        }
        // Send initialize request
        const initResult = await this.sendRequest("initialize", {
            processId: this.process.pid,
            clientInfo: {
                name: "BookStack-Tinymist",
                version: "1.0.0",
            },
            rootUri: `file:///${this.options.cwd}`,
            capabilities: {
                textDocumentSync: {
                    openClose: true,
                    change: 2,
                    save: true
                },
                textDocument: {
                    synchronization: {
                        dynamicRegistration: false,
                        willSave: false,
                        willSaveWaitUntil: false,
                        didSave: true,
                    },
                    hover: {
                        dynamicRegistration: false,
                        contentFormat: ["markdown", "plaintext"],
                    },
                    completion: {
                        dynamicRegistration: false,
                        completionItem: {
                            snippetSupport: true
                        },
                    },
                    semanticTokens: {
                        dynamicRegistration: false,
                        requests: {
                            full: {delta: true},
                            range: true,
                        },
                        formats: ["relative"],
                        tokenTypes: this.tokenTypes,
                        tokenModifiers: this.tokenModifiers,
                    },
                    publishDiagnostics: {
                        relatedInformation: true,
                        tagSupport: { valueSet: [1, 2] },
                    },
                },
            },
        });

        console.log("LSP initialized:", initResult);

        // Send initialized notification, for some reason it's required
        this.sendNotification("initialized", {});

        return initResult;
    }

    /**
     * Send a request to the LSP server (expects a response)
     */
    sendRequest(method: string, params?: any): Promise<any> {
        if (!this.process || !this.process.stdin) {
            return Promise.reject(new Error("LSP process not running"));
        }

        const id = this.nextId++;
        const message: LSPMessage = {
            jsonrpc: "2.0",
            id,
            method,
        };

        if (params !== undefined) { // null needed for shutdown
            message.params = params;
        }

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });

            const content = JSON.stringify(message);
            const header = `Content-Length: ${Buffer.byteLength(content, "utf8")}\r\n\r\n`;

            try {
                this.process!.stdin!.write(header + content, "utf8");
            } catch (error) {
                this.pendingRequests.delete(id);
                reject(error);
            }

            // Timeout this request after 30 seconds
            setTimeout(() => {
                const pending = this.pendingRequests.get(id);
                if (pending) {
                    this.pendingRequests.delete(id);
                    pending.reject(new Error(`Request timeout: ${method}`));
                }
            }, 30000);
        });
    }

    /**
     * Send a notification to the LSP server (no response expected)
     */
    sendNotification(method: string, params: any): void {
        if (!this.process || !this.process.stdin) {
            console.warn("[LSP Client] Cannot send notification, process not running");
            return;
        }

        const message: LSPMessage = {
            jsonrpc: "2.0",
            method,
            params,
        };

        const content = JSON.stringify(message);
        const header = `Content-Length: ${Buffer.byteLength(content, "utf8")}\r\n\r\n`;

        try {
            this.process.stdin.write(header + content, "utf8");
        } catch (error) {
            console.error("[LSP Client] Failed to send notification:", error);
        }
    }

    /**
     * Check if the LSP server is running
     */
    isRunning(): boolean {
        return this.process !== null && !this.process.killed;
    }

    /**
     * Setup streams for LSP communication
     */
    private setupStreams(): void {
        if (!this.process || !this.process.stdout) {
            throw new Error("Process or stdout not available");
        }

        this.process.stdout.on("data", (data: Buffer) => {
            this.buffer += data.toString("utf8");
            this.processBuffer();
        });

        // Only listen to stderr if we're not redirecting to a file
        if (!this.options.stderrLogFile && this.process.stderr) {
            this.process.stderr.on("data", (data: Buffer) => {
                const message = data.toString("utf8").trim();
                if (message && this.options.logStderr !== false) {
                    console.error("[LSP Client] stderr:", message);
                }
            });
        }
    }

    /**
     * Process the buffer for complete LSP messages
     */
    private processBuffer(): void {
        while (true) {
            // Parse Content-Length header
            if (this.contentLength === 0) {
                const headerMatch = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
                if (!headerMatch) break;

                this.contentLength = parseInt(headerMatch[1], 10);
                this.buffer = this.buffer.slice(headerMatch[0].length);
            }

            // Check if we have the complete message
            if (Buffer.byteLength(this.buffer, "utf8") >= this.contentLength) {
                const messageText = this.buffer.slice(0, this.contentLength);
                this.buffer = this.buffer.slice(this.contentLength);
                this.contentLength = 0;

                try {
                    const message: LSPMessage = JSON.parse(messageText);
                    this.handleMessage(message);
                } catch (error) {
                    console.error("[LSP Client] Failed to parse message:", error);
                }
            } else {
                break;
            }
        }
    }

    /**
     * Handle incoming LSP message
     */
    private handleMessage(message: LSPMessage): void {
        // Response to a request
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            const id = typeof message.id === "string" ? parseInt(message.id, 10) : message.id;
            const pending = this.pendingRequests.get(id);

            if (pending) {
                this.pendingRequests.delete(id);

                if (message.error) {
                    pending.reject(new Error(`LSP Error: ${message.error.message}`));
                } else {
                    pending.resolve(message.result);
                }
            }
            return;
        }

        // Notification from server
        if (message.method && this.options.onNotification) {
            this.options.onNotification(message.method, message.params);
        }
    }

    /**
     * Setup error handlers for the process
     */
    private setupErrorHandlers(): void {
        if (!this.process) return;

        this.process.on("error", (error) => {
            console.error("[LSP Client] Process error:", error);
            if (this.options.onError) {
                this.options.onError(error);
            }
            this.handleProcessExit(1);
        });

        this.process.on("exit", (code, signal) => {
            console.log("[LSP Client] Process exited:", { code, signal });
            this.handleProcessExit(code || 0);
        });
    }

    /**
     * Stop the LSP server process
     */
    async stop(): Promise<void> {
        this.isShuttingDown = true;

        if (!this.process) {
            return;
        }

        console.log("[LSP Client] Stopping LSP server...");

        try {
            // Send shutdown request (ignore response, some servers return null or object)
            await this.sendRequest("shutdown", null).catch((e) => {
                // Ignore shutdown errors, proceed with exit
                console.warn("[LSP Client] Shutdown request failed:", e);
            });

            // Send exit notification
            this.sendNotification("exit", {});

            // Wait for graceful exit
            await this.waitForExit(5000);
        } catch (error) {
            console.warn("[LSP Client] Graceful shutdown failed:", error);
        }

        // Force kill if still running
        if (this.process && !this.process.killed) {
            console.log("[LSP Client] Force killing LSP process");
            this.process.kill("SIGKILL");
        }

        this.cleanup();
        console.log("[LSP Client] LSP server stopped");
    }

    /**
     * Handle process exit and attempt restart
     */
    private handleProcessExit(code: number): void {
        this.cleanup();

        // Don't restart if shutting down intentionally
        if (this.isShuttingDown) {
            return;
        }

        // Don't restart if too many attempts
        if (this.restartAttempts >= this.maxRestartAttempts) {
            console.error(
                `[LSP Client] Max restart attempts (${this.maxRestartAttempts}) reached, giving up`
            );
            if (this.options.onError) {
                this.options.onError(new Error("LSP server crashed too many times"));
            }
            return;
        }

        // Attempt restart
        this.restartAttempts++;
        const delay = this.restartDelay * this.restartAttempts;

        console.warn(
            `[LSP Client] Process exited with code ${code}, restarting in ${delay}ms (attempt ${this.restartAttempts}/${this.maxRestartAttempts})`
        );

        setTimeout(() => {
            if (!this.isShuttingDown) {
                this.start()
                    .then(() => {
                        if (this.options.onRestart) {
                            this.options.onRestart();
                        }
                    })
                    .catch((error) => {
                        console.error("[LSP Client] Restart failed:", error);
                    });
            }
        }, delay);
    }

    /**
     * Wait for process to be ready
     */
    private waitForReady(timeout: number = 5000): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("LSP server startup timeout"));
            }, timeout);

            // Consider the server ready once the process is spawned
            // Actual initialization will happen through LSP initialize request
            if (this.process) {
                clearTimeout(timer);
                resolve();
            }
        });
    }

    /**
     * Wait for process to exit
     */
    private waitForExit(timeout: number): Promise<void> {
        return new Promise((resolve) => {
            if (!this.process || this.process.killed) {
                resolve();
                return;
            }

            const timer = setTimeout(() => {
                resolve();
            }, timeout);

            this.process.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    /**
     * Cleanup resources
     */
    private cleanup(): void {
        // Close stderr stream if open
        if (this.stderrStream) {
            this.stderrStream.end();
            this.stderrStream = null;
        }

        this.process = null;
        this.buffer = "";
        this.contentLength = 0;

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests.entries()) {
            pending.reject(new Error("LSP server stopped"));
        }
        this.pendingRequests.clear();
    }
}

// Determine the correct Tinymist executable based on platform
function getTinymistCommand(): string {
    const isWindows = platform() === "win32";

    // Check environment variable first
    if (process.env.TINYMIST_CLI_PATH) {
        const envPath = process.env.TINYMIST_CLI_PATH;

        // If it's a relative path, resolve it from project root
        const absolutePath = isAbsolute(envPath)
            ? envPath
            : resolve(process.cwd(), envPath);

        if (existsSync(absolutePath)) {
            console.log("[LSP Client] Using Tinymist from:", absolutePath);
            return absolutePath;
        } else {
            console.warn("[LSP Client] TINYMIST_CLI_PATH not found:", absolutePath);
        }
    }

    // Try common locations
    if (isWindows) {
        const defaultPath = resolve(process.cwd(), "vendor/bin/tinymist.exe");
        if (existsSync(defaultPath)) {
            console.log("[LSP Client] Using Tinymist from:", defaultPath);
            return defaultPath;
        }

        // Try user's cargo bin
        const cargoPath = join(process.env.USERPROFILE || "", ".cargo", "bin", "tinymist.exe");
        if (existsSync(cargoPath)) {
            console.log("[LSP Client] Using Tinymist from:", cargoPath);
            return cargoPath;
        }

        console.warn("[LSP Client] Tinymist not found, using 'tinymist.exe' (must be in PATH)");
        return "tinymist.exe";
    } else {
        // Linux/Mac
        const cargoBin = join(process.env.HOME || "", ".cargo", "bin", "tinymist");
        if (existsSync(cargoBin)) {
            console.log("[LSP Client] Using Tinymist from:", cargoBin);
            return cargoBin;
        }

        console.warn("[LSP Client] Tinymist not found, using 'tinymist' (must be in PATH)");
        return "tinymist";
    }
}
