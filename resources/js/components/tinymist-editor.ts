import { Component } from "./component";
import { TinymistApp } from "../tinymist/index";

export class TinymistEditor extends Component {
    private app: TinymistApp | null = null;

    setup(): void {
        this.app = new TinymistApp(this.$el, this.$refs as Record<string, HTMLElement>, this.$opts);
        this.app.setup();
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
    }
}
