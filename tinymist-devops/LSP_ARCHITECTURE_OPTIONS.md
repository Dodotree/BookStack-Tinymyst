# Tinymist LSP Architecture Options for Laravel

## Problem Statement

**LSP sends `textDocument/publishDiagnostics` as a server-initiated notification (push)**

- Not an HTTP response - it's a **notification** sent anytime LSP detects errors
- Happens automatically on `didChange` events
- Laravel HTTP is request/response - how to capture **push notifications**?

---

## Option 1: Backend LSP Process with WebSocket ⭐ (Recommended)

### Architecture

```txt
┌──────────────┐         WebSocket         ┌─────────────────┐         stdin/stdout        ┌──────────────┐
│   Browser    │ <──────────────────────> │  Laravel + WS   │ <────────────────────────> │  Tinymist    │
│  (CodeMirror)│                           │   (PHP daemon)  │                            │  LSP Process │
└──────────────┘                           └─────────────────┘                            └──────────────┘
      │                                             │                                             │
      │ User types: $infinit$                       │                                             │
      ├─────────────────────────────────────────────>                                             │
      │ WS: {type: 'change', text: '...'}           │                                             │
      │                                             │ Send didChange                              │
      │                                             ├────────────────────────────────────────────>│
      │                                             │                                             │
      │                                             │                                             │ Compile
      │                                             │                                             │
      │                                             │ PUSH: publishDiagnostics                    │
      │                                             │<────────────────────────────────────────────┤
      │                                             │                                             │
      │ WS: {type: 'diagnostics', items: [...]}     │                                             │
      │<─────────────────────────────────────────────                                             │
      │ Display red underlines                      │                                             │
```

### Implementation

#### 1. Create LSP Process Manager (PHP)

```php
<?php
// app/Entities/Tools/Tinymist/TinymistLspBridge.php

namespace BookStack\Entities\Tools\Tinymist;

use Illuminate\Support\Facades\Log;

class TinymistLspBridge
{
    private $process;
    private $pipes;
    private int $requestId = 0;
    private array $callbacks = [];

    public function __construct()
    {
        $tinymistPath = config('tinymist.tinymist_cli_path');

        $descriptorspec = [
            0 => ["pipe", "r"],  // stdin
            1 => ["pipe", "w"],  // stdout
            2 => ["pipe", "w"]   // stderr
        ];

        $this->process = proc_open(
            [$tinymistPath, 'lsp'],
            $descriptorspec,
            $this->pipes
        );

        if (!is_resource($this->process)) {
            throw new \RuntimeException("Failed to start Tinymist LSP");
        }

        // Make stdout non-blocking
        stream_set_blocking($this->pipes[1], false);

        // Initialize LSP
        $this->initialize();
    }

    private function initialize(): void
    {
        $this->sendRequest('initialize', [
            'processId' => getmypid(),
            'rootUri' => null,
            'capabilities' => [
                'textDocument' => [
                    'synchronization' => ['dynamicRegistration' => true],
                ],
            ],
        ]);

        $response = $this->readResponse();

        $this->sendNotification('initialized', []);
    }

    public function sendRequest(string $method, array $params): int
    {
        $this->requestId++;

        $request = [
            'jsonrpc' => '2.0',
            'id' => $this->requestId,
            'method' => $method,
            'params' => $params,
        ];

        $this->writeMessage($request);

        return $this->requestId;
    }

    public function sendNotification(string $method, array $params): void
    {
        $notification = [
            'jsonrpc' => '2.0',
            'method' => $method,
            'params' => $params,
        ];

        $this->writeMessage($notification);
    }

    private function writeMessage(array $message): void
    {
        $content = json_encode($message);
        $header = "Content-Length: " . strlen($content) . "\r\n\r\n";

        fwrite($this->pipes[0], $header . $content);
        fflush($this->pipes[0]);
    }

    public function readResponse(): ?array
    {
        // Read headers
        $headers = [];
        while (($line = fgets($this->pipes[1])) !== false) {
            $line = trim($line);
            if ($line === '') break;

            if (strpos($line, ':') !== false) {
                [$key, $value] = explode(':', $line, 2);
                $headers[trim($key)] = trim($value);
            }
        }

        if (!isset($headers['Content-Length'])) {
            return null;
        }

        // Read content
        $contentLength = (int)$headers['Content-Length'];
        $content = fread($this->pipes[1], $contentLength);

        return json_decode($content, true);
    }

    public function onPublishDiagnostics(callable $callback): void
    {
        $this->callbacks['textDocument/publishDiagnostics'] = $callback;
    }

    public function processMessages(): void
    {
        while ($message = $this->readResponse()) {
            // Check if it's a notification
            if (isset($message['method']) && !isset($message['id'])) {
                $method = $message['method'];

                if ($method === 'textDocument/publishDiagnostics') {
                    if (isset($this->callbacks[$method])) {
                        $this->callbacks[$method]($message['params']);
                    }
                }
            }
        }
    }

    public function openDocument(string $uri, string $content): void
    {
        $this->sendNotification('textDocument/didOpen', [
            'textDocument' => [
                'uri' => $uri,
                'languageId' => 'typst',
                'version' => 1,
                'text' => $content,
            ],
        ]);
    }

    public function changeDocument(string $uri, int $version, array $changes): void
    {
        $this->sendNotification('textDocument/didChange', [
            'textDocument' => [
                'uri' => $uri,
                'version' => $version,
            ],
            'contentChanges' => $changes,
        ]);
    }

    public function __destruct()
    {
        if (is_resource($this->process)) {
            $this->sendRequest('shutdown', []);
            $this->readResponse();
            $this->sendNotification('exit', []);

            foreach ($this->pipes as $pipe) {
                if (is_resource($pipe)) {
                    fclose($pipe);
                }
            }

            proc_close($this->process);
        }
    }
}
```

