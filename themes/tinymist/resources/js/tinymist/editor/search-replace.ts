import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tmClassNames, tmSelectors } from "../constants";

type MatchRange = {
    from: number;
    to: number;
};

export class TinymistSearchReplace {
    private readonly getEditorView: () => EditorView | null;
    private root: HTMLElement | null = null;
    private panel: HTMLElement | null = null;
    private searchInput: HTMLInputElement | null = null;
    private replaceInput: HTMLInputElement | null = null;
    private matchCount: HTMLElement | null = null;
    private replaceRow: HTMLElement | null = null;
    private toggleReplaceButton: HTMLButtonElement | null = null;

    constructor(getEditorView: () => EditorView | null) {
        this.getEditorView = getEditorView;

        this.open = this.open.bind(this);
        this.close = this.close.bind(this);
        this.destroy = this.destroy.bind(this);
        this.refreshMatchCount = this.refreshMatchCount.bind(this);

        this.onDocumentKeyDown = this.onDocumentKeyDown.bind(this);
        this.onSearchInput = this.onSearchInput.bind(this);
        this.onSearchInputKeyDown = this.onSearchInputKeyDown.bind(this);
        this.onReplaceInputKeyDown = this.onReplaceInputKeyDown.bind(this);
        this.onPanelClick = this.onPanelClick.bind(this);

        this.cacheNodes();
        this.addRemoveListeners(true);
    }

    open(showReplace = false): void {
        if (!this.panel) {
            return;
        }

        this.panel.hidden = false;
        this.panel.classList.add(tmClassNames.SearchVisible);

        if (showReplace) {
            this.setReplaceExpanded(true);
        }

        this.prefillSearchFromSelection();
        this.refreshMatchCount();
        this.searchInput?.focus();
        this.searchInput?.select();
    }

    close(): void {
        if (!this.panel) {
            return;
        }

        this.panel.classList.remove(tmClassNames.SearchVisible);
        this.panel.hidden = true;
        this.setReplaceExpanded(false);
    }

    destroy(): void {
        this.addRemoveListeners(false);
        this.root = null;
        this.panel = null;
        this.searchInput = null;
        this.replaceInput = null;
        this.matchCount = null;
        this.replaceRow = null;
        this.toggleReplaceButton = null;
    }

    refreshMatchCount(): void {
        const query = this.getQuery();
        const view = this.getEditorView();

        if (!this.matchCount || !view || query.length === 0) {
            if (this.matchCount) {
                this.matchCount.textContent = "0 / 0";
            }
            return;
        }

        const text = view.state.doc.toString();
        const matches = this.collectMatches(text, query);
        const selected = view.state.selection.main;
        const selectedIndex = matches.findIndex(
            (match) =>
                match.from === selected.from && match.to === selected.to,
        );

        this.matchCount.textContent =
            matches.length === 0
                ? "0 / 0"
                : `${selectedIndex >= 0 ? selectedIndex + 1 : 0} / ${matches.length}`;
    }

    nextMatch(): void {
        const view = this.getEditorView();
        const query = this.getQuery();
        if (!view || query.length === 0) {
            return;
        }

        const matches = this.collectMatches(view.state.doc.toString(), query);
        if (matches.length === 0) {
            this.refreshMatchCount();
            return;
        }

        const selected = view.state.selection.main;
        const nextIndex = matches.findIndex((match) => match.from >= selected.to);
        const target = matches[nextIndex >= 0 ? nextIndex : 0];
        this.selectRange(target.from, target.to);
    }

    previousMatch(): void {
        const view = this.getEditorView();
        const query = this.getQuery();
        if (!view || query.length === 0) {
            return;
        }

        const matches = this.collectMatches(view.state.doc.toString(), query);
        if (matches.length === 0) {
            this.refreshMatchCount();
            return;
        }

        const selected = view.state.selection.main;
        let target = matches[matches.length - 1];
        for (let index = matches.length - 1; index >= 0; index--) {
            if (matches[index].to <= selected.from) {
                target = matches[index];
                break;
            }
        }

        this.selectRange(target.from, target.to);
    }

    replaceNext(): void {
        const view = this.getEditorView();
        const query = this.getQuery();
        if (!view || query.length === 0) {
            return;
        }

        const replacement = this.replaceInput?.value ?? "";
        const matches = this.collectMatches(view.state.doc.toString(), query);
        if (matches.length === 0) {
            this.refreshMatchCount();
            return;
        }

        const selected = view.state.selection.main;
        const selectedIndex = matches.findIndex(
            (match) =>
                match.from === selected.from && match.to === selected.to,
        );
        const nextIndex =
            selectedIndex >= 0
                ? selectedIndex
                : matches.findIndex((match) => match.from >= selected.to);
        const targetIndex = nextIndex >= 0 ? nextIndex : 0;
        const target = matches[targetIndex];

        view.dispatch({
            changes: {
                from: target.from,
                to: target.to,
                insert: replacement,
            },
            selection: EditorSelection.single(
                target.from,
                target.from + replacement.length,
            ),
            scrollIntoView: true,
        });
        view.focus();

        this.nextMatch();
        this.refreshMatchCount();
    }

