import {
    ENTRY_FILE_NAME,
    PREVIEW_FALLBACK_SETTINGS,
    PREVIEW_SETTINGS_STORAGE_KEY,
    tmClassNames,
    tmEvents,
    tmSelectors,
} from "../constants";

/** Preview controls: toolbar, hot keys, mode dropdown
 * PDF is a static simple frame
 */
export class PreviewToolbar {
    private pageId: number|string;
    private activeFileName = ENTRY_FILE_NAME;

    private liveStatus: "paused" | "running" | "connecting" = "connecting";
    private lastSelectedMode: "live-preview" | `pdf-page-${number}` = "live-preview";

    private zoomLevel: number = 1;
    private readonly zoomStep: number = 0.1;
    private readonly zoomMin: number = 0.25;
    private readonly zoomMax: number = 3;
    private hasAppliedInitialZoom: boolean = false;
    private preferredInitialZoom: number = PREVIEW_FALLBACK_SETTINGS.initialZoom;
    private baseSvgWidth: number | null = null;
    private baseSvgHeight: number | null = null;
    private zKeyPressed: boolean = false;

    private panEnabled: boolean = false;
    private isPanning: boolean = false;
    private panStartX: number = 0;
    private panStartY: number = 0;
    private panStartScrollLeft: number = 0;
    private panStartScrollTop: number = 0;
    private pointerInPreview: boolean = false;
    private temporaryPanActive: boolean = false;

    private cursorSpotlightUserEnabled: boolean = true;
    private scrollIntoViewUserEnabled: boolean = true;

    private paneSelector = `${tmSelectors.Root} ${tmSelectors.PreviewPane}`;
    private pdfFrameSelector = `${tmSelectors.Root} ${tmSelectors.PreviewPdfFrame}`;
    private modeSelectSelector = `${tmSelectors.Root} ${tmSelectors.PreviewModeSelect}`;
    private overlaySelector = `${tmSelectors.Root} .tinymist-preview-settings-overlay`;
    private initialZoomInputSelector = `${tmSelectors.Root} .tinymist-preview-settings-overlay input[data-tm-preview-setting="initial-zoom"]`;
    private currentZoomValueSelector = `${tmSelectors.Root} .tinymist-preview-settings-overlay [data-tm-preview-setting="current-zoom"]`;


    constructor(pageId: number|string) {

        this.pageId = pageId;

        this.handleZoomIn = this.handleZoomIn.bind(this);
        this.handleZoomOut = this.handleZoomOut.bind(this);
        this.handleZoomReset = this.handleZoomReset.bind(this);
        this.handlePreviewPaneClick = this.handlePreviewPaneClick.bind(this);
        this.handlePanMouseDown = this.handlePanMouseDown.bind(this);
        this.handlePanMouseMove = this.handlePanMouseMove.bind(this);
        this.handlePanMouseUp = this.handlePanMouseUp.bind(this);
        this.handlePreviewMouseEnter = this.handlePreviewMouseEnter.bind(this);
        this.handlePreviewMouseLeave = this.handlePreviewMouseLeave.bind(this);
        this.handleGlobalKeyDown = this.handleGlobalKeyDown.bind(this);
        this.handleGlobalKeyUp = this.handleGlobalKeyUp.bind(this);
        this.handleWindowBlur = this.handleWindowBlur.bind(this);
        this.handlePreviewPaneChange = this.handlePreviewPaneChange.bind(this);
        this.handlePreviewSettingsInput = this.handlePreviewSettingsInput.bind(this);
        this.handlePreviewSettingsOverlayClick =
            this.handlePreviewSettingsOverlayClick.bind(this);
        this.handleWindowKeyUp = this.handleWindowKeyUp.bind(this);

        this.readStoredSettings();
        this.syncSettingsToInputs();
        this.syncCurrentZoomDisplay();

        this.handlePreviewConnectionState =
            this.handlePreviewConnectionState.bind(this);
        this.handleCursorPosition = this.handleCursorPosition.bind(this);
        this.onDocumentUpdate = this.onDocumentUpdate.bind(this);

        window.$tmEventBus.listen(
            tmEvents.PreviewDocumentUpdated,
            this.onDocumentUpdate,
        );

        window.$tmEventBus.listen(
            tmEvents.PreviewCursorPosition,
            this.handleCursorPosition,
        );
        window.$tmEventBus.listen(
            tmEvents.PreviewConnectionState,
            this.handlePreviewConnectionState,
        );

        window.$tmEventBus.listen(
            tmEvents.ActiveFileChange,
            (payload: { fileName: string; url: string }) => {
                this.activeFileName = payload.fileName || ENTRY_FILE_NAME;
                this.applyCursorSpotlightState();
                this.applyScrollIntoViewState();
            },
        );

        this.applyCursorSpotlightState();
        this.applyScrollIntoViewState();
        this.applyPanButtonState();
        this.addRemoveListeners(true);

        const modeSelect = document.querySelector(this.modeSelectSelector) as HTMLSelectElement | null;
        modeSelect?.toggleAttribute("disabled", this.pageId === 0 || this.pageId === "");
    }