#### 2. Create WebSocket Handler

**Using Laravel Reverb (Laravel 11+)**:

```php
<?php
// app/Events/TinymistDiagnosticsUpdated.php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

class TinymistDiagnosticsUpdated implements ShouldBroadcast
{
    use Dispatchable, InteractsWithSockets, SerializesModels;

    public function __construct(
        public string $documentUri,
        public array $diagnostics,
    ) {}

    public function broadcastOn(): Channel
    {
        return new Channel('tinymist.' . md5($this->documentUri));
    }

    public function broadcastAs(): string
    {
        return 'diagnostics';
    }
}
```

#### 3. WebSocket Server (Artisan Command)

```php
<?php
// app/Console/Commands/TinymistLspServer.php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use BookStack\Entities\Tools\Tinymist\TinymistLspBridge;
use App\Events\TinymistDiagnosticsUpdated;

class TinymistLspServer extends Command
{
    protected $signature = 'tinymist:serve';
    protected $description = 'Run Tinymist LSP bridge server';

    public function handle()
    {
        $this->info('Starting Tinymist LSP bridge...');

        $lsp = new TinymistLspBridge();

        // Listen for diagnostics
        $lsp->onPublishDiagnostics(function ($params) {
            $this->info("📋 Diagnostics: " . $params['uri']);

            // Broadcast via WebSocket
            broadcast(new TinymistDiagnosticsUpdated(
                $params['uri'],
                $params['diagnostics']
            ));
        });

        // Keep processing messages
        while (true) {
            $lsp->processMessages();
            usleep(10000); // 10ms
        }
    }
}
```

#### 4. Frontend Integration

```typescript
// resources/js/components/tinymist-lsp-client.ts

import { io } from 'socket.io-client';

export class TinymistLspClient {
    private socket: any;
    private documentUri: string;
    private version: number = 0;

    constructor(documentUri: string) {
        this.documentUri = documentUri;

        // Connect to Laravel Reverb
        this.socket = io('ws://localhost:6001', {
            transports: ['websocket']
        });

        // Join document channel
        const channel = this.socket.emit('subscribe', {
            channel: `tinymist.${this.hashUri(documentUri)}`
        });

        // Listen for diagnostics
        this.socket.on('diagnostics', (data: any) => {
            this.onDiagnostics(data.diagnostics);
        });
    }

    openDocument(content: string): void {
        fetch('/api/tinymist/open', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                uri: this.documentUri,
                content: content
            })
        });
    }

    changeDocument(changes: any[]): void {
        this.version++;

        fetch('/api/tinymist/change', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                uri: this.documentUri,
                version: this.version,
                changes: changes
            })
        });
    }

    private onDiagnostics(diagnostics: any[]): void {
        // Update CodeMirror with diagnostics
        console.log('Received diagnostics:', diagnostics);
        // Call your existing updateDiagnostics() method
    }

    private hashUri(uri: string): string {
        // Simple hash for channel name
        return btoa(uri).replace(/=/g, '');
    }
}
```

