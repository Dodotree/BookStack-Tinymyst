"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const lsp_client_1 = require("./lsp-client");
const path_1 = require("path");
const fs_1 = require("fs");
/**
 * Example: How to use the LSP client with Tinymist
 */
// Create and start the LSP client
async function main() {
    const logFile = (0, path_1.join)(process.cwd(), "storage", "logs", `tinymist-lsp-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.log`);
    console.log(`[LSP] Logging stderr to: ${logFile}`);
    const client = new lsp_client_1.LSPClient({
        command: "",
        args: ["lsp"],
        cwd: process.cwd(),
        stderrLogFile: logFile, // Redirect stderr to log file
        onNotification: (method, params) => {
            console.log("[LSP Notification]", method, params);
            // Handle specific notifications
            switch (method) {
                case "textDocument/publishDiagnostics":
                    console.log("[Diagnostics]", params);
                    break;
                case "$/progress":
                    console.log("[Progress]", params);
                    break;
            }
        },
        onError: (error) => {
            console.error("[LSP Error]", error);
        },
        onRestart: () => {
            console.log("[LSP] Server restarted, re-initializing...");
            client.initializeLSP();
        },
    });
    try {
        // Start the LSP server
        await client.start();
        console.log("LSP server started");
        // Initialize the LSP server
        const initResult = await client.initializeLSP();
        // Get token legend from server capabilities
        // const tokenLegend = initResult.capabilities.semanticTokensProvider?.legend;
        // const tokenTypes = tokenLegend?.tokenTypes || [];
        // const tokenModifiers = tokenLegend?.tokenModifiers || [];
        // console.log("\nToken legend:");
        // console.log("Types:", tokenTypes);
        // console.log("Modifiers:", tokenModifiers);
        // Example: Open a document that exists on disk
        // Note: Don't provide 'text' field - LSP will read from disk
        const docUri = `file:///${(0, path_1.join)(process.cwd(), "storage", "app", "tinymist", "page_266.typ")}`;
        // Check if file exists
        const docPath = (0, path_1.join)(process.cwd(), "storage", "app", "tinymist", "page_266.typ");
        if (!(0, fs_1.existsSync)(docPath)) {
            console.warn(`File not found: ${docPath}`);
            console.log("You need to create this file first for the example to work.");
        }
        client.sendNotification("textDocument/didOpen", {
            textDocument: {
                uri: docUri,
                languageId: "typst",
                version: 1,
                // text: "= Hello World\n\nThis is a test document.", // Only for in memory docs
            },
        });
        // Example: Request hover information
        // const hoverResult = await client.sendRequest("textDocument/hover", {
        //   textDocument: { uri: docUri },
        //   position: { line: 0, character: 2 },
        // });
        // console.log("Hover result:", hoverResult);
        // Example: Request semantic tokens
        console.log("\n--- Requesting Semantic Tokens ---");
        const tokensResult = await client.sendRequest("textDocument/semanticTokens/full", {
            textDocument: { uri: docUri },
        });
        if (tokensResult?.data) {
            console.log(`Received ${tokensResult.data.length / 5} tokens`);
            const decodedTokens = client.decodeSemanticTokens(tokensResult.data);
            console.log("\nDecoded tokens:");
            decodedTokens.forEach((token, idx) => {
                console.log(`${idx + 1}. Line ${token.line}, Col ${token.startChar}-${token.startChar + token.length}: ${token.tokenType}${token.tokenModifiers.length ? ' [' + token.tokenModifiers.join(', ') + ']' : ''}`);
            });
        }
        else {
            console.log("No semantic tokens returned");
        }
        // Keep running for 30 seconds, then shutdown
        setTimeout(async () => {
            console.log("Shutting down...");
            await client.stop();
            process.exit(0);
        }, 30000);
    }
    catch (error) {
        console.error("Failed to start LSP:", error);
        process.exit(1);
    }
}
// Run if this file is executed directly
if (require.main === module) {
    main().catch(console.error);
}
