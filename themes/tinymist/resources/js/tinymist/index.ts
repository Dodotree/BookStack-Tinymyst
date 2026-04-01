/**
 * Tinymist Core Entry Point
 */

import { TinymistConnectionsManager } from "./connections/connections-manager";
import { TinymistEditorUI } from "./editor/editor";
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
    private syncTextGetText: () => string = () => "supposed to be overridden in setup";

    constructor(opts: TinymistOpts) {
        this.opts = opts;
        this.pageId = Number(this.opts.pageId);
        this.uniqueTabId = this.createUniqueTabId(this.pageId);
        this.destroy = this.destroy.bind(this);
    }

    setup(httpService: any): void {
        if (!window.$tmEventBus) {
            window.$tmEventBus = new EventBus<TinymistEventPayloads>();
        }

        const editorUI = new TinymistEditorUI();
        this.getText = editorUI.getEntryText;
        this.syncTextGetText = editorUI.syncEntryContentToTextarea;

        new TinymistConsole(tmSelectors.ConsolePanel, tmSelectors.ConsoleContent);

        const connectionsManager = new TinymistConnectionsManager({
            pageId: this.pageId,
            uniqueTabId: this.uniqueTabId,
            wsToken: this.opts.wsToken,
            httpService,
        });
        connectionsManager.start();

        try {
            new PreviewRenderer(this.uniqueTabId, this.pageId);
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

        // Clean up connections on page navigation
        window.addEventListener("beforeunload", this.destroy);
        // Also listen to pagehide for better mobile support
        window.addEventListener("pagehide", this.destroy);

        window.$tmEventBus.listen(tmEvents.ConsoleToggle, (collapsed?: boolean) => {
            root?.classList.toggle(tmClassNames.ConsoleCollapsed, collapsed);
        });
    }

    async getContent(): Promise<{ tinymist: string }> {
        return {
            tinymist: this.syncTextGetText?.() || "",
        };
    }

    private createUniqueTabId(pageId: number): string {
        const rand = crypto.getRandomValues(new Uint32Array(2));
        return [
            pageId,
            Date.now().toString(36),
            rand[0].toString(36),
            rand[1].toString(36).slice(0, 4),
        ].join("-");
    }

    destroy(): void {
        window.$tmEventBus.emit(tmEvents.Destroy);
        window.removeEventListener("beforeunload", this.destroy);
        window.removeEventListener("pagehide", this.destroy);

        document.querySelector<HTMLElement>(tmSelectors.Root)
            ?.closest("form")
            ?.removeEventListener("submit", this.syncTextGetText);

        window.$tmEventBus.destroy();

        this.getText = () => "Destroyed";
        this.syncTextGetText = () => "Destroyed";
    }
}