## Option 2: Polling with LSP (Simpler) - ❌ Blocking and always spawning new LSPs

### Architecture1

```txt
Browser ──HTTP Poll every 500ms──> Laravel ──read stdout──> LSP Process
        <──{diagnostics: [...]}──        <──publishDiagnostics──
```

**How it works**:

1. Laravel starts one LSP process per user session
2. Frontend polls `/api/tinymist/diagnostics` every 500ms
3. Laravel reads from LSP stdout (non-blocking)
4. Returns any pending diagnostics

---

### If you add LSP ✅

**Option 1 (WebSocket)**:

```php
$lsp->onPublishDiagnostics(function ($params) {
    broadcast(new DiagnosticsEvent($params));
});
```

**The LSP doesn't send to HTTP endpoints** - it writes to **stdout as JSON-RPC**.

You need a **PHP process that reads stdout** and either:

- Broadcasts via WebSocket (Option 1)
- Stores in cache/session for polling (Option 2) - failed

## LSP polling Implementation - Complete Failure Analysis

## 🎯 Quick Summary

1. **Synchronous initialization blocks HTTP requests** for 5-30 seconds
2. **Unknown hang after initialization** - even successful init leads to silence
3. **Architecture mismatch** - LSP designed for persistent IDE connections, not stateless HTTP
4. **No error recovery** - hangs are silent, no exceptions thrown

## 🔴 Root Cause #1: Synchronous Initialization Blocks Page Load

### The Problem

```php

$client = $this->processManager->getClient($pageId);  // ← BLOCKS HERE! Each time new client waiting for handshake

public function getClient(int $pageId)
{
    $client = $this->createClient($pageId);  // Creates new LSP process
    return $client;
}

protected function createClient(...)
{
    $client = new TinymistLSPClient(...);
    $client->start();  // ← BLOCKS FOR 5-30 SECONDS!
    return $client;
}

public function start(): bool
{
    // ... start process ...
    $result = $this->initialize();  // ← WAITS FOR LSP HANDSHAKE
    return $result;
}

protected function initialize(): bool
{
    $response = $this->sendRequest('initialize', $params, 30); // 30 SECOND TIMEOUT!
    // If LSP hangs, user waits 30 seconds before error
}
```

### The Flow

``` log
User opens page
  ↓
HTTP Request: GET /books/123/page/456/edit
  ↓
Controller loads editor
  ↓
Frontend calls: POST /ajax/tinymist/compile
  ↓
TinymistService::compileToSvgLSP()
  ↓
ProcessManager::getClient(456)  ← First time for this page
  ↓
new TinymistLSPClient()
  ↓
$client->start()  ← BLOCKS HTTP REQUEST!
  ↓
Initialize LSP (5-30 seconds)
  ↓
IF successful: Continue to compile
IF timeout: Return error after 30s
IF hang: Page never loads
```

### Why It's Fatal

1. **User sees blank page** - HTTP request hasn't returned
2. **No cancel button** - Can't stop the request
3. **No loading indicator** - Looks like it crashed
4. **30 second timeout** - If LSP fails, user waits 30s for error
5. **No retry** - Have to refresh entire page

## 🔴 Root Cause #2: Unknown Hang After Successful Init

### Theories (Unproven)

**Theory 1**: `processNotifications()` blocks

```php
// TinymistLSPClient.php:181
public function getDiagnostics(): array
{
    $this->processNotifications(100); // ← Hangs here?
    return $this->diagnostics;
}
```

**Theory 2**: LSP process deadlock

- LSP waiting for more stdin data
- PHP waiting for stdout response
- Neither side times out properly

