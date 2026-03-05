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
import {
    ChangeSet,
    Compartment,
    EditorState,
    Extension,
    Transaction,
} from "@codemirror/state";
import {
    LanguageDescription,
    LanguageSupport,
    StreamLanguage,
    defaultHighlightStyle,
    syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { php } from "@codemirror/lang-php";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { toml } from "@codemirror/legacy-modes/mode/toml";

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
    pendingDirtyTimer: ReturnType<typeof setTimeout> | null;
    snapshots: FileSnapshot[];
};

export class TinymistEditorUI {
    editor: HTMLTextAreaElement;
    editorView: EditorView | null = null;
    private imageViewSelector: string;
    private imageSelector: string;
    private imageMessageSelector: string;

    private readonly languageCompartment = new Compartment();
    private readonly highlightCompartment = new Compartment();
    private readonly isDarkMode =
        document.documentElement.classList.contains("dark-mode");

    private readonly entryFileName = ENTRY_FILE_NAME;
    private activeFileName = this.entryFileName;

    private readonly fileStates: Map<string, FileSyncState> = new Map();
    private readonly maxSnapshots = 3;
    private readonly changeDebounceMs = 150;
    private readonly dirtyStateDebounceMs = 300;
    private readonly fallbackDebounceMs = 800;

    private fallbackEnabled = false;

    private getCurrentEditorText(): string {
        if (this.editorView) {
            return this.editorView.state.doc.toString();
        }

        return this.editor.value;
    }

