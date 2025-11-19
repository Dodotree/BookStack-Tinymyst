// UI Editor for Tinymist using CodeMirror
// Provides current content, emits change events, cursor position updates,
// observes semantic highlighting and diagnostics events and renders them.

import { EditorView } from "@codemirror/view";

import {
    EditorView,
    keymap,
    lineNumbers,
    highlightActiveLineGutter,
    highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState, StateEffect } from "@codemirror/state";
import { setDiagnostics } from "@codemirror/lint";

export class TinymistEditor {
    elem!: HTMLElement;
    editor!: HTMLTextAreaElement;
    editorView!: EditorView | null;

    private semanticTokens = new SemanticTokenProcessor();

    setup() {
        console.log("[Tinymist Editor] setup() called");

        this.elem = this.$el;
        this.editor = this.$refs.editor as HTMLTextAreaElement;

        console.log("[Tinymist Editor] Elements found:", {
            elem: !!this.elem,
            editor: !!this.editor,
        });

        this.editorView = null;

        this.setupCodeMirror();
        this.setupListeners();
        this.setupFormSubmitHandler();

        // Initial compilation
        console.log("[Tinymist Editor] Triggering initial compile...");
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
                    highlightField, // Add custom highlighting support
                    keymap.of(defaultKeymap),
                    EditorView.editable.of(true), // Make editor editable

                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) {
                            this.onInput();
                            // Send changes to WebSocket server
                            if (update.transactions.some((tr) => tr.docChanged)) {
                                update.transactions.forEach((tr) => {
                                    if (tr.changes && !tr.changes.empty) {
                                        this.sendChangesToServer(tr.changes);
                                    }
                                });
                            }
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

            this.semanticTokens.attachEditorView(this.editorView!);
            this.semanticTokens.flushPendingHighlights();
        } catch (error) {
            console.error("Failed to initialize CodeMirror:", error);
            // Fall back to textarea if CodeMirror fails
            this.editor.style.display = "block";
            this.editor.addEventListener("input", () => this.onInput());
        }
    }

    sendChangesToServer(changes: any) {
        if (!this.fileSyncClient || !this.fileSyncClient.connected()) {
            console.warn("[File Sync / LSP] not connected, file changes not synced");
            return;
        }

        this.fileSyncClient.sendChanges(changes);
    }

    setupListeners() {
        // Only add textarea listener if CodeMirror failed to initialize
        if (!this.editorView) {
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
            if (action === "clearConsole") this.clearConsole();
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

    syncContentToTextarea() {
        if (this.editorView) {
            const content = this.editorView.state.doc.toString();
            this.editor.value = content;
        }
    }

    onInput() {
        // Only compile in fallback mode (WebSocket handles changes otherwise)
        if (this.fallbackMode && this.fallbackCompiler) {
            const source = this.editorView?.state.doc.toString() || this.editor.value;
            this.fallbackCompiler.scheduleCompile(source);
        }

        // Notify page editor of changes
        window.$events.emit("editor-tinymist-change", "");
    }

    onCursorPositionChange(state: any) {
        // Get cursor position
        const selection = state.selection.main;
        const pos = selection.head;

        // Convert position to line and character
        const line = state.doc.lineAt(pos);
        const lineNumber = line.number - 1; // 0-indexed
        const character = pos - line.from;

        // Send cursor position to control plane
        if (this.controlClient) {
            const pageId = this.$opts.pageId;
            console.log("[Tinymist] Sending cursor position:", {
                line: lineNumber,
                character: character,
                pos: pos,
            });
            this.controlClient.sendControlMessage({
                event: "changeCursorPosition",
                filepath: `C:\\Users\\Ooo\\Desktop\\GitWork\\BookStack\\storage\\app\\tinymist\\page_${pageId}.typ`, //`storage/app/tinymist/page_${pageId}.typ`,
                line: lineNumber,
                character: character,
            });
        }
    }

    /**
     * Simple string hash function for content comparison
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
     * Get current editor content
     */
    getEditorContent(): string {
        if (this.editorView) {
            return this.editorView.state.doc.toString();
        }
        return this.editor.value;
    }

    /**
     * Get content for saving (called by page-editor).
     */
    async getContent() {
        // Sync CodeMirror content to textarea before returning
        this.syncContentToTextarea();

        return {
            tinymist: this.editorView
                ? this.editorView.state.doc.toString()
                : this.editor.value,
        };
    }

    /**
     * Set editor content.
     */
    setText(content: string) {
        if (this.editorView) {
            this.editorView.dispatch({
                changes: {
                    from: 0,
                    to: this.editorView.state.doc.length,
                    insert: content,
                },
            });
        } else {
            this.editor.value = content;
        }
        this.compile();
    }

    /**
     * Get current text.
     */
    getText() {
        return this.editorView
            ? this.editorView.state.doc.toString()
            : this.editor.value;
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

}
