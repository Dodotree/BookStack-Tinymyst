
# LSP Initialize Request Diagram

Initialize request (JSON-RPC) tree (expanded):

```log

initialize
├─ jsonrpc: "2.0"
├─ id: number|string
├─ method: "initialize"
└─ params
	├─ processId: number|null
	├─ clientInfo?: { name, version? }
	├─ locale?: string
	├─ rootPath?: string (deprecated)
	├─ rootUri: string|null
	├─ workspaceFolders?: [ { uri, name } ] | null
	├─ initializationOptions?: object
	│  ├─ (note) Tinymist accepts both top-level keys and a nested `tinymist` object.
	│  │        If both are present, `tinymist.*` values take precedence.
	│  ├─ tinymist?: { ...same keys as below... }
	│  ├─ colorTheme?: "light" | "dark"
	│  ├─ compileStatus?: "enable" | "disable"
	│  ├─ lint?: object
	│  ├─ completion?: object
	│  ├─ onEnter?: object
	│  ├─ triggerSuggest?: boolean
	│  ├─ triggerParameterHints?: boolean
	│  ├─ triggerSuggestAndParameterHints?: boolean
	│  ├─ customizedShowDocument?: boolean
	│  ├─ delegateFsRequests?: boolean
	│  ├─ supportHtmlInMarkdown?: boolean
	│  ├─ supportClientCodelens?: boolean
	│  ├─ supportExtendedCodeAction?: boolean
	│  ├─ development?: boolean
	│  ├─ syntaxOnly?: "enable" | "disable" | "onPowerSaving" | "auto"
	│  ├─ semanticTokens?: "enable" | "disable"
	│  ├─ formatterMode?: string
	│  ├─ formatterPrintWidth?: number | null
	│  ├─ formatterIndentSize?: number | null
	│  ├─ formatterProseWrap?: boolean | null
	│  ├─ systemFonts?: boolean | null
	│  ├─ fontPaths?: string[]
	│  ├─ rootPath?: string
	│  ├─ outputPath?: string
	│  ├─ projectResolution?: "singleFile" | "lockDatabase"
	│  ├─ exportTarget?: "paged" | "html"
	│  ├─ exportPdf?: "never" | "onSave" | "onType" | "onDocumentHasTitle"
	│  ├─ preview?: {

// LSP preview binds control plane of preview and returns url for data plane, so data and cursor paths will flow through data websocket. Technically LSP and Preview this way will be the same process. But LSP will ignore compileStatus messages from preview. You can still receive global tinymist/compileStatus from the main editor actor (not per-preview-task). Outline is forwarded to LSP as tinymist/documentOutline. Main difference here is enabling hoverPeriscope for receiving small SVGs on hover with the rest of the hover information. I didn't try LSP Preview yet. I'm not sure if it's better to make LSP share the process with Preview, probably depends on resources or if you want to update whole virtual file instead of letting Preview watching the real file. I'm quite sure there's no way you would want to keep several previews in one process. -- It's possible to switch to LSP Preview without changes to the front end, data channel sits on a separate socket anyway. Only in this case I would need to use separate processes for LSP+Preview and use Preview Data socket as bridge (without opening separate Preview processes, or as a fallback).

	│  │  // `BrowsingPreviewOpts`
	│  │  browsing?: {
	│  │    // args passed to `tinymist.startDefaultPreview`
	│  │    // (same parser as `PreviewCliArgs`)
	│  │    args?: string[] // e.g. ["--data-plane-host=127.0.0.1:0", "--invert-colors=auto", "--open"]
	│  │
	│  │    // common browsing args:
	│  │    // --data-plane-host=<host:port>   // preview websocket/http endpoint
	│  │    // --control-plane-host=<host:port> // control endpoint (mainly standalone mode)
	│  │    // --invert-colors=<never|auto|always>
	│  │    // --partial-rendering / --no-partial-rendering (via preview config flags)
	│  │    // --open / --no-open
	│  │    // --task-id=<id>                  // hidden/internal
	│  │    // --not-primary                   // hidden/internal
	│  │
	│  │    // if omitted, Tinymist uses browsing defaults from code/config,
	│  │    // typically including random ports (host ...:0), auto invert, and open browser.
	│  │  }
	│  │  // `BackgroundPreviewOpts`
	│  │  background?: {
	│  │    enabled?: boolean,
	│  │    args?: string[]
	│  │  }
	│  │  // when to refresh preview rendering
	│  │  refresh?: "never" | "onSave" | "onType" | "onDocumentHasTitle"
	│  │  // partial rendering switch
	│  │  partialRendering?: boolean
	│  │  // preview color inversion strategy
	│  │  invertColors?:
	│  │    | "never"
	│  │    | "auto"
	│  │    | "always"
	│  │    | {
	│  │        rest?: "never" | "auto" | "always",
	│  │        image?: "never" | "auto" | "always"
	│  │      }
	│  │ }
	│  ├─ typstExtraArgs?: string[]
	│  ├─ hoverPeriscope?: "enable" | "disable" | null | {
	│  │    yAbove?: number,
	│  │    yBelow?: number,
	│  │    scale?: number,
	│  │    invertColor?: "auto" | "always" | "never"
	│  │  }
	│  └─ (extra keys) ignored unless recognized by Tinymist config parser



Difference between capabilities/textDocument and initializationOptions

LSP capabilities (under initialize.params.capabilities.textDocument...) are standard protocol feature negotiation: “what the client can understand.”
Tinymist initializationOptions are server configuration knobs: “how Tinymist should behave.”
So, for hover:

capabilities.textDocument.hover.contentFormat says client prefers markdown/plaintext.
initializationOptions.supportHtmlInMarkdown and hoverPeriscope control whether Tinymist includes richer hover content/images.


	├─ trace?: "off" | "messages" | "verbose"
	└─ capabilities
		├─ workspace?
		│  ├─ applyEdit?: boolean
		│  ├─ workspaceEdit?
		│  │  ├─ documentChanges?: boolean
		│  │  ├─ resourceOperations?: [ "create" | "rename" | "delete" ]
		│  │  ├─ failureHandling?: "abort" | "transactional" | "textOnlyTransactional" | "undo"
		│  │  ├─ normalizesLineEndings?: boolean
		│  │  └─ changeAnnotationSupport?: { groupsOnLabel?: boolean }
		│  ├─ didChangeConfiguration?: { dynamicRegistration?: boolean }
		│  ├─ didChangeWatchedFiles?: { dynamicRegistration?: boolean }
		│  ├─ symbol?
		│  │  ├─ dynamicRegistration?: boolean
		│  │  ├─ symbolKind?: { valueSet?: number[] }
		│  │  ├─ tagSupport?: { valueSet: number[] }
		│  │  └─ resolveSupport?: { properties: string[] }
		│  ├─ executeCommand?: { dynamicRegistration?: boolean }
		│  ├─ workspaceFolders?: boolean
		│  ├─ configuration?: boolean
		│  ├─ semanticTokens?: { refreshSupport?: boolean }
		│  ├─ codeLens?: { refreshSupport?: boolean }
		│  └─ fileOperations?
		│     ├─ dynamicRegistration?: boolean
		│     ├─ didCreate?: { filters: [ { scheme?: string, pattern: { glob: string, matches?: "file" | "folder" } } ] }
		│     ├─ didRename?: { filters: [ { scheme?: string, pattern: { glob: string, matches?: "file" | "folder" } } ] }
		│     ├─ didDelete?: { filters: [ { scheme?: string, pattern: { glob: string, matches?: "file" | "folder" } } ] }
		│     ├─ willCreate?: { filters: [ { scheme?: string, pattern: { glob: string, matches?: "file" | "folder" } } ] }
		│     ├─ willRename?: { filters: [ { scheme?: string, pattern: { glob: string, matches?: "file" | "folder" } } ] }
		│     └─ willDelete?: { filters: [ { scheme?: string, pattern: { glob: string, matches?: "file" | "folder" } } ] }
		├─ textDocument?
		│  ├─ textDocumentSync?
		│  │  ├─ openClose?: boolean
		│  │  ├─ change?: 0 | 1 | 2
		│  │  ├─ willSave?: boolean
		│  │  ├─ willSaveWaitUntil?: boolean
		│  │  └─ save?: boolean | { includeText?: boolean }
		│  ├─ synchronization?
		│  │  ├─ dynamicRegistration?: boolean
		│  │  ├─ willSave?: boolean
		│  │  ├─ willSaveWaitUntil?: boolean
		│  │  └─ didSave?: boolean
		│  ├─ completion?
		│  │  ├─ dynamicRegistration?: boolean
		│  │  ├─ completionItem?
		│  │  │  ├─ snippetSupport?: boolean
		│  │  │  ├─ commitCharactersSupport?: boolean
		│  │  │  ├─ documentationFormat?: string[]
		│  │  │  ├─ deprecatedSupport?: boolean
		│  │  │  ├─ preselectSupport?: boolean
		│  │  │  ├─ tagSupport?: { valueSet: number[] }
		│  │  │  ├─ insertReplaceSupport?: boolean
		│  │  │  ├─ resolveSupport?: { properties: string[] }
		│  │  │  ├─ insertTextModeSupport?: { valueSet: number[] }
		│  │  │  └─ labelDetailsSupport?: boolean
		│  │  ├─ completionItemKind?: { valueSet?: number[] }
		│  │  └─ contextSupport?: boolean
		│  ├─ hover?: { dynamicRegistration?: boolean, contentFormat?: string["markdown"/"plaintext"] }
		│  ├─ signatureHelp?
		│  │  ├─ dynamicRegistration?: boolean
		│  │  ├─ signatureInformation?
		│  │  │  ├─ documentationFormat?: string[]
		│  │  │  ├─ parameterInformation?: { labelOffsetSupport?: boolean }
		│  │  │  └─ activeParameterSupport?: boolean
		│  │  └─ contextSupport?: boolean
		│  ├─ definition?: { dynamicRegistration?: boolean, linkSupport?: boolean }
		│  ├─ references?: { dynamicRegistration?: boolean }
		│  ├─ documentHighlight?: { dynamicRegistration?: boolean }
		│  ├─ documentSymbol?
		│  │  ├─ dynamicRegistration?: boolean
		│  │  ├─ symbolKind?: { valueSet?: number[] }
		│  │  ├─ hierarchicalDocumentSymbolSupport?: boolean
		│  │  ├─ tagSupport?: { valueSet: number[] }
		│  │  └─ labelSupport?: boolean
		│  ├─ codeAction?
		│  │  ├─ dynamicRegistration?: boolean
		│  │  ├─ codeActionLiteralSupport?: { codeActionKind: { valueSet: string[] } }
		│  │  ├─ isPreferredSupport?: boolean
		│  │  ├─ disabledSupport?: boolean
		│  │  ├─ dataSupport?: boolean
		│  │  ├─ resolveSupport?: { properties: string[] }
		│  │  └─ honorsChangeAnnotations?: boolean
		│  ├─ codeLens?: { dynamicRegistration?: boolean }
		│  ├─ documentLink?: { dynamicRegistration?: boolean, tooltipSupport?: boolean }
		│  ├─ documentColor?: { dynamicRegistration?: boolean }
		│  ├─ formatting?: { dynamicRegistration?: boolean }
		│  ├─ rangeFormatting?: { dynamicRegistration?: boolean }
		│  ├─ onTypeFormatting?: { dynamicRegistration?: boolean }
		│  ├─ rename?: { dynamicRegistration?: boolean, prepareSupport?: boolean, prepareSupportDefaultBehavior?: number, honorsChangeAnnotations?: boolean }
		│  ├─ foldingRange?: { dynamicRegistration?: boolean, rangeLimit?: number, lineFoldingOnly?: boolean }
		│  ├─ selectionRange?: { dynamicRegistration?: boolean }
		│  ├─ semanticTokens?
		│  │  ├─ dynamicRegistration?: boolean
		│  │  ├─ requests?: { range?: boolean, full?: boolean | { delta?: boolean } }

                range?: true → client can call textDocument/semanticTokens/range (tokens for a range).
                full?: true → client can call textDocument/semanticTokens/full (all tokens).
                full?: { delta?: true } → client can call textDocument/semanticTokens/full with delta updates, enabling textDocument/semanticTokens/full/delta to send only changes.

                If delta enabled you still need to request.  The server won’t push semantic token deltas by itself. Flow:
                On open or after invalidation: - textDocument/semanticTokens/full. Save resultId.
                On update: - textDocument/semanticTokens/full/delta with previousResultId.
                Delta request shape:
                request("textDocument/semanticTokens/full/delta", { textDocument: { uri }, previousResultId: "..." })
                Server returns either: SemanticTokensDelta with edits, or full SemanticTokens with a new resultId if it can’t compute a delta.

                Formats: LSP only defines relative (default). The server returns data: number[] in groups of 5:

                [deltaLine, deltaStart, length, tokenType, tokenModifiers, ...]

                Decoding:

                Maintain current line and startChar.
                line += deltaLine
                If deltaLine == 0, startChar += deltaStart; else startChar = deltaStart
                length is in UTF‑16 code units.
                tokenType is an index into the legend’s tokenTypes.
                tokenModifiers is a bitset index into tokenModifiers.
                For deltas, apply edits to the data array per SemanticTokensDelta edits, then decode as above.

		│  │  ├─ tokenTypes?: string[]
		│  │  ├─ tokenModifiers?: string[]
		│  │  ├─ formats?: string[]
		│  │  ├─ overlappingTokenSupport?: boolean
		│  │  ├─ multilineTokenSupport?: boolean
		│  │  ├─ serverCancelSupport?: boolean
		│  │  └─ augmentsSyntaxTokens?: boolean
		│  ├─ publishDiagnostics?  (LSP 3.15+ as part of capabilities.textDocument.publishDiagnostics)
		│  │  ├─ relatedInformation?: boolean
		│  │  ├─ tagSupport?: { valueSet: number[] }
		│  │  ├─ versionSupport?: boolean
		│  │  ├─ codeDescriptionSupport?: boolean
		│  │  └─ dataSupport?: boolean
		│  ├─ inlayHint?: { dynamicRegistration?: boolean, resolveSupport?: { properties: string[] } }
		│  ├─ typeHierarchy?: { dynamicRegistration?: boolean }
		│  ├─ callHierarchy?: { dynamicRegistration?: boolean }
		│  ├─ linkedEditingRange?: { dynamicRegistration?: boolean }
		│  ├─ moniker?: { dynamicRegistration?: boolean }
		│  ├─ inlineValue?: { dynamicRegistration?: boolean }
		│  └─ diagnostic?: { dynamicRegistration?: boolean, relatedDocumentSupport?: boolean }
		├─ notebookDocument?
		│  └─ synchronization?
		│     ├─ dynamicRegistration?: boolean
		│     └─ executionSummarySupport?: boolean
		├─ window?
		│  ├─ workDoneProgress?: boolean
		│  ├─ showMessage?: { messageActionItem?: { additionalPropertiesSupport?: boolean } }
		│  └─ showDocument?: { support?: boolean }
		├─ general?
		│  ├─ regularExpressions?: { engine: string, version?: string }
		│  ├─ markdown?: { parser: string, version?: string }
		│  └─ positionEncodings?: string[]
		└─ experimental?: any
```

