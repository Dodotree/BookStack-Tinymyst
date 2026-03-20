import {onSelect} from '../services/dom.ts';
import {debounce} from '../services/util.ts';
import {Component} from './component';
import {utcTimeStampToLocalTime} from '../services/dates.ts';

export class PageEditor extends Component {

    setup() {
        // Options
        this.draftsEnabled = this.$opts.draftsEnabled === 'true';
        this.editorType = this.$opts.editorType;
        this.pageId = Number(this.$opts.pageId);
        this.isNewDraft = this.$opts.pageNewDraft === 'true';
        this.hasDefaultTitle = this.$opts.hasDefaultTitle || false;

        // Elements
        this.container = this.$el;
        this.titleElem = this.$refs.titleContainer.querySelector('input');
        this.saveDraftButton = this.$refs.saveDraft;
        this.discardDraftButton = this.$refs.discardDraft;
        this.discardDraftWrap = this.$refs.discardDraftWrap;
        this.deleteDraftButton = this.$refs.deleteDraft;
        this.deleteDraftWrap = this.$refs.deleteDraftWrap;
        this.draftDisplay = this.$refs.draftDisplay;
        this.draftDisplayIcon = this.$refs.draftDisplayIcon;
        this.changelogInput = this.$refs.changelogInput;
        this.changelogDisplay = this.$refs.changelogDisplay;
        this.changelogCounter = this.$refs.changelogCounter;
        this.changeEditorButtons = this.$manyRefs.changeEditor || [];
        this.switchDialogContainer = this.$refs.switchDialog;
        this.deleteDraftDialogContainer = this.$refs.deleteDraftDialog;

        // Translations
        this.draftText = this.$opts.draftText;
        this.autosaveFailText = this.$opts.autosaveFailText;
        this.editingPageText = this.$opts.editingPageText;
        this.draftDiscardedText = this.$opts.draftDiscardedText;
        this.draftDeleteText = this.$opts.draftDeleteText;
        this.draftDeleteFailText = this.$opts.draftDeleteFailText;
        this.setChangelogText = this.$opts.setChangelogText;

        // State data
        this.autoSave = {
            interval: null,
            frequency: 30000,
            last: 0,
            pendingChange: false,
            inProgress: false,
            failCount: 0,
            blockedUntil: 0,
            lastErrorAt: 0,
        };
        this.network = {
            online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
            lastOfflineNoticeAt: 0,
        };
        this.offlineNoticeIntervalMs = 60000;
        this.onNetworkOnline = this.onNetworkOnline.bind(this);
        this.onNetworkOffline = this.onNetworkOffline.bind(this);
        this.shownWarningsCache = new Set();

        if (this.pageId !== 0 && this.draftsEnabled) {
            window.setTimeout(() => {
                this.startAutoSave();
            }, 1000);
        }
        this.draftDisplay.innerHTML = this.draftText;

        this.setupListeners();
        this.setInitialFocus();
    }

    setupListeners() {
        // Listen to save events from editor
        window.$events.listen('editor-save-draft', this.saveDraft.bind(this));
        window.$events.listen('editor-save-page', this.savePage.bind(this));

        // Listen to content changes from the editor
        const onContentChange = () => {
            this.autoSave.pendingChange = true;
        };
        window.$events.listen('editor-html-change', onContentChange);
        window.$events.listen('editor-markdown-change', onContentChange);
        window.$events.listen('editor-tinymist-change', onContentChange);

        // Listen to changes on the title input
        this.titleElem.addEventListener('input', onContentChange);

        // Changelog controls
        const updateChangelogDebounced = debounce(this.updateChangelogDisplay.bind(this), 300, false);
        this.changelogInput.addEventListener('input', () => {
            const count = this.changelogInput.value.length;
            this.changelogCounter.innerText = `${count} / 180`;
            updateChangelogDebounced();
        });

        // Draft Controls
        onSelect(this.saveDraftButton, this.saveDraft.bind(this));
        onSelect(this.discardDraftButton, this.discardDraft.bind(this));
        onSelect(this.deleteDraftButton, this.deleteDraft.bind(this));

        // Change editor controls
        onSelect(this.changeEditorButtons, this.changeEditor.bind(this));

        window.addEventListener('online', this.onNetworkOnline);
        window.addEventListener('offline', this.onNetworkOffline);
    }

