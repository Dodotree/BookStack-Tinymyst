export class TinymistAttachmentsBridge {
    private pageId: number;
    private container: HTMLElement | null;
    private listPanel: HTMLElement | null;
    private attachmentServerDirtyByName = new Map<string, boolean>();
    private attachmentSessionDirtyByName = new Map<string, boolean>();

    constructor(pageId: number) {
        this.pageId = pageId;
        this.container = document.querySelector('[component="attachments"]') as HTMLElement | null;
        this.listPanel = this.container?.querySelector('[refs="attachments@list-panel"]') as HTMLElement | null;

        this.refreshDirtyMap = this.refreshDirtyMap.bind(this);
        this.handleSaveRequest = this.handleSaveRequest.bind(this);
        this.handleUndoRequest = this.handleUndoRequest.bind(this);
        this.handlePreviewSaveEvent = this.handlePreviewSaveEvent.bind(this);
        this.handlePreviewUndoEvent = this.handlePreviewUndoEvent.bind(this);
        this.handleAttachmentStateChange = this.handleAttachmentStateChange.bind(this);
        this.reloadAttachmentList = this.reloadAttachmentList.bind(this);

        this.container?.addEventListener('event-emit-select-save', this.handlePreviewSaveEvent);
        this.container?.addEventListener('event-emit-select-undo', this.handlePreviewUndoEvent);
        this.container?.addEventListener('dropzone-upload-success', this.reloadAttachmentList);
        this.container?.addEventListener('ajax-form-success', this.reloadAttachmentList);
        this.container?.addEventListener('ajax-delete-row-success', this.reloadAttachmentList);
        window.$events.listen('attachments-file-dirty-state', this.handleAttachmentStateChange);

        void this.refreshDirtyMap();
    }

    private handlePreviewSaveEvent(event: Event): void {
        const details = (event as CustomEvent).detail || {};
        void this.handleSaveRequest({attachmentId: Number(details.id)});
    }

    private handlePreviewUndoEvent(event: Event): void {
        const details = (event as CustomEvent).detail || {};
        void this.handleUndoRequest({attachmentId: Number(details.id)});
    }

    private handleAttachmentStateChange(payload: {fileName?: string; isDirty?: boolean}): void {
        const normalizedName = String(payload?.fileName || '').trim();
        if (!normalizedName) {
            return;
        }

        this.attachmentSessionDirtyByName.set(normalizedName, Boolean(payload?.isDirty));
        this.applyDirtyStateForFile(normalizedName);
        this.emitDirtyMapUpdated();
    }

    private async reloadAttachmentList(): Promise<void> {
        if (!this.listPanel || !Number.isFinite(this.pageId) || this.pageId <= 0) {
            return;
        }

        const resp = await window.$http.get(`/attachments/get/page/${this.pageId}`);
        this.listPanel.innerHTML = String(resp.data || '');
        window.$components.init(this.listPanel);
        this.applyAllDirtyStatesToList();
        await this.refreshDirtyMap();
    }

    private async refreshDirtyMap(): Promise<void> {
        if (!Number.isFinite(this.pageId) || this.pageId <= 0) {
            return;
        }

        try {
            const resp = (await window.$http.get(`/attachments/dirty/page/${this.pageId}`)) as any;
            this.applyDirtyMap(resp?.data?.dirtyMap || {});
        } catch {
            // Keep existing in-memory state if dirty map fetch fails.
        }
    }

    private async handleSaveRequest(payload: {attachmentId?: number}): Promise<void> {
        const attachmentId = Number(payload?.attachmentId);
        if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
            return;
        }

        try {
            const resp = (await window.$http.put(`/attachments/${attachmentId}/save-from-preview`)) as any;
            const fileName = String(resp?.data?.fileName || '').trim();
            if (fileName) {
                this.markAttachmentClean(fileName);
            }
            if (resp?.data?.message) {
                window.$events.emit('success', resp.data.message);
            }
        } catch (error: any) {
            window.$events.emit('error', error?.response?.data?.message || 'Failed to save attachment changes');
        }
    }

    private async handleUndoRequest(payload: {attachmentId?: number}): Promise<void> {
        const attachmentId = Number(payload?.attachmentId);
        if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
            return;
        }

        try {
            const resp = (await window.$http.put(`/attachments/${attachmentId}/undo-from-preview`)) as any;
            const fileName = String(resp?.data?.fileName || '').trim();
            if (fileName) {
                this.markAttachmentClean(fileName);
                window.$events.emit('attachments-reset-file', {
                    fileName,
                });
            }
            if (resp?.data?.message) {
                window.$events.emit('success', resp.data.message);
            }
        } catch (error: any) {
            window.$events.emit('error', error?.response?.data?.message || 'Failed to undo attachment changes');
        }
    }

    private applyAllDirtyStatesToList(): void {
        const rows = this.listPanel?.querySelectorAll('[data-file-name]') || [];
        rows.forEach(row => {
            const fileName = String((row as HTMLElement).getAttribute('data-file-name') || '').trim();
            if (!fileName) {
                return;
            }
            const isDirty = this.isAttachmentDirty(fileName);
            this.setRowActionState(row as HTMLElement, isDirty);
        });
    }

    private applyDirtyStateForFile(fileName: string): void {
        const escapedFileName = (typeof window.CSS !== 'undefined' && typeof window.CSS.escape === 'function')
            ? window.CSS.escape(fileName)
            : fileName.replace(/"/g, '\\"');
        const row = this.listPanel?.querySelector(`[data-file-name="${escapedFileName}"]`) as HTMLElement | null;
        if (!row) {
            return;
        }
        this.setRowActionState(row, this.isAttachmentDirty(fileName));
    }

    private isAttachmentDirty(fileName: string): boolean {
        const normalizedName = String(fileName || '').trim();
        if (!normalizedName) {
            return false;
        }
        return Boolean(this.attachmentServerDirtyByName.get(normalizedName))
            || Boolean(this.attachmentSessionDirtyByName.get(normalizedName));
    }

    private setRowActionState(row: HTMLElement, isDirty: boolean): void {
        const actionButtons = row.querySelectorAll('[data-attachment-action="save"], [data-attachment-action="undo"]');
        actionButtons.forEach(button => {
            (button as HTMLButtonElement).disabled = !isDirty;
            button.classList.toggle('disabled', !isDirty);
            button.setAttribute('aria-disabled', (!isDirty).toString());
        });
    }

    private applyDirtyMap(dirtyMap: Record<string, unknown>): void {
        this.attachmentServerDirtyByName.clear();
        const nextMap = dirtyMap && typeof dirtyMap === 'object' ? dirtyMap : {};
        for (const [fileName, isDirty] of Object.entries(nextMap)) {
            const normalizedName = String(fileName || '').trim();
            if (!normalizedName) {
                continue;
            }
            this.attachmentServerDirtyByName.set(normalizedName, Boolean(isDirty));
        }
        this.applyAllDirtyStatesToList();
        this.emitDirtyMapUpdated();
    }

    private emitDirtyMapUpdated(): void {
        const effectiveMap: Record<string, boolean> = {};
        const fileNames = new Set([
            ...this.attachmentServerDirtyByName.keys(),
            ...this.attachmentSessionDirtyByName.keys(),
        ]);

        fileNames.forEach(fileName => {
            effectiveMap[fileName] = this.isAttachmentDirty(fileName);
        });

        window.$events.emit('attachments-dirty-map-updated', {
            dirtyMap: effectiveMap,
        });
    }

    private markAttachmentClean(fileName: string): void {
        const normalizedName = String(fileName || '').trim();
        if (!normalizedName) {
            return;
        }
        this.attachmentServerDirtyByName.set(normalizedName, false);
        this.attachmentSessionDirtyByName.set(normalizedName, false);
        this.applyDirtyStateForFile(normalizedName);
        this.emitDirtyMapUpdated();
    }
}