## Notifications Diagram (expanded)

```log
LSP standard
├─ initialized
│  └─ params: {}
├─ exit
│  └─ params: {}
├─ textDocument/didOpen
│  └─ params
│     ├─ textDocument
│     │  ├─ uri: string
│     │  ├─ languageId: string
│     │  ├─ version: number
│     │  └─ text: string
│     └─ workDoneToken?: string|number
├─ textDocument/didChange
│  └─ params
│     ├─ textDocument
│     │  ├─ uri: string
│     │  └─ version: number
│     ├─ contentChanges: [ { range?, rangeLength?, text } ]
│     └─ workDoneToken?: string|number
├─ textDocument/didSave
│  └─ params
│     ├─ textDocument: { uri: string }
│     ├─ text?: string
│     └─ workDoneToken?: string|number
├─ textDocument/didClose
│  └─ params
│     ├─ textDocument: { uri: string }
│     └─ workDoneToken?: string|number
├─ textDocument/publishDiagnostics
│  └─ params
│     ├─ uri: string
│     ├─ diagnostics: [Diagnostic]
│     └─ version?: number
├─ workspace/didChangeConfiguration
│  └─ params: { settings: any }
├─ workspace/didChangeWorkspaceFolders
│  └─ params
│     └─ event
│        ├─ added: [ { uri, name } ]
│        └─ removed: [ { uri, name } ]
├─ workspace/didChangeWatchedFiles
│  └─ params
│     └─ changes: [ { uri: string, type: 1|2|3 } ]
├─ workspace/didCreateFiles
│  └─ params
│     ├─ files: [ { uri: string } ]
│     └─ _???: (implementation-specific)
├─ workspace/didRenameFiles
│  └─ params
│     ├─ files: [ { oldUri: string, newUri: string } ]
│     └─ _???: (implementation-specific)
├─ workspace/didDeleteFiles
│  └─ params
│     ├─ files: [ { uri: string } ]
│     └─ _???: (implementation-specific)
├─ window/showMessage
│  └─ params: { type: 1|2|3|4, message: string }
├─ window/logMessage
│  └─ params: { type: 1|2|3|4, message: string }
├─ $/progress
│  └─ params: { token: string|number, value: any }
└─ $/logTrace
	└─ params: { message: string, verbose?: string }

Tinymist-specific
├─ tinymist/compileStatus
│  └─ params: { status, path, pageCount, wordsCount }
├─ tinymist/preview/dispose
│  └─ params: { taskId }
├─ tinymist/preview/scrollSource
│  └─ params: { filepath, start, end }
├─ tinymist/documentOutline
│  └─ params: Outline
└─ tinymist/devEvent
	└─ params: { type, ... }
```

