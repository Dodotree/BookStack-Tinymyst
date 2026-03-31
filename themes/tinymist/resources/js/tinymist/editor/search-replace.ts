import {
    EditorSelection,
    RangeSetBuilder,
    StateEffect,
    StateField,
} from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import { tmClassNames, tmEvents, tmSelectors } from "../constants";

type MatchRange = {
    from: number;
    to: number;
};

type SearchHighlightRange = MatchRange & {
    active: boolean;
};

const setSearchHighlightsEffect = StateEffect.define<SearchHighlightRange[]>();
const clearSearchHighlightsEffect = StateEffect.define<null>();

const searchMatchMark = Decoration.mark({ class: "tm-search-match" });
const activeSearchMatchMark = Decoration.mark({
    class: "tm-search-match tm-search-match-active",
});

const searchMatchHighlightField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(highlights, tr) {
        highlights = highlights.map(tr.changes);

        for (const effect of tr.effects) {
            if (effect.is(clearSearchHighlightsEffect)) {
                highlights = Decoration.none;
                continue;
            }

            if (!effect.is(setSearchHighlightsEffect)) {
                continue;
            }

            const builder = new RangeSetBuilder<Decoration>();
            const docLength = tr.state.doc.length;

            for (const range of effect.value) {
                const from = Math.max(0, Math.min(range.from, docLength));
                const to = Math.max(from, Math.min(range.to, docLength));
                if (to <= from) {
                    continue;
                }

                builder.add(
                    from,
                    to,
                    range.active ? activeSearchMatchMark : searchMatchMark,
                );
            }

            highlights = builder.finish();
        }

        return highlights;
    },
    provide: (field) => EditorView.decorations.from(field),
});

export class TinymistSearchReplace {
    private getEditorView: () => EditorView | null;
    private panelHidden: boolean = true;
    private query: string = "";
    private matchCount: HTMLElement | null = null;
    private replaceHidden: boolean = true;

    constructor(getEditorView: () => EditorView | null) {
        this.getEditorView = getEditorView;

        this.open = this.open.bind(this);
        this.close = this.close.bind(this);
        this.destroy = this.destroy.bind(this);
        this.refreshMatchCount = this.refreshMatchCount.bind(this);

        this.onDocumentKeyDown = this.onDocumentKeyDown.bind(this);
        this.onEditorKeyDown = this.onEditorKeyDown.bind(this);
        this.onSearchInput = this.onSearchInput.bind(this);
        this.onSearchInputKeyDown = this.onSearchInputKeyDown.bind(this);
        this.onReplaceInputKeyDown = this.onReplaceInputKeyDown.bind(this);
        this.onPanelClick = this.onPanelClick.bind(this);

        this.matchCount = document.querySelector<HTMLElement>(`${tmSelectors.Root} ${tmSelectors.SearchMatchCount}`);
        this.addRemoveListeners(true);
    }

    private addRemoveListeners(adding: boolean): void {
        const panel = document.querySelector<HTMLElement>(`${tmSelectors.Root} ${tmSelectors.SearchPanel}`);
        if (!panel) {
            return;
        }

        const method = adding ? "addEventListener" : "removeEventListener";

        document[method]("keydown", this.onDocumentKeyDown);
        panel[method]("keydown", this.onEditorKeyDown);
        panel[method]("click", this.onPanelClick);

        const searchInput = document.querySelector<HTMLInputElement>(`${tmSelectors.Root} ${tmSelectors.SearchInput}`);
        searchInput?.[method]("input", this.onSearchInput);
        searchInput?.[method]("keydown", this.onSearchInputKeyDown);

        const replaceInput = document.querySelector<HTMLInputElement>(`${tmSelectors.Root} ${tmSelectors.SearchReplaceInput}`);
        replaceInput?.[method]("keydown", this.onReplaceInputKeyDown);

        const busEventMethod = adding ? "listen" : "remove";
        window.$tmEventBus[busEventMethod](tmEvents.SearchReplaceOpen, this.open);
        window.$tmEventBus[busEventMethod](tmEvents.SearchReplaceClose, this.close);
        window.$tmEventBus[busEventMethod](tmEvents.Destroy, this.destroy);
    }

    destroy(): void {
        this.clearSearchHighlights();
        this.addRemoveListeners(false);
        this.getEditorView = () => null;
    }

    open(showReplace = false): void {
        const panel = document.querySelector<HTMLElement>(`${tmSelectors.Root} ${tmSelectors.SearchPanel}`);
        if (!panel) {
            return;
        }
        const searchInput = document.querySelector<HTMLInputElement>(`${tmSelectors.Root} ${tmSelectors.SearchInput}`);

        this.panelHidden = false;
        panel.hidden = false;
        panel.classList.add(tmClassNames.SearchVisible);

        this.toggleReplaceRow(showReplace);
        this.prefillSearchFromSelection();
        this.refreshMatchCount();
        searchInput?.focus();
        searchInput?.select();

        window.$tmEventBus.listen(tmEvents.TextModified, this.refreshMatchCount);
    }

    close(): void {
        const panel = document.querySelector<HTMLElement>(`${tmSelectors.Root} ${tmSelectors.SearchPanel}`);
        if (!panel) {
            return;
        }

        panel.classList.remove(tmClassNames.SearchVisible);
        panel.hidden = true;
        this.panelHidden = true;
        this.clearSearchHighlights();

        window.$tmEventBus.remove(tmEvents.TextModified, this.refreshMatchCount);
    }