    private onDocumentUpdate(payload: { pdfPagesCount: number }): void {
        this.baseSvgWidth = null;
        this.baseSvgHeight = null;

        if (!this.hasAppliedInitialZoom) {
            this.setZoom(this.preferredInitialZoom);
            this.hasAppliedInitialZoom = true;
        }

        this.applyZoomToSvg();
        this.refreshPdfOptions(payload.pdfPagesCount);
    }

    private addRemoveListeners(adding: boolean = true): void {
        const method = adding ? "addEventListener" : "removeEventListener";

        document
            .querySelector(this.paneSelector)
            ?.[method]("click", this.handlePreviewPaneClick);

        document
            .querySelector(this.paneSelector)
            ?.[method]("change", this.handlePreviewPaneChange);

        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;

        previewElement[method]("mousedown", this.handlePanMouseDown);
        previewElement[method]("mousemove", this.handlePanMouseMove);
        previewElement[method]("mouseup", this.handlePanMouseUp);
        previewElement[method]("mouseleave", this.handlePanMouseUp);
        previewElement[method]("mouseenter", this.handlePreviewMouseEnter);
        previewElement[method]("mouseleave", this.handlePreviewMouseLeave);

        if (adding) {
            window.addEventListener("keydown", this.handleGlobalKeyDown);
            window.addEventListener("keyup", this.handleGlobalKeyUp);
            window.addEventListener("keyup", this.handleWindowKeyUp);
            window.addEventListener("blur", this.handleWindowBlur);
        } else {
            window.removeEventListener("keydown", this.handleGlobalKeyDown);
            window.removeEventListener("keyup", this.handleGlobalKeyUp);
            window.removeEventListener("keyup", this.handleWindowKeyUp);
            window.removeEventListener("blur", this.handleWindowBlur);
        }

        const initialZoomInput = document.querySelector(this.initialZoomInputSelector) as HTMLInputElement | null;
        initialZoomInput?.[method](
            "input",
            this.handlePreviewSettingsInput,
        );
        const overlay = document.querySelector(this.overlaySelector) as HTMLElement | null;
        overlay?.[method](
            "click",
            this.handlePreviewSettingsOverlayClick,
        );
    }

    private setLivePreviewVisibility(visible: boolean): void {
        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;

        const svgHost = previewElement.querySelector(
            tmSelectors.PreviewDocumentHost,
        ) as HTMLElement | null;
        const muted = previewElement.querySelector(
            tmSelectors.PreviewMutedMessage,
        ) as HTMLElement | null;
        const error = previewElement.querySelector(
            tmSelectors.PreviewError,
        ) as HTMLElement | null;

        if (svgHost) {
            svgHost.style.display = visible ? "" : "none";
        }
        if (muted) {
            muted.style.display = visible ? "" : "none";
        }
        if (error) {
            error.style.display = visible ? "" : "none";
        }
    }

    private openPdfPreview(pdfPage: string): void {
        const pdfFrame = document.querySelector(
            this.pdfFrameSelector,
        ) as HTMLIFrameElement | null;
        if (!pdfFrame || this.pageId === 0 || this.pageId === "") {
            return;
        }

        const safePage = encodeURIComponent(pdfPage);
        pdfFrame.src = `/ajax/tinymist/${this.pageId}/pdf/${safePage}`;
        pdfFrame.hidden = false;
        this.setLivePreviewVisibility(false);
    }

    private closePdfPreview(): void {
        const pdfFrame = document.querySelector(
            this.pdfFrameSelector,
        ) as HTMLIFrameElement | null;
        if (!pdfFrame) {
            return;
        }

        pdfFrame.hidden = true;
        pdfFrame.src = "about:blank";
        this.setLivePreviewVisibility(true);
    }

