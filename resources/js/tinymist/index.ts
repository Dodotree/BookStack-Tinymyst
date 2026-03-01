/**
 * Tinymist Core Entry Point
 */

import { TinymistConnectionsManager } from "./connections/connections-manager";
import { TinymistFallbackCompiler } from "./connections/fallback";
import { TinymistEditorUI } from "./editor/editor";
import { TinymistFileDropdown } from "./editor/file-dropdown";
import { TinymistThemeSettings } from "./editor/theme-settings";
import { TinymistConsole } from "./console";
import { PreviewRenderer } from "./preview/render";

type TinymistRefs = Record<string, HTMLElement>;
type TinymistOpts = Record<string, string>;

export class TinymistApp {
    private root: HTMLElement;
    private refs: TinymistRefs;
    private opts: TinymistOpts;

    private uniqueTabId: string;
    private pageId: number;
    private editorUI: TinymistEditorUI | null = null;
    private connectionsManager: TinymistConnectionsManager | null = null;
    private formSubmitHandler: (() => string) | null = null;
    private consoleToggleHandler: ((collapsed?: boolean) => void) | null = null;

    constructor(root: HTMLElement, refs: TinymistRefs, opts: TinymistOpts) {
        this.root = root;
        this.refs = refs;
        this.opts = opts;
        this.uniqueTabId = this.createUniqueTabId();
        this.pageId = Number(this.opts.pageId);
    }

    setup(): void {
        const editorUI = new TinymistEditorUI(
            this.refs.editor as HTMLTextAreaElement,
            this.refs.imagePreview as HTMLDivElement,
            this.refs.imagePreviewImage as HTMLImageElement,
            this.refs.imagePreviewMessage as HTMLDivElement,
        );
        this.editorUI = editorUI;

        new TinymistThemeSettings(this.root);
        new TinymistFileDropdown(this.refs.fileList as HTMLSelectElement);
        new TinymistConsole(this.refs.console);
        new TinymistFallbackCompiler(this.pageId);

        this.connectionsManager = new TinymistConnectionsManager({
            pageId: this.pageId,
            wsToken: this.opts.wsToken,
            uniqueTabId: this.uniqueTabId,
        });
        this.connectionsManager.start();

        this.setupWasm();

        this.formSubmitHandler = editorUI.syncEntryContentToTextarea;
        this.root.closest("form")?.addEventListener("submit", this.formSubmitHandler);

        this.consoleToggleHandler = (collapsed?: boolean) => {
            this.root.classList.toggle("tinymist-console-collapsed", collapsed);
        };
        window.$events.listen("tinymist-console-toggle", this.consoleToggleHandler);
    }

    getEntryText(): string {
        return this.editorUI?.getEntryText() ?? "";
    }

    syncEntryContentToTextarea(): string {
        return this.editorUI?.syncEntryContentToTextarea() ?? "";
    }

    async getContent(): Promise<{ tinymist: string }> {
        return {
            tinymist: this.syncEntryContentToTextarea(),
        };
    }

    destroy(): void {
        this.connectionsManager?.destroy();
        this.connectionsManager = null;

        this.editorUI?.destroy();
        this.editorUI = null;

        if (this.formSubmitHandler) {
            this.root.closest("form")?.removeEventListener("submit", this.formSubmitHandler);
            this.formSubmitHandler = null;
        }

        if (this.consoleToggleHandler) {
            window.$events.remove("tinymist-console-toggle", this.consoleToggleHandler);
            this.consoleToggleHandler = null;
        }
    }

    private setupWasm(): void {
        const previewElement = this.refs.preview as HTMLElement;
        if (!previewElement) {
            console.warn("[Preview Data] Preview element not found, skipping preview setup");
            return;
        }

        try {
            new PreviewRenderer(previewElement);
            window.$events.emit("tinymist-wasm-init");
        } catch (error) {
            console.error("[Preview Data] renderer setup failed:", error);
            window.$events.emit("tinymist-console-log", {
                type: "error",
                message: "⚠ [Preview Data] initialization failed: ",
                details: error,
            });
        }
    }

    private createUniqueTabId(): string {
        const rand = crypto.getRandomValues(new Uint32Array(2));
        return [
            this.opts.pageId,
            Date.now().toString(36),
            rand[0].toString(36),
            rand[1].toString(36).slice(0, 4),
        ].join("-");
    }
}
