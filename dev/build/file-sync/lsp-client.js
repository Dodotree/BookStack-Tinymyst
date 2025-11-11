"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LSPClient = void 0;
const child_process_1 = require("child_process");
const os_1 = require("os");
const path_1 = require("path");
const fs_1 = require("fs");
class LSPClient {
    process = null;
    buffer = "";
    contentLength = 0;
    nextId = 1;
    pendingRequests = new Map();
    options;
    isShuttingDown = false;
    restartAttempts = 0;
    maxRestartAttempts = 3;
    stderrStream = null;
    restartDelay = 1000;
    tokenTypes = [
        "comment", "string", "keyword", "operator", "number",
        "function", "decorator", "type", "namespace", "bool",
        "punct", "escape", "link", "raw", "label", "ref",
        "heading", "marker", "term", "delim", "pol", "error", "text"
    ];
    tokenModifiers = [
        "strong", "emph", "math", "readonly", "static", "defaultLibrary"
    ];
    constructor(options) {
        this.options = {
            ...options,
            env: {
                ...process.env,
                ...options.env,
            },
        };
    }
    /**
     * Start the LSP server process
     */
    async start() {
        if (this.process) {
            console.warn("[LSP Client] Process already running");
            return;
        }
        this.options.command = getTinymistCommand();
        console.log("[LSP Client] Starting LSP server:", {
            command: this.options.command,
            args: this.options.args,
            cwd: this.options.cwd,
            platform: (0, os_1.platform)(),
        });
        try {
            this.process = (0, child_process_1.spawn)(this.options.command, this.options.args, {
                cwd: this.options.cwd,
                env: this.options.env,
                stdio: ["pipe", "pipe", this.options.stderrLogFile ? "pipe" : "inherit"],
                shell: false, // Don't use shell - we provide absolute paths
            });
            // Redirect stderr to log file if specified
            if (this.options.stderrLogFile && this.process.stderr) {
                this.stderrStream = (0, fs_1.createWriteStream)(this.options.stderrLogFile, { flags: "a" });
                this.process.stderr.pipe(this.stderrStream);
            }
            this.setupStreams();
            this.setupErrorHandlers();
            // Wait for process to be ready
            await this.waitForReady();
            this.restartAttempts = 0;
            console.log("[LSP Client] LSP server started successfully");
        }
        catch (error) {
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
                            full: true,
                            range: false
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
        // Send initialized notification
        this.sendNotification("initialized", {});
        return initResult;
    }
    /**
     * Send a request to the LSP server
     */
    sendRequest(method, params) {
        if (!this.process || !this.process.stdin) {
            return Promise.reject(new Error("LSP process not running"));
        }
        const id = this.nextId++;
        const message = {
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
                this.process.stdin.write(header + content, "utf8");
            }
            catch (error) {
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
    sendNotification(method, params) {
        if (!this.process || !this.process.stdin) {
            console.warn("[LSP Client] Cannot send notification, process not running");
            return;
        }
        const message = {
            jsonrpc: "2.0",
            method,
            params,
        };
        const content = JSON.stringify(message);
        const header = `Content-Length: ${Buffer.byteLength(content, "utf8")}\r\n\r\n`;
        try {
            this.process.stdin.write(header + content, "utf8");
        }
        catch (error) {
            console.error("[LSP Client] Failed to send notification:", error);
        }
    }
    /**
     * Check if the LSP server is running
     */
    isRunning() {
        return this.process !== null && !this.process.killed;
    }
    /**
     * Setup streams for LSP communication
     */
    setupStreams() {
        if (!this.process || !this.process.stdout) {
            throw new Error("Process or stdout not available");
        }
        this.process.stdout.on("data", (data) => {
            this.buffer += data.toString("utf8");
            this.processBuffer();
        });
        // Only listen to stderr if we're not redirecting to a file
        if (!this.options.stderrLogFile && this.process.stderr) {
            this.process.stderr.on("data", (data) => {
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
    processBuffer() {
        while (true) {
            // Parse Content-Length header
            if (this.contentLength === 0) {
                const headerMatch = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
                if (!headerMatch)
                    break;
                this.contentLength = parseInt(headerMatch[1], 10);
                this.buffer = this.buffer.slice(headerMatch[0].length);
            }
            // Check if we have the complete message
            if (Buffer.byteLength(this.buffer, "utf8") >= this.contentLength) {
                const messageText = this.buffer.slice(0, this.contentLength);
                this.buffer = this.buffer.slice(this.contentLength);
                this.contentLength = 0;
                try {
                    const message = JSON.parse(messageText);
                    this.handleMessage(message);
                }
                catch (error) {
                    console.error("[LSP Client] Failed to parse message:", error);
                }
            }
            else {
                break;
            }
        }
    }
    /**
     * Handle incoming LSP message
     */
    handleMessage(message) {
        // Response to a request
        if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            const id = typeof message.id === "string" ? parseInt(message.id, 10) : message.id;
            const pending = this.pendingRequests.get(id);
            if (pending) {
                this.pendingRequests.delete(id);
                if (message.error) {
                    pending.reject(new Error(`LSP Error: ${message.error.message}`));
                }
                else {
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
    setupErrorHandlers() {
        if (!this.process)
            return;
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
     * Decode semantic tokens from LSP format
     * The data is encoded as [deltaLine, deltaStartChar, length, tokenType, tokenModifiers]
     */
    decodeSemanticTokens(data) {
        const tokens = [];
        let line = 0;
        let startChar = 0;
        for (let i = 0; i < data.length; i += 5) {
            const deltaLine = data[i];
            const deltaStartChar = data[i + 1];
            const length = data[i + 2];
            const tokenType = data[i + 3];
            const tokenModifierBits = data[i + 4];
            // Update position
            line += deltaLine;
            if (deltaLine === 0) {
                startChar += deltaStartChar;
            }
            else {
                startChar = deltaStartChar;
            }
            // Decode token modifiers from bitmask
            const modifiers = [];
            for (let j = 0; j < this.tokenModifiers.length; j++) {
                if (tokenModifierBits & (1 << j)) {
                    modifiers.push(this.tokenModifiers[j]);
                }
            }
            tokens.push({
                line,
                startChar,
                length,
                tokenType: this.tokenTypes[tokenType] || `unknown(${tokenType})`,
                tokenModifiers: modifiers,
            });
        }
        return tokens;
    }
    /**
     * Stop the LSP server process
     */
    async stop() {
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
        }
        catch (error) {
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
    handleProcessExit(code) {
        this.cleanup();
        // Don't restart if shutting down intentionally
        if (this.isShuttingDown) {
            return;
        }
        // Don't restart if too many attempts
        if (this.restartAttempts >= this.maxRestartAttempts) {
            console.error(`[LSP Client] Max restart attempts (${this.maxRestartAttempts}) reached, giving up`);
            if (this.options.onError) {
                this.options.onError(new Error("LSP server crashed too many times"));
            }
            return;
        }
        // Attempt restart
        this.restartAttempts++;
        const delay = this.restartDelay * this.restartAttempts;
        console.warn(`[LSP Client] Process exited with code ${code}, restarting in ${delay}ms (attempt ${this.restartAttempts}/${this.maxRestartAttempts})`);
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
    waitForReady(timeout = 5000) {
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
    waitForExit(timeout) {
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
    cleanup() {
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
exports.LSPClient = LSPClient;
// Determine the correct Tinymist executable based on platform
function getTinymistCommand() {
    const isWindows = (0, os_1.platform)() === "win32";
    // Check environment variable first
    if (process.env.TINYMIST_PATH) {
        const envPath = process.env.TINYMIST_PATH;
        // If it's a relative path, resolve it from project root
        const absolutePath = (0, path_1.isAbsolute)(envPath)
            ? envPath
            : (0, path_1.resolve)(process.cwd(), envPath);
        if ((0, fs_1.existsSync)(absolutePath)) {
            console.log("[LSP Client] Using Tinymist from:", absolutePath);
            return absolutePath;
        }
        else {
            console.warn("[LSP Client] TINYMIST_PATH not found:", absolutePath);
        }
    }
    // Try common locations
    if (isWindows) {
        const defaultPath = (0, path_1.resolve)(process.cwd(), "vendor/bin/tinymist.exe");
        if ((0, fs_1.existsSync)(defaultPath)) {
            console.log("[LSP Client] Using Tinymist from:", defaultPath);
            return defaultPath;
        }
        // Try user's cargo bin
        const cargoPath = (0, path_1.join)(process.env.USERPROFILE || "", ".cargo", "bin", "tinymist.exe");
        if ((0, fs_1.existsSync)(cargoPath)) {
            console.log("[LSP Client] Using Tinymist from:", cargoPath);
            return cargoPath;
        }
        console.warn("[LSP Client] Tinymist not found, using 'tinymist.exe' (must be in PATH)");
        return "tinymist.exe";
    }
    else {
        // Linux/Mac
        const cargoBin = (0, path_1.join)(process.env.HOME || "", ".cargo", "bin", "tinymist");
        if ((0, fs_1.existsSync)(cargoBin)) {
            console.log("[LSP Client] Using Tinymist from:", cargoBin);
            return cargoBin;
        }
        console.warn("[LSP Client] Tinymist not found, using 'tinymist' (must be in PATH)");
        return "tinymist";
    }
}
