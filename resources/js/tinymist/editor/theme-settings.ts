type ThemeSettingValues = Record<string, string>;

const STORAGE_KEY = "tinymist-theme-settings-v1";

const DEFAULT_THEME_SETTINGS: ThemeSettingValues = {
    "tm-font-mono": '"Monaco", "Menlo", "Ubuntu Mono", "Consolas", monospace',
    "tm-font-ui": '"-apple-system", BlinkMacSystemFont, "Segoe UI", "Oxygen", "Ubuntu", "Roboto", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
    "tm-hlt-keyword": "#8250df",
    "tm-hlt-keyword-dark": "#bb8fce",
    "tm-hlt-string": "#0a7f3f",
    "tm-hlt-string-dark": "#52be80",
    "tm-hlt-comment": "#57606a",
    "tm-hlt-comment-dark": "#808080",
    "tm-hlt-number": "#9a6700",
    "tm-hlt-number-dark": "#d6863e",
    "tm-hlt-error": "#cf222e",
    "tm-hlt-error-dark": "#e74c3c",
};

export class TinymistThemeSettings {
    private static readonly FONT_TOKENS = new Set(["tm-font-mono", "tm-font-ui"]);
    private static readonly BASELINE_FONT_ONE = "Times New Roman";
    private static readonly BASELINE_FONT_TWO = "Courier New";
    private static readonly METRIC_SAMPLE = {
        xHeight: "xxxxxxxxxxxx",
        capHeight: "XXXXXXXXXXXX",
        emWidth: "mmmmmmmmmmmm",
        normalWidth: "nnnnnnnnnnnn",
    };
    private static readonly GENERIC_FONT_FAMILIES = new Set([
        "serif",
        "sans-serif",
        "monospace",
        "cursive",
        "fantasy",
        "system-ui",
        "emoji",
        "math",
        "fangsong",
        "ui-serif",
        "ui-sans-serif",
        "ui-monospace",
        "ui-rounded",
    ]);

    private root: HTMLElement;
    private overlay: HTMLElement | null;
    private openButton: HTMLButtonElement | null;
    private currentSettings: ThemeSettingValues = { ...DEFAULT_THEME_SETTINGS };
    private measureCanvas: HTMLCanvasElement | null = null;

    constructor(root: HTMLElement) {
        this.root = root;
        this.overlay = this.root.querySelector(".tinymist-theme-settings-overlay");
        this.openButton = this.root.querySelector('button[data-action="changeCodeMirrorSettings"]');

        if (!this.overlay || !this.openButton) {
            return;
        }

        this.loadAndApplyInitialSettings();
        this.setupFontInputHelpers();
        this.syncActiveColorThemeMarker();
        this.bindOpenClose();
        this.bindInputs();
        this.bindReset();
        this.bindGlobalEvents();
    }

    destroy(): void {
        window.removeEventListener("keyup", this.onKeyUp);
    }

    private loadAndApplyInitialSettings(): void {
        const stored = this.readStoredSettings();
        this.currentSettings = {
            ...DEFAULT_THEME_SETTINGS,
            ...stored,
        };

        this.applySettings(this.currentSettings);
        this.syncInputsFromCurrentState();
    }

    private bindOpenClose(): void {
        this.openButton?.addEventListener("click", () => this.open());

        const closeButtons = this.overlay?.querySelectorAll('button[data-action="closeThemeSettings"]') ?? [];
        closeButtons.forEach((button) => {
            button.addEventListener("click", () => this.close());
        });

        this.overlay?.addEventListener("click", (event) => {
            if (event.target === this.overlay) {
                this.close();
            }
        });
    }

    private bindInputs(): void {
        const inputs = this.overlay?.querySelectorAll<HTMLInputElement>("[data-tm-token]") ?? [];
        inputs.forEach((input) => {
            const token = input.dataset.tmToken;
            if (!token) return;

            const eventName = input.type === "color" || TinymistThemeSettings.FONT_TOKENS.has(token) ? "input" : "change";
            input.addEventListener(eventName, () => {
                this.currentSettings[token] = input.value.trim();
                this.root.style.setProperty(`--${token}`, this.currentSettings[token]);
                if (TinymistThemeSettings.FONT_TOKENS.has(token)) {
                    this.updateFontInputFeedback(input);
                }
                this.persistSettings();
            });
        });

        const colorInputs = this.overlay?.querySelectorAll<HTMLInputElement>(".tinymist-theme-color-half") ?? [];
        colorInputs.forEach((input) => {
            input.addEventListener("click", () => {
                this.syncActiveColorThemeMarker(input.dataset.themeVariant === "dark" ? "dark" : "light");
            });
        });
    }