**Theory 3**: PHP execution timeout

- Request killed silently by PHP
- No exception, no log
- Just stops mid-execution

### Why It's Hard to Debug

- No exception thrown
- Logs just stop
- Can't attach debugger (blocking I/O)
- Can't see LSP stderr in real-time
- PHP timeout kills before error handling

---

## 🔴 Root Cause #3: Architecture Mismatch

### LSP ≠ HTTP

| Aspect | LSP Assumption | HTTP Reality | Result |
|--------|----------------|--------------|--------|
| **Connection** | Persistent (like IDE) | Stateless | Can't maintain LSP between requests |
| **Latency** | Localhost, instant | Network roundtrip | 100-500ms overhead |
| **Concurrency** | One user, one doc | Multiple users | Need process pooling |
| **Notifications** | Async push anytime | Sync request/response | Can't wait for `publishDiagnostics` |
| **Errors** | Long-running, can retry | Must return quickly | No time to retry |

Obvious statements about how sync can not wait for async

## 🔴 Root Cause #4: Process Management Is Impossible

Described really bizarre implementation it created. Whatever.

---

## ✅ What Actually Works: Our Test Script

### Python Test Script (Success!)

```python
# dev/test-tinymist-lsp-simple.py

client = TinymistLspClient()
client.start()  # Initialize LSP

# Open document
client.send('textDocument/didOpen', {
    'textDocument': {
        'uri': 'file:///test.typ',
        'text': '$infinity$'
    }
}, is_notification=True)

# Wait for diagnostics
time.sleep(1.0)

# Read notifications
responses = client.get_responses()
for resp in responses:
    if resp['method'] == 'textDocument/publishDiagnostics':
        print(resp['params']['diagnostics'])
```

## 🎓 Lessons Learned

### 1. LSP Is NOT a "Service"

**Wrong mental model**:
> "LSP is like a compilation service we can call via HTTP"
**Correct mental model**:
> "LSP is a persistent IDE backend that requires long-running connections"

### 2. Not Everything Needs to be Real-Time

**Question**: "Do users really need diagnostics in < 100ms?"
**Answer**: Probably not. 500ms is fine for most users.
**Conclusion**: CLI compilation (200-500ms) is fast enough.

### 3. Simplicity Has Value

### 4. PHP Resources Can't Be Serialized

Not what I had in mind for polling

### 5. Async Doesn't Fit Sync

**LSP**: Async notifications at any time
**HTTP**: Synchronous request/response
**Can't bridge the gap** without:

- WebSocket (real async)
- Polling (fake async)
- Message queue (background workers) -- that's more like it + polling?

Question: is it possible with the right implementation of queue and polling?

## Artifacts of Tinymist LSP Implementation

## Frontend Components

### 2. `tinymist-editor.ts` Updates

- **New Features**:
  - Document version tracking -?
  - Previous content storage for diffing
  - LSP-based compilation path -?
  - CodeMirror lint integration

### 3. Error Highlighting

- **Integration**: CodeMirror `@codemirror/lint` package
- **Display**: Wavy underlines for errors/warnings
- **Real-time**: Updates as you type (after debounce)

## Files Modified/Created

### Backend

- ✅ `config/tinymist.php` - Added LSP configuration

### Frontend

- ✅ `package.json` - Added dependencies
- ✅ `resources/js/components/tinymist-editor.ts` - Updated

## Tinymist LSP Investigation Results

**Date**: 2025-10-24
**Tinymist Version**: v0.13.28
**Typst Version**: 0.13.1
**Test Scenario**: `$infinity$` → delete 'y' → `$infinit$`

## Summary

Successfully tested Tinymist LSP Record & Replay technique and discovered key LSP capabilities and limitations.

---

## Test Setup

### Environment

- **OS**: Windows 11
- **Tinymist Binary**: `vendor/bin/tinymist.exe`
- **Workspace**: `C:\Users\Ooo\Desktop\GitWork\BookStack\storage\logs`
- **Test File**: `test-lsp.typ`

### Test Scenario

1. **Initial document**: `$infinity$` (valid Typst math)
2. **Incremental change**: Delete `y` at character 8 → `$infinit$` (invalid variable)

