export const tmEvents = {
    ActiveFileChange: "active-file-change",
    AllDisconnect: "all-disconnect",
    ConsoleLog: "console-log",
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
    PreviewConnect: "preview-connect",
    PreviewControlMessage: "preview-control-message",
    PreviewCursorPosition: "preview-cursor-position",
    PreviewDataMessage: "preview-data-message",
    PreviewDisconnect: "preview-disconnect",
    PreviewSendControl: "preview-send-control",
    PreviewSendData: "preview-send-data",
    PruneSnapshots: "prune-snapshots",
    ResetFile: "reset-file",
    SyncRemoteChanges: "sync-remote-changes",
    Status: "status",
    SyncConnect: "sync-connect",
    SyncDisconnect: "sync-disconnect",
    SyncFullState: "sync-full-state",
    SyncOpenFile: "sync-open-file",
    TextChange: "text-change",
    TextDiff: "text-diff",
    ThemeSettingsOpen: "theme-settings-open",
    TokenRenewed: "token-renewed",
    VersionedCursorRequest: "versioned-cursor-request",
    WasmDispose: "wasm-dispose",
    WasmInit: "wasm-init",
} as const;

export type TinymistControlEventPayload =
    | { event: "UpdateMemoryFiles" | "SyncMemoryFiles"; filepath: string; content: string }
    | { event: "removeMemoryFiles"; filepath: string }
    | { event: "changeCursorPosition"; fileName: string; line: number; character: number }
    | { event: "panelScrollTo"; line: number; character: number }
    | { event: "sourceScrollBySpan"; span: string }
    | { event: "panelScrollByPosition"; position: number };

export type TinymistEventPayloads = {
    [tmEvents.ActiveFileChange]: { fileName: string; url: string };
    [tmEvents.AllDisconnect]: undefined;
    [tmEvents.ConsoleLog]: { type: "error" | "warning" | "info" | "success" | "hint"; message: string; details?: unknown };
    [tmEvents.ConsoleToggle]: boolean;
    [tmEvents.Control]: TinymistControlEventPayload;
    [tmEvents.CursorScrollIntoViewToggle]: { enabled: boolean; activeFile: string; userEnabled: boolean };
    [tmEvents.CursorSpotlightToggle]: { enabled?: boolean; activeFile?: string; userEnabled?: boolean };
    [tmEvents.DataBinary]: { command: string; payload: Uint8Array };
    [tmEvents.DataCursorPaths]: unknown;
    [tmEvents.DataCursorShow]: undefined;
    [tmEvents.Destroy]: undefined;
    [tmEvents.Diagnostics]: { fileName?: string; diagnostics: any[]; docVersion?: number };
    [tmEvents.FallbackCompile]: { docVersion: number; content: string };
    [tmEvents.FallbackCompiledSvg]: { svg: string; docVersion?: number | string };
    [tmEvents.FallbackEnable]: boolean;
    [tmEvents.FileSyncAck]: { timestamp: number; fileName: string; docVersion: number };
    [tmEvents.FileDirtyState]: { fileName: string; isDirty: boolean };
    [tmEvents.FilesDirtyUpdated]: { dirtyMap?: Record<string, boolean> };
    [tmEvents.FilesUpdated]: { html?: string };
    [tmEvents.Insert]: { typst?: string; markdown?: string; html?: string };
    [tmEvents.InvalidToken]: undefined;
    [tmEvents.LspSemanticTokens]: { fileName: string; tokens: number[]; resultId?: string; docVersion: number };
    [tmEvents.LspSemanticTokensDelta]: { fileName: string; edits: any[]; resultId?: string; previousResultId?: string; docVersion: number };
    [tmEvents.PreviewConnect]: undefined;
    [tmEvents.PreviewControlMessage]: string;
    [tmEvents.PreviewCursorPosition]: { contentX: number; contentY: number; width: number; height: number };
    [tmEvents.PreviewDataMessage]: Uint8Array;
    [tmEvents.PreviewDisconnect]: undefined;
    [tmEvents.PreviewSendControl]: string;
    [tmEvents.PreviewSendData]: string | Uint8Array;
    [tmEvents.PruneSnapshots]: { fileName: string; docVersion: number };
    [tmEvents.ResetFile]: { fileName?: string };
    [tmEvents.SyncRemoteChanges]: { timestamp: number; fileName: string; docVersion: number; changes: any };
    [tmEvents.Status]: { what: string; connected: boolean };
    [tmEvents.SyncConnect]: undefined;
    [tmEvents.SyncDisconnect]: undefined;
    [tmEvents.SyncFullState]: { timestamp: number; fileName: string; content: string; docVersion: number };
    [tmEvents.SyncOpenFile]: { fileName: string };
    [tmEvents.VersionedCursorRequest]: { docVersion: number; request: { event: string; fileName: string; line: number; character: number } };
    [tmEvents.TextChange]: string;
    [tmEvents.TextDiff]: { fileName: string; changes: any; docVersion: number };
    [tmEvents.ThemeSettingsOpen]: undefined;
    [tmEvents.TokenRenewed]: string;
    [tmEvents.WasmDispose]: undefined;
    [tmEvents.WasmInit]: undefined;
};