    private bindReset(): void {
        const resetButton = this.overlay?.querySelector<HTMLButtonElement>('button[data-action="resetThemeSettings"]');
        if (!resetButton) return;

        resetButton.addEventListener("click", () => {
            this.currentSettings = { ...DEFAULT_THEME_SETTINGS };
            this.applySettings(this.currentSettings);
            this.syncInputsFromCurrentState();
            this.refreshAllFontFeedback();
            this.persistSettings();
        });
    }

    private bindGlobalEvents(): void {
        window.addEventListener("keyup", this.onKeyUp);
    }

    private syncActiveColorThemeMarker(theme?: "light" | "dark"): void {
        const isDarkMode = document.documentElement.classList.contains("dark-mode");
        const activeTheme = theme ?? (isDarkMode ? "dark" : "light");
        const splitControls = this.overlay?.querySelectorAll<HTMLElement>(".tinymist-theme-color-split") ?? [];
        splitControls.forEach((control) => {
            control.dataset.activeTheme = activeTheme;
        });
    }

    private onKeyUp = (event: KeyboardEvent): void => {
        if (event.key === "Escape" && this.isOpen()) {
            this.close();
        }
    };

    private syncInputsFromCurrentState(): void {
        const inputs = this.overlay?.querySelectorAll<HTMLInputElement>("[data-tm-token]") ?? [];
        inputs.forEach((input) => {
            const token = input.dataset.tmToken;
            if (!token) return;

            const value = this.currentSettings[token] ?? "";
            input.value = value;
        });

        this.refreshAllFontFeedback();
    }

    private setupFontInputHelpers(): void {
        const inputs = this.overlay?.querySelectorAll<HTMLInputElement>('input[type="text"][data-tm-token]') ?? [];
        inputs.forEach((input) => {
            const token = input.dataset.tmToken ?? "";
            if (!TinymistThemeSettings.FONT_TOKENS.has(token)) {
                return;
            }

            const wrapper = input.closest(".tinymist-theme-setting-row");
            if (!wrapper) {
                return;
            }

            if (!wrapper.querySelector(".tinymist-theme-font-status")) {
                const statusElement = document.createElement("div");
                statusElement.className = "tinymist-theme-font-status text-small text-muted";
                wrapper.appendChild(statusElement);
            }

            if (!wrapper.querySelector(".tinymist-theme-font-preview")) {
                const previewElement = document.createElement("div");
                previewElement.className = "tinymist-theme-font-preview";
                wrapper.appendChild(previewElement);
            }

            if (!wrapper.querySelector(".tinymist-theme-font-probes")) {
                const probesElement = document.createElement("div");
                probesElement.className = "tinymist-theme-font-probes";
                wrapper.appendChild(probesElement);
            }

            this.updateFontInputFeedback(input);
        });
    }

    private refreshAllFontFeedback(): void {
        const inputs = this.overlay?.querySelectorAll<HTMLInputElement>('input[type="text"][data-tm-token]') ?? [];
        inputs.forEach((input) => this.updateFontInputFeedback(input));
    }

