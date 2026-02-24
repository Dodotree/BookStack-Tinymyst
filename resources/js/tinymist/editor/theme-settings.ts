import { highlightColors } from "./semantic-tokens";

type ThemeSettingValues = Record<string, string>;

const STORAGE_KEY = "tinymist-theme-settings-v1";

const FONT_TOKENS = ["tm-font-mono", "tm-font-ui"] as const;
const HIGHLIGHT_COLOR_TYPES = highlightColors.filter((type) => type !== "text");
const toThemeToken = (type: string, isDark = false): string => `tm-hlt-${type}${isDark ? "-dark" : ""}`;
const toReadableLabel = (value: string): string => value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

const FALLBACK_THEME_SETTINGS: ThemeSettingValues = {
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

const SEMANTIC_HIGHLIGHT_TYPES = new Set<string>(highlightColors);
const HIGHLIGHT_COLOR_TOKENS = HIGHLIGHT_COLOR_TYPES.flatMap((type) => [toThemeToken(type, false), toThemeToken(type, true)]);
const THEME_TOKENS = [...FONT_TOKENS, ...HIGHLIGHT_COLOR_TOKENS];
const COLOR_TOKENS = new Set(
    THEME_TOKENS.filter((token) => {
        if (!token.startsWith("tm-hlt-")) {
            return false;
        }
        const semanticType = token.replace(/^tm-hlt-/, "").replace(/-dark$/, "");
        return SEMANTIC_HIGHLIGHT_TYPES.has(semanticType);
    })
);

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
    private currentSettings: ThemeSettingValues = {};
    private stylesheetDefaults: ThemeSettingValues = { ...FALLBACK_THEME_SETTINGS };
    private measureCanvas: HTMLCanvasElement | null = null;

    constructor(root: HTMLElement) {
        this.root = root;

        // Ensure stored settings are loaded
        this.stylesheetDefaults = this.readDefaultsFromStylesheet();
        const stored = this.readStoredSettings();
        this.currentSettings = {
            ...this.stylesheetDefaults,
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
            this.applyTokenToEditor(token, value);
        });
    }

    private applyTokenToEditor(token: string, value: string): void {
        this.root.style.setProperty(`--${token}`, value);
        if (token === "tm-font-mono") {
            this.root.style.setProperty("--font-code", value);
        }
    }

    private reset(): void {
        this.currentSettings = { ...this.stylesheetDefaults };
        this.applyStateToEditor(this.currentSettings);
        this.syncStateToInputs();
        this.refreshAllFontFeedback();
        this.persistSettings();
    }

    private updateInput(event: Event): void {
        const input = event.target as HTMLInputElement;
        const token = input.dataset.tmToken;
        if (!token) return;

        const rawValue = input.value.trim();
        const nextValue = COLOR_TOKENS.has(token)
            ? (this.normalizeColorValue(rawValue) ?? this.currentSettings[token] ?? this.stylesheetDefaults[token] ?? "")
            : rawValue;

        this.currentSettings[token] = nextValue;
        this.applyTokenToEditor(token, this.currentSettings[token]);
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
        this.renderHighlightColorNodes();
        this.syncStateToInputs();

        const isDarkMode = document.documentElement.classList.contains("dark-mode");
        const splitControls = this.overlay?.querySelectorAll<HTMLElement>(".color-split") ?? [];
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

    private renderHighlightColorNodes(): void {
        const grid = this.overlay?.querySelector<HTMLElement>(".settings-grid");
        if (!grid) {
            return;
        }

        grid.replaceChildren();

        HIGHLIGHT_COLOR_TYPES.forEach((type) => {
            const row = document.createElement("label");
            row.className = "setting-row";

            const title = document.createElement("span");
            title.className = "text-muted text-small";
            title.textContent = toReadableLabel(type);
            row.appendChild(title);

            const split = document.createElement("div");
            split.className = "color-split";
            split.title = "Left = Light, Right = Dark";
            split.appendChild(this.createColorHalfWrap(type, false));
            split.appendChild(this.createColorHalfWrap(type, true));
            row.appendChild(split);

            grid.appendChild(row);
        });
    }

    private createColorHalfWrap(type: string, isDark: boolean): HTMLElement {
        const variant = isDark ? "dark" : "light";

        const wrap = document.createElement("label");
        wrap.className = "color-half-wrap";
        wrap.dataset.themeVariant = variant;

        const badge = document.createElement("span");
        badge.className = "color-badge";
        badge.textContent = isDark ? "D" : "L";
        wrap.appendChild(badge);

        const input = document.createElement("input");
        input.className = "color-half";
        input.type = "color";
        input.dataset.themeVariant = variant;
        input.dataset.tmToken = toThemeToken(type, isDark);
        input.setAttribute("aria-label", `${toReadableLabel(type)} ${variant} color`);
        wrap.appendChild(input);

        return wrap;
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
            if (input.type === "color") {
                input.value = this.normalizeColorValue(value) ?? this.normalizeColorValue(this.stylesheetDefaults[token]) ?? "#000000";
                return;
            }
            input.value = value;
        });

        this.refreshAllFontFeedback();
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

        const wrapper = input.closest(".setting-row");
        if (!wrapper) {
            return;
        }

        const statusElement = wrapper.querySelector<HTMLElement>(".font-status");
        const previewElement = wrapper.querySelector<HTMLElement>(".font-preview");
        const probesElement = wrapper.querySelector<HTMLElement>(".font-probes");

        const rawFontStack = input.value.trim();
        const candidates = this.splitFontFamilyList(rawFontStack);
        const firstRequested = candidates[0] ?? "";

        if (previewElement) {
            previewElement.style.fontFamily = rawFontStack || this.currentSettings[token] || this.stylesheetDefaults[token] || FALLBACK_THEME_SETTINGS[token] || "";
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
            if (!firstRequested) {
                statusElement.className = "font-status text-small text-muted";
                statusElement.textContent = "Type a font name or stack (for example: Inter, Segoe UI, sans-serif).";
            } else {
                statusElement.className = firstExistingFontName !== ""
                    ? "font-status text-small text-pos"
                    : "font-status text-small text-warn";
                statusElement.textContent = `First available font from stack: ${firstExistingFontName || "generic (available not detected)"}.`;
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
        if (!fontCandidates.length) {
            return firstExistingFontName;
        }

        probesElement.innerHTML = "";
        const grouped = new Map<string, Array<{ fontName: string; className: string; sampleFamily: string }>>();

        fontCandidates.forEach((fontName) => {
            const cleanName = this.cleanFontCandidate(fontName);
            if (!cleanName) {
                return;
            }
            const signal = this.getFontDistinctSignal(cleanName);
            if (signal.label !== "available") {
                return;
            }
            if (!firstExistingFontName) {
                firstExistingFontName = cleanName;
            }

            const available = grouped.get(signal.label) ?? [];
            available.push({
                fontName: cleanName,
                className: signal.className,
                sampleFamily: `"${cleanName}"`,
            });
            grouped.set(signal.label, available);
        });

        const sampleText = fallbackFamily === "monospace"
            ? "AaBb 0O1l {}[] () => +-*/ #_"
            : "The quick brown fox jumps over the lazy dog 1234567890.";
        grouped.forEach((items, groupLabel) => {
            const group = this.generateProbeGroup(groupLabel, sampleText, items);
            probesElement.appendChild(group);
        });

        return firstExistingFontName;
    }

    private generateProbeGroup(
        label: string,
        sampleText: string,
        items: { fontName: string; className: string; sampleFamily: string }[]
    ): HTMLElement {
        const group = document.createElement("div");
        group.className = "probe-group";

        const title = document.createElement("div");
        title.className = "probe-title text-small";
        title.textContent = label;
        group.appendChild(title);

        const list = document.createElement("div");
        list.className = "probe-list";

        items.forEach((item) => {
            const row = this.generateProbeRow(item, sampleText);
            list.appendChild(row);
        });
        group.appendChild(list);
        return group;
    }

    private generateProbeRow(
        item: { fontName: string; className: string; sampleFamily: string },
        text: string
    ): HTMLElement {
        const row = document.createElement("div");
        row.className = `probe-row ${item.className}`;

        const name = document.createElement("span");
        name.className = "probe-name";
        name.textContent = `${item.fontName}: `;
        row.appendChild(name);

        const sample = document.createElement("span");
        sample.className = "probe-sample";
        sample.style.fontFamily = item.sampleFamily;
        sample.textContent = text;
        row.appendChild(sample);
        return row;
    }

    private getFontDistinctSignal(
        fontName: string,
    ): { label: string; className: string; } {
        // Generic is not the name of the font
        if (TinymistThemeSettings.GENERIC_FONT_FAMILIES.has(fontName.toLowerCase())) {
            return { label: "generic", className: "is-generic" };
        }
        // In case it works in some environments or will work in the future
        const available = this.checkFontAvailability(fontName);
        if (available === false) {
            return { label: "not found", className: "is-missing" };
        }

        if (this.runDualBaselineFontTest(fontName)) {
            return { label: "available", className: "is-distinct" };
        }

        return { label: "not rendering", className: "is-unknown" };
    }

    /** If in both cases returned signature is the same, and we know that checker fonts are different
     * then we know that the engine didn't fall back to the checker fonts and fontName is rendering.
    */
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
        if (!document.fonts?.check) {
            return null;
        }
        const normalized = this.cleanFontCandidate(fontCandidate);
        if (!normalized) {
            return false;
        }
        if (TinymistThemeSettings.GENERIC_FONT_FAMILIES.has(normalized.toLowerCase())) {
            return true;
        }
        const escaped = normalized.replace(/"/g, '\\"');
        return document.fonts.check(`16px "${escaped}"`);
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

    private readDefaultsFromStylesheet(): ThemeSettingValues {
        const computedRootStyle = getComputedStyle(this.root);
        const defaults: ThemeSettingValues = {};

        THEME_TOKENS.forEach((token) => {
            let value = computedRootStyle.getPropertyValue(`--${token}`).trim();

            if (!value && token === "tm-font-mono") {
                const computedCodeFont = this.readComputedCodeFont();
                if (computedCodeFont) {
                    value = computedCodeFont;
                }
            }

            if (!value && token === "tm-font-ui") {
                const computedUiFont = this.readComputedUiFont();
                if (computedUiFont) {
                    value = computedUiFont;
                }
            }

            if (COLOR_TOKENS.has(token)) {
                value = this.normalizeColorValue(value)
                    ?? this.readComputedHighlightColor(token)
                    ?? FALLBACK_THEME_SETTINGS[token]
                    ?? "";
            }

            defaults[token] = value || FALLBACK_THEME_SETTINGS[token] || "";
        });

        return defaults;
    }

    private readComputedHighlightColor(token: string): string | null {
        const type = token.replace(/^tm-hlt-/, "").replace(/-dark$/, "");
        const probe = document.createElement("span");
        probe.className = `tm-hlt tm-hlt-${type}`;
        probe.textContent = "x";
        probe.style.position = "absolute";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.inset = "0";
        this.root.appendChild(probe);

        const color = getComputedStyle(probe).color;
        probe.remove();
        return this.normalizeColorValue(color);
    }

    private readComputedCodeFont(): string {
        const editorLine = this.root.querySelector<HTMLElement>(".cm-editor .cm-line, .cm-editor .cm-gutter");
        if (editorLine) {
            return getComputedStyle(editorLine).fontFamily.trim();
        }

        return getComputedStyle(this.root).getPropertyValue("--font-code").trim();
    }

    private readComputedUiFont(): string {
        const previewPane = this.root.querySelector<HTMLElement>(".tinymist-preview-pane");
        if (!previewPane) {
            return "";
        }

        return getComputedStyle(previewPane).fontFamily.trim();
    }

    private normalizeColorValue(value: string): string | null {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }

        const hex = trimmed.match(/^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i);
        if (hex) {
            const normalized = hex[1].toLowerCase();
            if (normalized.length === 3) {
                return `#${normalized.split("").map((char) => `${char}${char}`).join("")}`;
            }
            if (normalized.length === 8) {
                return `#${normalized.slice(0, 6)}`;
            }
            return `#${normalized}`;
        }

        const rgb = trimmed.match(/^rgba?\(([^)]+)\)$/i);
        if (!rgb) {
            return null;
        }

        const channels = rgb[1].split(",").slice(0, 3).map((part) => Number.parseFloat(part.trim()));
        if (channels.length !== 3 || channels.some((value) => Number.isNaN(value))) {
            return null;
        }

        const [red, green, blue] = channels.map((channel) => Math.max(0, Math.min(255, Math.round(channel))));
        return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    }
}
