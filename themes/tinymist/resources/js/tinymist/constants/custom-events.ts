import { ChangeSet } from "@codemirror/state";

export const tmEvents = {
    ActiveFileChange: "active-file-change",
    AllDisconnect: "all-disconnect",
    ConsoleLog: "console-log",
    ConsoleJumpToLocation: "console-jump-to-location",
    ConsoleToggle: "console-toggle",
    Control: "control",
    CursorScrollIntoViewToggle: "cursor-scroll-into-view-toggle",
    CursorSpotlightToggle: "cursor-spotlight-toggle",
    DataBinary: "data-binary",
    DataCursorPaths: "data-cursor-paths",
    DataCursorShow: "data-cursor-show",
    Destroy: "destroy",
    Diagnostics: "diagnostics",
    FallbackCompile: "fallback-compile",
    FallbackCompiledSvg: "fallback-compiled-svg",
    FallbackEnable: "fallback-enable",
    FileSyncAck: "file-sync-ack",
    FileDirtyState: "file-dirty-state",
    FilesDirtyUpdated: "files-dirty-updated",
    FilesUpdated: "files-updated",
    Insert: "insert",
    InvalidToken: "invalid-token",
    LspSemanticTokens: "lsp-semantic-tokens",
    LspSemanticTokensDelta: "lsp-semantic-tokens-delta",
    OnlineStatus: "online-status",
    PreviewConnect: "preview-connect",
    PreviewConnectionState: "preview-connection-state",
    PreviewConnectionToggle: "preview-connection-toggle",
    PreviewControlMessage: "preview-control-message",
    PreviewCursorRequest: "preview-cursor-request",
    PreviewCursorPosition: "preview-cursor-position",
    PreviewDataMessage: "preview-data-message",
    PreviewDisconnect: "preview-disconnect",
    PreviewDocumentUpdated: "preview-document-updated",
    PreviewSendControl: "preview-send-control",
    PreviewSendData: "preview-send-data",
    PruneSnapshots: "prune-snapshots",
    ReconnectAllowed: "reconnect-allowed",
    RenderVersion: "render-version",
    ResetFile: "reset-file",
    SearchReplaceOpen: "search-replace-open",
    SearchReplaceClose: "search-replace-close",
    SyncRemoteChanges: "sync-remote-changes",
    Status: "status",
    SyncConnect: "sync-connect",
    SyncDisconnect: "sync-disconnect",
    SyncFullState: "sync-full-state",
    SyncOpenFile: "sync-open-file",
    EntryTextModified: "entry-text-modified",
    TextModified: "text-modified",
    TextDiff: "text-diff",
    ThemeSettingsOpen: "theme-settings-open",
    TokenRenewed: "token-renewed",
    VersionedCursorRequest: "versioned-cursor-request",
    WasmDispose: "wasm-dispose",
    WasmInit: "wasm-init",
} as const;

export type TinymistConsoleLocation = {
    fileName?: string;
    line: number;
    character: number;
    endLine?: number;
    endCharacter?: number;
};

export type TinymistControlEventPayload =
    | { event: "UpdateMemoryFiles" | "SyncMemoryFiles"; filepath: string; content: string }
    | { event: "removeMemoryFiles"; filepath: string }
    | { event: "changeCursorPosition"; fileName: string; line: number; character: number }
    | { event: "panelScrollTo"; line: number; character: number }
    | { event: "sourceScrollBySpan"; span: string }
    | { event: "panelScrollByPosition"; position: number };

export type SemanticTokensDeltaEdit = {
    start: number;
    deleteCount: number;
    data?: number[];
};

export type DiagnosticsPayload =         {
        range: { start: { line: number, character: number }, end: { line: number, character: number } }
        severity?: 1|2|3|4 // (Error/Warning/Info/Hint)
        code?: number|string
        codeDescription?: { href: string }
        source?: string
        message: string
        tags?: number[] // (1=Unnecessary, 2=Deprecated)
        relatedInformation?: [{ location: { uri: string, range: { start: { line: number, character: number }, end: { line: number, character: number } } }, message: string }]
        data?: any
    }[];

