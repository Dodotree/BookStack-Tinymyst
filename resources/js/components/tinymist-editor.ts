import { Component } from "./component";


import { TinymistConnectionsManager } from "../tinymist/connections/connections-manager";
import { TinymistFallbackCompiler } from "../tinymist/connections/fallback";
import { TinymistEditorUI } from "../tinymist/editor/editor";
import { TinymistConsole } from "../tinymist/console";
import { PreviewRenderer } from "../tinymist/preview/render";


export class TinymistEditor extends Component {
    elem!: HTMLElement;
    editor!: HTMLTextAreaElement;
    preview!: HTMLElement;
    console!: HTMLElement;
    getText!: () => string;
    syncContentToTextarea!: () => string;

    private uniqueTabId: string = this.createUniqueTabId();

    private connectionsManager: TinymistConnectionsManager | null = null;

    async setupWasm() {
        try {
            const previewElement = this.$refs.preview as HTMLElement;
            if (!previewElement) {
                console.warn("[Preview Data] Preview element not found, skipping preview setup");
                return;
            }

            new PreviewRenderer(previewElement);
            window.$events.emit("tinymist-wasm-init");

        } catch (error) {
            console.error("[Preview Data] renderer setup failed:", error);
            window.$events.emit("tinymist-console-log", {
                type: "error", message: "⚠ [Preview Data] initialization failed: ", details: error
            });
        }
    }

    private createUniqueTabId(): string {
        const rand = crypto.getRandomValues(new Uint32Array(2));
        return [
            this.$opts.pageId,
            Date.now().toString(36),
            rand[0].toString(36),
            rand[1].toString(36).slice(0, 4),
        ].join("-");
    }

    setup() {
        console.log("[Tinymist Editor] setup() called");

        this.elem = this.$el;
        this.editor = this.$refs.editor as HTMLTextAreaElement;

        console.log("[Tinymist Editor] Elements found:", {
            elem: !!this.elem,
            editor: !!this.editor,
            console: !!this.$refs.console,
        });
        console.log(
            "[Tinymist Editor] Initial content length:",
            this.editor.value.length
        );

        const editorUI = new TinymistEditorUI(this.elem, this.editor);
        // Since all Bookstack editors require getText()
        this.getText = editorUI.getText.bind(editorUI);
        this.syncContentToTextarea = editorUI.syncContentToTextarea.bind(editorUI);

        new TinymistConsole(this.$refs.console);
        // Even if the page was not saved yet, Bookstack still creates a page ID for draft pages
        const pageId = Number(this.$opts.pageId);
        new TinymistFallbackCompiler(pageId);

        if (!pageId) {
            window.$events.emit('tinymist-console-log', {
                type: 'warning',
                message: '⚠ Page ID not found, only fallback compilation will be available',
            });
            window.$events.emit('tinymist-fallback-enable', true);
            return;
        }

        this.connectionsManager = new TinymistConnectionsManager({
            pageId,
            wsToken: this.$opts.wsToken as string | undefined,
            uniqueTabId: this.uniqueTabId,
        });

        this.connectionsManager.start();

        // WASM can be useless if the preview bridge fails to initialize
        // but we set it up early so it will be ready once the bridge is connected
        void this.setupWasm();
    }

    /**
     * Get content for saving (called by page-editor).
     */
    async getContent() {
        // Sync CodeMirror content to textarea before returning
        return {
            tinymist: this.syncContentToTextarea(),
        };
    }

    destroy() {
        this.connectionsManager?.destroy();
    }

}