    private updateFontInputFeedback(input: HTMLInputElement): void {
        const token = input.dataset.tmToken ?? "";
        if (!TinymistThemeSettings.FONT_TOKENS.has(token)) {
            return;
        }

        const wrapper = input.closest(".tinymist-theme-setting-row");
        if (!wrapper) {
            return;
        }

        const statusElement = wrapper.querySelector<HTMLElement>(".tinymist-theme-font-status");
        const previewElement = wrapper.querySelector<HTMLElement>(".tinymist-theme-font-preview");
        const probesElement = wrapper.querySelector<HTMLElement>(".tinymist-theme-font-probes");

        const rawFontStack = input.value.trim();
        const candidates = this.splitFontFamilyList(rawFontStack);
        const firstRequested = candidates[0] ?? "";
        const checkResult = this.checkFontAvailability(firstRequested);

        if (previewElement) {
            previewElement.style.fontFamily = rawFontStack || DEFAULT_THEME_SETTINGS[token];
            previewElement.textContent = token === "tm-font-mono"
                ? "Monospace preview: AaBb 0O1l {}[] () => +-*/ #_"
                : "UI preview: The quick brown fox jumps over 1234567890.";
        }

        const computedPreviewFontFamily = previewElement
            ? getComputedStyle(previewElement).fontFamily
            : "";
        const computedCandidates = this.splitFontFamilyList(computedPreviewFontFamily);

        const firstExistingFontName = this.renderFontProbes(
            probesElement,
            computedCandidates,
            token === "tm-font-mono" ? "monospace" : "sans-serif",
        );

        if (statusElement) {
            if (checkResult === null) {
                statusElement.className = "tinymist-theme-font-status text-small text-muted";
                statusElement.textContent = "Font check unavailable in this browser. Open DevTools → Rendered Fonts for exact face.";
            } else if (!firstRequested) {
                statusElement.className = "tinymist-theme-font-status text-small text-muted";
                statusElement.textContent = "Type a font name or stack (for example: Inter, Segoe UI, sans-serif).";
            } else {
                statusElement.className = checkResult
                    ? "tinymist-theme-font-status text-small text-pos"
                    : "tinymist-theme-font-status text-small text-warn";
                statusElement.textContent = `First existing font from stack: ${firstExistingFontName || "(none detected)"}.`;
            }
        }
    }

    private renderFontProbes(
        probesElement: HTMLElement | null,
        fontCandidates: string[],
        fallbackFamily: string,
    ): string {
        let firstExistingFontName = '';

        if (!probesElement) {
            return firstExistingFontName;
        }

        probesElement.innerHTML = "";

        if (!fontCandidates.length) {
            return firstExistingFontName;
        }

        const grouped = new Map<string, Array<{ fontName: string; className: string; sampleFamily: string }>>();

        fontCandidates.forEach((fontName) => {
            const cleanName = this.cleanFontCandidate(fontName);
            if (!cleanName) {
                return;
            }
            const signal = this.getFontDistinctSignal(cleanName, fallbackFamily);
            if (signal.hideDemo) {
                return;
            }
            if (signal.label === "exists" && !firstExistingFontName) {
                firstExistingFontName = cleanName;
            }

            const existing = grouped.get(signal.label) ?? [];
            existing.push({
                fontName: cleanName,
                className: signal.className,
                sampleFamily: `"${cleanName}", ${fallbackFamily}`,
            });
            grouped.set(signal.label, existing);
        });

        grouped.forEach((items, groupLabel) => {
            const group = document.createElement("div");
            group.className = "tinymist-theme-font-probe-group";

            const title = document.createElement("div");
            title.className = "tinymist-theme-font-probe-group-title text-small";
            title.textContent = groupLabel;
            group.appendChild(title);

            const list = document.createElement("div");
            list.className = "tinymist-theme-font-probe-list";

            items.forEach((item) => {
                const row = document.createElement("div");
                row.className = `tinymist-theme-font-probe-row ${item.className}`;

                const name = document.createElement("span");
                name.className = "tinymist-theme-font-probe-name";
                name.textContent = `${item.fontName}: `;
                row.appendChild(name);

                const sample = document.createElement("span");
                sample.className = "tinymist-theme-font-probe-sample";
                sample.style.fontFamily = item.sampleFamily;
                sample.textContent = fallbackFamily === "monospace"
                    ? "AaBb 0O1l {}[] () => +-*/ #_"
                    : "The quick brown fox jumps over the lazy dog 1234567890.";
                row.appendChild(sample);

                list.appendChild(row);
            });

            group.appendChild(list);
            probesElement.appendChild(group);
        });

        return firstExistingFontName;
    }

