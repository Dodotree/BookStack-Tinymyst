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


export class TinymistEditorUI {
    elem: HTMLElement;
    editor: HTMLTextAreaElement;
    editorView: EditorView | null = null;
    private diagnosticsProcessor = new DiagnosticsProcessor();
    private semanticTokens = new SemanticTokenProcessor();
    private previewPanEnabled = false;
    private fallbackEnabled = false;

    private docVersion = 0;
    private pendingSendTimer: ReturnType<typeof setTimeout> | null = null;
    private snapshots: Array<{
        docVersion: number;
        snapshot: string;
        afterTransactions: ChangeSet;
    }> = [];
    private readonly maxSnapshots = 3;
    private readonly changeDebounceMs = 150;
    private readonly fallbackDebounceMs = 800;

    constructor(elem: HTMLElement, editor: HTMLTextAreaElement) {
        this.elem = elem;
        this.editor = editor;

        this.setupCodeMirror();

        // Setup event listeners
        this.setupListeners();

        // Setup form submit handler to sync CodeMirror content to textarea
        this.setupFormSubmitHandler();

        this.diagnosticsProcessor.attachEditorView(this.editorView!, this.getSnapshotContext.bind(this));
        this.semanticTokens.attachEditorView(this.editorView!, this.getSnapshotContext.bind(this));

        // Initial snapshot
        this.resetSyncState(this.docVersion);
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
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) {
                            this.onDocumentChange(update.transactions);
                        }
                        // Track cursor position changes
                        if (update.selectionSet) {
                            this.onCursorPositionChange(update.state);
                        }
                    }),
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
            console.error("Failed to initialize CodeMirror:", error);
            window.$events.emit("tinymist-console-log",
                { type: "error", message: "Failed to initialize CodeMirror editor", details: error });
        }
    }

    setupListeners() {
        this.syncFullStateFromServer = this.syncFullStateFromServer.bind(this);
        window.$events.listen("tinymist-sync-full-state", this.syncFullStateFromServer);
        this.pruneSnapshots = this.pruneSnapshots.bind(this);
        window.$events.listen("tinymist-prune-snapshots", this.pruneSnapshots);
        window.$events.listen("tinymist-fallback-enable", (enabled: boolean) => this.fallbackEnabled = enabled);

        if (!this.editorView) {
            // Fall back to textarea if CodeMirror fails, otherwise onInput() called from CodeMirror update listener
            this.editor.style.display = "block";
            this.editor.addEventListener("input", () => this.onInput());
        }

        // Button actions
        this.elem.addEventListener("click", (event) => {
            if (!event.target) return;
            const button = (event.target as Element).closest("button[data-action]");
            if (button === null) return;

            const action = button.getAttribute("data-action");
            if (action === "insertBold") this.insertMarkup("*", "*");
            if (action === "insertItalic") this.insertMarkup("_", "_");
            if (action === "insertMath") this.insertMarkup("$", "$");
            if (action === "insertHeading") this.insertHeading();
            if (action === "clearConsole") window.$events.emit("tinymist-console-clear");
            if (action === "toggleConsole") this.toggleConsole(button as HTMLButtonElement);
            if (action === "previewZoomIn") window.$events.emit("tinymist-preview-zoom-in");
            if (action === "previewZoomOut") window.$events.emit("tinymist-preview-zoom-out");
            if (action === "previewZoomReset") window.$events.emit("tinymist-preview-zoom-reset");
            if (action === "previewPanToggle") this.togglePreviewPan(button as HTMLButtonElement);
        });

        // Clean up connections on page navigation
        window.addEventListener("beforeunload", () => {
            this.destroy();
        });

        // Also listen to pagehide for better mobile support
        window.addEventListener("pagehide", () => {
            this.destroy();
        });
    }

    setupFormSubmitHandler() {
        // Find the form containing this editor
        const form = this.elem.closest("form");
        if (!form) return;

        // Before form submit, sync CodeMirror content to textarea
        form.addEventListener("submit", () => {
            this.syncContentToTextarea();
        });
    }

    syncFullStateFromServer(payload: { content: string; docVersion?: number }) {
        if (payload.content !== this.getText()) {
            this.setText(payload.content, true); // Sets' flag to true to avoid emitting change events
            this.resetSyncState(payload.docVersion || this.docVersion);
            window.$events.emit("tinymist-console-log",
                { type: "info", message: "[File Sync / LSP] Document synchronized from server" });
        }
    }

    public syncContentToTextarea() {
        if (this.editorView) {
            const content = this.editorView.state.doc.toString();
            this.editor.value = content;
        }
        return this.editor.value;
    }

    /**
     * Get current editor content
     */
    public getText(): string {
        if (this.editorView) {
            return this.editorView.state.doc.toString();
        }
        return this.editor.value;
    }

    onInput() {
        // Notify Bookstack page editor of changes, also fallback is using it
        window.$events.emit("editor-tinymist-change", "");
    }

    onDocumentChange(transactions: readonly Transaction[]) {
        if (transactions.some((tr) => tr.annotation(Transaction.userEvent) === "tinymist-sync")) {
            return;
        }
        this.onInput();
        // Send changes to WebSocket server
        if (transactions.some((tr) => tr.docChanged)) {
            transactions.forEach((tr) => {
                if (tr.changes && !tr.changes.empty) {
                    this.queueChanges(tr.changes);
                }
            });
        }
    }

    private queueChanges(changes: ChangeSet): void {
        const lastSnapshot = this.snapshots.at(-1);
        if (lastSnapshot) {
            this.snapshots[this.snapshots.length - 1].afterTransactions =
                lastSnapshot.afterTransactions ? lastSnapshot.afterTransactions.compose(changes) : changes;
        }

        if (this.pendingSendTimer) {
            clearTimeout(this.pendingSendTimer);
        }
        this.pendingSendTimer = setTimeout(() => {
            this.flushPendingChanges();
        }, this.fallbackEnabled ? this.fallbackDebounceMs : this.changeDebounceMs);
    }

    private flushPendingChanges(): void {
        this.docVersion += 1;
        const currentContent = this.getText();
        if(this.fallbackEnabled) {
            window.$events.emit("tinymist-fallback-compile", {
                docVersion: this.docVersion,
                content: currentContent,
            });
        } else {
            window.$events.emit("tinymist-text-diff", {
                changes: this.snapshots.at(-1)?.afterTransactions,
                docVersion: this.docVersion,
            });
        }
        this.snapshots.push({
            docVersion: this.docVersion,
            snapshot: currentContent,
            afterTransactions: ChangeSet.empty(currentContent.length),
        });
        if (this.snapshots.length > this.maxSnapshots) {
            this.snapshots = this.snapshots.slice(-this.maxSnapshots);
        }
    }

    private resetSyncState(docVersion: number): void {
        this.docVersion = docVersion;
        const currentContent = this.getText();
        this.snapshots = [{
            docVersion: this.docVersion,
            snapshot: currentContent,
            afterTransactions: ChangeSet.empty(currentContent.length),
        }];
        if (this.pendingSendTimer) {
            clearTimeout(this.pendingSendTimer);
            this.pendingSendTimer = null;
        }
    }

    private getSnapshotContext(docVersion: number): { snapshot: string; changeSet: ChangeSet } {
        const index = this.snapshots.findIndex((s) => s.docVersion === docVersion);
        if (index === -1) {
            const currentContent = this.getText();
            return {
                snapshot: currentContent,
                changeSet: ChangeSet.empty(currentContent.length),
            };
        }
        let pending = this.snapshots[index].afterTransactions;
        for (let i = index + 1; i < this.snapshots.length; i++) {
            if (this.snapshots[i].afterTransactions) {
                pending = pending.compose(this.snapshots[i].afterTransactions);
            }
        }
        return {
            snapshot: this.snapshots[index].snapshot,
            changeSet: pending,
        };
    }

    private pruneSnapshots(docVersion: number): void {
        if (this.snapshots.length === 0) {
            return;
        }
        this.snapshots = this.snapshots.filter((s) => s.docVersion >= docVersion);
    }

    onCursorPositionChange(state: any) {
        // Get cursor position and line
        const pos = state.selection.main.head;
        const line = state.doc.lineAt(pos);
        window.$events.emit("tinymist-control", {
            event: "changeCursorPosition",
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
     * Simple string hash function for content comparison // unused now
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
        if (this.pendingSendTimer) {
            clearTimeout(this.pendingSendTimer);
            this.pendingSendTimer = null;
        }
        this.semanticTokens.clearHighlights();
        this.semanticTokens.detachEditorView();
    }
}
