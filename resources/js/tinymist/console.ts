// Visible editor console for displaying compilation messages and diagnostics
export class TinymistConsole {
    console: HTMLElement;
    collapsed: boolean = false;

    constructor(console: HTMLElement) {
        this.console = console;

        // Saving reference of the bound method to be able to remove listeners later if needed
        this.logMessage = this.logMessage.bind(this);
        this.clearConsole = this.clearConsole.bind(this);
        this.handlePanelClick = this.handlePanelClick.bind(this);
        this.toggleConsole = this.toggleConsole.bind(this);

        window.$tmEventBus.listen("console-log", this.logMessage);
        this.console
            .closest("#tinymist-console-panel")
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
        window.$tmEventBus.emit("console-toggle", this.collapsed);
        if (button) {
            button.setAttribute("aria-expanded", (!this.collapsed).toString());
            button.setAttribute(
                "title",
                this.collapsed ? "Expand Console" : "Collapse Console",
            );
        }

        this.console.setAttribute(
            "aria-hidden",
            this.collapsed ? "true" : "false",
        );
    }

    logMessage({
        type,
        message,
        details,
    }: {
        type: "error" | "warning" | "info" | "success";
        message: string;
        details?: any;
    }) {
        const timestamp = new Date().toLocaleTimeString();
        const messageDiv = document.createElement("div");
        messageDiv.className = `console-message ${type}`;
        messageDiv.innerHTML =
            `<span class="text-muted">[${timestamp}]</span> ` +
            this.escapeHtml(message) +
            "<br>" +
            this.getErrorDetails(details!);

        this.console.appendChild(messageDiv);
        // Auto-scroll to bottom
        this.console.scrollTop = this.console.scrollHeight;
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
        this.console.innerHTML =
            '<div class="text-muted p-m text-small">Console cleared.</div>';
    }

    destroy(): void {
        this.console
            .closest("#tinymist-console-panel")
            ?.removeEventListener("click", this.handlePanelClick);
    }
}
