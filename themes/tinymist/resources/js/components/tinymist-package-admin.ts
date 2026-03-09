import { Component } from "../../../../../resources/js/components/component";
import { showLoading } from "../../../../../resources/js/services/dom";
import { HttpError } from "../../../../../resources/js/services/http";

export class TinymistPackageAdmin extends Component {
    private loadingEl: HTMLDivElement | null = null;

    setup(): void {
        this.$el.addEventListener('submit', (event: Event) => {
            const target = event.target;
            if (!(target instanceof HTMLFormElement)) {
                return;
            }

            if (!target.hasAttribute('data-tinymist-package-form')) {
                return;
            }

            event.preventDefault();
            const submitEvent = event as SubmitEvent;
            const submitter = submitEvent.submitter instanceof HTMLButtonElement ? submitEvent.submitter : null;
            void this.submitForm(target, submitter);
        });

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
            void this.runDependencyAction(actionButton);
        });
    }

    private async submitForm(form: HTMLFormElement, button: HTMLButtonElement | null): Promise<void> {
        if (!(button instanceof HTMLButtonElement)) {
            button = form.querySelector('button[type="submit"], button:not([type])');
        }

        const formData = new FormData(form);
        this.appendReportContext(formData);
        this.appendGithubSelection(formData);
        await this.performRequest(form.action, formData, button);
    }

    private async runDependencyAction(button: HTMLButtonElement): Promise<void> {
        const action = button.dataset.dependencyAction || '';
        const formData = new FormData();
        this.appendButtonContext(button, formData);

        let url = '';
        if (action === 'scan-full') {
            url = this.$opts.reportUrl || '';
            formData.set('full_scan', '1');
        }

        if (action === 'install-single') {
            url = this.$opts.installUrl || '';
            formData.set('github_package_name', button.dataset.githubPackageName || '');
            formData.set('github_package_version', button.dataset.githubPackageVersion || '');
        }

        if (action === 'install-all') {
            url = this.$opts.installAllUrl || '';
            formData.set('full_scan', '1');
        }

        if (url === '') {
            return;
        }

        this.appendGithubSelection(formData);
        await this.performRequest(url, formData, button);
    }

    private async performRequest(url: string, formData: FormData, button: HTMLButtonElement | null): Promise<void> {
        const content = this.$refs.content as HTMLElement | undefined;
        if (!(content instanceof HTMLElement)) {
            return;
        }

        this.setLoadingState(button, true);

        try {
            const response = await window.$http.post(url, formData);
            if (typeof response.data === 'object' && response.data !== null) {
                if (typeof response.data.html === 'string') {
                    content.innerHTML = response.data.html;
                    window.$components.init(content);
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
                window.$events.error(this.$opts.requestErrorText || 'Package request failed');
            }
        } finally {
            this.setLoadingState(button, false);
        }
    }

    private appendReportContext(formData: FormData): void {
        const reportState = this.$el.querySelector('[data-current-report="true"]');
        if (!(reportState instanceof HTMLElement)) {
            return;
        }

        if (!formData.has('report_package_namespace')) {
            formData.set('report_package_namespace', reportState.dataset.reportPackageNamespace || '');
        }
        if (!formData.has('report_package_name')) {
            formData.set('report_package_name', reportState.dataset.reportPackageName || '');
        }
        if (!formData.has('report_package_version')) {
            formData.set('report_package_version', reportState.dataset.reportPackageVersion || '');
        }
        if (!formData.has('full_scan')) {
            formData.set('full_scan', reportState.dataset.fullScan || '0');
        }
    }

    private appendButtonContext(button: HTMLButtonElement, formData: FormData): void {
        formData.set('report_package_namespace', button.dataset.reportPackageNamespace || '');
        formData.set('report_package_name', button.dataset.reportPackageName || '');
        formData.set('report_package_version', button.dataset.reportPackageVersion || '');
        formData.set('full_scan', button.dataset.fullScan || '0');
    }

    private appendGithubSelection(formData: FormData): void {
        const packageNameInput = this.$el.querySelector<HTMLSelectElement>('select[name="github_package_name"]');
        const packageVersionInput = this.$el.querySelector<HTMLSelectElement>('select[name="github_package_version"]');

        if (packageNameInput && !formData.has('github_package_name')) {
            formData.set('github_package_name', packageNameInput.value);
        }

        if (packageVersionInput && !formData.has('github_package_version')) {
            formData.set('github_package_version', packageVersionInput.value);
        }
    }

    private setLoadingState(button: HTMLButtonElement | null, active: boolean): void {

        const buttons = this.$el.querySelectorAll<HTMLButtonElement>('button');
        buttons.forEach(targetButton => {
            targetButton.disabled = active;
        });

        if (active && button instanceof HTMLButtonElement) {
            if (!this.loadingEl) {
                this.loadingEl = document.createElement('div');
                this.loadingEl.className = 'inline block';
                showLoading(this.loadingEl);
            }

            button.after(this.loadingEl);
            this.$el.setAttribute('aria-busy', 'true');
            return;
        }

        this.loadingEl?.remove();
        this.$el.removeAttribute('aria-busy');
    }
}
