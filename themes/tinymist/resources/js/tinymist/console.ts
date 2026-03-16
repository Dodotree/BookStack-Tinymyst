// Visible editor console for displaying compilation messages and diagnostics
import { tmClassNames, tmEvents } from "./constants";

type TinymistConsoleMessage = {
    type: "error" | "warning" | "info" | "success" | "hint";
    message: string;
    details?: unknown;
    location?: {
        fileName?: string;
        line: number;
        character: number;
        endLine?: number;
        endCharacter?: number;
    };
};

type TinymistConsoleEntry = {
    signature: string;
    timestampMs: number;
    repeatCount: number;
    element: HTMLDivElement;
};

type TinymistConsoleOptions = {
    dedupeWindowMs?: number;
    aggregateWindowMs?: number;
    maxMessages?: number;
};

export class TinymistConsole {
    static readonly DEFAULT_DEDUPE_WINDOW_MS = 1_000;
    static readonly DEFAULT_AGGREGATE_WINDOW_MS = 3 * 60_000;
    static readonly DEFAULT_MAX_MESSAGES = 20;

    panelSelector: string;
    consoleSelector: string;
    collapsed: boolean = false;
    dedupeWindowMs: number;
    aggregateWindowMs: number;
    maxMessages: number;
    entries: TinymistConsoleEntry[] = [];

    constructor(panelSelector: string, consoleSelector: string, options?: TinymistConsoleOptions) {
        this.panelSelector = panelSelector;
        this.consoleSelector = consoleSelector;
        this.dedupeWindowMs = options?.dedupeWindowMs ?? TinymistConsole.DEFAULT_DEDUPE_WINDOW_MS;
        this.aggregateWindowMs = options?.aggregateWindowMs ?? TinymistConsole.DEFAULT_AGGREGATE_WINDOW_MS;
        this.maxMessages = options?.maxMessages ?? TinymistConsole.DEFAULT_MAX_MESSAGES;

        // Saving reference of the bound method to be able to remove listeners later if needed
        this.logMessage = this.logMessage.bind(this);
        this.clearConsole = this.clearConsole.bind(this);
        this.handlePanelClick = this.handlePanelClick.bind(this);
        this.toggleConsole = this.toggleConsole.bind(this);

        window.$tmEventBus.listen(tmEvents.ConsoleLog, this.logMessage);
        document.querySelector(this.panelSelector)
            ?.addEventListener("click", this.handlePanelClick);
    }

    handlePanelClick(event: Event): void {
        const button = (event.target as Element | null)?.closest(
            "button[data-action]",
        ) as HTMLButtonElement | null;
        if (!button) {
            return;
        }

        const action = button.getAttribute("data-action");
        switch (action) {
            case "toggleConsole":
                this.toggleConsole(button);
                break;
            case "clearConsole":
                this.clearConsole();
                break;
            case "goToDiagnostic": {
                const line = Number.parseInt(button.getAttribute("data-line") || "", 10);
                const character = Number.parseInt(button.getAttribute("data-character") || "", 10);

                if (!Number.isFinite(line) || !Number.isFinite(character)) {
                    return;
                }

                const fileName = button.getAttribute("data-file-name") || undefined;
                window.$tmEventBus.emit(tmEvents.ConsoleJumpToLocation, {
                    fileName,
                    line,
                    character,
                });
                break;
            }
            default:
                break;
        }
    }

    toggleConsole(button?: HTMLButtonElement): void {
        this.collapsed = !this.collapsed;
        window.$tmEventBus.emit(tmEvents.ConsoleToggle, this.collapsed);
        if (button) {
            button.setAttribute("aria-expanded", (!this.collapsed).toString());
            button.setAttribute(
                "title",
                this.collapsed ? "Expand Console" : "Collapse Console",
            );
        }

        document.querySelector(`${this.panelSelector} ${this.consoleSelector}`)?.setAttribute(
            "aria-hidden",
            this.collapsed ? "true" : "false",
        );
    }

