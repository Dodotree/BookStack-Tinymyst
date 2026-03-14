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
import { tmSelectors, tmClassNames, tmEvents } from "./constants";
import type { TinymistEventPayloads } from "./constants/custom-events";

type TinymistOpts = Record<string, string>;

declare global {
    interface Window {
        $tmEventBus: EventBus<TinymistEventPayloads>;
    }
}

export class TinymistApp {
    private opts: TinymistOpts;

    private uniqueTabId: string;
    private pageId: number;
    getText: () => string = () => "supposed to be overridden in setup";
    private syncTextGetText: () => string = () =>
        "supposed to be overridden in setup";
    private consoleToggleHandler: ((collapsed?: boolean) => void) | null = null;

    constructor(opts: TinymistOpts) {
        this.opts = opts;
        this.uniqueTabId = this.createUniqueTabId();
        this.pageId = Number(this.opts.pageId);
        this.destroy = this.destroy.bind(this);
    }

    setup(): void {
        if (!window.$tmEventBus) {
            window.$tmEventBus = new EventBus<TinymistEventPayloads>();
        }

        const editorUI = new TinymistEditorUI();
        this.getText = editorUI.getEntryText;
        this.syncTextGetText = editorUI.syncEntryContentToTextarea;

        new TinymistThemeSettings();
        new TinymistFileDropdown(`${tmSelectors.Root} ${tmSelectors.FileDropDown}`);
        new TinymistConsole(tmSelectors.ConsolePanel, tmSelectors.ConsoleContent);
        new TinymistFallbackCompiler(this.pageId);

        const connectionsManager = new TinymistConnectionsManager({
            pageId: this.pageId,
            wsToken: this.opts.wsToken,
            uniqueTabId: this.uniqueTabId,
        });
        connectionsManager.start();

        try {
            new PreviewRenderer(this.uniqueTabId);
            window.$tmEventBus.emit(tmEvents.WasmInit);
        } catch (error) {
            console.error("[Tinymist App] renderer setup failed:", error);
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "error",
                message: "⚠ [App] renderer initialization failed: ",
                details: error,
            });
        }

        const root = document.querySelector<HTMLElement>(tmSelectors.Root);
        root
            ?.closest("form")
            ?.addEventListener("submit", this.syncTextGetText);

        this.consoleToggleHandler = (collapsed?: boolean) => {
            root?.classList.toggle(tmClassNames.ConsoleCollapsed, collapsed);
        };
        window.$tmEventBus.listen(tmEvents.ConsoleToggle, this.consoleToggleHandler);

        // Clean up connections on page navigation
        window.addEventListener("beforeunload", this.destroy);
        // Also listen to pagehide for better mobile support
        window.addEventListener("pagehide", this.destroy);
    }

    async getContent(): Promise<{ tinymist: string }> {
        return {
            tinymist: this.syncTextGetText?.() || "",
        };
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
        window.$tmEventBus.emit(tmEvents.Destroy);
        window.removeEventListener("beforeunload", this.destroy);
        window.removeEventListener("pagehide", this.destroy);

        if (this.syncTextGetText) {
            document.querySelector<HTMLElement>(tmSelectors.Root)
                ?.closest("form")
                ?.removeEventListener("submit", this.syncTextGetText);
        }

        this.consoleToggleHandler = null;
        window.$tmEventBus.destroy();
    }
}