    private getFontDistinctSignal(
        fontName: string,
        fallbackFamily: string,
    ): { label: string; className: string; hideDemo: boolean } {
        if (TinymistThemeSettings.GENERIC_FONT_FAMILIES.has(fontName.toLowerCase())) {
            return { label: "generic", className: "is-generic", hideDemo: false };
        }

        const available = this.checkFontAvailability(fontName);
        if (available === false) {
            return { label: "not found", className: "is-missing", hideDemo: false };
        }

        const result = this.runDualBaselineFontTest(fontName, fallbackFamily);
        if (!result) {
            return { label: "unknown", className: "is-unknown", hideDemo: false };
        }

        if (result.matchesFallbackPattern) {
            return { label: "fallback", className: "is-missing", hideDemo: true };
        }

        if (result.sameAcrossTests && result.differentFromAtLeastOneBaseline) {
            return { label: "exists", className: "is-distinct", hideDemo: false };
        }

        if (result.sameAcrossTests) {
            return { label: "same in both tests", className: "is-similar", hideDemo: false };
        }

        return { label: "mixed signal", className: "is-unknown", hideDemo: false };
    }

    private runDualBaselineFontTest(
        fontName: string,
        fallbackFamily: string,
    ): {
        sameAcrossTests: boolean;
        differentFromAtLeastOneBaseline: boolean;
        matchesFallbackPattern: boolean;
    } | null {
        const context = this.getMeasureContext();
        if (!context) {
            return null;
        }

        const baselineOne = this.measureTypographySignature(context, TinymistThemeSettings.BASELINE_FONT_ONE);
        const baselineTwo = this.measureTypographySignature(context, TinymistThemeSettings.BASELINE_FONT_TWO);
        const testOne = this.measureTypographySignature(
            context,
            `"${fontName}", ${TinymistThemeSettings.BASELINE_FONT_ONE}, ${fallbackFamily}`,
        );
        const testTwo = this.measureTypographySignature(
            context,
            `"${fontName}", ${TinymistThemeSettings.BASELINE_FONT_TWO}, ${fallbackFamily}`,
        );

        if (!baselineOne || !baselineTwo || !testOne || !testTwo) {
            return null;
        }

        const sameAcrossTests = this.areSignaturesClose(testOne, testTwo);
        const matchesFallbackPattern =
            this.areSignaturesClose(testOne, baselineOne)
            && this.areSignaturesClose(testTwo, baselineTwo);

        const differentFromAtLeastOneBaseline =
            !this.areSignaturesClose(testOne, baselineOne)
            || !this.areSignaturesClose(testTwo, baselineTwo);

        return {
            sameAcrossTests,
            differentFromAtLeastOneBaseline,
            matchesFallbackPattern,
        };
    }

    private measureTypographySignature(
        context: CanvasRenderingContext2D,
        fontFamily: string,
    ): {
        xHeight: number;
        capHeight: number;
        emWidth: number;
        normalWidth: number;
    } | null {
        const xMetrics = this.measureTextMetrics(context, fontFamily, TinymistThemeSettings.METRIC_SAMPLE.xHeight);
        const capMetrics = this.measureTextMetrics(context, fontFamily, TinymistThemeSettings.METRIC_SAMPLE.capHeight);
        const emMetrics = this.measureTextMetrics(context, fontFamily, TinymistThemeSettings.METRIC_SAMPLE.emWidth);
        const normalMetrics = this.measureTextMetrics(context, fontFamily, TinymistThemeSettings.METRIC_SAMPLE.normalWidth);

        if (!xMetrics || !capMetrics || !emMetrics || !normalMetrics) {
            return null;
        }

        const xCount = TinymistThemeSettings.METRIC_SAMPLE.xHeight.length;
        const capCount = TinymistThemeSettings.METRIC_SAMPLE.capHeight.length;
        const emCount = TinymistThemeSettings.METRIC_SAMPLE.emWidth.length;
        const normalCount = TinymistThemeSettings.METRIC_SAMPLE.normalWidth.length;

        return {
            xHeight: xMetrics.height,
            capHeight: capMetrics.height,
            emWidth: emMetrics.width / emCount,
            normalWidth: normalMetrics.width / normalCount,
        };
    }

