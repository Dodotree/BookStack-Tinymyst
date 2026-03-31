// UI Editor for Tinymist using CodeMirror
// Provides current content, emits change events, cursor position updates,
// observes semantic highlighting and diagnostics events and renders them.

import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLineGutter,
    highlightActiveLine,
} from "@codemirror/view";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { rebaseUpdates } from "@codemirror/collab";
import {
    ChangeSet,
    Compartment,
    EditorState,
    Transaction,
} from "@codemirror/state";
import { bracketMatching } from "@codemirror/language";

import {
    EditorToolbar,
    getLanguageExtensionForFile,
    getHighlightExtension,
    isImageFile,
} from "./editor-toolbar";
import { SemanticTokenProcessor, highlightField } from "./semantic-tokens";
import { DiagnosticsProcessor } from "./diagnostics";

import { ENTRY_FILE_NAME, tmEvents, tmSelectors } from "../constants";

type FileSnapshot = {
    docVersion: number;
    snapshot: string;
    afterTransactions: ChangeSet;
};

type FileSyncState = {
    fileName: string;
    docVersion: number;
    currentContent: string;
    savedContentHash: string;
    lastEmittedDirty: boolean;
    loaded: boolean;
    pendingSendTimer: ReturnType<typeof setTimeout> | null;
    snapshots: FileSnapshot[];
    cursorRequest?: { event: string; fileName: string; line: number; character: number };
};

export class TinymistEditorUI {
    editor: HTMLTextAreaElement;
    editorView: EditorView | null = null;
    private activeFileName: string = ENTRY_FILE_NAME;
    private fallbackEnabled: boolean = false;
    private isOffline: boolean = !navigator.onLine;

    private readonly languageCompartment = new Compartment();
    private readonly highlightCompartment = new Compartment();
    private readonly isDarkMode: boolean =
        document.documentElement.classList.contains("dark-mode");

    private readonly fileStates: Map<string, FileSyncState> = new Map();
    private readonly maxSnapshots: number = 3;
    private readonly changeDebounceMs: number = 150;
    private readonly fallbackDebounceMs: number = 800;
    private readonly collabClientId: string = `tinymist-${crypto.randomUUID()}`; // formality to distinguish local vs remote changes in rebase

    constructor() {
        this.editor = document.querySelector(
            tmSelectors.TextArea,
        ) as HTMLTextAreaElement;

        // Hook for diagnostics and semantic tokens to get editor state context for mapping
        this.getSnapshotContext = this.getSnapshotContext.bind(this);

        // Those are hooks for Bookstack's native form submission and for fallback mode
        this.getEntryText = this.getEntryText.bind(this);
        this.syncEntryContentToTextarea =
            this.syncEntryContentToTextarea.bind(this);

        this.onCodeMirrorUpdate = this.onCodeMirrorUpdate.bind(this);
        this.jumpToConsoleLocation = this.jumpToConsoleLocation.bind(this);

        this.setActiveFile = this.setActiveFile.bind(this);
        this.syncFullStateFromServer = this.syncFullStateFromServer.bind(this);
        this.syncRemoteChangesFromServer =
            this.syncRemoteChangesFromServer.bind(this);
        this.resetAttachmentFileFromServer =
            this.resetAttachmentFileFromServer.bind(this);
        this.pruneSnapshots = this.pruneSnapshots.bind(this);

        this.getEditorView = this.getEditorView.bind(this);
        this.getTextarea = this.getTextarea.bind(this);

        this.destroy = this.destroy.bind(this);

        this.setupCodeMirror();
        this.setupListeners();

        new EditorToolbar(this.getEditorView, this.getTextarea);
        new DiagnosticsProcessor(this.getEditorView, this.getSnapshotContext);
        new SemanticTokenProcessor(this.getEditorView, this.getSnapshotContext);

        this.resetSyncStateForFile({
            fileName: ENTRY_FILE_NAME,
            docVersion: 1,
            content: this.getCurrentEditorText(),
        });
    }