```js
// First request (full)
// Request:
{
    "jsonrpc":"2.0",
    "id":1,
    "method":"textDocument/semanticTokens/full",
    "params":{
        "textDocument":{
            "uri":"file:///path/doc.typ"
        }
    }
}

//Reply:
{
    "jsonrpc":"2.0",
    "id":1,"result":{
        "resultId":"v1",
        "data":[0,0,5,3,0,0,6,4,1]
    }
}

// Second request (delta, successful)
// Request:
{
    "jsonrpc":"2.0",
    "id":2,
    "method":"textDocument/semanticTokens/full/delta",
    "params":{
        "textDocument":{
            "uri":"file:///path/doc.typ"
        },
        "previousResultId":"v1"
    }
}

// Reply:
{
    "jsonrpc":"2.0",
    "id":2,
    "result":{
        "resultId":"v2",
        "edits":[
            {"start":5,"deleteCount":5,"data":[0,10,3,2,0]}
        ]
    }
}

// Third request (delta can’t be computed → full returned)
// Request:
{
    "jsonrpc":"2.0",
    "id":3,
    "method":"textDocument/semanticTokens/full/delta",
    "params":{
        "textDocument":{
            "uri":"file:///path/doc.typ"
        },
        "previousResultId":"v2"
    }
}

// Reply:
{
    "jsonrpc":"2.0",
    "id":3,
    "result":{
        "resultId":"v3",
        "data":[0,0,4,1,0,0,5,2,0]
    }
}
```