    private handlePreviewPaneChange(event: Event): void {
        const modeSelect = document.querySelector(this.modeSelectSelector) as HTMLSelectElement | null;
        if (!modeSelect) {
            return;
        }
        const value = (modeSelect.value || "").trim();
        const isActionOption =
            value === "toggle-live-preview" || value === "download-all";

        if (isActionOption) {
            modeSelect.value = this.lastSelectedMode;
        }

        if (value === "toggle-live-preview") {

            event.preventDefault();

            window.$tmEventBus.emit(tmEvents.PreviewConnectionToggle);
            return;
        }

        if (value === "download-all") {

            event.preventDefault();

            if (this.pageId !== 0 && this.pageId !== "") {
                window.location.assign(
                    `/ajax/tinymist/${this.pageId}/pdf/download-all`,
                );
            }
            return;
        }

        if (value === "live-preview") {
            modeSelect.value = "live-preview";
            this.lastSelectedMode = "live-preview";
            this.closePdfPreview();
            return;
        }
        if (value.startsWith("pdf-page-")) {
            const page = value.replace("pdf-page-", "");
            this.lastSelectedMode = value as `pdf-page-${number}`;
            this.openPdfPreview(page);
        }
    }

    private handlePreviewConnectionState(payload: {
        label: "paused" | "running" | "connecting";
    }): void {

        this.liveStatus = payload.label;

        const modeSelect = document.querySelector(this.modeSelectSelector) as HTMLSelectElement | null;
        const liveOption = modeSelect?.querySelector(
            'option[value="live-preview"]',
        );
        const output = liveOption?.querySelector("output");
        const toggleOption = modeSelect?.querySelector(
            'option[value="toggle-live-preview"]',
        );
        if (!modeSelect || !liveOption || !output || !toggleOption) {
            return;
        }
        output.textContent =
            this.liveStatus === "connecting"
                ? "connecting"
                : this.liveStatus === "running"
                  ? ""
                  : "paused";
        toggleOption.textContent =
            this.liveStatus === "running" ? "Pause Live" : "Resume Live";
    }

    private refreshPdfOptions(pageCount: number): void {
        const modeSelect = document.querySelector(this.modeSelectSelector) as HTMLSelectElement | null;
        if (!modeSelect) {
            return;
        }

        const previousStableValue = this.lastSelectedMode;

        modeSelect
            .querySelectorAll("option.pdf-option")
            .forEach((option) => option.remove());

        for (let index = 1; index <= pageCount; index++) {
            const option = document.createElement("option");
            option.classList.add("pdf-option");
            option.value = `pdf-page-${index}`;
            option.textContent = `PDF page ${index}`;
            modeSelect.appendChild(option);
        }

        if (pageCount > 0) {
            const downloadAll = document.createElement("option");
            downloadAll.classList.add("pdf-option");
            downloadAll.value = "download-all";
            downloadAll.textContent = "Download all";
            modeSelect.appendChild(downloadAll);
        }

        const hasStableOption = Boolean(
            modeSelect.querySelector(
                `option[value="${CSS.escape(previousStableValue)}"]`,
            ),
        );

        this.lastSelectedMode = hasStableOption
            ? previousStableValue
            : "live-preview";
        modeSelect.value = this.lastSelectedMode;
    }

    private handleZoomIn(): void {
        this.setZoom(this.zoomLevel + this.zoomStep);
    }

    private handleZoomOut(): void {
        this.setZoom(this.zoomLevel - this.zoomStep);
    }

    private handleZoomReset(): void {
        this.setZoom(1);
    }

    private handlePanToggle(enabled: boolean): void {
        this.panEnabled = enabled;
        if (!enabled) {
            this.stopPanning();
        }

        this.applyPanInteractionState();
        this.applyPanButtonState();
    }

    private isPanInteractionEnabled(): boolean {
        return this.panEnabled || this.temporaryPanActive;
    }

    private applyPanInteractionState(): void {
        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;
        previewElement.classList.toggle(
            tmClassNames.PreviewPanEnabled,
            this.isPanInteractionEnabled(),
        );
    }

    private handlePreviewMouseEnter(): void {
        this.pointerInPreview = true;
    }

    private handlePreviewMouseLeave(): void {
        this.pointerInPreview = false;
        this.zKeyPressed = false;
        this.setTemporaryPanActive(false);
    }

    private shouldHandlePreviewShortcut(eventTarget: EventTarget | null): boolean {
        if (!this.pointerInPreview) {
            return false;
        }

        const element = eventTarget as HTMLElement | null;
        if (!element) {
            return true;
        }

        if (element.isContentEditable) {
            return false;
        }

        return !Boolean(element.closest("input, textarea, select"));
    }