---

## Key Findings

### ✅ What WORKS

#### 1. **Auto-Published Diagnostics** (CRITICAL DISCOVERY!)

- **Method**: `textDocument/publishDiagnostics` (server-initiated notification)
- **Behavior**: Tinymist **automatically** publishes diagnostics on:
  - Document open
  - Document change
  - **No request needed!**

**Example Output** (after deleting 'y'):

```json
{
  "jsonrpc": "2.0",
  "method": "textDocument/publishDiagnostics",
  "params": {
    "uri": "file:///C:/Users/Ooo/Desktop/GitWork/BookStack/storage/logs/test-lsp.typ",
    "diagnostics": [
      {
        "range": {
          "start": {"line": 0, "character": 1},
          "end": {"line": 0, "character": 8}
        },
        "severity": 1,  // Error
        "message": "unknown variable: infinit\nHint: if you meant to display multiple letters as is, try adding spaces between each letter: `i n f i n i t`\nHint: or if you meant to display this as text, try placing it in quotes: `\"infinit\"`"
      }
    ]
  }
}
```

**Format**:

- `severity`: 1 = Error, 2 = Warning, 3 = Info, 4 = Hint
- `range`: 0-indexed line, 0-indexed character (UTF-16 code units)
- `message`: Full error message with hints

#### 2. **Completion** ✅

- **Method**: `textDocument/completion`
- **Position**: After `$infinit|$` (cursor at position 0:8)

**Response**:

```json
{
  "isIncomplete": false,
  "items": [
    {
      "label": "infinity",
      "kind": 5,  // Field/Variable
      "detail": "∞, unicode: `\\u{221e}`",
      "insertTextFormat": 2  // Snippet
    }
  ]
}
```

**Features**:

- Suggests `infinity` to complete `infinit`
- Shows Unicode representation
- Supports snippets

---

#### 3. **Hover** ✅ (but limited on errors)

- **Method**: `textDocument/hover`
- **Result**: `null` on invalid variables
- **Note**: Would show type info/docs on valid symbols

---

### ❌ What DOESN'T Work -- not sure if that was the right approach

#### 1. **`tinymist/exportSvg` Request** ❌

- **Error**: `-32601: method not found`
- **Reason**: This is a custom Tinymist method, not standard LSP
- **Workaround**: Use `workspace/executeCommand` with `tinymist.exportSvg` command
  - But requires file path, not URI (different from web usage)

#### 2. **`textDocument/diagnostic` Request** ❌

- **Error**: `-32601: method not found`
- **Reason**: LSP 3.17 pull diagnostics not implemented in Tinymist
- **Workaround**: **Not needed!** Use auto-published `publishDiagnostics` instead---

## LSP Implementation Recommendations

listen for `publishDiagnostics` notifications!

```typescript
// Listen for notifications
lspClient.on('textDocument/publishDiagnostics', (params) => {
    const diagnostics = params.diagnostics;
    updateEditorDiagnostics(diagnostics);
});
```

**Incremental Document Sync** (Priority 2)
**On document change**:

```typescript
lspClient.send('textDocument/didChange', {
    textDocument: { uri, version: ++docVersion },
    contentChanges: [{
        range: {
            start: { line: 0, character: startChar },
            end: { line: 0, character: endChar }
        },
        text: newText
    }]
});
// LSP automatically publishes diagnostics after change!
```

**Completion Integration** (Priority 3)
**On user request** (Ctrl+Space or auto-trigger):

```typescript
const completions = await lspClient.request('textDocument/completion', {
    textDocument: { uri },
    position: { line, character }
});
// Show completion dropdown
```

---

**Tinymist `--mirror` and `--replay` flags**:

- Designed for LSP testing
- Not needed for BookStack integration
- Useful for debugging LSP behavior

**Better approach for testing**:

- Use Python/Node LSP client library
- Connect to `tinymist lsp` process
- Send JSON-RPC via stdin/stdout

---

**Goal**: Real-time updates, completion, hover

1. Replace CLI compilation with LSP incremental sync
2. Add completion support
3. Add hover tooltips for symbols
4. Use LSP for SVG export (via `workspace/executeCommand`)
