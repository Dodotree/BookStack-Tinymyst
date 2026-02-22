import {showLoading} from '../services/dom.ts';
import {Component} from './component';

export class Attachments extends Component {

    setup() {
        this.container = this.$el;
        this.pageId = this.$opts.pageId;
        this.editContainer = this.$refs.editContainer;
        this.listContainer = this.$refs.listContainer;
        this.linksContainer = this.$refs.linksContainer;
        this.listPanel = this.$refs.listPanel;
        this.attachLinkButton = this.$refs.attachLinkButton;
        this.attachmentServerDirtyByName = new Map();
        this.attachmentSessionDirtyByName = new Map();

        this.setupListeners();
    }

    setupListeners() {
        const reloadListBound = this.reloadList.bind(this);
        this.container.addEventListener('dropzone-upload-success', reloadListBound);
        this.container.addEventListener('ajax-form-success', reloadListBound);
        this.container.addEventListener('ajax-delete-row-success', reloadListBound);

        this.container.addEventListener('sortable-list-sort', event => {
            this.updateOrder(event.detail.ids);
        });

        this.container.addEventListener('event-emit-select-edit', event => {
            this.startEdit(event.detail.id);
        });

        this.container.addEventListener('event-emit-select-edit-back', () => {
            this.stopEdit();
        });

        this.container.addEventListener('event-emit-select-insert', event => {
            const insertContent = event.target.closest('[data-drag-content]').getAttribute('data-drag-content');
            const contentTypes = JSON.parse(insertContent);
            window.$events.emit('editor::insert', {
                html: contentTypes['text/html'],
                markdown: contentTypes['text/plain'],
                typst: contentTypes['text/typst'],
            });
        });

        this.container.addEventListener('event-emit-select-undo', event => {
            this.undoAttachmentFromPreview(Number(event.detail.id));
        });

        this.container.addEventListener('event-emit-select-save', event => {
            this.saveAttachmentFromPreview(Number(event.detail.id));
        });

        window.$events.listen('tinymist-attachment-dirty-state', ({fileName, isDirty}) => {
            const normalizedName = String(fileName || '').trim();
            if (!normalizedName) {
                return;
            }
            this.attachmentSessionDirtyByName.set(normalizedName, Boolean(isDirty));
            this.applyDirtyStateForFile(normalizedName);
            this.emitDirtyMapUpdated();
        });

        this.attachLinkButton.addEventListener('click', () => {
            this.showSection('links');
        });

        this.applyAllDirtyStatesToList();
        void this.refreshDirtyMapFromServer();
    }

    showSection(section) {
        const sectionMap = {
            links: this.linksContainer,
            edit: this.editContainer,
            list: this.listContainer,
        };

        for (const [name, elem] of Object.entries(sectionMap)) {
            elem.toggleAttribute('hidden', name !== section);
        }
    }

    reloadList() {
        this.stopEdit();
        window.$http.get(`/attachments/get/page/${this.pageId}`).then(resp => {
            this.listPanel.innerHTML = resp.data;
            window.$components.init(this.listPanel);
            this.applyAllDirtyStatesToList();
            window.$events.emit('attachments-page-updated', {
                html: String(resp.data || ''),
            });
            void this.refreshDirtyMapFromServer();
        });
    }

    updateOrder(idOrder) {
        window.$http.put(`/attachments/sort/page/${this.pageId}`, {order: idOrder}).then(resp => {
            window.$events.emit('success', resp.data.message);
        });
    }

    async startEdit(id) {
        this.showSection('edit');

        showLoading(this.editContainer);
        const resp = await window.$http.get(`/attachments/edit/${id}`);
        this.editContainer.innerHTML = resp.data;
        window.$components.init(this.editContainer);
    }

    stopEdit() {
        this.showSection('list');
    }

    applyAllDirtyStatesToList() {
        const rows = this.listPanel.querySelectorAll('[data-file-name]');
        rows.forEach(row => {
            const fileName = String(row.getAttribute('data-file-name') || '').trim();
            if (!fileName) {
                return;
            }
            const isDirty = this.isAttachmentDirty(fileName);
            this.setRowActionState(row, isDirty);
        });
    }

