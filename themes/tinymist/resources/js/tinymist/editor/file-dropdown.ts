import { ENTRY_FILE_NAME, SYNC_AND_LSP_STATUS_KEY, tmEvents } from "../constants";

export class TinymistFileDropdown {
    private dropdownSelector: string;
    private fileSyncWSConnected: boolean = false;
    private activeFileName: string = ENTRY_FILE_NAME;
    private loadedFileStateByName: Map<string, boolean> = new Map([
        [ENTRY_FILE_NAME, true],
    ]);
    private dirtyAttachmentByName: Map<string, boolean> = new Map();

    constructor(dropdownSelector: string) {
        this.dropdownSelector = dropdownSelector;
        const fileSelect = document.querySelector(dropdownSelector) as HTMLSelectElement;

        this.dirtyMapUpdateHandler = this.dirtyMapUpdateHandler.bind(this);
        this.onSelectChange = this.onSelectChange.bind(this);
        this.refreshFileDropdown = this.refreshFileDropdown.bind(this);
        fileSelect.addEventListener("change", this.onSelectChange);

        window.$tmEventBus.listen(
            tmEvents.Status,
            (status: { what?: string; connected?: boolean }) => {
                if (status?.what !== SYNC_AND_LSP_STATUS_KEY) {
                    return;
                }
                this.fileSyncWSConnected = Boolean(status.connected);
            },
        );

        window.$tmEventBus.listen(
            tmEvents.SyncFullState,
            (payload: { fileName?: string }) => {
                const fileName = String(payload?.fileName || "").trim();
                if (!fileName) {
                    return;
                }
                this.loadedFileStateByName.set(fileName, true);
            },
        );

        window.$tmEventBus.listen(
            tmEvents.FilesUpdated,this.refreshFileDropdown
        );

        window.$tmEventBus.listen(
            tmEvents.FilesDirtyUpdated,
            this.dirtyMapUpdateHandler,
        );
        window.$tmEventBus.listen(tmEvents.Destroy, () => {
            fileSelect.removeEventListener("change", this.onSelectChange);
            this.loadedFileStateByName.clear();
            this.dirtyAttachmentByName.clear();
        });
    }

    private onSelectChange(): void {
        const fileSelect = document.querySelector(this.dropdownSelector) as HTMLSelectElement;
        const selectedFile = (fileSelect?.value || ENTRY_FILE_NAME).trim();
        if (!selectedFile) {
            fileSelect.value = this.activeFileName;
            return;
        }

        const isImage = this.isImageFileName(selectedFile);
        const hasLoadedState = Boolean(
            this.loadedFileStateByName.get(selectedFile),
        );

        if (!this.fileSyncWSConnected && !isImage && !hasLoadedState) {
            fileSelect.value = this.activeFileName;
            const warning = `[Editor] Cannot open ${selectedFile} while file sync socket is offline: file state is not loaded yet.`;
            console.warn(warning);
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: "warning",
                message: warning,
            });
            return;
        }

        this.activeFileName = selectedFile;
        window.$tmEventBus.emit(tmEvents.ActiveFileChange, {
            fileName: selectedFile,
            url: fileSelect.selectedOptions[0]?.dataset.fileUrl || "",
        });
    }

    private isImageFileName(fileName: string): boolean {
        return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(fileName);
    }

    private dirtyMapUpdateHandler(payload: {
        dirtyMap?: Record<string, boolean>;
    }): void {
        if (!payload) {
            return;
        }

        this.dirtyAttachmentByName.clear();
        const dirtyMap =
            payload.dirtyMap && typeof payload.dirtyMap === "object"
                ? payload.dirtyMap
                : {};
        Object.entries(dirtyMap).forEach(([fileName, isDirty]) => {
            const normalized = String(fileName || "").trim();
            if (!normalized) {
                return;
            }
            this.dirtyAttachmentByName.set(normalized, Boolean(isDirty));
        });

        this.applyDirtyCueToDropdown();
    }

    private refreshFileDropdown(data: { files?: Record<string, string> }): void {
        const fileSelect = document.querySelector(this.dropdownSelector) as HTMLSelectElement;
        if (!fileSelect) {
            return;
        }

        const files =
            data?.files && typeof data.files === "object" ? data.files : {};
        const attachmentNames = Object.keys(files).filter(
            (name) => String(name || "").trim() !== "" && name !== ENTRY_FILE_NAME,
        );
        const selectedValue = fileSelect.value || ENTRY_FILE_NAME;

        fileSelect.innerHTML = "";
        fileSelect.add(new Option(ENTRY_FILE_NAME, ENTRY_FILE_NAME));
        attachmentNames.forEach((name) => {
            const option = new Option(name, name);
            option.dataset.fileUrl = String(files[name] || "").trim();
            fileSelect?.add(option);
        });

        const hasPrevious = Array.from(fileSelect.options).some(
            (option) => option.value === selectedValue,
        );
        fileSelect.value = hasPrevious ? selectedValue : ENTRY_FILE_NAME;
        this.applyDirtyCueToDropdown();
    }

    private applyDirtyCueToDropdown(): void {
        const fileSelect = document.querySelector(this.dropdownSelector) as HTMLSelectElement;
        if (!fileSelect) {
            return;
        }
        Array.from(fileSelect.options).forEach((option) => {
            const fileName = (option.value || "").trim();
            if (!fileName || fileName === ENTRY_FILE_NAME) {
                option.text = fileName || option.text;
                return;
            }

            const dirty = Boolean(this.dirtyAttachmentByName.get(fileName));
            option.text = dirty ? `* ${fileName}` : fileName;
        });
    }

    destroy() {
        document.querySelector(this.dropdownSelector)
            ?.removeEventListener("change", this.onSelectChange);
    }
}