export type TinymistEventPayloads = {
    [tmEvents.ActiveFileChange]: { fileName: string; url: string };
    [tmEvents.AllDisconnect]: undefined;
    [tmEvents.ConsoleLog]: { type: "error" | "warning" | "info" | "success" | "hint"; message: string; details?: unknown; location?: TinymistConsoleLocation };
    [tmEvents.ConsoleJumpToLocation]: TinymistConsoleLocation;
    [tmEvents.ConsoleToggle]: boolean;
    [tmEvents.Control]: TinymistControlEventPayload;
    [tmEvents.CursorScrollIntoViewToggle]: { enabled: boolean; activeFile: string; userEnabled: boolean };
    [tmEvents.CursorSpotlightToggle]: { enabled?: boolean; activeFile?: string; userEnabled?: boolean };
    [tmEvents.DataBinary]: { command: string; payload: Uint8Array };
    [tmEvents.DataCursorPaths]: unknown;
    [tmEvents.DataCursorShow]: undefined;
    [tmEvents.Destroy]: undefined;
    [tmEvents.Diagnostics]: { fileName?: string; diagnostics: DiagnosticsPayload; docVersion?: number };
    [tmEvents.FallbackCompile]: { docVersion: number; content: string };
    [tmEvents.FallbackCompiledSvg]: { svg: string; docVersion?: number | string };
    [tmEvents.FallbackEnable]: boolean;
    [tmEvents.FileSyncAck]: { timestamp: number; fileName: string; docVersion: number };
    [tmEvents.FileDirtyState]: { fileName: string; isDirty: boolean };
    [tmEvents.FilesDirtyUpdated]: { dirtyMap?: Record<string, boolean> };
    [tmEvents.FilesUpdated]: { files?: Record<string, string> };
    [tmEvents.Insert]: { typst?: string; markdown?: string; html?: string };
    [tmEvents.InvalidToken]: undefined;
    [tmEvents.LspSemanticTokens]: { fileName: string; tokens: number[]; resultId?: string; docVersion: number };
    [tmEvents.PreviewDocumentUpdated]: { pdfPagesCount: number };
    [tmEvents.LspSemanticTokensDelta]: { fileName: string; edits: SemanticTokensDeltaEdit[]; resultId?: string; previousResultId?: string; docVersion: number };
    [tmEvents.OnlineStatus]: boolean;
    [tmEvents.PreviewConnect]: undefined;
    [tmEvents.PreviewConnectionState]: { label: "paused" | "running" | "connecting" };
    [tmEvents.PreviewConnectionToggle]: undefined;
    [tmEvents.PreviewControlMessage]: string;
    [tmEvents.PreviewCursorRequest]: { uniqueTabId?: string };
    [tmEvents.PreviewCursorPosition]: { contentX: number; contentY: number; width: number; height: number };
    [tmEvents.PreviewDataMessage]: Uint8Array;
    [tmEvents.PreviewDisconnect]: undefined;
    [tmEvents.PreviewSendControl]: string;
    [tmEvents.PreviewSendData]: string | Uint8Array;
    [tmEvents.PruneSnapshots]: { fileName: string; docVersion: number };
    [tmEvents.ReconnectAllowed]: undefined;
    [tmEvents.RenderVersion]: {type: string;timestamp: number;fileName: string;docVersion: number;};
    [tmEvents.ResetFile]: { fileName?: string };
    [tmEvents.SearchReplaceOpen]: boolean;
    [tmEvents.SearchReplaceClose]: undefined;
    // It's a ChangeSet from another tab
    [tmEvents.SyncRemoteChanges]: { timestamp: number; fileName: string; docVersion: number; changes: ChangeSet };
    [tmEvents.Status]: { what: string; connected: boolean };
    [tmEvents.SyncConnect]: undefined;
    [tmEvents.SyncDisconnect]: undefined;
    [tmEvents.SyncFullState]: { timestamp: number; fileName: string; content: string; docVersion: number };
    [tmEvents.SyncOpenFile]: { fileName: string };
    [tmEvents.VersionedCursorRequest]: { docVersion: number; timestamp: number; request: { event: string; fileName: string; line: number; character: number } };
    [tmEvents.EntryTextModified]: string; // gets forwarded outside of Tinymist as "editor-tinymist-change" for auto-saving trigger
    [tmEvents.TextModified]: undefined; // for searchReplace to trigger without marking as changed
    [tmEvents.TextDiff]: { fileName: string; changes: ChangeSet; docVersion: number };
    [tmEvents.ThemeSettingsOpen]: undefined;
    [tmEvents.TokenRenewed]: string;
    [tmEvents.WasmDispose]: undefined;
    [tmEvents.WasmInit]: undefined;
};