    private areSignaturesClose(
        first: { xHeight: number; capHeight: number; emWidth: number; normalWidth: number },
        second: { xHeight: number; capHeight: number; emWidth: number; normalWidth: number },
    ): boolean {
        const maxHeightBase = Math.max(1, second.capHeight);
        const maxWidthBase = Math.max(1, second.emWidth);

        const xHeightDelta = Math.abs(first.xHeight - second.xHeight) / maxHeightBase;
        const capHeightDelta = Math.abs(first.capHeight - second.capHeight) / maxHeightBase;
        const emWidthDelta = Math.abs(first.emWidth - second.emWidth) / maxWidthBase;
        const normalWidthDelta = Math.abs(first.normalWidth - second.normalWidth) / maxWidthBase;

        const aggregateDelta = (xHeightDelta + capHeightDelta + emWidthDelta + normalWidthDelta) / 4;
        return aggregateDelta <= 0.02;
    }

    private getMeasureContext(): CanvasRenderingContext2D | null {
        if (!this.measureCanvas) {
            this.measureCanvas = document.createElement("canvas");
        }

        return this.measureCanvas.getContext("2d");
    }

    private measureTextMetrics(
        context: CanvasRenderingContext2D,
        fontFamily: string,
        sample: string,
    ): { width: number; height: number } | null {
        context.font = `32px ${fontFamily}`;
        const metrics = context.measureText(sample);

        const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
            ? metrics.actualBoundingBoxAscent
            : 0;
        const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
            ? metrics.actualBoundingBoxDescent
            : 0;
        const height = Math.max(1, ascent + descent);

        if (!Number.isFinite(metrics.width) || metrics.width <= 0) {
            return null;
        }

        return {
            width: metrics.width,
            height,
        };
    }

    private splitFontFamilyList(fontStack: string): string[] {
        if (!fontStack.trim()) {
            return [];
        }

        const parts: string[] = [];
        let current = "";
        let quote: string | null = null;

        for (let index = 0; index < fontStack.length; index++) {
            const character = fontStack[index];

            if ((character === '"' || character === "'") && (!quote || quote === character)) {
                quote = quote ? null : character;
                current += character;
                continue;
            }

            if (character === "," && !quote) {
                const cleaned = this.cleanFontCandidate(current);
                if (cleaned) {
                    parts.push(cleaned);
                }
                current = "";
                continue;
            }

            current += character;
        }

        const cleaned = this.cleanFontCandidate(current);
        if (cleaned) {
            parts.push(cleaned);
        }

        return parts;
    }

    private cleanFontCandidate(candidate: string): string {
        return candidate.trim().replace(/^['"]|['"]$/g, "").trim();
    }

    private checkFontAvailability(fontCandidate: string): boolean | null {
        const normalized = this.cleanFontCandidate(fontCandidate);
        if (!normalized) {
            return false;
        }

        if (TinymistThemeSettings.GENERIC_FONT_FAMILIES.has(normalized.toLowerCase())) {
            return true;
        }

        if (!document.fonts?.check) {
            return null;
        }

        const escaped = normalized.replace(/"/g, '\\"');
        return document.fonts.check(`16px "${escaped}"`);
    }

    private findFirstAvailableFontCandidate(candidates: string[]): string {
        for (const candidate of candidates) {
            const available = this.checkFontAvailability(candidate);
            if (available) {
                return this.cleanFontCandidate(candidate);
            }
        }

        return "";
    }


    private applySettings(settings: ThemeSettingValues): void {
        Object.entries(settings).forEach(([token, value]) => {
            this.root.style.setProperty(`--${token}`, value);
        });
    }

    private persistSettings(): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.currentSettings));
        } catch (error) {
            console.warn("[Tinymist Theme] Failed to store theme settings", error);
        }
    }

    private readStoredSettings(): ThemeSettingValues {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return {};
            }

            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                return parsed as ThemeSettingValues;
            }
        } catch (error) {
            console.warn("[Tinymist Theme] Failed to read stored theme settings", error);
        }

        return {};
    }

    private open(): void {
        if (!this.overlay) return;
        this.overlay.hidden = false;
        this.overlay.classList.add("is-visible");
    }

    private close(): void {
        if (!this.overlay) return;
        this.overlay.classList.remove("is-visible");
        this.overlay.hidden = true;
    }

    private isOpen(): boolean {
        return !!this.overlay && !this.overlay.hidden;
    }
}