    private setTemporaryPanActive(enabled: boolean): void {
        if (this.temporaryPanActive === enabled) {
            return;
        }

        this.temporaryPanActive = enabled;
        this.applyPanInteractionState();

        if (!this.isPanInteractionEnabled()) {
            this.stopPanning();
        }
    }

    private handleGlobalKeyDown(event: KeyboardEvent): void {
        if (!this.shouldHandlePreviewShortcut(event.target)) {
            return;
        }

        if (event.code === "KeyZ") {
            this.zKeyPressed = true;
            return;
        }

        if (event.code === "Space") {
            this.setTemporaryPanActive(true);
            event.preventDefault();
            return;
        }

        if (!this.zKeyPressed) {
            return;
        }

        if (event.code === "Equal") {
            this.handleZoomIn();
            event.preventDefault();
            return;
        }

        if (event.code === "Minus") {
            this.handleZoomOut();
            event.preventDefault();
        }
    }

    private handleGlobalKeyUp(event: KeyboardEvent): void {
        if (event.code === "KeyZ") {
            this.zKeyPressed = false;
            return;
        }

        if (event.code === "Space") {
            this.setTemporaryPanActive(false);
            if (this.pointerInPreview) {
                event.preventDefault();
            }
        }
    }

    private handleWindowBlur(): void {
        this.zKeyPressed = false;
        this.setTemporaryPanActive(false);
    }

    private handlePreviewPaneClick(event: Event): void {
        const button = (event.target as Element | null)?.closest(
            tmSelectors.ActionButton,
        ) as HTMLButtonElement | null;
        if (!button) {
            return;
        }

        const action = button.getAttribute("data-action");
        switch (action) {
            case "previewZoomIn":
                this.handleZoomIn();
                break;
            case "previewZoomOut":
                this.handleZoomOut();
                break;
            case "previewZoomReset":
                this.handleZoomReset();
                break;
            case "previewPanToggle":
                this.handlePanToggle(!this.panEnabled);
                break;
            case "previewScrollIntoViewToggle":
                this.scrollIntoViewUserEnabled =
                    !this.scrollIntoViewUserEnabled;
                this.applyScrollIntoViewState();
                break;
            case "previewCursorSpotlightToggle":
                this.cursorSpotlightUserEnabled =
                    !this.cursorSpotlightUserEnabled;
                this.applyCursorSpotlightState();
                break;
            case "previewSettingsOpen":
                this.openPreviewSettings();
                break;
            case "closePreviewSettings":
                this.closePreviewSettings();
                break;
            default:
                break;
        }
    }

    private openPreviewSettings(): void {
        const overlay = document.querySelector(this.overlaySelector) as HTMLElement | null;
        if (!overlay) {
            return;
        }

        overlay.hidden = false;
        overlay.classList.add(tmClassNames.ThemeVisible);
        this.syncSettingsToInputs();

        const initialZoomInput = document.querySelector(this.initialZoomInputSelector) as HTMLInputElement | null;
        initialZoomInput?.focus();
        initialZoomInput?.select();
    }

    private closePreviewSettings(): void {
        const overlay = document.querySelector(this.overlaySelector) as HTMLElement | null;
        if (!overlay) {
            return;
        }

        overlay.classList.remove(tmClassNames.ThemeVisible);
        overlay.hidden = true;
    }

    private handlePreviewSettingsOverlayClick(event: Event): void {
        const overlay = document.querySelector(this.overlaySelector) as HTMLElement | null;
        if (!overlay) {
            return;
        }

        if (event.target === overlay) {
            this.closePreviewSettings();
        }
    }

    private handleWindowKeyUp(event: Event): void {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key !== "Escape") {
            return;
        }

