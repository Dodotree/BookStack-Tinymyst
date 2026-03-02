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
import { EventBus } from "./event-bus";

type TinymistRefs = Record<string, HTMLElement>;
type TinymistOpts = Record<string, string>;

declare global {
    interface Window {
        $tmEventBus: EventBus;
    }
}

export class TinymistApp {
    private root: HTMLElement;
    private refs: TinymistRefs;
    private opts: TinymistOpts;

    private uniqueTabId: string;
    private pageId: number;
    getText: () => string = () => "supposed to be overridden in setup";
    private syncTextGetText: () => string = () =>
        "supposed to be overridden in setup";
    private consoleToggleHandler: ((collapsed?: boolean) => void) | null = null;

    constructor(root: HTMLElement, refs: TinymistRefs, opts: TinymistOpts) {
        this.root = root;
        this.refs = refs;
        this.opts = opts;
        this.uniqueTabId = this.createUniqueTabId();
        this.pageId = Number(this.opts.pageId);
    }

    setup(): void {
        if (!window.$tmEventBus) {
            window.$tmEventBus = new EventBus();
        }

        const editorUI = new TinymistEditorUI(
            this.refs.editor as HTMLTextAreaElement,
            this.refs.imagePreview as HTMLDivElement,
            this.refs.imagePreviewImage as HTMLImageElement,
            this.refs.imagePreviewMessage as HTMLDivElement,
        );

        new TinymistThemeSettings(this.root);
        new TinymistFileDropdown(this.refs.fileList as HTMLSelectElement);
        new TinymistConsole(this.refs.console);
        new TinymistFallbackCompiler(this.pageId);

        const connectionsManager = new TinymistConnectionsManager({
            pageId: this.pageId,
            wsToken: this.opts.wsToken,
            uniqueTabId: this.uniqueTabId,
        });
        connectionsManager.start();

        this.setupWasm();

        this.getText = editorUI.getEntryText;
        this.syncTextGetText = editorUI.syncEntryContentToTextarea;
        this.root
            .closest("form")
            ?.addEventListener("submit", this.syncTextGetText);

        this.consoleToggleHandler = (collapsed?: boolean) => {
            this.root.classList.toggle("tinymist-console-collapsed", collapsed);
        };
        window.$tmEventBus.listen("console-toggle", this.consoleToggleHandler);
    }

    async getContent(): Promise<{ tinymist: string }> {
        return {
            tinymist: this.syncTextGetText?.() || "",
        };
    }

    private setupWasm(): void {
        try {
            new PreviewRenderer(this.refs.preview as HTMLElement);
            window.$tmEventBus.emit("wasm-init");
        } catch (error) {
            console.error("[Tinymist App] renderer setup failed:", error);
            window.$tmEventBus.emit("console-log", {
                type: "error",
                message: "⚠ [App] renderer initialization failed: ",
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

    destroy(): void {
        window.$tmEventBus.emit("destroy");

        if (this.syncTextGetText) {
            this.root
                .closest("form")
                ?.removeEventListener("submit", this.syncTextGetText);
        }

        if (this.consoleToggleHandler) {
            window.$tmEventBus.remove(
                "console-toggle",
                this.consoleToggleHandler,
            );
            this.consoleToggleHandler = null;
        }
    }
}