### textDocument/publishDiagnostics

params shape (LSP 3.17):

```js
{
    uri: string
    version?: number
    diagnostics: [
        {
            range: { start: { line, character }, end: { line, character } }
            severity?: 1|2|3|4 (Error/Warning/Info/Hint)
            code?: number|string
            codeDescription?: { href: string }
            source?: string
            message: string
            tags?: number[] (1=Unnecessary, 2=Deprecated)
            relatedInformation?: [{ location: { uri, range }, message }]
            data?: any
        }, ...
    ]
}
```

### textDocument/inlayHint

```js
// Request
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "textDocument/inlayHint",
  "params": {
    "textDocument": {
      "uri": "file:///path/to/main.typ"
    },
    "range": {
      "start": { "line": 10, "character": 0 }, //  0-based line/character
      "end":   { "line": 30, "character": 120 }
    }
  }
}

// Reply

{
  "jsonrpc": "2.0",
  "id": 42,
  "result": [
    {
      "position": { "line": 12, "character": 14 },
      "label": "fill:",
      "kind": 2,
      "paddingRight": true
    },
    {
      "position": { "line": 18, "character": 8 },
      "label": "..args:",
      "kind": 2,
      "paddingRight": true // paddingRight: true means render a small space after the hint.
    }
  ]
}

// #rect(red, 20pt, 10pt) -> #rect(fill: red, width: 20pt, height: 10pt)
// #foo(..args: bar, baz, qux)
```