        const overlay = document.querySelector(this.overlaySelector) as HTMLElement | null;
        if (overlay && !overlay.hidden) {
            this.closePreviewSettings();
        }
    }

    private handlePreviewSettingsInput(event: Event): void {
        const input = event.target as HTMLInputElement | null;
        if (!input) {
            return;
        }

        const parsed = Number(input.value);
        if (!Number.isFinite(parsed)) {
            return;
        }

        const clamped = Number(
            Math.min(this.zoomMax, Math.max(this.zoomMin, parsed)).toFixed(2),
        );
        this.preferredInitialZoom = clamped;
        this.persistSettings();
    }

    private syncSettingsToInputs(): void {
        const initialZoomInput = document.querySelector(this.initialZoomInputSelector) as HTMLInputElement | null;
        if (!initialZoomInput) {
            return;
        }

        initialZoomInput.value = this.preferredInitialZoom.toFixed(2);
    }

    private readStoredSettings(): void {
        try {
            const raw = window.localStorage.getItem(PREVIEW_SETTINGS_STORAGE_KEY);
            if (!raw) {
                this.preferredInitialZoom = PREVIEW_FALLBACK_SETTINGS.initialZoom;
                return;
            }

            const parsed = JSON.parse(raw) as { initialZoom?: unknown };
            const candidate = Number(parsed?.initialZoom);
            if (Number.isFinite(candidate)) {
                this.preferredInitialZoom = Number(
                    Math.min(this.zoomMax, Math.max(this.zoomMin, candidate)).toFixed(2),
                );
                return;
            }
        } catch {
        }

        this.preferredInitialZoom = PREVIEW_FALLBACK_SETTINGS.initialZoom;
    }

    private persistSettings(): void {
        try {
            window.localStorage.setItem(
                PREVIEW_SETTINGS_STORAGE_KEY,
                JSON.stringify({ initialZoom: this.preferredInitialZoom }),
            );
        } catch {
        }
    }

    private applyPanButtonState(): void {
        const button = document.querySelector(
            `${this.paneSelector} ${tmSelectors.PreviewPan}`,
        ) as HTMLButtonElement | null;

        if (!button) {
            return;
        }
        button.setAttribute("aria-pressed", this.panEnabled.toString());
        button.setAttribute(
            "title",
            this.panEnabled
                ? "Disable Hand Tool (Hold Space to temporarily enable)"
                : "Enable Hand Tool (Hold Space to temporarily enable)",
        );
    }

    private applyCursorSpotlightState(): void {
        const enabled =
            this.cursorSpotlightUserEnabled &&
            this.activeFileName === ENTRY_FILE_NAME;

        const button = document.querySelector(
            `${this.paneSelector} ${tmSelectors.PreviewCursorSpotlight}`,
        ) as HTMLButtonElement | null;
        if (button) {
            button.setAttribute("aria-pressed", enabled.toString());
            button.setAttribute(
                "title",
                enabled ? "Disable Caret Spotlight" : "Enable Caret Spotlight",
            );
        }

        window.$tmEventBus.emit(tmEvents.CursorSpotlightToggle, {
            enabled,
            activeFile: this.activeFileName,
            userEnabled: this.cursorSpotlightUserEnabled,
        });
    }

    private applyScrollIntoViewState(): void {
        const enabled =
            this.scrollIntoViewUserEnabled &&
            this.activeFileName === ENTRY_FILE_NAME;

        const button = document.querySelector(
            `${this.paneSelector} ${tmSelectors.PreviewScrollIntoView}`,
        ) as HTMLButtonElement | null;
        if (button) {
            button.setAttribute("aria-pressed", enabled.toString());
            button.setAttribute(
                "title",
                enabled
                    ? "Disable Scroll Into View"
                    : "Enable Scroll Into View",
            );
        }

        window.$tmEventBus.emit(tmEvents.CursorScrollIntoViewToggle, {
            enabled,
            activeFile: this.activeFileName,
            userEnabled: this.scrollIntoViewUserEnabled,
        });
    }

    private handleCursorPosition(payload: {
        contentX?: number;
        contentY?: number;
        width?: number;
        height?: number;
    }): void {
        const enabled =
            this.scrollIntoViewUserEnabled &&
            this.activeFileName === ENTRY_FILE_NAME;
        if (!enabled) {
            return;
        }

        const contentX = Number(payload?.contentX);
        const contentY = Number(payload?.contentY);
        const width = Math.max(1, Number(payload?.width ?? 1));
        const height = Math.max(1, Number(payload?.height ?? 1));
        if (!Number.isFinite(contentX) || !Number.isFinite(contentY)) {
            return;
        }

        this.scrollPreviewToClosestVisibleArea(
            contentX,
            contentY,
            width,
            height,
        );
    }

    private scrollPreviewToClosestVisibleArea(
        contentX: number,
        contentY: number,
        width: number,
        height: number,
    ): void {
        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;

        const viewportWidth = previewElement.clientWidth;
        const viewportHeight = previewElement.clientHeight;
        const scrollLeft = previewElement.scrollLeft;
        const scrollTop = previewElement.scrollTop;

        if (viewportWidth <= 0 || viewportHeight <= 0) {
            return;
        }

        const marginX = Math.max(24, Math.min(120, viewportWidth * 0.1));
        const marginY = Math.max(24, Math.min(120, viewportHeight * 0.1));

        const minVisibleX = scrollLeft + marginX;
        const maxVisibleX = scrollLeft + viewportWidth - marginX;
        const minVisibleY = scrollTop + marginY;
        const maxVisibleY = scrollTop + viewportHeight - marginY;

        const cursorLeft = contentX - width / 2;
        const cursorRight = contentX + width / 2;
        const cursorTop = contentY - height / 2;
        const cursorBottom = contentY + height / 2;

        let nextScrollLeft = scrollLeft;
        let nextScrollTop = scrollTop;

        if (cursorLeft < minVisibleX) {
            nextScrollLeft = cursorLeft - marginX;
        } else if (cursorRight > maxVisibleX) {
            nextScrollLeft = cursorRight - viewportWidth + marginX;
        }

        if (cursorTop < minVisibleY) {
            nextScrollTop = cursorTop - marginY;
        } else if (cursorBottom > maxVisibleY) {
            nextScrollTop = cursorBottom - viewportHeight + marginY;
        }

        nextScrollLeft = Math.max(0, nextScrollLeft);
        nextScrollTop = Math.max(0, nextScrollTop);

        if (
            Math.abs(nextScrollLeft - scrollLeft) < 1 &&
            Math.abs(nextScrollTop - scrollTop) < 1
        ) {
            return;
        }

        previewElement.scrollTo({
            left: nextScrollLeft,
            top: nextScrollTop,
            behavior: "smooth",
        });
    }

    private setZoom(level: number): void {
        const clamped = Math.min(
            this.zoomMax,
            Math.max(this.zoomMin, Number(level)),
        );
        this.zoomLevel = Number(clamped.toFixed(2));
        this.syncCurrentZoomDisplay();
        this.applyZoomToSvg();
    }

    private syncCurrentZoomDisplay(): void {
        const currentZoomValue = document.querySelector(this.currentZoomValueSelector) as HTMLElement | null;
        if (!currentZoomValue) {
            return;
        }

        currentZoomValue.textContent = `${this.zoomLevel.toFixed(2)}x`;
    }

    private applyZoomToSvg(): void {
        const svg = document.querySelector(
            `${tmSelectors.PreviewDocumentHost} > svg`,
        ) as SVGElement | null;
        if (!svg) {
            return;
        }

        if (this.baseSvgWidth === null || this.baseSvgHeight === null) {
            const rect = svg.getBoundingClientRect();
            const fallbackWidth = svg.clientWidth || rect.width;
            const fallbackHeight = svg.clientHeight || rect.height;
            this.baseSvgWidth = fallbackWidth || 0;
            this.baseSvgHeight = fallbackHeight || 0;
        }

        const width = (this.baseSvgWidth || 0) * this.zoomLevel;
        const height = (this.baseSvgHeight || 0) * this.zoomLevel;
        svg.style.width = `${Math.max(1, width)}px`;
        svg.style.height = `${Math.max(1, height)}px`;
        svg.style.maxWidth = "none";
    }

    private handlePanMouseDown(event: Event): void {
        const mouseEvent = event as MouseEvent;
        if (!this.isPanInteractionEnabled() || mouseEvent.button !== 0) {
            return;
        }

        this.isPanning = true;
        this.panStartX = mouseEvent.clientX;
        this.panStartY = mouseEvent.clientY;

        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;
        this.panStartScrollLeft = previewElement.scrollLeft;
        this.panStartScrollTop = previewElement.scrollTop;
        previewElement.classList.add(tmClassNames.PreviewPanning);
        event.preventDefault();
    }

    private handlePanMouseMove(event: Event): void {
        if (!this.isPanning) {
            return;
        }

        const mouseEvent = event as MouseEvent;
        const dx = mouseEvent.clientX - this.panStartX;
        const dy = mouseEvent.clientY - this.panStartY;

        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;
        previewElement.scrollLeft = this.panStartScrollLeft - dx;
        previewElement.scrollTop = this.panStartScrollTop - dy;

        event.preventDefault();
    }

    private handlePanMouseUp(event: Event): void {
        if (!this.isPanning) {
            return;
        }

        this.stopPanning();
    }

    private stopPanning(): void {
        this.isPanning = false;
        const previewElement = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewContent}`,
        ) as HTMLElement;
        previewElement.classList.remove(tmClassNames.PreviewPanning);
    }

    destroy() {
        this.closePreviewSettings();
        this.addRemoveListeners(false);
    }
}
