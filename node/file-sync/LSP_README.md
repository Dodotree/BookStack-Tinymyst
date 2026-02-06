
# LSP Initialize Request Diagram

Initialize request (JSON-RPC) tree (expanded):

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
	├─ initializationOptions?: any
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
		│  ├─ hover?: { dynamicRegistration?: boolean, contentFormat?: string[] }
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

# Notifications Diagram (expanded)

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
