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

import { defaultKeymap } from "@codemirror/commands";
import { ChangeSet, EditorState, Transaction } from "@codemirror/state";
import { LanguageDescription, defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { php } from "@codemirror/lang-php";

import { SemanticTokenProcessor, highlightField } from "./semantic-tokens";
import { DiagnosticsProcessor } from "./diagnostics";

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
    pendingDirtyTimer: ReturnType<typeof setTimeout> | null;
    snapshots: FileSnapshot[];
};


export class TinymistEditorUI {
    elem: HTMLElement;
    editor: HTMLTextAreaElement;
    editorView: EditorView | null = null;
    private diagnosticsProcessor = new DiagnosticsProcessor();
    private semanticTokens = new SemanticTokenProcessor();
    private previewPanEnabled = false;
    private fallbackEnabled = false;

    private readonly entryFileName = "entry.typ";
    private activeFileName = this.entryFileName;
    private readonly fileStates: Map<string, FileSyncState> = new Map();
    private readonly maxSnapshots = 3;
    private readonly changeDebounceMs = 150;
    private readonly dirtyStateDebounceMs = 300;
    private readonly fallbackDebounceMs = 800;

    constructor(elem: HTMLElement, editor: HTMLTextAreaElement) {
        this.elem = elem;
        this.editor = editor;

        // Hook for diagnostics and semantic tokens to get editor state context for mapping
        this.getSnapshotContext = this.getSnapshotContext.bind(this);
        // Those are hooks for Bookstack's native form submission and for fallback mode
        this.getEntryText = this.getEntryText.bind(this);
        this.syncEntryContentToTextarea = this.syncEntryContentToTextarea.bind(this);

        this.updateListenerForCodeMirror = this.updateListenerForCodeMirror.bind(this);
        this.syncFullStateFromServer = this.syncFullStateFromServer.bind(this);
        this.pruneSnapshots = this.pruneSnapshots.bind(this);
        this.onInput = this.onInput.bind(this);
        this.buttonsListener = this.buttonsListener.bind(this);
        this.insertFromEditorEvent = this.insertFromEditorEvent.bind(this);
        this.resetAttachmentFileFromServer = this.resetAttachmentFileFromServer.bind(this);
        this.setActiveFile = this.setActiveFile.bind(this);
        this.destroy = this.destroy.bind(this);

        this.setupCodeMirror();
        this.setupListeners();

        this.diagnosticsProcessor.attachEditorView(
            this.editorView!,
            this.getSnapshotContext,
        );
        this.semanticTokens.attachEditorView(
            this.editorView!,
            this.getSnapshotContext,
        );

        this.resetSyncStateForFile({ fileName: this.entryFileName, docVersion: 1, content: this.editor.value });
    }