### textDocument/hover

hover-on-cursor/mouse pause, F12 for definition, Shift+F12 for references, visible CodeLens refresh, viewport/range updates for inlay hints.

```js
// Minimal init ??

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "processId": null,
    "rootUri": "file:///workspace",
    "capabilities": {
      "textDocument": {
        "hover": { "contentFormat": ["markdown", "plaintext"] }
      }
    },
    "initializationOptions": {
      "tinymist": {
        "supportHtmlInMarkdown": true,
        "supportClientCodelens": true,
        "supportExtendedCodeAction": true,
        "customizedShowDocument": true,
        "delegateFsRequests": false,
        "triggerSuggest": true,
        "triggerParameterHints": true,
        "triggerSuggestAndParameterHints": true,
        "hoverPeriscope": "enable"
      }
    }
  }
}
// Change later
{
  "jsonrpc": "2.0",
  "method": "workspace/didChangeConfiguration",
  "params": {
    "settings": {
      "tinymist": {
        "hoverPeriscope": {
          "yAbove": 55,
          "yBelow": 55,
          "scale": 1.5,
          "invertColor": "auto"
        }
      }
    }
  }
}


// Request
{
  "jsonrpc": "2.0",
  "id": 1001,
  "method": "textDocument/hover",
  "params": {
    "textDocument": {
      "uri": "file:///workspace/main.typ"
    },
    "position": {
      "line": 12,
      "character": 8
    },
    "workDoneToken": "optional-progress-token"
  }
}

// Responses

{
  "jsonrpc": "2.0",
  "id": 1001,
  "result": {  // can be null
    "contents": "...", // required if result provided
    "range": { // optional
      "start": { "line": 12, "character": 5 },
      "end":   { "line": 12, "character": 14 }
    }
  }
}

// Contents variants
// Content is assembled from multiple parts:
// definition/type snippet, sampled value tooltip, previews/docs, and action links;
// then joined into one markdown string separated by ---

// The image is embedded inside contents markdown text
// Tinymist currently builds hover as HoverContents::Scalar(MarkedString::String(...)) in hover.rs:73-77.
// Periscope image markdown is generated as ![Periscope Mode](data:image/svg+xml;base64,...|width=...|height=...) in lib.rs:85-91.

"contents": {
    "kind": "markdown",
    "value": "### rect\n`rect(width, height, fill, ..args)`\n\nDraws a rectangle."
}

"contents": {
    "kind": "plaintext",
    "value": "rect(width, height, fill, ..args)\nDraws a rectangle."
}

"contents": "rect(width, height, fill, ..args)\nDraws a rectangle."

"contents": {
    "language": "typc",
    "value": "let x: length = 10pt;"
}

"contents": [
    { "language": "typc", "value": "let x: length = 10pt;" },
    "x is inferred from #rect(...) argument context"
]
```

