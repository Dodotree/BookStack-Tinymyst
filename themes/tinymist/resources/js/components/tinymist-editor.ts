import { Component } from "../../../../../resources/js/components/component";
import { TinymistApp } from "../tinymist/index";
import type { TinymistEventPayloads } from "../tinymist/constants/custom-events";

const externalToInternalEvents: Record<string, keyof TinymistEventPayloads> = {
    "editor::insert":"insert", // used by attachment panel to insert image markdown
    "attachments-page-updated":"files-updated", // used by attachment panel to notify about changes in attachments list
    "attachments-dirty-map-updated":"files-dirty-updated", // used by attachment panel to notify of file dirty state changes
    "attachments-reset-file":"reset-file", // used by attachment panel to reset a file
};

const internalToExternalEvents: Partial<Record<keyof TinymistEventPayloads, string>> = {
    "text-change": "editor-tinymist-change", // used for letting know page-editor.js that something changed, so it can trigger auto-saving
    "file-dirty-state": "attachments-file-dirty-state",
};

export class TinymistEditor extends Component {
    private app: TinymistApp | null = null;
    private removeEventBridge: (() => void) | null = null;

    protected setupEventBridge(): () => void {
        const externalBus = window.$events;
        const tinymistBus = window.$tmEventBus;
        const externalListeners = Object.entries(externalToInternalEvents).map(([externalEvent, internalEvent]) => {
            const handler = (payload: unknown) => tinymistBus.emit(internalEvent, payload as TinymistEventPayloads[typeof internalEvent]);
            externalBus.listen(externalEvent, handler);
            return { eventName: externalEvent, handler };
        });

        const internalListeners = Object.entries(internalToExternalEvents)
            .filter(([, externalEvent]) => externalEvent)
            .map(([internalEvent, externalEvent]) => {
            const typedInternalEvent = internalEvent as keyof TinymistEventPayloads;
            const handler = (payload: unknown) => externalBus.emit(externalEvent, payload as {});
            tinymistBus.listen(typedInternalEvent, handler as any);
            return { eventName: internalEvent, handler };
        });

        return () => {
            for (const { eventName, handler } of externalListeners) {
                externalBus.remove(eventName, handler);
            }
            for (const { eventName, handler } of internalListeners) {
                tinymistBus.remove(eventName as keyof TinymistEventPayloads, handler as any);
            }
        };
    }

    setup(): void {
        this.app = new TinymistApp(this.$opts);
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