    onNetworkOnline() {
        this.network.online = true;
        this.autoSave.blockedUntil = 0;
    }

    onNetworkOffline() {
        this.network.online = false;
        this.notifyOfflineStatus();
    }

    notifyOfflineStatus() {
        const now = Date.now();
        if (now - this.network.lastOfflineNoticeAt < this.offlineNoticeIntervalMs) {
            return;
        }

        window.$events.emit('warning', 'Offline: draft autosave is temporarily unavailable. Changes stay in this browser until connection returns.');
        this.network.lastOfflineNoticeAt = now;
    }

    setInitialFocus() {
        if (this.hasDefaultTitle) {
            this.titleElem.select();
            return;
        }

        window.setTimeout(() => {
            window.$events.emit('editor::focus', '');
        }, 500);
    }

    startAutoSave() {
        this.autoSave.interval = window.setInterval(this.runAutoSave.bind(this), this.autoSave.frequency);
    }

    runAutoSave() {
        if (!this.network.online) {
            this.notifyOfflineStatus();
            return;
        }

        if (this.autoSave.inProgress) {
            return;
        }

        if (Date.now() < this.autoSave.blockedUntil) {
            return;
        }

        // Stop if manually saved recently to prevent bombarding the server
        const savedRecently = (Date.now() - this.autoSave.last < (this.autoSave.frequency) / 2);
        if (savedRecently || !this.autoSave.pendingChange) {
            return;
        }

        this.saveDraft();
    }

    savePage() {
        this.container.closest('form').requestSubmit();
    }

    async saveDraft() {
        if (!this.network.online) {
            this.persistFailedDraft({
                name: this.titleElem.value.trim(),
                ...(await this.getEditorComponent().getContent()),
            });
            this.notifyOfflineStatus();
            return false;
        }

        if (this.autoSave.inProgress) {
            return false;
        }

        this.autoSave.inProgress = true;
        const data = {name: this.titleElem.value.trim()};

        const editorContent = await this.getEditorComponent().getContent();
        Object.assign(data, editorContent);

        let didSave = false;
        try {
            const resp = await window.$http.put(`/ajax/page/${this.pageId}/save-draft`, data);
            if (!this.isNewDraft) {
                this.discardDraftWrap.toggleAttribute('hidden', false);
                this.deleteDraftWrap.toggleAttribute('hidden', false);
            }

            this.draftNotifyChange(`${resp.data.message} ${utcTimeStampToLocalTime(resp.data.timestamp)}`);
            this.autoSave.last = Date.now();
            if (resp.data.warning && !this.shownWarningsCache.has(resp.data.warning)) {
                window.$events.emit('warning', resp.data.warning);
                this.shownWarningsCache.add(resp.data.warning);
            }

            didSave = true;
            this.autoSave.pendingChange = false;
            this.autoSave.failCount = 0;
            this.autoSave.blockedUntil = 0;
        } catch {
            this.autoSave.failCount += 1;
            const backoffMs = Math.min(300000, Math.max(this.autoSave.frequency, 10000)
                * this.autoSave.failCount);
            this.autoSave.blockedUntil = Date.now() + backoffMs;

            // Save the editor content in LocalStorage as a last resort, just in case.
            this.persistFailedDraft(data);

            const now = Date.now();
            const notifyIntervalMs = 60000;
            if (now - this.autoSave.lastErrorAt >= notifyIntervalMs) {
                window.$events.emit('error', this.autosaveFailText);
                this.autoSave.lastErrorAt = now;
            }
        } finally {
            this.autoSave.inProgress = false;
        }

        return didSave;
    }

    persistFailedDraft(data) {
        const saveKey = `draft-save-fail-page-${this.pageId}`;

        try {
            const payload = this.buildDraftRecoveryPayload(data);
            window.localStorage.setItem(saveKey, JSON.stringify(payload));
            return;
        } catch (error) {
            if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') {
                console.error(error);
                return;
            }
        }