### textDocument/definition

```js
// Request
{
  "jsonrpc": "2.0",
  "id": 2001,
  "method": "textDocument/definition",
  "params": {
    "textDocument": { "uri": "file:///workspace/main.typ" },
    "position": { "line": 15, "character": 9 }
  }
}

// Reply
{
  "jsonrpc": "2.0",
  "id": 2001,
  "result": [
    {
      "originSelectionRange": { "start": { "line": 15, "character": 5 }, "end": { "line": 15, "character": 12 } },
      "targetUri": "file:///workspace/lib.typ",
      "targetRange": { "start": { "line": 40, "character": 0 }, "end": { "line": 52, "character": 1 } },
      "targetSelectionRange": { "start": { "line": 40, "character": 4 }, "end": { "line": 40, "character": 12 } }
    }
  ]
}
```

### textDocument/references

```js
// Request
{
  "jsonrpc": "2.0",
  "id": 2002,
  "method": "textDocument/references",
  "params": {
    "textDocument": { "uri": "file:///workspace/main.typ" },
    "position": { "line": 15, "character": 9 },
    "context": { "includeDeclaration": true }
  }
}

//Reply
{
  "jsonrpc": "2.0",
  "id": 2002,
  "result": [
    { "uri": "file:///workspace/main.typ", "range": { "start": { "line": 15, "character": 5 }, "end": { "line": 15, "character": 12 } } },
    { "uri": "file:///workspace/section.typ", "range": { "start": { "line": 8, "character": 2 }, "end": { "line": 8, "character": 9 } } }
  ]
}
```