    refreshMatchCount(): void {
        if (this.panelHidden) {
            return;
        }

        const view = this.getEditorView();

        if (!this.matchCount || !view || this.query.length === 0) {
            this.clearSearchHighlights();
            if (this.matchCount) {
                this.matchCount.textContent = "0 / 0";
            }
            return;
        }

        const text = view.state.doc.toString();
        const matches = this.collectMatches(text, this.query);
        const selected = view.state.selection.main;
        const selectedIndex = matches.findIndex(
            (match) =>
                match.from === selected.from && match.to === selected.to,
        );

        this.applySearchHighlights(view, matches, selectedIndex);

        this.matchCount.textContent =
            matches.length === 0
                ? "0 / 0"
                : `${selectedIndex >= 0 ? selectedIndex + 1 : 0} / ${matches.length}`;
    }

    private onDocumentKeyDown(event: Event): void {
        const keyboardEvent = event as KeyboardEvent;

        if (keyboardEvent.key === "Escape" && !this.panelHidden) {
            keyboardEvent.preventDefault();
            this.close();
            this.getEditorView()?.focus();
        }
    }

    private onEditorKeyDown(event: Event): void {
        const keyboardEvent = event as KeyboardEvent;
        const usesMeta = keyboardEvent.ctrlKey || keyboardEvent.metaKey;
        const key = keyboardEvent.key.toLowerCase();

        if (usesMeta && (key === "f" || key === "h")) {
            keyboardEvent.preventDefault();
            this.open(Boolean(key === "h"));
        }
    }

    private onSearchInput(event: Event): void {
        this.query = (event.target as HTMLInputElement)?.value ?? "";
        this.refreshMatchCount();
    }

    private onSearchInputKeyDown(event: Event): void {
        const keyboardEvent = event as KeyboardEvent;
        const input = event.target as HTMLInputElement;
        if (keyboardEvent.key !== "Enter") {
            return;
        }
        keyboardEvent.preventDefault();
        if (keyboardEvent.shiftKey) {
            this.previousMatch();
            input.focus();
            return;
        }
        this.nextMatch();
        input.focus();
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
                this.toggleReplaceRow();
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

    nextMatch(): void {
        const view = this.getEditorView();
        if (!view || this.query.length === 0) {
            return;
        }

        const matches = this.collectMatches(view.state.doc.toString(), this.query);
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
        if (!view || this.query.length === 0) {
            return;
        }

        const matches = this.collectMatches(view.state.doc.toString(), this.query);
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
        if (!view || this.query.length === 0) {
            return;
        }
        const replaceInput = document.querySelector<HTMLInputElement>(`${tmSelectors.Root} ${tmSelectors.SearchReplaceInput}`);
        const replacement = replaceInput?.value ?? "";
        const matches = this.collectMatches(view.state.doc.toString(), this.query);
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
        if (!view || this.query.length === 0) {
            return;
        }

        const replaceInput = document.querySelector<HTMLInputElement>(`${tmSelectors.Root} ${tmSelectors.SearchReplaceInput}`);
        const replacement = replaceInput?.value ?? "";
        const matches = this.collectMatches(view.state.doc.toString(), this.query);
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

    private toggleReplaceRow(expanded?: boolean): void {
        const replaceRow = document.querySelector<HTMLElement>(`${tmSelectors.Root} ${tmSelectors.SearchReplaceRow}`);
        const toggleReplaceButton = document.querySelector<HTMLButtonElement>(`${tmSelectors.Root} ${tmSelectors.SearchReplaceToggle}`);

        if (!replaceRow || !toggleReplaceButton) {
            return;
        }

        if (expanded !== undefined) {
            this.replaceHidden = !expanded;
        } else {
            this.replaceHidden = !this.replaceHidden;
        }
        replaceRow.hidden = this.replaceHidden;
        toggleReplaceButton.setAttribute("aria-expanded", String(!this.replaceHidden));
    }

    private prefillSearchFromSelection(): void {
        const view = this.getEditorView();
        const searchInput = document.querySelector<HTMLInputElement>(`${tmSelectors.Root} ${tmSelectors.SearchInput}`);
        if (!view || !searchInput) {
            return;
        }

        const selected = view.state.selection.main;
        const selectedText = view.state.doc.sliceString(selected.from, selected.to).trim();
        if (selectedText.length > 0) {
            searchInput.value = selectedText;
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

    private ensureSearchHighlightExtension(view: EditorView): void {
        if (view.state.field(searchMatchHighlightField, false)) {
            return;
        }

        view.dispatch({
            effects: StateEffect.appendConfig.of([searchMatchHighlightField]),
        });
    }

    private applySearchHighlights(
        view: EditorView,
        matches: MatchRange[],
        selectedIndex: number,
    ): void {
        this.ensureSearchHighlightExtension(view);

        view.dispatch({
            effects: setSearchHighlightsEffect.of(
                matches.map((match, index) => ({
                    from: match.from,
                    to: match.to,
                    active: index === selectedIndex,
                })),
            ),
        });
    }

    private clearSearchHighlights(): void {
        const view = this.getEditorView();
        if (!view || !view.state.field(searchMatchHighlightField, false)) {
            return;
        }

        view.dispatch({
            effects: clearSearchHighlightsEffect.of(null),
        });
    }
}