        try {
            this.clearLegacyFailedDraftEntries();
            const payload = this.buildDraftRecoveryPayload(data, 200000);
            window.localStorage.setItem(saveKey, JSON.stringify(payload));
        } catch (error) {
            console.error(error);
        }
    }

    clearLegacyFailedDraftEntries() {
        const keysToDelete = [];
        for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (typeof key === 'string' && key.startsWith('draft-save-fail-')) {
                keysToDelete.push(key);
            }
        }

        for (const key of keysToDelete) {
            window.localStorage.removeItem(key);
        }
    }

    buildDraftRecoveryPayload(data, perFieldLimit = 0) {
        const sanitizedData = {};

        for (const [key, value] of Object.entries(data)) {
            if (typeof value === 'string' && perFieldLimit > 0 && value.length > perFieldLimit) {
                sanitizedData[key] = value.slice(0, perFieldLimit);
            } else {
                sanitizedData[key] = value;
            }
        }

        return {
            savedAt: new Date().toISOString(),
            pageId: this.pageId,
            editorType: this.editorType,
            data: sanitizedData,
            truncated: perFieldLimit > 0,
        };
    }

    draftNotifyChange(text) {
        this.draftDisplay.innerText = text;
        this.draftDisplayIcon.classList.add('visible');
        window.setTimeout(() => {
            this.draftDisplayIcon.classList.remove('visible');
        }, 2000);
    }

    async discardDraft(notify = true) {
        let response;
        try {
            response = await window.$http.get(`/ajax/page/${this.pageId}`);
        } catch (e) {
            console.error(e);
            return;
        }

        if (this.autoSave.interval) {
            window.clearInterval(this.autoSave.interval);
        }

        this.draftDisplay.innerText = this.editingPageText;
        this.discardDraftWrap.toggleAttribute('hidden', true);
        window.$events.emit('editor::replace', {
            html: response.data.html,
            markdown: response.data.markdown,
        });

        this.titleElem.value = response.data.name;
        window.setTimeout(() => {
            this.startAutoSave();
        }, 1000);

        if (notify) {
            window.$events.success(this.draftDiscardedText);
        }
    }

    async deleteDraft() {
        /** @var {ConfirmDialog} * */
        const dialog = window.$components.firstOnElement(this.deleteDraftDialogContainer, 'confirm-dialog');
        const confirmed = await dialog.show();
        if (!confirmed) {
            return;
        }

        try {
            const discard = this.discardDraft(false);
            const draftDelete = window.$http.delete(`/page-revisions/user-drafts/${this.pageId}`);
            await Promise.all([discard, draftDelete]);
            window.$events.success(this.draftDeleteText);
            this.deleteDraftWrap.toggleAttribute('hidden', true);
        } catch (err) {
            console.error(err);
            window.$events.error(this.draftDeleteFailText);
        }
    }

    updateChangelogDisplay() {
        let summary = this.changelogInput.value.trim();
        if (summary.length === 0) {
            summary = this.setChangelogText;
        } else if (summary.length > 16) {
            summary = `${summary.slice(0, 16)}...`;
        }
        this.changelogDisplay.innerText = summary;
    }

    async changeEditor(event) {
        event.preventDefault();

        const link = event.target.closest('a').href;
        /** @var {ConfirmDialog} * */
        const dialog = window.$components.firstOnElement(this.switchDialogContainer, 'confirm-dialog');
        const [saved, confirmed] = await Promise.all([this.saveDraft(), dialog.show()]);

        if (saved && confirmed) {
            window.location = link;
        }
    }

    /**
     * @return {TinymistEditor|MarkdownEditor|WysiwygEditor|WysiwygEditorTinymce}
     */
    getEditorComponent() {
        return window.$components.first('tinymist-editor')
            || window.$components.first('markdown-editor')
            || window.$components.first('wysiwyg-editor')
            || window.$components.first('wysiwyg-editor-tinymce');
    }

    destroy() {
        window.removeEventListener('online', this.onNetworkOnline);
        window.removeEventListener('offline', this.onNetworkOffline);
    }

}
