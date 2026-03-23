import {
    ENTRY_FILE_NAME,
    tmClassNames,
    tmEvents,
    tmSelectors,
} from "../constants";

/** Preview controls: toolbar, hot keys, mode dropdown
 * PDF is a static simple frame
 */
export class PreviewToolbar {
    private previewElement: HTMLElement;
    private pageId: number;
    private activeFileName = ENTRY_FILE_NAME;

    private paneSelector: string;
    private pdfFrameSelector: string;

    private previewModeSelect: HTMLSelectElement | null = null;
    private liveStatus: "paused" | "running" | "connecting" = "connecting";
    private lastSelectedMode = "live-preview";

    private zoomLevel = 1;
    private readonly zoomStep = 0.1;
    private readonly zoomMin = 0.25;
    private readonly zoomMax = 3;
    private baseSvgWidth: number | null = null;
    private baseSvgHeight: number | null = null;
    private panEnabled = false;
    private isPanning = false;
    private panStartX = 0;
    private panStartY = 0;
    private panStartScrollLeft = 0;
    private panStartScrollTop = 0;
    private pointerInPreview = false;
    private zKeyPressed = false;
    private temporaryPanActive = false;

    private cursorSpotlightUserEnabled = true;
    private scrollIntoViewUserEnabled = true;