    logMessage({type, message, details, location}: TinymistConsoleMessage) {
        const consoleEl = document.querySelector(`${this.panelSelector} ${this.consoleSelector}`);
        if (!consoleEl) {
            console.warn("Console element not found for logging message:", message);
            return;
        }

        const detailsHtml = this.getErrorDetails(details);
        const signature = JSON.stringify([type, message, detailsHtml, location ?? null]);
        const timestampMs = Date.now();
        const existingEntry = this.findLatestEntry(signature);

        if (existingEntry) {
            const ageMs = timestampMs - existingEntry.timestampMs;

            if (ageMs <= this.dedupeWindowMs) {
                return;
            }

            if (ageMs <= this.aggregateWindowMs) {
                this.removeEntry(existingEntry);
                this.appendEntry(consoleEl, {
                    signature,
                    timestampMs,
                    repeatCount: existingEntry.repeatCount + 1,
                    element: this.buildMessageElement(type, message, detailsHtml, timestampMs, existingEntry.repeatCount + 1, location),
                });
                return;
            }
        }

        this.appendEntry(consoleEl, {
            signature,
            timestampMs,
            repeatCount: 1,
            element: this.buildMessageElement(type, message, detailsHtml, timestampMs, 1, location),
        });
    }

    buildMessageElement(
        type: TinymistConsoleMessage["type"],
        message: string,
        detailsHtml: string,
        timestampMs: number,
        repeatCount: number,
        location?: TinymistConsoleMessage["location"],
    ): HTMLDivElement {
        const timestamp = new Date(timestampMs).toLocaleTimeString();
        const messageDiv = document.createElement("div");
        messageDiv.className = `${tmClassNames.ConsoleMessage} ${type}`;

        const badgeHtml = repeatCount > 1
            ? `<span class="tinymist-console-message-badge" aria-label="Repeated ${repeatCount} times">(${repeatCount})</span>`
            : "";

        const locationHtml = location
            ? `<button type="button" class="tinymist-console-location" data-action="goToDiagnostic" data-file-name="${this.escapeHtml(location.fileName || "")}" data-line="${location.line}" data-character="${location.character}" title="Go to line ${location.line}, position ${location.character}">L${location.line}:C${location.character}</button>`
            : "";

        const detailsBlock = detailsHtml !== "" ? `<div class="tinymist-console-message-details">${detailsHtml}</div>` : "";

        messageDiv.innerHTML =
            `<div class="tinymist-console-message-line">` +
            `<span class="text-muted tinymist-console-message-meta">[${timestamp}]</span>` +
            `${badgeHtml}` +
            `<span class="tinymist-console-message-body">${this.escapeHtml(message)}</span>` +
            `${locationHtml}` +
            `</div>` +
            detailsBlock;

        return messageDiv;
    }

    findLatestEntry(signature: string): TinymistConsoleEntry | null {
        for (let i = this.entries.length - 1; i >= 0; i--) {
            if (this.entries[i].signature === signature) {
                return this.entries[i];
            }
        }

        return null;
    }

    appendEntry(consoleEl: Element, entry: TinymistConsoleEntry): void {
        consoleEl.appendChild(entry.element);
        this.entries.push(entry);
        this.pruneEntries();
        // Auto-scroll to bottom
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    pruneEntries(): void {
        while (this.entries.length > this.maxMessages) {
            const entry = this.entries.shift();
            entry?.element.remove();
        }
    }

    removeEntry(entry: TinymistConsoleEntry): void {
        const index = this.entries.indexOf(entry);
        if (index !== -1) {
            this.entries.splice(index, 1);
        }
        entry.element.remove();
    }

    escapeHtml(text: string) {
        const div = document.createElement("div");
        div.textContent = text;
        return div.innerHTML;
    }

    getErrorDetails(error: any): string {
        if (!error) {
            return "";
        } else if (error instanceof DOMException) {
            return `<code>DOMException:\nname: ${error.name}\nmessage: ${error.message}</code>`;
        } else if (error instanceof Error) {
            return (
                `<code>\ntype: ${typeof error}\nname: ${error.name}\n` +
                `message: ${error.message}\ncause: ${error.cause}` +
                JSON.stringify(error, null, 2) +
                "</code>"
            );
        } else if (
            error instanceof Object &&
            error?.type === "error" &&
            error.message
        ) {
            return `<code>${error.message} ${error?.code}</code>`;
        }
        return `<code>${JSON.stringify(error, null, 2)}</code>`;
    }

    clearConsole() {
        const consoleEl = document.querySelector(`${this.panelSelector} ${this.consoleSelector}`);
        if (!consoleEl) {
            console.warn("Console element not found for clearing.");
            return;
        }
        this.entries = [];
        consoleEl.innerHTML =
                '<div class="text-muted p-m text-small">Console cleared.</div>';
    }

    destroy(): void {
        document.querySelector(this.panelSelector)
            ?.removeEventListener("click", this.handlePanelClick);
    }
}
