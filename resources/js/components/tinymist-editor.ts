import { Component } from "./component";


import { TinymistConnectionsManager } from "../tinymist/connections/connections-manager";
import { TinymistFallbackCompiler } from "../tinymist/connections/fallback";
import { TinymistEditorUI } from "../tinymist/editor/editor";
import { TinymistFileDropdown } from "../tinymist/editor/file-dropdown";
import { TinymistThemeSettings } from "../tinymist/editor/theme-settings";
import { TinymistConsole } from "../tinymist/console";
import { PreviewRenderer } from "../tinymist/preview/render";

export class TinymistEditor extends Component {
    elem!: HTMLElement;
    preview!: HTMLElement;
    getText!: () => string;
    syncContentToTextarea!: () => string;
    pageId: number | undefined = undefined;

    private uniqueTabId: string = this.createUniqueTabId();
    private editorUI: TinymistEditorUI | null = null;

    private connectionsManager: TinymistConnectionsManager | null = null;

    async setupWasm() {
        try {
            // The preview element is for content, not the whole pane
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

        const editorUI = new TinymistEditorUI(
            this.$refs.editor as HTMLTextAreaElement,
            this.$refs.imagePreview as HTMLDivElement,
            this.$refs.imagePreviewImage as HTMLImageElement,
            this.$refs.imagePreviewMessage as HTMLDivElement
        );
        this.editorUI = editorUI;
        new TinymistThemeSettings(this.elem);
        // Since all Bookstack editors require getText()
        this.getText = editorUI.getEntryText;
        this.syncContentToTextarea = editorUI.syncEntryContentToTextarea;
        new TinymistFileDropdown(this.$refs.fileList as HTMLSelectElement);


        new TinymistConsole(this.$refs.console);

        // Even if the page was not saved yet, Bookstack still creates a page ID for draft pages
        this.pageId = Number(this.$opts.pageId);

        new TinymistFallbackCompiler(this.pageId);

        this.connectionsManager = new TinymistConnectionsManager({
            pageId: this.pageId,
            wsToken: this.$opts.wsToken as string | undefined,
            uniqueTabId: this.uniqueTabId,
        });

        this.connectionsManager.start();

        // WASM can be useless if the preview bridge fails to initialize
        // but we set it up early so it will be ready once the bridge is connected
        void this.setupWasm();

        // Before form submit, sync CodeMirror content to textarea
        this.elem.closest("form")?.addEventListener("submit", this.syncContentToTextarea);

        window.$events.listen('tinymist-console-toggle', (collapsed?: boolean) => {
            // On parent element for all panes
            this.elem.classList.toggle('tinymist-console-collapsed', collapsed)
        });
    }

    /**
     * Get content for saving (called by page-editor).
     */
    async getContent() {
        // Sync CodeMirror entry.typ content to textarea before returning
        return {
            tinymist: this.syncContentToTextarea(),
        };
    }

    destroy() {
        this.connectionsManager?.destroy();
        this.editorUI?.destroy();
        this.editorUI = null;

        this.elem.closest("form")?.removeEventListener("submit", this.syncContentToTextarea);
    }

}
