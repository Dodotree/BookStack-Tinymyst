import { Component } from "../../../../../resources/js/components/component";
import { HttpError } from "../../../../../resources/js/services/http";

export class TinymistPackageDependencies extends Component {
    setup(): void {
        this.$el.addEventListener('click', (event: Event) => {
            const target = event.target;
            if (!(target instanceof Element)) {
                return;
            }

            const actionButton = target.closest('[data-dependency-action]');
            if (!(actionButton instanceof HTMLButtonElement)) {
                return;
            }

            event.preventDefault();
            void this.handleAction(actionButton);
        });
    }

    private async handleAction(button: HTMLButtonElement): Promise<void> {
        const action = button.dataset.dependencyAction || '';
        const reportContainer = this.$refs.reportContainer as HTMLElement | undefined;
        if (!(reportContainer instanceof HTMLElement)) {
            return;
        }

        const payload = {
            report_package_namespace: button.dataset.reportPackageNamespace || '',
            report_package_name: button.dataset.reportPackageName || '',
            report_package_version: button.dataset.reportPackageVersion || '',
            full_scan: button.dataset.fullScan === '1',
        };

        let url = '';
        let requestBody: Record<string, string|boolean> = payload;

        if (action === 'scan-full') {
            url = this.$opts.reportUrl || '';
            requestBody = {...payload, full_scan: true};
        }

        if (action === 'install-single') {
            url = this.$opts.installUrl || '';
            requestBody = {
                ...payload,
                github_package_name: button.dataset.githubPackageName || '',
                github_package_version: button.dataset.githubPackageVersion || '',
            };
        }

        if (action === 'install-all') {
            url = this.$opts.installAllUrl || '';
            requestBody = {...payload, full_scan: true};
        }

        if (url === '') {
            return;
        }

        this.setBusyState(true);

        try {
            const response = await window.$http.post(url, requestBody);
            if (typeof response.data === 'object' && response.data !== null) {
                if (typeof response.data.html === 'string') {
                    reportContainer.innerHTML = response.data.html;
                }

                if (typeof response.data.message === 'string' && response.data.message !== '') {
                    window.$events.success(response.data.message);
                }
            }
        } catch (error) {
            if (error instanceof HttpError) {
                window.$events.showValidationErrors(error);
                window.$events.showResponseError(error);
            } else {
                window.$events.error(this.$opts.requestErrorText || 'Dependency request failed');
            }
        } finally {
            this.setBusyState(false);
        }
    }

    private setBusyState(isBusy: boolean): void {
        const buttons = this.$el.querySelectorAll<HTMLButtonElement>('[data-dependency-action]');
        buttons.forEach(button => {
            button.disabled = isBusy;
        });

        if (isBusy) {
            this.$el.setAttribute('aria-busy', 'true');
        } else {
            this.$el.removeAttribute('aria-busy');
        }
    }
}