    applyDirtyStateForFile(fileName) {
        const escapedFileName = window.CSS?.escape ? CSS.escape(fileName) : fileName.replace(/"/g, '\\"');
        const row = this.listPanel.querySelector(`[data-file-name="${escapedFileName}"]`);
        if (!row) {
            return;
        }
        this.setRowActionState(row, this.isAttachmentDirty(fileName));
    }

    isAttachmentDirty(fileName) {
        const normalizedName = String(fileName || '').trim();
        if (!normalizedName) {
            return false;
        }
        return Boolean(this.attachmentServerDirtyByName.get(normalizedName))
            || Boolean(this.attachmentSessionDirtyByName.get(normalizedName));
    }

    setRowActionState(row, isDirty) {
        const actionButtons = row.querySelectorAll('[data-attachment-action="save"], [data-attachment-action="undo"]');
        actionButtons.forEach(button => {
            button.disabled = !isDirty;
            button.classList.toggle('disabled', !isDirty);
            button.setAttribute('aria-disabled', (!isDirty).toString());
        });
    }

    applyDirtyMap(dirtyMap) {
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

    emitDirtyMapUpdated() {
        const effectiveMap = {};
        const fileNames = new Set([
            ...this.attachmentServerDirtyByName.keys(),
            ...this.attachmentSessionDirtyByName.keys(),
        ]);

        fileNames.forEach(fileName => {
            effectiveMap[fileName] = this.isAttachmentDirty(fileName);
        });

        window.$events.emit('tinymist-attachments-dirty-map-updated', {
            dirtyMap: effectiveMap,
        });
    }

    async refreshDirtyMapFromServer() {
        try {
            const resp = await window.$http.get(`/attachments/dirty/page/${this.pageId}`);
            this.applyDirtyMap(resp?.data?.dirtyMap || {});
        } catch {
            // Keep existing in-memory state if dirty map fetch fails.
        }
    }

    getAttachmentRowById(attachmentId) {
        const escapedId = window.CSS?.escape ? CSS.escape(String(attachmentId)) : String(attachmentId).replace(/"/g, '\\"');
        return this.listPanel.querySelector(`[data-id="${escapedId}"]`);
    }

    getAttachmentFileNameById(attachmentId) {
        const row = this.getAttachmentRowById(attachmentId);
        if (!row) {
            return '';
        }
        return String(row.getAttribute('data-file-name') || '').trim();
    }

    markAttachmentClean(fileName) {
        const normalizedName = String(fileName || '').trim();
        if (!normalizedName) {
            return;
        }
        this.attachmentServerDirtyByName.set(normalizedName, false);
        this.attachmentSessionDirtyByName.set(normalizedName, false);
        this.applyDirtyStateForFile(normalizedName);
        this.emitDirtyMapUpdated();
    }

    async saveAttachmentFromPreview(attachmentId) {
        if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
            return;
        }

        try {
            const resp = await window.$http.put(`/attachments/${attachmentId}/save-from-preview`);
            const fileName = String(resp?.data?.fileName || this.getAttachmentFileNameById(attachmentId));
            this.markAttachmentClean(fileName);
            if (resp?.data?.message) {
                window.$events.emit('success', resp.data.message);
            }
        } catch (error) {
            window.$events.emit('error', error?.response?.data?.message || 'Failed to save attachment changes');
        }
    }

    async undoAttachmentFromPreview(attachmentId) {
        if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
            return;
        }

        try {
            const resp = await window.$http.put(`/attachments/${attachmentId}/undo-from-preview`);
            const fileName = String(resp?.data?.fileName || this.getAttachmentFileNameById(attachmentId));
            this.markAttachmentClean(fileName);
            if (fileName) {
                window.$events.emit('tinymist-attachment-reset-file', {
                    fileName,
                });
            }
            if (resp?.data?.message) {
                window.$events.emit('success', resp.data.message);
            }
        } catch (error) {
            window.$events.emit('error', error?.response?.data?.message || 'Failed to undo attachment changes');
        }
    }

}