### textDocument/codeLens

```js
// Request
{
  "jsonrpc": "2.0",
  "id": 2003,
  "method": "textDocument/codeLens",
  "params": {
    "textDocument": { "uri": "file:///workspace/main.typ" }
  }
}

// Reply
{
  "jsonrpc": "2.0",
  "id": 2003,
  "result": [
    {
      "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } },
      "command": { "title": "Preview", "command": "tinymist.runCodeLens", "arguments": ["preview"] }
    },
    {
      "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 0 } },
      "command": { "title": "Export", "command": "tinymist.runCodeLens", "arguments": ["export"] }
    }
  ]
}

```

#### CodeLens Commands

Tinymist server emits CodeLens entries with command tinymist.runCodeLens and one argument (profile, preview, export, export-html, export-pdf, more) in code_lens.rs:28-67.
VS Code extension handles them in commandRunCodeLens in extension.ts:544-635.
What Each One Does

profile → runs tinymist.profileCurrentFile (profiles current file compile/perf).
preview → runs typst-preview.preview (opens/refreshes preview).
export → runs tinymist.openExportTool (opens export UI/tool picker).
export-html → calls export flow for HTML (commandShow("Html")).
export-pdf → calls export flow for PDF (commandShow("Pdf")).
more → opens a Quick Pick with extra actions (browsing preview, preview in tab/browser doc/slide mode, profile server, plus quick export shortcuts) in extension.ts:573-635.

#### Fallback Behavior

If client-side CodeLens handling is disabled (supportClientCodelens=false), server sends direct commands (tinymist.exportPdf / tinymist.exportHtml) instead of tinymist.runCodeLens in code_lens.rs:69-92, controlled by config in config.rs:92-97.

### Completion

