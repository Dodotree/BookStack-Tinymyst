# LSP Client for Tinymist

A cross-platform LSP client for managing Tinymist LSP server processes.

## Features

- ✅ **Cross-platform**: Works on Windows and Ubuntu/Linux
- ✅ **Auto-restart**: Automatically restarts crashed processes (up to 3 attempts)
- ✅ **Graceful shutdown**: Sends proper shutdown/exit sequence
- ✅ **Request/Response**: Full LSP request/response handling with promises
- ✅ **Notifications**: Handle server notifications with callbacks
- ✅ **Timeout handling**: Automatic timeout for requests (30s default)
- ✅ **stdin/stdout pipes**: Standard LSP communication protocol

## Usage

### Basic Setup

```typescript
import { LSPClient } from "./lsp-client";

const client = new LSPClient({
  command: "tinymist.exe",  // or "tinymist" on Linux
  args: ["lsp"],
  cwd: process.cwd(),
  onNotification: (method, params) => {
    console.log("Notification:", method, params);
  },
  onError: (error) => {
    console.error("LSP Error:", error);
  },
  onRestart: () => {
    console.log("LSP restarted");
  },
});

// Start the server
await client.start();

// Initialize LSP
const initResult = await client.sendRequest("initialize", {
  processId: process.pid,
  rootUri: "file:///path/to/workspace",
  capabilities: { /* ... */ },
});

client.sendNotification("initialized", {});
```

### Send Requests

```typescript
// Request with response
const hoverResult = await client.sendRequest("textDocument/hover", {
  textDocument: { uri: "file:///document.typ" },
  position: { line: 0, character: 5 },
});
console.log(hoverResult);
```

### Send Notifications

```typescript
// Notification (no response expected)
client.sendNotification("textDocument/didOpen", {
  textDocument: {
    uri: "file:///document.typ",
    languageId: "typst",
    version: 1,
    text: "= Hello World",
  },
});
```

### Graceful Shutdown

```typescript
// Stop the server gracefully
await client.stop();
```

## Configuration

### Finding Tinymist Executable

The client needs to know where the Tinymist executable is located:

**Windows:**

- Check `%LOCALAPPDATA%\\tinymist\\tinymist.exe`
- Check `%USERPROFILE%\\.cargo\\bin\\tinymist.exe`
- Or set `TINYMIST_PATH` environment variable

**Linux/Ubuntu:**

- Check `~/.cargo/bin/tinymist`
- Check `/usr/local/bin/tinymist`
- Or set `TINYMIST_PATH` environment variable

### Environment Variables

```bash
# Set custom Tinymist path
export TINYMIST_PATH=/path/to/tinymist

# Or on Windows
set TINYMIST_PATH=C:\\path\\to\\tinymist.exe
```

## Auto-Restart Behavior

The client automatically restarts the LSP server if it crashes:

- **Max attempts**: 3
- **Restart delay**: 1 second × attempt number (1s, 2s, 3s)
- **Callback**: `onRestart()` called after successful restart

After 3 failed restart attempts, the client gives up and calls `onError()`.

## LSP Message Protocol

The client implements the standard LSP protocol:

### Message Format

```bash
Content-Length: 123\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
```

### Request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "textDocument/hover",
  "params": { /* ... */ }
}
```

### Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { /* ... */ }
}
```

### Notification

```json
{
  "jsonrpc": "2.0",
  "method": "textDocument/publishDiagnostics",
  "params": { /* ... */ }
}
```

## Example

See `lsp-client-example.ts` for a complete working example.

## Integration with File Sync Server

To integrate with the file-sync server:

```typescript
import { LSPClient } from "./lsp-client";
import { FileManager } from "./file-manager";

const fileManager = new FileManager(STORAGE_ROOT);
const lspClient = new LSPClient({
  command: getTinymistCommand(),
  args: ["lsp"],
  onNotification: (method, params) => {
    if (method === "textDocument/publishDiagnostics") {
      // Send diagnostics to connected clients
      broadcastDiagnostics(params);
    }
  },
});

await lspClient.start();
await initializeLSP(lspClient);

// When file changes, notify LSP
function onFileChange(pageId: number, content: string) {
  const uri = getFileUri(pageId);
  lspClient.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: getVersion(pageId) },
    contentChanges: [{ text: content }],
  });
}
```

## Error Handling

The client handles several error scenarios:

1. **Process spawn errors**: Caught and reported via `onError()`
2. **Request timeouts**: Automatically reject after 30 seconds
3. **Process crashes**: Auto-restart with exponential backoff
4. **Parse errors**: Logged to console, processing continues
5. **Shutdown errors**: Force kill after 5 second grace period

## Platform Differences

### Windows

- Uses shell spawning for better path resolution
- Executable name: `tinymist.exe`
- Default locations: `%LOCALAPPDATA%`, `%USERPROFILE%\\.cargo\\bin`

### Linux/Ubuntu

- Direct spawn (no shell)
- Executable name: `tinymist`
- Default locations: `~/.cargo/bin`, `/usr/local/bin`

## License

Same as parent project.
