import { Component } from "../../../../../resources/js/components/component";

export class TinymistPackageManager extends Component {
    setup(): void {
        const packageSelect = this.$refs.packageName as HTMLSelectElement | undefined;
        const versionSelect = this.$refs.packageVersion as HTMLSelectElement | undefined;

        if (!(packageSelect instanceof HTMLSelectElement) || !(versionSelect instanceof HTMLSelectElement)) {
            return;
        }

        let packageMap: Record<string, string[]> = {};
        try {
            packageMap = JSON.parse(this.$opts.packageMap || '{}');
        } catch (error) {
            console.error('Failed to parse Tinymist package map', error);
            packageMap = {};
        }

        const pickVersionText = this.$opts.pickVersionText || '';

        const renderVersions = () => {
            const packageName = packageSelect.value;
            const versions = packageMap[packageName] || [];
            versionSelect.innerHTML = '';

            if (versions.length === 0) {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = pickVersionText;
                versionSelect.appendChild(option);
                return;
            }

            versions.forEach((version, index) => {
                const option = document.createElement('option');
                option.value = version;
                option.textContent = version;
                if (index === 0) {
                    option.selected = true;
                }
                versionSelect.appendChild(option);
            });
        };

        packageSelect.addEventListener('change', renderVersions);
        renderVersions();
    }
}
