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
    private attachmentRefreshHandler: ((data: { pageId?: number, html?: string }) => void) | null = null;
    private fileSyncStatusHandler: ((status: { what?: string; connected?: boolean }) => void) | null = null;
    private editorUI: TinymistEditorUI | null = null;
    private fileSelect: HTMLSelectElement | null = null;
    private fileSyncConnected = false;

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
        this.editorUI = editorUI;
        // Since all Bookstack editors require getText()
        this.getText = editorUI.getEntryText;
        this.syncContentToTextarea = editorUI.syncEntryContentToTextarea;

        new TinymistConsole(this.$refs.console);
        // Even if the page was not saved yet, Bookstack still creates a page ID for draft pages
        const pageId = Number(this.$opts.pageId);
        new TinymistFallbackCompiler(pageId);
        this.setupFileDropdown(pageId);

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

        this.fileSyncStatusHandler = (status: { what?: string; connected?: boolean }) => {
            if (status?.what !== 'file-lsp-ws') {
                return;
            }
            this.fileSyncConnected = Boolean(status.connected);
        };
        window.$events.listen('tinymist-status', this.fileSyncStatusHandler);

        this.connectionsManager.start();

        // WASM can be useless if the preview bridge fails to initialize
        // but we set it up early so it will be ready once the bridge is connected
        void this.setupWasm();
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
        if (this.fileSyncStatusHandler) {
            window.$events.remove('tinymist-status', this.fileSyncStatusHandler);
            this.fileSyncStatusHandler = null;
        }
        if (this.attachmentRefreshHandler) {
            window.$events.remove('attachments-page-updated', this.attachmentRefreshHandler);
            this.attachmentRefreshHandler = null;
        }
    }

    private setupFileDropdown(pageId: number): void {
        const fileSelect = this.$refs.fileList as HTMLSelectElement | undefined;
        if (!fileSelect || !pageId) {
            return;
        }
        this.fileSelect = fileSelect;

        fileSelect.addEventListener('change', () => {
            const selectedFile = this.fileSyncConnected ?
                (fileSelect.value || 'entry.typ').trim() : 'entry.typ';
            window.$events.emit("tinymist-active-file-change", selectedFile);
        });

        const refresh = (data: { pageId?: number, html?: string }) => {
            if (!data || Number(data.pageId) !== pageId) {
                return;
            }
            this.refreshFileDropdown(fileSelect, data.html || '');
        };
        this.attachmentRefreshHandler = refresh;
        window.$events.listen('attachments-page-updated', refresh);
    }

    private refreshFileDropdown(fileSelect: HTMLSelectElement, attachmentsHtml: string): void {
        const parser = new DOMParser();
        const doc = parser.parseFromString(attachmentsHtml, 'text/html');
        const attachmentNames = Array.from(doc.querySelectorAll('a'))
            .map(link => (link.textContent || '').trim())
            .filter(name => name.length > 0 && name !== 'entry.typ');

        const uniqueAttachmentNames = [...new Set(attachmentNames)];
        const selectedValue = fileSelect.value || 'entry.typ';

        fileSelect.innerHTML = '';
        fileSelect.add(new Option('entry.typ', 'entry.typ'));
        uniqueAttachmentNames.forEach(name => fileSelect.add(new Option(name, name)));

        const hasPrevious = Array.from(fileSelect.options).some(option => option.value === selectedValue);
        fileSelect.value = hasPrevious ? selectedValue : 'entry.typ';
    }

}