    private getEditorView(): EditorView | null {
        return this.editorView;
    }
    private getTextarea(): HTMLTextAreaElement {
        return this.editor;
    }

    private reconfigureEditorForFile(fileName: string): void {
        if (!this.editorView) {
            return;
        }

        this.editorView.dispatch({
            effects: [
                this.languageCompartment.reconfigure(
                    getLanguageExtensionForFile(fileName),
                ),
                this.highlightCompartment.reconfigure(
                    getHighlightExtension(this.isDarkMode),
                ),
            ],
        });
    }

    async setupCodeMirror() {
        try {
            // Create editor state
            const startState = EditorState.create({
                doc: this.editor.value,
                extensions: [
                    EditorView.lineWrapping,
                    lineNumbers(), // Enable line numbers
                    highlightActiveLineGutter(), // Highlight current line number in gutter
                    highlightActiveLine(), // Highlight current line
                    this.languageCompartment.of(
                        getLanguageExtensionForFile(this.activeFileName),
                    ),
                    this.highlightCompartment.of(
                        getHighlightExtension(this.isDarkMode),
                    ),
                    bracketMatching(), // Extension for bracket matching
                    highlightField, // Add custom highlighting support
                    history(), // Extension for undo/redo history
                    keymap.of([...historyKeymap, ...defaultKeymap]),
                    EditorView.editable.of(true), // Make editor editable
                    EditorView.updateListener.of(this.onCodeMirrorUpdate),
                ],
            });

            // Create editor view
            this.editorView = new EditorView({
                state: startState,
                parent: this.editor.parentElement!,
            });

            // Hide original textarea
            this.editor.style.display = "none";
        } catch (error) {
            this.editor.style.display = "block";
            this.editor.addEventListener("input", () => {
                window.$tmEventBus.emit(tmEvents.EntryTextModified, "");
            });
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "error",
                message: "[Editor] Failed to initialize CodeMirror editor",
                details: error,
            });
        }
    }

    setupListeners() {
        window.addEventListener("online", this.onBrowserOnline);
        window.addEventListener("offline", this.onBrowserOffline);

        window.$tmEventBus.listen(
            tmEvents.SyncFullState,
            this.syncFullStateFromServer,
        );
        window.$tmEventBus.listen(
            tmEvents.SyncRemoteChanges,
            this.syncRemoteChangesFromServer,
        );
        window.$tmEventBus.listen(tmEvents.PruneSnapshots, this.pruneSnapshots);
        window.$tmEventBus.listen(
            tmEvents.FallbackEnable,
            (enabled: boolean) => (this.fallbackEnabled = enabled),
        );
        window.$tmEventBus.listen(
            tmEvents.ActiveFileChange,
            this.setActiveFile,
        );
        window.$tmEventBus.listen(
            tmEvents.ResetFile,
            this.resetAttachmentFileFromServer,
        );
        window.$tmEventBus.listen(
            tmEvents.ConsoleJumpToLocation,
            this.jumpToConsoleLocation,
        );
    }

    public setActiveFile(payload: { fileName: string; url: string }): void {
        const { fileName, url } = payload;
        if (fileName === this.activeFileName) {
            return;
        }

        this.flushPendingChanges(this.activeFileName);
        this.activeFileName = fileName;

        if (isImageFile(fileName)) {
            return;
        }

        this.reconfigureEditorForFile(fileName);
        const state = this.getOrCreateFileState(fileName);

        if (state.loaded) {
            // In case it's already loaded by some chance
            this.setText(state.currentContent, true);
            return;
        }

        this.setText("", true);
        window.$tmEventBus.emit(tmEvents.SyncOpenFile, { fileName: fileName });
    }

    onCodeMirrorUpdate(update: any) {
        if (update.docChanged) {
            this.onDocumentChange(update.transactions);
        }
        if (update.selectionSet) {
            this.onCursorPositionChange(update.state);
        }
    }

    private jumpToConsoleLocation(payload: {
        fileName?: string;
        line: number;
        character: number;
    }): void {
        if (!this.editorView) {
            return;
        }

        if (payload.fileName && payload.fileName !== this.activeFileName) {
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "warning",
                message: `[Editor] Open ${payload.fileName} to navigate to this diagnostic`,
            });
            return;
        }

        const state = this.editorView.state;
        const safeLineNumber = Math.min(
            Math.max(1, payload.line || 1),
            state.doc.lines,
        );
        const line = state.doc.line(safeLineNumber);
        const safeCharacter = Math.max(1, payload.character || 1);
        const targetPos = Math.min(line.from + safeCharacter - 1, line.to);

        this.editorView.dispatch({
            selection: { anchor: targetPos },
            scrollIntoView: true,
        });
        this.editorView.focus();
    }

    onCursorPositionChange(updateState: any) {
        if (this.activeFileName !== ENTRY_FILE_NAME) {
            return;
        }

        // Get cursor position and line
        const pos = updateState.selection.main.head;
        const line = updateState.doc.lineAt(pos);
        const state = this.getOrCreateFileState(this.activeFileName);
        const request = {
                    event: "changeCursorPosition",
                    fileName: ENTRY_FILE_NAME,
                    line: line.number - 1, // 0-indexed
                    character: Math.max(0, pos - line.from - 1),
                };

        // Since diffs are debounced it doesn't make sense to ram the server with cursor updates on every keystroke
        if (!state.pendingSendTimer && !this.isOffline) {
            window.$tmEventBus.emit(tmEvents.VersionedCursorRequest, {
                docVersion: state.docVersion,
                timestamp: Date.now(),
                request
            });
            return;
        }
        // Will go out with the diff, only to be waiting in the control-plane
        // until diff render is confirmed and applied, then it will be queried
        state.cursorRequest = request;
    }

    onDocumentChange(transactions: readonly Transaction[]) {
        // In case search-replace is active
        window.$tmEventBus.emit(tmEvents.TextModified);

        if (this.activeFileName === ENTRY_FILE_NAME) {
            // goes to tinymist-editor.ts and there translated to BookStack event that content changed
            window.$tmEventBus.emit(tmEvents.EntryTextModified, "");
        }

        if (
            transactions.some(
                (tr) =>
                    tr.annotation(Transaction.userEvent) === "tinymist-sync",
            )
        ) {
            return;
        }

        const fileName = this.activeFileName;
        const state = this.getOrCreateFileState(fileName);
        state.currentContent = this.getCurrentEditorText();

        // Accumulates changes from transactions, eventually flushed to WebSocket server
        if (transactions.some((tr) => tr.docChanged)) {
            transactions.forEach((tr) => {
                if (tr.changes && !tr.changes.empty) {
                    const lastSnapshot = state.snapshots.at(-1);
                    if (lastSnapshot) {
                        lastSnapshot.afterTransactions = lastSnapshot.afterTransactions
                            ? lastSnapshot.afterTransactions.compose(tr.changes)
                            : tr.changes;
                    }
                }
            });
            this.schedulePendingFlush(fileName);
        }
    }

    // Debounced for furious typing
    private schedulePendingFlush(fileName: string): void {
        const state = this.getOrCreateFileState(fileName);

        if (state.pendingSendTimer) {
            clearTimeout(state.pendingSendTimer);
        }
        state.pendingSendTimer = setTimeout(
            () => {
                this.flushPendingChanges(fileName);
            },
            this.fallbackEnabled
                ? this.fallbackDebounceMs
                : this.changeDebounceMs,
        );
    }

    private flushAllPendingChanges(): void {
        for (const fileName of this.fileStates.keys()) {
            this.flushPendingChanges(fileName);
        }
    }

    private emitDirtyState(fileName: string, isDirty: boolean): void {
        window.$tmEventBus.emit(tmEvents.FileDirtyState, {
            fileName,
            isDirty,
        });
    }

    private flushPendingChanges(fileName: string): void {
        const state = this.getOrCreateFileState(fileName);

        if (state.pendingSendTimer) {
            clearTimeout(state.pendingSendTimer);
            state.pendingSendTimer = null;
        }

        const nextDirty =
            this.hashString(state.currentContent) !== state.savedContentHash;
        if (nextDirty !== state.lastEmittedDirty) {
            this.emitDirtyState(fileName, nextDirty);
        }
        state.lastEmittedDirty = nextDirty;

        const pendingChanges = state.snapshots.at(-1)?.afterTransactions;
        if (!pendingChanges || pendingChanges.empty) {
            // Happens only on early flash when files are switched
            // Nothing gives you nothing, no need to advance docVersion or send empty changes to the server
            return;
        }

        if (this.isOffline) {
            return;
        }

        state.docVersion += 1;

        // After applying changes, back end will be at current docVersion with current content
        if (this.fallbackEnabled && fileName === ENTRY_FILE_NAME) {
            window.$tmEventBus.emit(tmEvents.FallbackCompile, {
                content: state.currentContent,
                docVersion: state.docVersion,
            });
        } else if (!this.fallbackEnabled) {
            window.$tmEventBus.emit(tmEvents.TextDiff, {
                fileName,
                changes: pendingChanges,
                docVersion: state.docVersion,
            });

            if (state.cursorRequest) {
                window.$tmEventBus.emit(tmEvents.VersionedCursorRequest, {
                    docVersion: state.docVersion,
                    timestamp: Date.now(),
                    request: state.cursorRequest,
                });
            }
        }

        state.snapshots.push({
            docVersion: state.docVersion,
            snapshot: state.currentContent,
            afterTransactions: ChangeSet.empty(state.currentContent.length),
        });
        if (state.snapshots.length > this.maxSnapshots) {
            state.snapshots = state.snapshots.slice(-this.maxSnapshots);
        }
    }

    private getSnapshotContext(
        docVersion: number,
        fileName: string,
    ): { snapshot: string; changeSet: ChangeSet } {
        const state = this.getOrCreateFileState(fileName);
        const index = state.snapshots.findIndex(
            (s) => s.docVersion === docVersion,
        );
        if (index === -1) {
            console.error("[Editor] Snapshot not found", state);
            throw new Error(
                `No snapshot found for docVersion ${docVersion} in file ${fileName}`,
            );
        }
        let pending = state.snapshots[index].afterTransactions;
        for (let i = index + 1; i < state.snapshots.length; i++) {
            if (state.snapshots[i].afterTransactions) {
                pending = pending.compose(state.snapshots[i].afterTransactions);
            }
        }
        return {
            snapshot: state.snapshots[index].snapshot,
            changeSet: pending,
        };
    }

    private pruneSnapshots(payload: {
        fileName: string;
        docVersion: number;
    }): void {
        const state = this.getOrCreateFileState(payload.fileName);

        if (
            !Number.isFinite(payload.docVersion) ||
            state.snapshots.length === 0
        ) {
            return;
        }
        if (payload.docVersion > state.docVersion) {
            return;
        }

        // Leave at least one snapshot
        const pruned = state.snapshots.filter(
            (s) =>
                s.docVersion >=
                Math.min(payload.docVersion, state.docVersion - 1),
        );
        state.snapshots = pruned;
    }

    syncFullStateFromServer(payload: {
        content: string;
        docVersion: number;
        fileName: string;
    }) {
        if (payload.fileName === this.activeFileName) {
            const currentText = this.getCurrentEditorText();
            if (payload.content !== currentText) {
                this.setText(payload.content, true);
            }
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "info",
                message: `[Editor] Document ${payload.fileName} synchronized from server`,
            });
        }

        // Full sync can be dispatched for not active files as well
        this.resetSyncStateForFile(payload);
    }

    private resetSyncStateForFile(payload: {
        fileName: string;
        docVersion: number;
        content: string;
    }): void {
        const state = this.getOrCreateFileState(payload.fileName);
        state.docVersion = payload.docVersion;
        state.currentContent = payload.content;
        state.savedContentHash = this.hashString(payload.content);
        state.loaded = true;
        state.snapshots = [
            {
                docVersion: payload.docVersion,
                snapshot: payload.content,
                afterTransactions: ChangeSet.empty(payload.content.length),
            },
        ];
        if (state.pendingSendTimer) {
            clearTimeout(state.pendingSendTimer);
            state.pendingSendTimer = null;
        }
        state.lastEmittedDirty = false;
        this.emitDirtyState(payload.fileName, false);
    }

    private resetAttachmentFileFromServer(payload: {
        fileName?: string;
    }): void {
        const fileName = String(payload?.fileName || "").trim();
        if (!fileName || fileName === ENTRY_FILE_NAME) {
            return;
        }
        // will be reset after full sync comes from node server
        window.$tmEventBus.emit(tmEvents.SyncOpenFile, { fileName });
    }

    private syncRemoteChangesFromServer(payload: {
        fileName: string;
        docVersion: number;
        changes: unknown;
    }): void {

        // Sync with remote only files already loaded
        if (!this.fileStates.has(payload.fileName)) {
            return;
        }

        const state = this.getOrCreateFileState(payload.fileName);
        const nextDocVersion = Number(payload.docVersion);

        if (!Number.isFinite(nextDocVersion) || nextDocVersion < 1) {
            return;
        }

        let remoteChanges: ChangeSet;
        try {
            remoteChanges = ChangeSet.fromJSON(payload.changes);
        } catch (error) {
            console.error("[Editor] Failed to parse remote changes", {
                fileName: payload.fileName,
                docVersion: payload.docVersion,
                error,
            });
            window.$tmEventBus.emit(tmEvents.SyncOpenFile, {
                fileName: payload.fileName,
            });
            return;
        }

        const baseDocVersion = nextDocVersion - 1;
        const baseSnapshotIndex = state.snapshots.findIndex(
            (snapshot) => snapshot.docVersion === baseDocVersion,
        );

        if (baseSnapshotIndex === -1) {
            console.warn("[Editor] Missing base snapshot for remote merge", {
                fileName: payload.fileName,
                requestedDocVersion: nextDocVersion,
                availableSnapshots: state.snapshots.map(
                    (snapshot) => snapshot.docVersion,
                ),
            });
            window.$tmEventBus.emit(tmEvents.SyncOpenFile, {
                fileName: payload.fileName,
            });
            return;
        }

        const baseSnapshot = state.snapshots[baseSnapshotIndex];
        let localPending = ChangeSet.empty(baseSnapshot.snapshot.length);
        let hasLocalPending = false;

        for (let i = baseSnapshotIndex; i < state.snapshots.length; i++) {
            const snapshot = state.snapshots[i];
            if (!snapshot.afterTransactions.empty) {
                localPending = hasLocalPending
                    ? localPending.compose(snapshot.afterTransactions)
                    : snapshot.afterTransactions;
                hasLocalPending = true;
            }
        }

        const remoteDoc = remoteChanges.apply(
            EditorState.create({ doc: baseSnapshot.snapshot }).doc,
        );
        const syncedContent = remoteDoc.toString();
        const rebasedLocal = hasLocalPending
            ? (rebaseUpdates(
                  [{ changes: localPending, clientID: this.collabClientId }],
                  [{ changes: remoteChanges.desc, clientID: "remote" }],
              )[0]?.changes ?? ChangeSet.empty(remoteDoc.length))
            : ChangeSet.empty(remoteDoc.length);
        const finalContent = rebasedLocal.empty
            ? syncedContent
            : rebasedLocal.apply(remoteDoc).toString();
        const currentToFinal = hasLocalPending
            ? remoteChanges.map(localPending, true)
            : remoteChanges;

        if (state.pendingSendTimer) {
            clearTimeout(state.pendingSendTimer);
            state.pendingSendTimer = null;
        }

        state.docVersion = nextDocVersion;
        state.currentContent = finalContent;
        state.savedContentHash = this.hashString(syncedContent);
        state.loaded = true;
        state.snapshots = [
            {
                docVersion: nextDocVersion,
                snapshot: syncedContent,
                afterTransactions: rebasedLocal,
            },
        ];

        if (payload.fileName === this.activeFileName && this.editorView) {
            const currentText = this.editorView.state.doc.toString();
            const nextSelection =
                this.editorView.state.selection.map(currentToFinal);

            if (
                !currentToFinal.empty ||
                currentText !== finalContent ||
                !nextSelection.eq(this.editorView.state.selection)
            ) {
                this.editorView.dispatch({
                    changes: currentToFinal,
                    selection: nextSelection,
                    annotations: [
                        Transaction.addToHistory.of(false),
                        Transaction.remote.of(true),
                    ],
                });
            }
        }

        window.$tmEventBus.emit(tmEvents.ConsoleLog, {
            type: "info",
            message: `[Editor] Remote changes merged for ${payload.fileName}`,
        });
    }

    /**
     * Set editor content from file sync or because editor switched files.
     */
    setText(content: string, fromSync: boolean = false) {
        if (this.editorView) {
            this.editorView.dispatch({
                changes: {
                    from: 0,
                    to: this.editorView.state.doc.length,
                    insert: content,
                },
                annotations: fromSync
                    ? [
                          Transaction.userEvent.of("tinymist-sync"),
                          Transaction.addToHistory.of(false),
                      ]
                    : undefined,
            });
        } else {
            this.editor.value = content;
        }
    }

    /**
     * Simple string hash function for content comparison.
     */
    hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash.toString();
    }

    private getOrCreateFileState(fileName: string): FileSyncState {
        const existing = this.fileStates.get(fileName);
        if (existing) {
            return existing;
        }

        const currentContent =
            fileName === this.activeFileName ? this.getCurrentEditorText() : "";

        const created: FileSyncState = {
            fileName: fileName,
            docVersion: 1,
            currentContent: currentContent,
            savedContentHash: this.hashString(currentContent),
            lastEmittedDirty: false,
            loaded: fileName === this.activeFileName,
            pendingSendTimer: null,
            snapshots: [
                {
                    docVersion: 1,
                    snapshot: currentContent,
                    afterTransactions: ChangeSet.empty(currentContent.length),
                },
            ],
        };

        this.fileStates.set(fileName, created);
        return created;
    }

    private readonly onBrowserOnline = () => {
        this.isOffline = false;
        this.flushAllPendingChanges();
    };
    private readonly onBrowserOffline = () => {
        this.isOffline = true;
    };

    private getCurrentEditorText(): string {
        if (this.editorView) {
            return this.editorView.state.doc.toString();
        }

        return this.editor.value;
    }

    // Those are hooks for Bookstack's native form submission and for fallback mode
    public syncEntryContentToTextarea() {
        const entryContent = this.getEntryText();
        this.editor.value = entryContent;
        return this.editor.value;
    }

    public getEntryText(): string {
        if (this.activeFileName === ENTRY_FILE_NAME) {
            return this.getCurrentEditorText();
        }
        return this.getOrCreateFileState(ENTRY_FILE_NAME).currentContent;
    }

    removeListeners() {
        // event bus removes them automatically on destroy, but we need to remove browser events
         window.removeEventListener("online", this.onBrowserOnline);
         window.removeEventListener("offline", this.onBrowserOffline);
    }

    destroy() {
        for (const fileState of this.fileStates.values()) {
            if (fileState.pendingSendTimer) {
                clearTimeout(fileState.pendingSendTimer);
                fileState.pendingSendTimer = null;
            }
        }
        this.removeListeners();
        if (this.editorView) {
            this.editorView.destroy();
            this.editorView = null;
        }
        // dereference editor to release DOM reference, but don't remove
        this.editor = null as any;
    }
}
