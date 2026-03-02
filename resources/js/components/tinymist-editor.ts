import { Component } from "./component";
import { TinymistApp } from "../tinymist/index";

const externalToInternalEvents = {
    "editor::insert":"insert", // used by attachment panel to insert image markdown
    "attachments-page-updated":"files-updated", // used by attachment panel to notify about changes in attachments list
    "tinymist-attachments-dirty-map-updated":"files-dirty-updated", // used by attachment panel to notify of file dirty state changes
    "tinymist-attachment-reset-file":"reset-file", // used by attachment panel to reset a file
};

const internalToExternalEvents = {
    "text-change": "editor-tinymist-change", // used for letting know page-editor.js that something changed, so it can trigger auto-saving
    "file-dirty-state": "tinymist-attachment-dirty-state",
};

export class TinymistEditor extends Component {
    private app: TinymistApp | null = null;
    private removeEventBridge: (() => void) | null = null;

    protected setupEventBridge(): () => void {
        const externalBus = window.$events;
        const tinymistBus = window.$tmEventBus;
        const externalListeners = Object.entries(externalToInternalEvents).map(([externalEvent, internalEvent]) => {
            const handler = (payload: unknown) => tinymistBus.emit(internalEvent, payload as {});
            externalBus.listen(externalEvent, handler);
            return { eventName: externalEvent, handler };
        });

        const internalListeners = Object.entries(internalToExternalEvents).map(([internalEvent, externalEvent]) => {
            const handler = (payload: unknown) => externalBus.emit(externalEvent, payload as {});
            tinymistBus.listen(internalEvent, handler);
            return { eventName: internalEvent, handler };
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
