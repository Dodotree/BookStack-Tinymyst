export class TinymistFileDropdown {
    fileSelect!: HTMLSelectElement;
    private fileSyncWSConnected = false;
    private activeFileName = "entry.typ";
    private loadedFileStateByName: Map<string, boolean> = new Map([
        ["entry.typ", true],
    ]);
    private dirtyAttachmentByName: Map<string, boolean> = new Map();

    constructor(fileSelect: HTMLSelectElement) {
        this.fileSelect = fileSelect;

        this.dirtyMapUpdateHandler = this.dirtyMapUpdateHandler.bind(this);
        this.onSelectChange = this.onSelectChange.bind(this);
        this.refreshFileDropdown = this.refreshFileDropdown.bind(this);
        this.fileSelect.addEventListener("change", this.onSelectChange);

        window.$tmEventBus.listen(
            "status",
            (status: { what?: string; connected?: boolean }) => {
                if (status?.what !== "file-lsp-ws") {
                    return;
                }
                this.fileSyncWSConnected = Boolean(status.connected);
            },
        );

        window.$tmEventBus.listen(
            "sync-full-state",
            (payload: { fileName?: string }) => {
                const fileName = String(payload?.fileName || "").trim();
                if (!fileName) {
                    return;
                }
                this.loadedFileStateByName.set(fileName, true);
            },
        );

        window.$tmEventBus.listen(
            "files-updated",this.refreshFileDropdown
        );

        window.$tmEventBus.listen(
            "files-dirty-updated",
            this.dirtyMapUpdateHandler,
        );
        window.$tmEventBus.listen("destroy", () => {
            this.fileSelect.removeEventListener("change", this.onSelectChange);
        });
    }

    private onSelectChange(): void {
        const selectedFile = (this.fileSelect?.value || "entry.typ").trim();
        if (!selectedFile) {
            this.fileSelect.value = this.activeFileName;
            return;
        }

        const isImage = this.isImageFileName(selectedFile);
        const hasLoadedState = Boolean(
            this.loadedFileStateByName.get(selectedFile),
        );

        if (!this.fileSyncWSConnected && !isImage && !hasLoadedState) {
            this.fileSelect.value = this.activeFileName;
            const warning = `[Editor] Cannot open ${selectedFile} while file sync socket is offline: file state is not loaded yet.`;
            console.warn(warning);
            window.$tmEventBus.emit("console-log", {
                type: "warning",
                message: warning,
            });
            return;
        }

        this.activeFileName = selectedFile;
        window.$tmEventBus.emit("active-file-change", {
            fileName: selectedFile,
            url: this.fileSelect.selectedOptions[0]?.dataset.fileUrl || "",
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

    private refreshFileDropdown(data: { html?: string }): void {
        if (!data) {
            return;
        }
        if (!this.fileSelect) {
            return;
        }
        const parser = new DOMParser();
        const doc = parser.parseFromString(data.html || "", "text/html");
        const linkByName = new Map<string, string>();
        Array.from(doc.querySelectorAll("a")).forEach((link) => {
            const name = (link.textContent || "").trim();
            if (!name || name === "entry.typ") {
                return;
            }
            const href = String(link.getAttribute("href") || "").trim();
            if (href) {
                linkByName.set(name, href);
            } else if (!linkByName.has(name)) {
                linkByName.set(name, "");
            }
        });

        const attachmentNames = Array.from(linkByName.keys());
        const selectedValue = this.fileSelect.value || "entry.typ";

        this.fileSelect.innerHTML = "";
        this.fileSelect.add(new Option("entry.typ", "entry.typ"));
        attachmentNames.forEach((name) => {
            const option = new Option(name, name);
            option.dataset.fileUrl = linkByName.get(name) || "";
            this.fileSelect?.add(option);
        });

        const hasPrevious = Array.from(this.fileSelect.options).some(
            (option) => option.value === selectedValue,
        );
        this.fileSelect.value = hasPrevious ? selectedValue : "entry.typ";
        this.applyDirtyCueToDropdown();
    }

    private applyDirtyCueToDropdown(): void {
        if (!this.fileSelect) {
            return;
        }
        Array.from(this.fileSelect.options).forEach((option) => {
            const fileName = (option.value || "").trim();
            if (!fileName || fileName === "entry.typ") {
                option.text = fileName || option.text;
                return;
            }

            const dirty = Boolean(this.dirtyAttachmentByName.get(fileName));
            option.text = dirty ? `* ${fileName}` : fileName;
        });
    }

    destroy() {
        this.fileSelect?.removeEventListener("change", this.onSelectChange);
    }
}