```js
// Initiation
// ValueSet from LSP specification
1 Text, 2 Method, 3 Function, 4 Constructor, 5 Field, 6 Variable, 7 Class, 8 Interface, 9 Module, 10 Property,
11 Unit, 12 Value, 13 Enum, 14 Keyword, 15 Snippet, 16 Color, 17 File, 18 Reference, 19 Folder, 20 EnumMember,
21 Constant, 22 Struct, 23 Event, 24 Operator, 25 TypeParameter

{
  "capabilities": {
    "textDocument": {
      "completion": {
        "dynamicRegistration": true,
        "contextSupport": true,
        "completionItem": {
          "snippetSupport": true,
          "commitCharactersSupport": true,
          "documentationFormat": ["markdown", "plaintext"],
          "deprecatedSupport": true,
          "preselectSupport": true,
          "tagSupport": { "valueSet": [1] },
          "insertReplaceSupport": true,
          "resolveSupport": {
            "properties": [
              "documentation",
              "detail",
              "additionalTextEdits"
            ]
          },
          "insertTextModeSupport": { "valueSet": [1, 2] },
          "labelDetailsSupport": true
        },
        "completionItemKind": {
          "valueSet": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25]
        }
      }
    }
  }
}

// Request
{
  "jsonrpc": "2.0",
  "id": 101,
  "method": "textDocument/completion",
  "params": {
    "textDocument": { "uri": "file:///C:/work/main.typ" },
    "position": { "line": 12, "character": 7 },
    "context": {
      "triggerKind": 1, // 1 = invoked (manual or automatic in many editors) 2 = trigger character 3 = retrigger for incomplete list
      "triggerCharacter": "#" // Server trigger chars include: # ( < , . : / " @
    },
    "workDoneToken": "optional",
    "partialResultToken": "optional"
  }
}

// Reply

{
  "jsonrpc": "2.0",
  "id": 101,
  "result": {
    "isIncomplete": false,
    "items": [
      {
        "label": "set",
        "labelDetails": { "detail": "(key, value)", "description": "std" },
        "kind": 3,
        "detail": "Function",
        "sortText": "0010_set",
        "filterText": "set",
        "insertText": "set(${1:key}, ${2:value})",
        "insertTextFormat": 2,
        "textEdit": {
          "range": {
            "start": { "line": 12, "character": 4 },
            "end": { "line": 12, "character": 7 }
          },
          "newText": "set(${1:key}, ${2:value})"
        },
        "additionalTextEdits": [],
        "command": {
          "title": "",
          "command": "editor.action.triggerParameterHints"
        }
      }
    ]
  }
}

```

#### From a user-story view, completion is this loop

- User types (for example #im or foo.).
- Editor decides whether to trigger completion (trigger char, manual Ctrl+Space, or retrigger while popup is open).
- Editor sends textDocument/completion with current uri, cursor position, and context (triggerKind, optional triggerCharacter).
- Tinymist analyzes the current document snapshot at that cursor and returns a CompletionList (items with label, kind, sort/filter text, and edit info).
- Editor shows the popup, ranks/filters items as user keeps typing.
- User selects an item.
- Editor applies textEdit (preferred) or insertText, then applies additionalTextEdits, then optional command.
- If needed, editor retriggers completion/signature help right after insertion.

### signatureHelp

context is optional.
triggerKind: 1=Invoked, 2=TriggerCharacter, 3=ContentChange.
triggerCharacter is valid when triggerKind=2.
activeSignatureHelp lets client send previous UI state so server can refine/keep selection.
ParameterInformation.label can be a string or a [start, end] UTF-16 offset range into signature label.

```js

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "textDocument/signatureHelp",
  "params": {
    "textDocument": { "uri": "file:///path/doc.typ" },
    "position": { "line": 12, "character": 8 },

    "context": {
      "triggerKind": 1,
      "triggerCharacter": "(",
      "isRetrigger": false,
      "activeSignatureHelp": {
        "signatures": [
          {
            "label": "fn(a: int, b: str)",
            "documentation": "string | MarkupContent",
            "parameters": [
              { "label": "a: int", "documentation": "string | MarkupContent" },
              { "label": [4, 10], "documentation": "string | MarkupContent" }
            ],
            "activeParameter": 0
          }
        ],
        "activeSignature": 0,
        "activeParameter": 0
      }
    },

    "workDoneToken": "optional",
    "partialResultToken": "optional"
  }
}

// Reply
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "signatures": [
      {
        "label": "sum(a: int, b: int) -> int",
        "documentation": {
          "kind": "markdown",
          "value": "Adds two integers."
        },
        "parameters": [
          { "label": [4, 10], "documentation": "First operand" },
          { "label": [12, 18], "documentation": "Second operand" }
        ],
        "activeParameter": 1
      }
    ],
    "activeSignature": 0,
    "activeParameter": 1
  }
}
```

result can be null if no signature applies.
activeSignature and activeParameter are optional; if omitted, client defaults (typically first signature/parameter).
documentation supports plain string or MarkupContent (markdown/plaintext).
