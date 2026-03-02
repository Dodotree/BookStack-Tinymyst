import { Component } from "./component";
import { TinymistApp } from "../tinymist/index";

const externalToInternalEvents = [
    "editor::insert", // used by attachment panel to insert image markdown
    "attachments-page-updated", // used by attachment panel to notify about changes in attachments list
    "tinymist-attachments-dirty-map-updated", // used by attachment panel to notify of file dirty state changes
    "tinymist-attachment-reset-file", // used by attachment panel to reset a file
];

const internalToExternalEvents = [
    "editor-tinymist-change", // used for letting know page-editor.js that something changed, so it can trigger auto-saving
    "tinymist-attachment-dirty-state",
];

export class TinymistEditor extends Component {
    private app: TinymistApp | null = null;
    private removeEventBridge: (() => void) | null = null;

    protected setupEventBridge(): () => void {
        const externalBus = window.$events;
        const tinymistBus = window.$tmEventBus;
        const externalListeners = externalToInternalEvents.map((eventName) => {
            const handler = (payload: unknown) => tinymistBus.emit(eventName, payload as {});
            externalBus.listen(eventName, handler);
            return { eventName, handler };
        });

        const internalListeners = internalToExternalEvents.map((eventName) => {
            const handler = (payload: unknown) => externalBus.emit(eventName, payload as {});
            tinymistBus.listen(eventName, handler);
            return { eventName, handler };
        });

        return () => {
            for (const { eventName, handler } of externalListeners) {
                externalBus.remove(eventName, handler);
            }
            for (const { eventName, handler } of internalListeners) {
                tinymistBus.remove(eventName, handler);
            }
        };
    }

    setup(): void {
        this.app = new TinymistApp(this.$el, this.$refs as Record<string, HTMLElement>, this.$opts);
        this.app.setup();
        this.removeEventBridge = this.setupEventBridge();
    }

    getText(): string {
        return this.app?.getText() ?? "";
    }

    async getContent(): Promise<{ tinymist: string }> {
        return this.app?.getContent() ?? { tinymist: "" };
    }

    destroy(): void {
        this.app?.destroy();
        this.app = null;

        this.removeEventBridge?.();
        this.removeEventBridge = null;
    }
}
