// Visible editor console for displaying compilation messages and diagnostics
import { tmClassNames, tmEvents } from "./constants";

export class TinymistConsole {
    panelSelector: string;
    consoleSelector: string;
    collapsed: boolean = false;

    constructor(panelSelector: string, consoleSelector: string) {
        this.panelSelector = panelSelector;
        this.consoleSelector = consoleSelector;

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

    logMessage({
        type,
        message,
        details,
    }: {
        type: "error" | "warning" | "info" | "success" | "hint";
        message: string;
        details?: any;
    }) {
        const timestamp = new Date().toLocaleTimeString();
        const messageDiv = document.createElement("div");
        messageDiv.className = `${tmClassNames.ConsoleMessage} ${type}`;
        messageDiv.innerHTML =
            `<span class="text-muted">[${timestamp}]</span> ` +
            this.escapeHtml(message) +
            "<br>" +
            this.getErrorDetails(details!);

        const consoleEl = document.querySelector(`${this.panelSelector} ${this.consoleSelector}`);
        if(!consoleEl) {
            console.warn("Console element not found for logging message:", message);
            return;
        }
        consoleEl.appendChild(messageDiv);
        // Auto-scroll to bottom
        consoleEl.scrollTop = consoleEl.scrollHeight;
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
        consoleEl.innerHTML =
                '<div class="text-muted p-m text-small">Console cleared.</div>';
    }

    destroy(): void {
        document.querySelector(this.panelSelector)
            ?.removeEventListener("click", this.handlePanelClick);
    }
}