    constructor(previewElement: HTMLElement, pageId: number) {
        this.previewElement = previewElement;
        this.pageId = pageId;
        this.paneSelector = `${tmSelectors.Root} ${tmSelectors.PreviewPane}`;
        this.pdfFrameSelector = `${tmSelectors.Root} ${tmSelectors.PreviewPdfFrame}`;

        this.previewModeSelect = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.PreviewModeSelect}`,
        ) as HTMLSelectElement | null;

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

        this.previewModeSelect?.toggleAttribute("disabled", this.pageId <= 0);
    }

    private onDocumentUpdate(payload: { pdfPagesCount: number }): void {
        this.baseSvgWidth = null;
        this.baseSvgHeight = null;
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

        this.previewElement[method]("mousedown", this.handlePanMouseDown);
        this.previewElement[method]("mousemove", this.handlePanMouseMove);
        this.previewElement[method]("mouseup", this.handlePanMouseUp);
        this.previewElement[method]("mouseleave", this.handlePanMouseUp);
        this.previewElement[method]("mouseenter", this.handlePreviewMouseEnter);
        this.previewElement[method]("mouseleave", this.handlePreviewMouseLeave);

        if (adding) {
            window.addEventListener("keydown", this.handleGlobalKeyDown);
            window.addEventListener("keyup", this.handleGlobalKeyUp);
            window.addEventListener("blur", this.handleWindowBlur);
        } else {
            window.removeEventListener("keydown", this.handleGlobalKeyDown);
            window.removeEventListener("keyup", this.handleGlobalKeyUp);
            window.removeEventListener("blur", this.handleWindowBlur);
        }
    }

    private setLivePreviewVisibility(visible: boolean): void {
        const svgHost = this.previewElement.querySelector(
            tmSelectors.PreviewDocumentHost,
        ) as HTMLElement | null;
        const muted = this.previewElement.querySelector(
            tmSelectors.PreviewMutedMessage,
        ) as HTMLElement | null;
        const error = this.previewElement.querySelector(
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
        if (!pdfFrame || this.pageId <= 0) {
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
        if (!this.previewModeSelect) {
            return;
        }
        const value = (this.previewModeSelect.value || "").trim();
        const isActionOption =
            value === "toggle-live-preview" || value === "download-all";

        if (isActionOption) {
            this.previewModeSelect.value = this.lastSelectedMode;
        }

        if (value === "toggle-live-preview") {

            event.preventDefault();

            window.$tmEventBus.emit(tmEvents.PreviewConnectionToggle);
            return;
        }

        if (value === "download-all") {

            event.preventDefault();

            if (this.pageId > 0) {
                window.location.assign(
                    `/ajax/tinymist/${this.pageId}/pdf/download-all`,
                );
            }
            return;
        }

        if (value === "live-preview") {
            this.previewModeSelect.value = "live-preview";
            this.lastSelectedMode = "live-preview";
            this.closePdfPreview();
            return;
        }
        if (value.startsWith("pdf-page-")) {
            const page = value.replace("pdf-page-", "");
            this.lastSelectedMode = value;
            this.openPdfPreview(page);
        }
    }

    private handlePreviewConnectionState(payload: {
        label: "paused" | "running" | "connecting";
    }): void {

        this.liveStatus = payload.label;

        console.log(`[Preview Toolbar] Connection state changed: ${this.liveStatus}`);

        const liveOption = this.previewModeSelect?.querySelector(
            'option[value="live-preview"]',
        );
        const output = liveOption?.querySelector("output");
        const toggleOption = this.previewModeSelect?.querySelector(
            'option[value="toggle-live-preview"]',
        );
        if (!this.previewModeSelect || !liveOption || !output || !toggleOption) {
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
        if (!this.previewModeSelect) {
            return;
        }

        const previousStableValue = this.lastSelectedMode;

        this.previewModeSelect
            .querySelectorAll("option.pdf-option")
            .forEach((option) => option.remove());

        for (let index = 1; index <= pageCount; index++) {
            const option = document.createElement("option");
            option.classList.add("pdf-option");
            option.value = `pdf-page-${index}`;
            option.textContent = `PDF page ${index}`;
            this.previewModeSelect.appendChild(option);
        }

        if (pageCount > 0) {
            const downloadAll = document.createElement("option");
            downloadAll.classList.add("pdf-option");
            downloadAll.value = "download-all";
            downloadAll.textContent = "Download all";
            this.previewModeSelect.appendChild(downloadAll);
        }

        const hasStableOption = Boolean(
            this.previewModeSelect.querySelector(
                `option[value="${CSS.escape(previousStableValue)}"]`,
            ),
        );

        this.lastSelectedMode = hasStableOption
            ? previousStableValue
            : "live-preview";
        this.previewModeSelect.value = this.lastSelectedMode;
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
        this.previewElement.classList.toggle(
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
            default:
                break;
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
        const viewportWidth = this.previewElement.clientWidth;
        const viewportHeight = this.previewElement.clientHeight;
        if (viewportWidth <= 0 || viewportHeight <= 0) {
            return;
        }

        const marginX = Math.max(24, Math.min(120, viewportWidth * 0.1));
        const marginY = Math.max(24, Math.min(120, viewportHeight * 0.1));

        const minVisibleX = this.previewElement.scrollLeft + marginX;
        const maxVisibleX =
            this.previewElement.scrollLeft + viewportWidth - marginX;
        const minVisibleY = this.previewElement.scrollTop + marginY;
        const maxVisibleY =
            this.previewElement.scrollTop + viewportHeight - marginY;

        const cursorLeft = contentX - width / 2;
        const cursorRight = contentX + width / 2;
        const cursorTop = contentY - height / 2;
        const cursorBottom = contentY + height / 2;

        let nextScrollLeft = this.previewElement.scrollLeft;
        let nextScrollTop = this.previewElement.scrollTop;

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
            Math.abs(nextScrollLeft - this.previewElement.scrollLeft) < 1 &&
            Math.abs(nextScrollTop - this.previewElement.scrollTop) < 1
        ) {
            return;
        }

        this.previewElement.scrollTo({
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
        this.applyZoomToSvg();
    }

    private applyZoomToSvg(): void {
        const svg = this.previewElement.querySelector(
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
        this.panStartScrollLeft = this.previewElement.scrollLeft;
        this.panStartScrollTop = this.previewElement.scrollTop;
        this.previewElement.classList.add(tmClassNames.PreviewPanning);
        event.preventDefault();
    }

    private handlePanMouseMove(event: Event): void {
        if (!this.isPanning) {
            return;
        }

        const mouseEvent = event as MouseEvent;
        const dx = mouseEvent.clientX - this.panStartX;
        const dy = mouseEvent.clientY - this.panStartY;
        this.previewElement.scrollLeft = this.panStartScrollLeft - dx;
        this.previewElement.scrollTop = this.panStartScrollTop - dy;

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
        this.previewElement.classList.remove(tmClassNames.PreviewPanning);
    }

    destroy() {
        this.addRemoveListeners(false);
    }
}
