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
    // Baseline fonts should be commonly available, but measurably distinct, we need a pair to compare against to detect fallbacks
    private static readonly FONT_ONE_VARIANTS = ["Arial","Verdana", "Times New Roman", "Palatino", "Helvetica"];
    private static readonly FONT_TWO_VARIANTS = ["Courier New", "Courier","Lucida Console", "Lucida Sans Typewriter"];
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
    private font1: { name: string; xHeight: number; capHeight: number; emWidth: number; normalWidth: number } | null = null;
    private font2: { name: string; xHeight: number; capHeight: number; emWidth: number; normalWidth: number } | null = null;

    private root: HTMLElement;
    private overlay: HTMLElement | null;
    private currentSettings: ThemeSettingValues = { ...DEFAULT_THEME_SETTINGS };
    private measureCanvas: HTMLCanvasElement | null = null;

    constructor(root: HTMLElement) {
        this.root = root;

        // Ensure stored settings are loaded
        const stored = this.readStoredSettings();
        this.currentSettings = {
            ...DEFAULT_THEME_SETTINGS,
            ...stored,
        };
        this.applyStateToEditor(this.currentSettings);

        this.overlay = this.root.querySelector(".tinymist-theme-settings-overlay");
        if (!this.overlay) {
            return;
        }

        // One way to open
        window.$events.listen("tinymist-theme-settings-open", () => {
            if (!this.overlay) return;
            this.overlay.hidden = false;
            this.overlay.classList.add("is-visible");
            this.ensureSettingsLoaded();
        });

        // Many ways to close
        const close = () => {
            if (!this.overlay) return;
            this.overlay.classList.remove("is-visible");
            this.overlay.hidden = true;
        };
        const closeButtons = this.overlay?.querySelectorAll('button[data-action="closeThemeSettings"]') ?? [];
        closeButtons.forEach((button) => {
            button.addEventListener("click", () => close());
        });
        this.overlay?.addEventListener("click", (event) => {
            if (event.target === this.overlay) {
                close();
            }
        });
        window.addEventListener("keyup", (event) => {
            if (event.key === "Escape" && !!this.overlay && !this.overlay.hidden) {
                close();
            }
        });

        this.updateInput = this.updateInput.bind(this);
        this.reset = this.reset.bind(this);
    }

    private applyStateToEditor(settings: ThemeSettingValues): void {
        Object.entries(settings).forEach(([token, value]) => {
            this.root.style.setProperty(`--${token}`, value);
        });
    }

    private reset(): void {
        this.currentSettings = { ...DEFAULT_THEME_SETTINGS };
        this.applyStateToEditor(this.currentSettings);
        this.syncStateToInputs();
        this.refreshAllFontFeedback();
        this.persistSettings();
    }

    private updateInput(event: Event): void {
        const input = event.target as HTMLInputElement;
        const token = input.dataset.tmToken;
        if (!token) return;

        this.currentSettings[token] = input.value.trim();
        this.root.style.setProperty(`--${token}`, this.currentSettings[token]);
        if (TinymistThemeSettings.FONT_TOKENS.has(token)) {
            this.updateFontInputFeedback(input);
        }
        this.persistSettings();
    }

    // fires only once if the user decides to use settings, so we can delay setup until then
    ensureSettingsLoaded(): void {
        if (this.font1 && this.font2) {
            return;
        }
        this.defineCheckerFonts();
        this.setupFontInputHelpers();
        this.syncStateToInputs();

        const isDarkMode = document.documentElement.classList.contains("dark-mode");
        const splitControls = this.overlay?.querySelectorAll<HTMLElement>(".tinymist-theme-color-split") ?? [];
        splitControls.forEach((control) => {
            control.dataset.activeTheme = isDarkMode ? "dark" : "light";
        });

        // add listeners to inputs
        const inputs = this.overlay?.querySelectorAll<HTMLInputElement>("[data-tm-token]") ?? [];
        inputs.forEach((input) => {
            const token = input.dataset.tmToken;
            if (!token) return;
            const eventName = input.type === "color" || TinymistThemeSettings.FONT_TOKENS.has(token) ? "input" : "change";
            input.addEventListener(eventName, this.updateInput);
        });

        const resetButton = this.overlay?.querySelector<HTMLButtonElement>('button[data-action="resetThemeSettings"]');
        resetButton?.addEventListener("click", this.reset);
    }

    /** Finding 2 distinct fonts that are not fallbacks and override each other if the order is swapped */
    private defineCheckerFonts(): void {
        const fonts_one  = TinymistThemeSettings.FONT_ONE_VARIANTS;
        const fonts_two  = TinymistThemeSettings.FONT_TWO_VARIANTS;
        const context = this.getMeasureContext();
        if (!context) {
            return;
        }

        for (let i = 0; i < fonts_one.length; i++) {
            const fontName1 = this.cleanFontCandidate(fonts_one[i]);
            for (let j = 0; j < fonts_two.length; j++) {
                const fontName2 = this.cleanFontCandidate(fonts_two[j]);
                const signature1 = this.measureTypographySignature(context, `"${fontName1}", "${fontName2}"`);
                const signature2 = this.measureTypographySignature(context, `"${fontName2}", "${fontName1}"`);
                if (signature1 && signature2 && !this.areSignaturesClose(signature1, signature2)) {
                    this.font1 = {name: fontName1, ...signature1};
                    this.font2 = {name: fontName2, ...signature2};
                    break;
                }
            }
            if (this.font1 && this.font2) {
                break;
            }
        }
    }

    private syncStateToInputs(): void {
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
            const signal = this.getFontDistinctSignal(cleanName);
            if (signal.hideDemo) {
                return;
            }
            if (signal.label === "available" && !firstExistingFontName) {
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
    ): { label: string; className: string; hideDemo: boolean } {
        if (TinymistThemeSettings.GENERIC_FONT_FAMILIES.has(fontName.toLowerCase())) {
            return { label: "generic", className: "is-generic", hideDemo: false };
        }

        const available = this.checkFontAvailability(fontName);
        if (available === false) {
            return { label: "not found", className: "is-missing", hideDemo: false };
        }

        if (this.runDualBaselineFontTest(fontName)) {
            return { label: "available", className: "is-distinct", hideDemo: false };
        }

        return { label: "not rendering", className: "is-unknown", hideDemo: true };
    }

    private runDualBaselineFontTest(fontName: string): boolean {
        const context = this.getMeasureContext();
        if (!context || !this.font1 || !this.font2) {
            return false;
        }

        const testOne = this.measureTypographySignature(
            context,
            `"${fontName}", ${this.font1.name}`,
        );
        const testTwo = this.measureTypographySignature(
            context,
            `"${fontName}", ${this.font2.name}`,
        );

        return this.areSignaturesClose(testOne, testTwo);
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
        first: { xHeight: number; capHeight: number; emWidth: number; normalWidth: number } | null,
        second: { xHeight: number; capHeight: number; emWidth: number; normalWidth: number } | null,
    ): boolean {
        if (!first || !second) {
            return false;
        }
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
}
