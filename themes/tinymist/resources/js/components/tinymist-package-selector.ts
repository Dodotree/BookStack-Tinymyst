import * as DOM from '../../../../../resources/js/services/dom';
import { Component } from '../../../../../resources/js/components/component';

export class TinymistPackageSelector extends Component {
    setup(): void {
        const searchInput = this.$refs.searchInput as HTMLInputElement | undefined;
        const searchButton = this.$refs.searchButton as HTMLButtonElement | undefined;
        const searchCancel = this.$refs.searchCancel as HTMLButtonElement | undefined;

        DOM.onChildEvent(this.$el, '[data-package-item]', 'click', (event, item) => {
            if ((event.target as HTMLElement | null)?.closest('[data-package-action="insert"]')) {
                return;
            }

            this.insertPackage(item);
        });

        DOM.onChildEvent(this.$el, '[data-package-action="insert"]', 'click', (event, button) => {
            event.stopPropagation();
            const item = button.closest('[data-package-item]');
            if (item instanceof HTMLElement) {
                this.insertPackage(item);
            }
        });

        this.$el.addEventListener('keydown', (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const item = target?.closest('[data-package-item]');
            if (!(item instanceof HTMLElement)) {
                return;
            }

            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.insertPackage(item);
            }
        });

        const runSearch = () => this.applySearch(searchInput?.value || '');

        searchInput?.addEventListener('input', runSearch);
        searchInput?.addEventListener('keypress', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                runSearch();
            }
        });
        searchButton?.addEventListener('click', runSearch);
        searchCancel?.addEventListener('click', () => {
            if (searchInput) {
                searchInput.value = '';
            }
            runSearch();
        });
    }

    private insertPackage(item: HTMLElement): void {
        const namespace = (item.dataset.packageNamespace || '').trim();
        const name = (item.dataset.packageName || '').trim();
        const version = (item.dataset.packageVersion || '').trim();

        if (!namespace || !name || !version) {
            return;
        }

        window.$events.emit('editor::insert', {
            typst: `#import "@${namespace}/${name}:${version}": *\n`,
        });
    }

    private applySearch(rawTerm: string): void {
        const term = rawTerm.trim().toLowerCase();
        const items = Array.from(this.$el.querySelectorAll<HTMLElement>('[data-package-item]'));
        const noResults = this.$refs.noResults as HTMLElement | undefined;
        let visibleCount = 0;

        items.forEach(item => {
            const haystack = (item.dataset.packageSearch || '').toLowerCase();
            const matches = term === '' || haystack.includes(term);
            item.style.display = matches ? '' : 'none';
            visibleCount += matches ? 1 : 0;
        });

        const searchCancel = this.$refs.searchCancel as HTMLElement | undefined;
        if (searchCancel instanceof HTMLElement) {
            searchCancel.style.display = term ? 'block' : 'none';
        }

        if (noResults instanceof HTMLElement) {
            noResults.hidden = visibleCount !== 0;
        }
    }
}