    async setupCodeMirror() {
        try {
            // Create editor state
            const startState = EditorState.create({
                doc: this.editor.value,
                extensions: [
                    lineNumbers(), // Enable line numbers
                    highlightActiveLineGutter(), // Highlight current line number in gutter
                    highlightActiveLine(), // Highlight current line
                    markdown({
                        codeLanguages: [
                            LanguageDescription.of({
                                name: "javascript",
                                alias: ["js", "jsx", "ts", "tsx"],
                                load: async () => javascript(),
                            }),
                            LanguageDescription.of({
                                name: "python",
                                alias: ["py"],
                                load: async () => python(),
                            }),
                            LanguageDescription.of({
                                name: "php",
                                load: async () => php(),
                            }),
                        ],
                    }),
                    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
                    highlightField, // Add custom highlighting support
                    keymap.of(defaultKeymap),
                    EditorView.editable.of(true), // Make editor editable
                    EditorView.updateListener.of(this.updateListenerForCodeMirror),
                ],
            });

            // Create editor view
            this.editorView = new EditorView({
                state: startState,
                parent: this.editor.parentElement!,
            });

            // Hide original textarea
            this.editor.style.display = "none";

            window.$events.emit("tinymist-console-log", { type: "info", message: "CodeMirror editor initialized" });

        } catch (error) {
            this.editor.style.display = "block";
            this.editor.addEventListener("input", this.onInput);
            console.error("[Editor] Failed to initialize CodeMirror:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "[Editor] Failed to initialize CodeMirror editor", details: error });
        }
    }

    updateListenerForCodeMirror(update: any) {
        if (update.docChanged) {
            this.onInput();
            this.onDocumentChange(update.transactions);
        }
        // Track cursor position changes
        if (update.selectionSet) {
            this.onCursorPositionChange(update.state);
        }
    }

    setupListeners() {
        window.$events.listen("tinymist-sync-full-state", this.syncFullStateFromServer);
        window.$events.listen("tinymist-prune-snapshots", this.pruneSnapshots);
        window.$events.listen("tinymist-fallback-enable", (enabled: boolean) => this.fallbackEnabled = enabled);
        window.$events.listen("tinymist-active-file-change", this.setActiveFile);
        window.$events.listen("editor::insert", this.insertFromEditorEvent);
        window.$events.listen("tinymist-attachment-reset-file", this.resetAttachmentFileFromServer);

        // Button actions, it counts on event bubbling to the container
        this.elem.addEventListener("click", this.buttonsListener);

        // Clean up connections on page navigation
        window.addEventListener("beforeunload", this.destroy);
        // Also listen to pagehide for better mobile support
        window.addEventListener("pagehide", this.destroy);

        // Before form submit, sync CodeMirror content to textarea
        this.elem.closest("form")?.addEventListener("submit", this.syncEntryContentToTextarea);
    }

    removeListeners() {
        window.$events.remove("tinymist-sync-full-state", this.syncFullStateFromServer);
        window.$events.remove("tinymist-prune-snapshots", this.pruneSnapshots);
        window.$events.remove("tinymist-active-file-change", this.setActiveFile);
        window.$events.remove("editor::insert", this.insertFromEditorEvent);
        window.$events.remove("tinymist-attachment-reset-file", this.resetAttachmentFileFromServer);
        this.editor.removeEventListener("input", this.onInput);
        this.elem.removeEventListener("click", this.buttonsListener);
        window.removeEventListener("beforeunload", this.destroy);
        window.removeEventListener("pagehide", this.destroy);
        // Before form submit, sync CodeMirror content to textarea
        this.elem.closest("form")?.removeEventListener("submit", this.syncEntryContentToTextarea);
    }

    onInput() {
        // Notify Bookstack page editor of changes, also fallback is using it
        if (this.activeFileName === this.entryFileName) {
            window.$events.emit("editor-tinymist-change", "");
        }
    }

    buttonsListener(event: Event) {
        if (!event.target) return;
        const button = (event.target as Element).closest("button[data-action]");
        if (button === null) return;

        const action = button.getAttribute("data-action");
        switch (action) {
            case "insertBold":
                this.insertMarkup("*", "*");
                break;
            case "insertItalic":
                this.insertMarkup("_", "_");
                break;
            case "insertMath":
                this.insertMarkup("$", "$");
                break;
            case "insertHeading":
                this.insertHeading();
                break;
            case "clearConsole":
                window.$events.emit("tinymist-console-clear");
                break;
            case "toggleConsole":
                this.toggleConsole(button as HTMLButtonElement);
                break;
            case "previewZoomIn":
                window.$events.emit("tinymist-preview-zoom-in");
                break;
            case "previewZoomOut":
                window.$events.emit("tinymist-preview-zoom-out");
                break;
            case "previewZoomReset":
                window.$events.emit("tinymist-preview-zoom-reset");
                break;
            case "previewPanToggle":
                this.togglePreviewPan(button as HTMLButtonElement);
                break;
            default:
                console.warn(`[Editor]Unknown button action: ${action}`);
        }
    }

    syncFullStateFromServer(payload: { content: string; docVersion: number; fileName: string }) {
        const state = this.getOrCreateFileState(payload.fileName);
        state.loaded = true;
        state.currentContent = payload.content;
        this.resetSyncStateForFile(payload);

        if (payload.fileName === this.activeFileName) {
            const currentText = this.editor.value;
            if (payload.content !== currentText) {
                this.setText(payload.content, true);
            }
            window.$events.emit("tinymist-console-log",
                { type: "info", message: "[Editor] Document synchronized from server" });
        }
    }

    // Those are hooks for Bookstack's native form submission and for fallback mode
    public syncEntryContentToTextarea() {
        const entryContent = this.getEntryText();
        this.editor.value = entryContent;
        return this.editor.value;
    }
    public getEntryText(): string {
        if (this.activeFileName === this.entryFileName) {
            return this.editor.value;
        }
        return this.getOrCreateFileState(this.entryFileName).currentContent;
    }

    public setActiveFile(fileName: string): void {
        if (fileName === this.activeFileName) {
            return;
        }

        this.flushPendingChanges(this.activeFileName);

        this.activeFileName = fileName;
        const state = this.getOrCreateFileState(fileName);
        this.semanticTokens.clearHighlights();
        this.diagnosticsProcessor.triggerLinting([]);

        if (state.loaded) {
            this.setText(state.currentContent, true);
        } else {
            this.setText("", true);
        }

        window.$events.emit("tinymist-sync-open-file", { fileName: fileName });
    }

    onDocumentChange(transactions: readonly Transaction[]) {
        if (transactions.some((tr) => tr.annotation(Transaction.userEvent) === "tinymist-sync")) {
            return;
        }
        const state = this.getOrCreateFileState(this.activeFileName);
        state.currentContent = this.editor.value;
        this.queueDirtyStateEmit(this.activeFileName);

        // Eventually changes from transactions sent to WebSocket server
        if (transactions.some((tr) => tr.docChanged)) {
            transactions.forEach((tr) => {
                if (tr.changes && !tr.changes.empty) {
                    this.queueChanges(tr.changes, this.activeFileName);
                }
            });
        }
    }

    private queueChanges(changes: ChangeSet, fileName: string): void {
        const state = this.getOrCreateFileState(fileName);
        const lastSnapshot = state.snapshots.at(-1);
        if (lastSnapshot) {
            state.snapshots[state.snapshots.length - 1].afterTransactions =
                lastSnapshot.afterTransactions ? lastSnapshot.afterTransactions.compose(changes) : changes;
        }

        if (state.pendingSendTimer) {
            clearTimeout(state.pendingSendTimer);
        }
        state.pendingSendTimer = setTimeout(() => {
            this.flushPendingChanges(fileName);
        }, this.fallbackEnabled ? this.fallbackDebounceMs : this.changeDebounceMs);
    }

    private flushPendingChanges(fileName: string): void {
        const state = this.getOrCreateFileState(fileName);
        if (state.pendingSendTimer) {
            clearTimeout(state.pendingSendTimer);
            state.pendingSendTimer = null;
        }

        state.docVersion += 1;

        // After applying changes back end will be at current docVersion with current content
        if (this.fallbackEnabled && fileName === this.entryFileName) {
            window.$events.emit("tinymist-fallback-compile", {
                content: state.currentContent,
                docVersion: state.docVersion,
            });
        } else if (!this.fallbackEnabled) {
            window.$events.emit("tinymist-text-diff", {
                fileName,
                changes: state.snapshots.at(-1)?.afterTransactions,
                docVersion: state.docVersion,
            });
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

    private resetSyncStateForFile(payload: {fileName: string, docVersion: number, content: string}): void {
        const state = this.getOrCreateFileState(payload.fileName);
        console.log(`[Editor] Resetting sync state for ${payload.fileName} to docVersion ${payload.docVersion}`);
        state.docVersion = payload.docVersion;
        state.currentContent = payload.content;
        state.savedContentHash = this.hashString(payload.content);
        state.loaded = true;
        state.snapshots = [{
            docVersion: payload.docVersion,
            snapshot: payload.content,
            afterTransactions: ChangeSet.empty(payload.content.length),
        }];
        if (state.pendingSendTimer) {
            clearTimeout(state.pendingSendTimer);
            state.pendingSendTimer = null;
        }
        if (state.pendingDirtyTimer) {
            clearTimeout(state.pendingDirtyTimer);
            state.pendingDirtyTimer = null;
        }
        state.lastEmittedDirty = false;
        this.emitDirtyState(payload.fileName, false);
    }

    private queueDirtyStateEmit(fileName: string): void {
        if (fileName === this.entryFileName) {
            return;
        }
        const state = this.getOrCreateFileState(fileName);
        if (state.pendingDirtyTimer) {
            clearTimeout(state.pendingDirtyTimer);
        }
        state.pendingDirtyTimer = setTimeout(() => {
            state.pendingDirtyTimer = null;
            const nextDirty = this.hashString(state.currentContent) !== state.savedContentHash;
            if (nextDirty === state.lastEmittedDirty) {
                return;
            }
            state.lastEmittedDirty = nextDirty;
            this.emitDirtyState(fileName, nextDirty);
        }, this.dirtyStateDebounceMs);
    }

    private emitDirtyState(fileName: string, isDirty: boolean): void {
        window.$events.emit("tinymist-attachment-dirty-state", {
            fileName,
            isDirty,
        });
    }

    private resetAttachmentFileFromServer(payload: { fileName?: string }): void {
        const fileName = String(payload?.fileName || "").trim();
        if (!fileName || fileName === this.entryFileName) {
            return;
        }

        const state = this.getOrCreateFileState(fileName);
        if (state.pendingSendTimer) {
            clearTimeout(state.pendingSendTimer);
            state.pendingSendTimer = null;
        }
        if (state.pendingDirtyTimer) {
            clearTimeout(state.pendingDirtyTimer);
            state.pendingDirtyTimer = null;
        }

        state.loaded = false;
        state.snapshots = [{
            docVersion: state.docVersion,
            snapshot: "",
            afterTransactions: ChangeSet.empty(0),
        }];
        state.currentContent = "";
        state.lastEmittedDirty = false;
        this.emitDirtyState(fileName, false);

        if (this.activeFileName === fileName) {
            this.semanticTokens.clearHighlights();
            this.diagnosticsProcessor.triggerLinting([]);
        }

        window.$events.emit("tinymist-sync-open-file", { fileName });
    }

    private getSnapshotContext(docVersion: number, fileName: string): { snapshot: string; changeSet: ChangeSet } {
        const state = this.getOrCreateFileState(fileName);
        const index = state.snapshots.findIndex((s) => s.docVersion === docVersion);
        if (index === -1) {
            console.error('[Editor] Snapshot not found', state);
            throw new Error(`No snapshot found for docVersion ${docVersion} in file ${fileName}`);
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

    private pruneSnapshots(payload: { fileName: string; docVersion: number }): void {
        const state = this.getOrCreateFileState(payload.fileName);

        if (!Number.isFinite(payload.docVersion) || state.snapshots.length === 0) {
            return;
        }
        if (payload.docVersion > state.docVersion) {
            console.warn(`[Editor] DocVersion out of sync for ${payload.fileName} current: ${state.docVersion}, requested prune: ${payload.docVersion}`);
            return;
        }

        // Leave at least one snapshot
        const pruned = state.snapshots.filter((s) => s.docVersion >= Math.min(payload.docVersion, state.docVersion-1));
        state.snapshots = pruned;
    }

    onCursorPositionChange(state: any) {
        if (this.activeFileName !== this.entryFileName) {
            return;
        }
        // Get cursor position and line
        const pos = state.selection.main.head;
        const line = state.doc.lineAt(pos);
        window.$events.emit("tinymist-control", {
            event: "changeCursorPosition",
            fileName: this.entryFileName,
            line: line.number - 1, // 0-indexed
            character: pos - line.from,
        });
    }

    private toggleConsole(button?: HTMLButtonElement) {
        const collapsed = this.elem.classList.toggle("tinymist-console-collapsed");
        if (button) {
            button.setAttribute("aria-expanded", (!collapsed).toString());
            button.setAttribute("title", collapsed ? "Expand Console" : "Collapse Console");
        }

        const consoleContent = this.elem.querySelector(".tinymist-console-content") as HTMLElement | null;
        if (consoleContent) {
            consoleContent.setAttribute("aria-hidden", collapsed ? "true" : "false");
        }
    }

    private togglePreviewPan(button?: HTMLButtonElement) {
        this.previewPanEnabled = !this.previewPanEnabled;
        if (button) {
            button.setAttribute("aria-pressed", this.previewPanEnabled.toString());
            button.setAttribute("title", this.previewPanEnabled ? "Disable Hand Tool" : "Enable Hand Tool");
        }
        window.$events.emit("tinymist-preview-pan-toggle", { enabled: this.previewPanEnabled });
    }

    private insertFromEditorEvent(eventContent: { typst?: string; markdown?: string; html?: string }): void {
        const insertText = (eventContent?.typst || eventContent?.markdown || eventContent?.html || "").toString();
        if (!insertText) {
            return;
        }
        if (this.activeFileName !== this.entryFileName) {
            console.warn("[Editor] Ignoring insert event for non-active file", { activeFile: this.activeFileName, eventFile: this.activeFileName });
            return;
        }

        if (this.editorView) {
            const selection = this.editorView.state.selection.main;
            this.editorView.dispatch({
                changes: {
                    from: selection.from,
                    to: selection.to,
                    insert: insertText,
                },
                selection: {
                    anchor: selection.from + insertText.length,
                },
            });
            this.editorView.focus();
            return;
        }

        const start = this.editor.selectionStart;
        const end = this.editor.selectionEnd;
        this.editor.setRangeText(insertText, start, end, "end");
        this.editor.focus();
        this.onInput();
    }

        /**
     * Insert markup around selected text or at cursor position.
     */
    insertMarkup(before: string, after: string) {
        if (this.editorView) {
            const state = this.editorView.state;
            const selection = state.selection.main;
            const selectedText = state.doc.sliceString(selection.from, selection.to);
            const replacement = before + selectedText + after;

            this.editorView.dispatch({
                changes: {
                    from: selection.from,
                    to: selection.to,
                    insert: replacement,
                },
                selection: {
                    anchor: selection.from + before.length,
                    head: selection.from + before.length + selectedText.length,
                },
            });
            this.editorView.focus();
        } else {
            const start = this.editor.selectionStart;
            const end = this.editor.selectionEnd;
            const selectedText = this.editor.value.substring(start, end);
            const replacement = before + selectedText + after;

            this.editor.setRangeText(replacement, start, end, "select");
            this.editor.focus();
            this.onInput();
        }
    }

    /**
     * Insert heading at cursor position.
     */
    insertHeading() {
        if (this.editorView) {
            const state = this.editorView.state;
            const selection = state.selection.main;
            const before = state.doc.sliceString(0, selection.from);
            const heading =
                before.endsWith("\n") || before === ""
                    ? "= Heading\n"
                    : "\n= Heading\n";

            this.editorView.dispatch({
                changes: { from: selection.from, insert: heading },
                selection: { anchor: selection.from + heading.length - 1 },
            });
            this.editorView.focus();
        } else {
            const start = this.editor.selectionStart;
            const before = this.editor.value.substring(0, start);
            const after = this.editor.value.substring(start);

            const heading =
                before.endsWith("\n") || before === ""
                    ? "= Heading\n"
                    : "\n= Heading\n";
            this.editor.value = before + heading + after;
            this.editor.selectionStart = this.editor.selectionEnd =
                start + heading.length - 1;
            this.editor.focus();
            this.onInput();
        }
    }

    /**
     * Set editor content.
     */
    setText(content: string, fromSync: boolean = false) {
        if (this.editorView) {
            this.editorView.dispatch({
                changes: {
                    from: 0,
                    to: this.editorView.state.doc.length,
                    insert: content,
                },
                annotations: fromSync ? Transaction.userEvent.of("tinymist-sync") : undefined,
            });
        } else {
            this.editor.value = content;
        }
    }

    /**
     * Focus editor.
     */
    focus() {
        if (this.editorView) {
            this.editorView.focus();
        } else {
            this.editor.focus();
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

    destroy() {
        for (const fileState of this.fileStates.values()) {
            if (fileState.pendingSendTimer) {
                clearTimeout(fileState.pendingSendTimer);
                fileState.pendingSendTimer = null;
            }
            if (fileState.pendingDirtyTimer) {
                clearTimeout(fileState.pendingDirtyTimer);
                fileState.pendingDirtyTimer = null;
            }
        }
        this.semanticTokens.clearHighlights();
        this.semanticTokens.detachEditorView();
        this.removeListeners();
        if (this.editorView) {
            this.editorView.destroy();
            this.editorView = null;
        }
    }

    private getOrCreateFileState(fileName: string): FileSyncState {
        const existing = this.fileStates.get(fileName);
        if (existing) {
            return existing;
        }

        const currentContent = fileName === this.entryFileName ? this.editor.value : "";
        const created: FileSyncState = {
            fileName: fileName,
            docVersion: 1,
            currentContent: currentContent,
            savedContentHash: this.hashString(currentContent),
            lastEmittedDirty: false,
            loaded: fileName === this.entryFileName,
            pendingSendTimer: null,
            pendingDirtyTimer: null,
            snapshots: [{
                docVersion: 1,
                snapshot: currentContent,
                afterTransactions: ChangeSet.empty(currentContent.length),
            }],
        };

        this.fileStates.set(fileName, created);
        return created;
    }
}