    constructor() {
        this.editor = document.querySelector(tmSelectors.TextArea) as HTMLTextAreaElement;
        this.imageViewSelector = `${tmSelectors.Root} ${tmSelectors.ImageView}`;
        this.imageSelector = `${tmSelectors.Root} ${tmSelectors.Image}`;
        this.imageMessageSelector = `${tmSelectors.Root} ${tmSelectors.ImageMessage}`;

        // Hook for diagnostics and semantic tokens to get editor state context for mapping
        this.getSnapshotContext = this.getSnapshotContext.bind(this);
        // Those are hooks for Bookstack's native form submission and for fallback mode
        this.getEntryText = this.getEntryText.bind(this);
        this.syncEntryContentToTextarea =
            this.syncEntryContentToTextarea.bind(this);

        this.updateListenerForCodeMirror =
            this.updateListenerForCodeMirror.bind(this);
        this.syncFullStateFromServer = this.syncFullStateFromServer.bind(this);
        this.pruneSnapshots = this.pruneSnapshots.bind(this);
        this.onInput = this.onInput.bind(this);
        this.buttonsListener = this.buttonsListener.bind(this);
        this.insertFromEditorEvent = this.insertFromEditorEvent.bind(this);
        this.resetAttachmentFileFromServer =
            this.resetAttachmentFileFromServer.bind(this);
        this.setActiveFile = this.setActiveFile.bind(this);
        this.destroy = this.destroy.bind(this);

        this.setupCodeMirror();
        this.setupListeners();

        const diagnosticsProcessor = new DiagnosticsProcessor();
        diagnosticsProcessor.attachEditorView(
            this.editorView!,
            this.getSnapshotContext,
        );
        const semanticTokenProcessor = new SemanticTokenProcessor();
        semanticTokenProcessor.attachEditorView(
            this.editorView!,
            this.getSnapshotContext,
        );

        this.resetSyncStateForFile({
            fileName: this.entryFileName,
            docVersion: 1,
            content: this.getCurrentEditorText(),
        });
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
                    this.languageCompartment.of(
                        this.getLanguageExtensionForFile(this.activeFileName),
                    ),
                    this.highlightCompartment.of(this.getHighlightExtension()),
                    highlightField, // Add custom highlighting support
                    history(),
                    keymap.of([...historyKeymap, ...defaultKeymap]),
                    EditorView.editable.of(true), // Make editor editable
                    EditorView.updateListener.of(
                        this.updateListenerForCodeMirror,
                    ),
                ],
            });

            // Create editor view
            this.editorView = new EditorView({
                state: startState,
                parent: this.editor.parentElement!,
            });

            // Hide original textarea
            this.editor.style.display = "none";

            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "info",
                message: "CodeMirror editor initialized",
            });
        } catch (error) {
            this.editor.style.display = "block";
            this.editor.addEventListener("input", this.onInput);
            console.error("[Editor] Failed to initialize CodeMirror:", error);
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "error",
                message: "[Editor] Failed to initialize CodeMirror editor",
                details: error,
            });
        }
    }

    private getHighlightExtension(): Extension {
        return syntaxHighlighting(
            this.isDarkMode ? oneDarkHighlightStyle : defaultHighlightStyle,
            { fallback: true },
        );
    }

    private getMarkdownLanguageExtension(): Extension {
        return markdown({
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
                LanguageDescription.of({
                    name: "shell",
                    alias: ["sh", "bash", "zsh", "shell"],
                    load: async () =>
                        new LanguageSupport(StreamLanguage.define(shell)),
                }),
            ],
        });
    }

    private getLanguageExtensionForFile(fileName: string): Extension {
        const ext = this.getFileExtension(fileName);

        switch (ext) {
            case "md":
                return this.getMarkdownLanguageExtension();
            case "toml":
                return StreamLanguage.define(toml);
            case "bib":
                return StreamLanguage.define(stex);
            case "sh":
            case "bash":
                return StreamLanguage.define(shell);
            case "html":
                return html();
            case "css":
                return css();
            case "json":
                return json();
            case "ts":
                return javascript({ typescript: true });
            case "js":
                return javascript();
            case "php":
                return php();
            case "py":
                return python();
            case "txt":
                return [];
            default:
                return this.getMarkdownLanguageExtension();
        }
    }

    private getFileExtension(fileName: string): string {
        const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
        const dotIndex = baseName.lastIndexOf(".");
        if (dotIndex <= 0 || dotIndex >= baseName.length - 1) {
            return "";
        }

        return baseName.slice(dotIndex + 1).toLowerCase();
    }

    private reconfigureEditorForFile(fileName: string): void {
        if (!this.editorView) {
            return;
        }

        this.editorView.dispatch({
            effects: [
                this.languageCompartment.reconfigure(
                    this.getLanguageExtensionForFile(fileName),
                ),
                this.highlightCompartment.reconfigure(
                    this.getHighlightExtension(),
                ),
            ],
        });
    }

    private isImageFile(fileName: string): boolean {
        return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(fileName);
    }

    private showImagePreview(fileName: string, url: string): void {
        const imageViewContainer = document.querySelector(this.imageViewSelector) as HTMLDivElement | null;
        const imageViewElement = document.querySelector(this.imageSelector) as HTMLImageElement | null;
        const imageViewMessage = document.querySelector(this.imageMessageSelector) as HTMLDivElement | null;
        if (
            !imageViewContainer ||
            !imageViewElement ||
            !imageViewMessage
        ) {
            return;
        }

        imageViewContainer.hidden = false;
        if (this.editorView) {
            this.editorView.dom.style.setProperty(
                "display",
                "none",
                "important",
            );
        }
        this.editor.style.display = "none";

        if (!url) {
            imageViewElement.hidden = true;
            imageViewElement.removeAttribute("src");
            imageViewMessage.hidden = false;
            imageViewMessage.textContent = `Image preview unavailable for ${fileName}.`;
            return;
        }

        imageViewElement.src = url;
        imageViewElement.hidden = false;
        imageViewMessage.hidden = true;
    }

    private showTextEditor(): void {
        const imageViewContainer = document.querySelector(this.imageViewSelector) as HTMLDivElement | null;
        const imageViewElement = document.querySelector(this.imageSelector) as HTMLImageElement | null;
        const imageViewMessage = document.querySelector(this.imageMessageSelector) as HTMLDivElement | null;
        if (imageViewContainer) {
            imageViewContainer.hidden = true;
        }
        if (imageViewElement) {
            imageViewElement.hidden = true;
            imageViewElement.removeAttribute("src");
        }
        if (imageViewMessage) {
            imageViewMessage.hidden = true;
        }
        if (this.editorView) {
            this.editorView.dom.style.display = "";
            return;
        }
        this.editor.style.display = "block";
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
        window.$tmEventBus.listen(
            tmEvents.SyncFullState,
            this.syncFullStateFromServer,
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
        window.$tmEventBus.listen(tmEvents.Insert, this.insertFromEditorEvent);
        window.$tmEventBus.listen(
            tmEvents.ResetFile,
            this.resetAttachmentFileFromServer,
        );

        // Button actions, it counts on event bubbling to the container
        this.editor
            .closest(tmSelectors.EditorPane)
            ?.addEventListener("click", this.buttonsListener);
    }

    removeListeners() {
        this.editor.removeEventListener("input", this.onInput);
        this.editor
            .closest(tmSelectors.EditorPane)
            ?.removeEventListener("click", this.buttonsListener);
    }

    onInput() {
        // Notify Bookstack page editor of changes, also fallback is using it
        if (this.activeFileName === this.entryFileName) {
            window.$tmEventBus.emit(tmEvents.TextChange, "");
        }
    }

    buttonsListener(event: Event) {
        if (!event.target) return;
        const button = (event.target as Element).closest(tmSelectors.ActionButton);
        if (button === null) return;

        const action = button.getAttribute("data-action");
        switch (action) {
            case "insertImage":
                this.insertImage();
                break;
            case "insertLink":
                this.insertLink();
                break;
            case "insertBold":
                this.insertMarkup("*", "*");
                break;
            case "insertItalic":
                this.insertMarkup("_", "_");
                break;
            case "insertMath":
                this.insertMarkup("$", "$");
                break;
            case "insertCodeBlock":
                this.insertCodeBlock();
                break;
            case "insertHeading":
                this.insertHeading();
                break;
            case "changeCodeMirrorSettings":
                window.$tmEventBus.emit(tmEvents.ThemeSettingsOpen);
                break;
            default:
                console.warn(`[Editor]Unknown button action: ${action}`);
        }
    }

    private getSelectionInfo(): {
        selectedText: string;
        from: number;
        to: number;
    } {
        if (this.editorView) {
            const selection = this.editorView.state.selection.main;
            return {
                selectedText: this.editorView.state.doc.sliceString(
                    selection.from,
                    selection.to,
                ),
                from: selection.from,
                to: selection.to,
            };
        }

        return {
            selectedText: this.editor.value.substring(
                this.editor.selectionStart,
                this.editor.selectionEnd,
            ),
            from: this.editor.selectionStart,
            to: this.editor.selectionEnd,
        };
    }

    private replaceSelection(replacement: string): void {
        if (this.editorView) {
            const selection = this.editorView.state.selection.main;
            this.editorView.dispatch({
                changes: {
                    from: selection.from,
                    to: selection.to,
                    insert: replacement,
                },
                selection: {
                    anchor: selection.from + replacement.length,
                },
            });
            this.editorView.focus();
            return;
        }

        this.editor.setRangeText(
            replacement,
            this.editor.selectionStart,
            this.editor.selectionEnd,
            "end",
        );
        this.editor.focus();
        this.onInput();
    }

    private escapeTypstString(value: string): string {
        return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }

    private insertImage(): void {
        const selection = this.getSelectionInfo();
        const selectedSrc = selection.selectedText.trim();
        const src = selectedSrc.length > 0 ? selectedSrc : "image.png";
        const escapedSrc = this.escapeTypstString(src);
        this.replaceSelection(
            `#image("${escapedSrc}", width: 100%, height: 100%, fit: "cover", scaling: "smooth", alt: "my image description")`,
        );
    }

    private insertLink(): void {
        const selection = this.getSelectionInfo();
        const selectedUrl = selection.selectedText.trim();
        const url =
            selectedUrl.length > 0 ? selectedUrl : "https://example.com";
        const escapedUrl = this.escapeTypstString(url);
        this.replaceSelection(`#link("${escapedUrl}")[\n  See example.com\n]`);
    }

    private insertCodeBlock(): void {
        const selection = this.getSelectionInfo();
        const selectedCode = selection.selectedText;
        if (selectedCode.length > 0) {
            this.replaceSelection(`\`\`\`python\n${selectedCode}\n\`\`\``);
            return;
        }
        this.replaceSelection("```python\n\n```");
    }

    syncFullStateFromServer(payload: {
        content: string;
        docVersion: number;
        fileName: string;
    }) {
        const state = this.getOrCreateFileState(payload.fileName);
        state.loaded = true;
        state.currentContent = payload.content;
        this.resetSyncStateForFile(payload);

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
    }

    // Those are hooks for Bookstack's native form submission and for fallback mode
    public syncEntryContentToTextarea() {
        const entryContent = this.getEntryText();
        this.editor.value = entryContent;
        return this.editor.value;
    }
    public getEntryText(): string {
        if (this.activeFileName === this.entryFileName) {
            return this.getCurrentEditorText();
        }
        return this.getOrCreateFileState(this.entryFileName).currentContent;
    }

    public setActiveFile(payload: { fileName: string; url: string }): void {
        const { fileName, url } = payload;
        if (fileName === this.activeFileName) {
            return;
        }

        this.flushPendingChanges(this.activeFileName);

        this.activeFileName = fileName;
        if (this.isImageFile(fileName)) {
            this.showImagePreview(fileName, url);
            return;
        }

        this.showTextEditor();
        this.reconfigureEditorForFile(fileName);
        const state = this.getOrCreateFileState(fileName);

        if (state.loaded) {
            this.setText(state.currentContent, true);
        } else {
            this.setText("", true);
        }

        window.$tmEventBus.emit(tmEvents.SyncOpenFile, { fileName: fileName });
    }

    onDocumentChange(transactions: readonly Transaction[]) {
        if (
            transactions.some(
                (tr) =>
                    tr.annotation(Transaction.userEvent) === "tinymist-sync",
            )
        ) {
            return;
        }
        const state = this.getOrCreateFileState(this.activeFileName);
        state.currentContent = this.getCurrentEditorText();
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
                lastSnapshot.afterTransactions
                    ? lastSnapshot.afterTransactions.compose(changes)
                    : changes;
        }

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

    private flushPendingChanges(fileName: string): void {
        const state = this.getOrCreateFileState(fileName);

        if (state.pendingSendTimer) {
            clearTimeout(state.pendingSendTimer);
            state.pendingSendTimer = null;
        }

        const pendingChanges = state.snapshots.at(-1)?.afterTransactions;
        if (!pendingChanges || pendingChanges.empty) {
            // Happens only on early flash when files are switched
            // Nothing gives you nothing, no need to advance docVersion or send empty changes to the server
            return;
        }

        state.docVersion += 1;

        // After applying changes back end will be at current docVersion with current content
        if (this.fallbackEnabled && fileName === this.entryFileName) {
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

    private resetSyncStateForFile(payload: {
        fileName: string;
        docVersion: number;
        content: string;
    }): void {
        const state = this.getOrCreateFileState(payload.fileName);
        console.log(
            `[Editor] Resetting sync state for ${payload.fileName} to docVersion ${payload.docVersion}`,
        );
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
        if (state.pendingDirtyTimer) {
            clearTimeout(state.pendingDirtyTimer);
            state.pendingDirtyTimer = null;
        }
        state.lastEmittedDirty = false;
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
            const nextDirty =
                this.hashString(state.currentContent) !==
                state.savedContentHash;
            if (nextDirty === state.lastEmittedDirty) {
                return;
            }
            state.lastEmittedDirty = nextDirty;
            this.emitDirtyState(fileName, nextDirty);
        }, this.dirtyStateDebounceMs);
    }

    private emitDirtyState(fileName: string, isDirty: boolean): void {
        window.$tmEventBus.emit(tmEvents.FileDirtyState, {
            fileName,
            isDirty,
        });
    }

    private resetAttachmentFileFromServer(payload: {
        fileName?: string;
    }): void {
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
        state.snapshots = [
            {
                docVersion: state.docVersion,
                snapshot: "",
                afterTransactions: ChangeSet.empty(0),
            },
        ];
        state.currentContent = "";
        state.lastEmittedDirty = false;
        this.emitDirtyState(fileName, false);

        window.$tmEventBus.emit(tmEvents.SyncOpenFile, { fileName });
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
            console.warn(
                `[Editor] DocVersion out of sync for ${payload.fileName} current: ${state.docVersion}, requested prune: ${payload.docVersion}`,
            );
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

    onCursorPositionChange(state: any) {
        if (this.activeFileName !== this.entryFileName) {
            return;
        }
        // Get cursor position and line
        const pos = state.selection.main.head;
        const line = state.doc.lineAt(pos);
        window.$tmEventBus.emit(tmEvents.Control, {
            event: "changeCursorPosition",
            fileName: this.entryFileName,
            line: line.number - 1, // 0-indexed
            character: pos - line.from,
        });
    }

    private insertFromEditorEvent(eventContent: {
        typst?: string;
        markdown?: string;
        html?: string;
    }): void {
        const insertText = (
            eventContent?.typst ||
            eventContent?.markdown ||
            eventContent?.html ||
            ""
        ).toString();
        if (!insertText) {
            return;
        }
        if (this.activeFileName !== this.entryFileName) {
            console.warn("[Editor] Ignoring insert event for non-active file", {
                activeFile: this.activeFileName,
                eventFile: this.activeFileName,
            });
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
            const selectedText = state.doc.sliceString(
                selection.from,
                selection.to,
            );
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
        this.removeListeners();
        if (this.editorView) {
            this.editorView.destroy();
            this.editorView = null;
        }
        // dereference editor to release DOM reference, but don't remove
        this.editor = null as any;
    }

    private getOrCreateFileState(fileName: string): FileSyncState {
        const existing = this.fileStates.get(fileName);
        if (existing) {
            return existing;
        }

        const currentContent =
            fileName === this.entryFileName ? this.getCurrentEditorText() : "";
        const created: FileSyncState = {
            fileName: fileName,
            docVersion: 1,
            currentContent: currentContent,
            savedContentHash: this.hashString(currentContent),
            lastEmittedDirty: false,
            loaded: fileName === this.entryFileName,
            pendingSendTimer: null,
            pendingDirtyTimer: null,
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
}