    replaceAll(): void {
        const view = this.getEditorView();
        const query = this.getQuery();
        if (!view || query.length === 0) {
            return;
        }

        const replacement = this.replaceInput?.value ?? "";
        const matches = this.collectMatches(view.state.doc.toString(), query);
        if (matches.length === 0) {
            this.refreshMatchCount();
            return;
        }

        const changes = matches
            .slice()
            .reverse()
            .map((match) => ({
                from: match.from,
                to: match.to,
                insert: replacement,
            }));

        view.dispatch({ changes });
        view.focus();
        this.refreshMatchCount();
    }

    private cacheNodes(): void {
        this.root = document.querySelector<HTMLElement>(tmSelectors.Root);
        this.panel = this.root?.querySelector<HTMLElement>(
            tmSelectors.SearchPanel,
        ) ?? null;
        this.searchInput = this.root?.querySelector<HTMLInputElement>(
            tmSelectors.SearchInput,
        ) ?? null;
        this.replaceInput = this.root?.querySelector<HTMLInputElement>(
            tmSelectors.SearchReplaceInput,
        ) ?? null;
        this.matchCount = this.root?.querySelector<HTMLElement>(
            tmSelectors.SearchMatchCount,
        ) ?? null;
        this.replaceRow = this.root?.querySelector<HTMLElement>(
            tmSelectors.SearchReplaceRow,
        ) ?? null;
        this.toggleReplaceButton = this.root?.querySelector<HTMLButtonElement>(
            tmSelectors.SearchReplaceToggle,
        ) ?? null;
    }

    private addRemoveListeners(adding: boolean): void {
        if (!this.root || !this.panel) {
            return;
        }

        const method = adding ? "addEventListener" : "removeEventListener";
        document[method]("keydown", this.onDocumentKeyDown);
        this.panel[method]("click", this.onPanelClick);
        this.searchInput?.[method]("input", this.onSearchInput);
        this.searchInput?.[method]("keydown", this.onSearchInputKeyDown);
        this.replaceInput?.[method]("keydown", this.onReplaceInputKeyDown);
    }

    private onDocumentKeyDown(event: Event): void {
        const keyboardEvent = event as KeyboardEvent;
        const target = keyboardEvent.target as Node | null;
        const focusInTinymist = Boolean(target && this.root?.contains(target));

        const usesMeta = keyboardEvent.ctrlKey || keyboardEvent.metaKey;
        const key = keyboardEvent.key.toLowerCase();

        if (usesMeta && key === "f" && focusInTinymist) {
            keyboardEvent.preventDefault();
            this.open(false);
            return;
        }

        if (usesMeta && key === "h" && focusInTinymist) {
            keyboardEvent.preventDefault();
            this.open(true);
            return;
        }

        if (keyboardEvent.key === "Escape" && this.panel && !this.panel.hidden) {
            keyboardEvent.preventDefault();
            this.close();
            this.getEditorView()?.focus();
        }
    }

    private onSearchInput(): void {
        this.refreshMatchCount();
    }

    private onSearchInputKeyDown(event: Event): void {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== "Enter") {
            return;
        }
        keyboardEvent.preventDefault();
        if (keyboardEvent.shiftKey) {
            this.previousMatch();
            return;
        }
        this.nextMatch();
    }

    private onReplaceInputKeyDown(event: Event): void {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== "Enter") {
            return;
        }
        keyboardEvent.preventDefault();
        this.replaceNext();
    }

    private onPanelClick(event: Event): void {
        const target = event.target as Element;
        const button = target.closest<HTMLButtonElement>("button[data-tm-search-action]");
        if (!button) {
            return;
        }

        const action = button.dataset.tmSearchAction;
        switch (action) {
            case "close":
                this.close();
                this.getEditorView()?.focus();
                break;
            case "next":
                this.nextMatch();
                break;
            case "previous":
                this.previousMatch();
                break;
            case "toggleReplace":
                this.setReplaceExpanded(this.replaceRow?.hidden ?? true);
                break;
            case "replace":
                this.replaceNext();
                break;
            case "replaceAll":
                this.replaceAll();
                break;
            default:
                break;
        }
    }

    private setReplaceExpanded(expanded: boolean): void {
        if (!this.replaceRow || !this.toggleReplaceButton) {
            return;
        }

        this.replaceRow.hidden = !expanded;
        this.toggleReplaceButton.setAttribute("aria-expanded", expanded ? "true" : "false");
    }

    private prefillSearchFromSelection(): void {
        const view = this.getEditorView();
        if (!view || !this.searchInput) {
            return;
        }

        const selected = view.state.selection.main;
        const selectedText = view.state.doc.sliceString(selected.from, selected.to).trim();
        if (selectedText.length > 0) {
            this.searchInput.value = selectedText;
        }
    }

    private collectMatches(text: string, query: string): MatchRange[] {
        if (query.length === 0) {
            return [];
        }

        const matches: MatchRange[] = [];
        let fromIndex = 0;
        while (fromIndex <= text.length) {
            const index = text.indexOf(query, fromIndex);
            if (index < 0) {
                break;
            }

            matches.push({
                from: index,
                to: index + query.length,
            });

            fromIndex = index + Math.max(query.length, 1);
        }

        return matches;
    }

    private selectRange(from: number, to: number): void {
        const view = this.getEditorView();
        if (!view) {
            return;
        }

        view.dispatch({
            selection: EditorSelection.single(from, to),
            scrollIntoView: true,
        });
        view.focus();
        this.refreshMatchCount();
    }

    private getQuery(): string {
        return this.searchInput?.value ?? "";
    }
}
