import { FontProbe } from "./font-probe";
import {
    THEME_COLOR_INPUT_DEFAULT,
    THEME_COLOR_SPLIT_TITLE,
    THEME_FALLBACK_SETTINGS,
    THEME_FONT_PREVIEW_TEXT,
    THEME_FONT_STATUS_EMPTY_HINT,
    THEME_FONT_TOKENS,
    THEME_FONT_SIZE_TOKENS,
    THEME_SETTINGS_STORAGE_KEY,
    HIGHLIGHT_COLORS,
    tmClassNames,
    tmEvents,
    tmSelectors,
} from "../constants";

type ThemeSettingValues = Record<string, string>;

const toThemeToken = (type: string, isDark = false): string =>
    `${tmClassNames.TokenTypePrefix}${type}${isDark ? "-dark" : ""}`;
const toReadableLabel = (value: string): string =>
    value
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());

const HIGHLIGHT_COLOR_TYPES = HIGHLIGHT_COLORS.filter(
    (type) => type !== "text",
);
const SEMANTIC_HIGHLIGHT_TYPES = new Set<string>(HIGHLIGHT_COLORS);
const HIGHLIGHT_COLOR_TOKENS = HIGHLIGHT_COLOR_TYPES.flatMap((type) => [
    toThemeToken(type, false),
    toThemeToken(type, true),
]);
const THEME_TOKENS = [
    ...THEME_FONT_TOKENS,
    ...THEME_FONT_SIZE_TOKENS,
    ...HIGHLIGHT_COLOR_TOKENS,
];
const FONT_SIZE_TOKENS = new Set<string>(THEME_FONT_SIZE_TOKENS);
const COLOR_TOKENS = new Set(
    THEME_TOKENS.filter((token) => {
        if (!token.startsWith(tmClassNames.TokenTypePrefix)) {
            return false;
        }
        const semanticType = token
            .replace(tmClassNames.TokenTypePrefix, "")
            .replace(/-dark$/, "");
        return SEMANTIC_HIGHLIGHT_TYPES.has(semanticType);
    }),
);

export class TinymistThemeSettings {
    private static readonly FONT_TOKENS = new Set<string>(THEME_FONT_TOKENS);
    private overlay: HTMLElement | null;
    private currentSettings: ThemeSettingValues = {};
    private stylesheetDefaults: ThemeSettingValues = {
        ...THEME_FALLBACK_SETTINGS,
    };
    private listenersBound = false;

    constructor() {
        this.overlay = document.querySelector(
            `${tmSelectors.Root} ${tmSelectors.ThemeSettingsOverlay}`
        );
        if (!this.overlay) {
            return;
        }

        this.updateInput = this.updateInput.bind(this);
        this.reset = this.reset.bind(this);
        this.destroy = this.destroy.bind(this);
        this.closeOverlay = this.closeOverlay.bind(this);
        this.handleThemeSettingsOpen = this.handleThemeSettingsOpen.bind(this);
        this.handleOverlayClick = this.handleOverlayClick.bind(this);
        this.handleWindowKeyUp = this.handleWindowKeyUp.bind(this);

        // One way to open
        window.$tmEventBus.listen(
            tmEvents.ThemeSettingsOpen,
            this.handleThemeSettingsOpen,
        );
        window.$tmEventBus.listen(tmEvents.Destroy, this.destroy);
    }

    // fires only once if the user decides to use settings, so we can delay setup until then
    ensureSettingsLoaded(): void {
        // Ensure stored settings are loaded
        this.stylesheetDefaults = this.readDefaultsFromStylesheet();
        const stored = this.readStoredSettings();
        this.currentSettings = {
            ...this.stylesheetDefaults,
            ...stored,
        };
        this.applyStateToEditor(this.currentSettings);

        this.renderHighlightColorNodes();
        this.syncStateToInputs();

        const isDarkMode =
            document.documentElement.classList.contains("dark-mode");
        const splitControls =
            this.overlay?.querySelectorAll<HTMLElement>(tmSelectors.ThemeColorSplit) ?? [];
        splitControls.forEach((control) => {
            control.dataset.activeTheme = isDarkMode ? "dark" : "light";
        });

        if (this.listenersBound) {
            return;
        }
        this.addRemoveListeners(true);
    }

    addRemoveListeners(adding = true): void {
        if (!this.overlay) {
            return;
        }
        const method = adding ? "addEventListener" : "removeEventListener";

        // Many ways to close
        const closeButtons = this.overlay.querySelectorAll<HTMLButtonElement>(
            tmSelectors.ThemeCloseButton,
        );
        closeButtons.forEach((button) => {
            button[method]("click", this.closeOverlay);
        });
        this.overlay[method]("click", this.handleOverlayClick);
        window[method]("keyup", this.handleWindowKeyUp);

        // add listeners to inputs
        const inputs =
            this.overlay?.querySelectorAll<HTMLInputElement>(
                "[data-tm-token]",
            ) ?? [];
        inputs.forEach((input) => {
            const token = input.dataset.tmToken;
            if (!token) return;
            const eventName =
                input.type === "color" ||
                TinymistThemeSettings.FONT_TOKENS.has(token)
                    ? "input"
                    : "change";
            input[method](eventName, this.updateInput);
        });

        const resetButton =
            this.overlay?.querySelector<HTMLButtonElement>(
                'button[data-action="resetThemeSettings"]',
            ) ?? null;
        resetButton?.[method]("click", this.reset);

        this.listenersBound = adding;
    }

    private applyStateToEditor(settings: ThemeSettingValues): void {
        Object.entries(settings).forEach(([token, value]) => {
            this.applyTokenToEditor(token, value);
        });
    }

    private applyTokenToEditor(token: string, value: string): void {
        const root = document.querySelector<HTMLElement>(tmSelectors.Root);
        root?.style.setProperty(`--${token}`, value);
        if (token === "tm-font-mono") {
            root?.style.setProperty("--font-code", value);
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
            ? (this.normalizeColorValue(rawValue) ??
              this.currentSettings[token] ??
              this.stylesheetDefaults[token] ??
              "")
                        : FONT_SIZE_TOKENS.has(token)
                            ? (this.normalizeFontSizeValue(rawValue) ??
                                this.currentSettings[token] ??
                                this.stylesheetDefaults[token] ??
                                THEME_FALLBACK_SETTINGS[token] ??
                                "")
            : rawValue;

        this.currentSettings[token] = nextValue;
        this.applyTokenToEditor(token, this.currentSettings[token]);
        if (TinymistThemeSettings.FONT_TOKENS.has(token)) {
            this.updateFontInputFeedback(input);
        }
        this.persistSettings();
    }

    private readonly closeOverlay = (): void => {
        if (!this.overlay) return;
        this.overlay.classList.remove(tmClassNames.ThemeVisible);
        this.overlay.hidden = true;
    };

    private readonly handleThemeSettingsOpen = (): void => {
        if (!this.overlay) return;
        this.overlay.hidden = false;
        this.overlay.classList.add(tmClassNames.ThemeVisible);
        this.ensureSettingsLoaded();
    };

    private readonly handleOverlayClick = (event: Event): void => {
        if (event.target === this.overlay) {
            this.closeOverlay();
        }
    };

    private readonly handleWindowKeyUp = (event: Event): void => {
        if (
            (event as KeyboardEvent).key === "Escape" &&
            !!this.overlay &&
            !this.overlay.hidden
        ) {
            this.closeOverlay();
        }
    };

    destroy(): void {
        this.addRemoveListeners(false);
        this.overlay = null;
        this.currentSettings = {};
    }

    private renderHighlightColorNodes(): void {
        const grid = this.overlay?.querySelector<HTMLElement>(".settings-grid");
        if (!grid) {
            return;
        }

        grid.replaceChildren();

        HIGHLIGHT_COLOR_TYPES.forEach((type) => {
            const row = document.createElement("label");
            row.className = tmClassNames.ThemeSettingRow;

            const title = document.createElement("span");
            title.className = "text-muted text-small";
            title.textContent = toReadableLabel(type);
            row.appendChild(title);

            const split = document.createElement("div");
            split.className = tmClassNames.ThemeColorSplit;
            split.title = THEME_COLOR_SPLIT_TITLE;
            split.appendChild(this.createColorHalfWrap(type, false));
            split.appendChild(this.createColorHalfWrap(type, true));
            row.appendChild(split);

            grid.appendChild(row);
        });
    }

    private createColorHalfWrap(type: string, isDark: boolean): HTMLElement {
        const variant = isDark ? "dark" : "light";

        const wrap = document.createElement("label");
        wrap.className = tmClassNames.ColorHalfWrap;
        wrap.dataset.themeVariant = variant;

        const badge = document.createElement("span");
        badge.className = tmClassNames.ColorBadge;
        badge.textContent = isDark ? "D" : "L";
        wrap.appendChild(badge);

        const input = document.createElement("input");
        input.className = tmClassNames.ColorHalf;
        input.type = "color";
        input.dataset.themeVariant = variant;
        input.dataset.tmToken = toThemeToken(type, isDark);
        input.setAttribute(
            "aria-label",
            `${toReadableLabel(type)} ${variant} color`,
        );
        wrap.appendChild(input);

        return wrap;
    }

    private syncStateToInputs(): void {
        const inputs =
            this.overlay?.querySelectorAll<HTMLInputElement>(
                "[data-tm-token]",
            ) ?? [];
        inputs.forEach((input) => {
            const token = input.dataset.tmToken;
            if (!token) return;
            const value = this.currentSettings[token] ?? "";
            if (input.type === "color") {
                input.value =
                    this.normalizeColorValue(value) ??
                    this.normalizeColorValue(this.stylesheetDefaults[token]) ??
                    THEME_COLOR_INPUT_DEFAULT;
                return;
            }
            if (input.type === "number") {
                const normalizedNumber = this.normalizeFontSizeValue(value);
                input.value = normalizedNumber
                    ? String(parseFloat(normalizedNumber))
                    : "";
                return;
            }
            input.value = value;
        });

        this.refreshAllFontFeedback();
    }

    private refreshAllFontFeedback(): void {
        const inputs =
            this.overlay?.querySelectorAll<HTMLInputElement>(
                tmSelectors.ThemeFontTextInputs,
            ) ?? [];
        inputs.forEach((input) => this.updateFontInputFeedback(input));
    }

    private updateFontInputFeedback(input: HTMLInputElement): void {
        const token = input.dataset.tmToken ?? "";
        if (!TinymistThemeSettings.FONT_TOKENS.has(token)) {
            return;
        }

        const wrapper = input.closest(tmSelectors.ThemeSettingRow);
        if (!wrapper) {
            return;
        }

        const statusElement =
            wrapper.querySelector<HTMLElement>(tmSelectors.ThemeFontStatus);
        const previewElement =
            wrapper.querySelector<HTMLElement>(tmSelectors.ThemeFontPreview);
        const probesElement =
            wrapper.querySelector<HTMLElement>(tmSelectors.ThemeFontProbes);

        const rawFontStack = input.value.trim();
        const candidates = FontProbe.splitFontFamilyList(rawFontStack);
        const firstRequested = candidates[0] ?? "";

        if (previewElement) {
            previewElement.style.fontFamily =
                rawFontStack ||
                this.currentSettings[token] ||
                this.stylesheetDefaults[token] ||
                THEME_FALLBACK_SETTINGS[token] ||
                "";
            previewElement.textContent =
                token === "tm-font-mono"
                    ? THEME_FONT_PREVIEW_TEXT.mono
                    : THEME_FONT_PREVIEW_TEXT.ui;
        }

        const computedPreviewFontFamily = previewElement
            ? getComputedStyle(previewElement).fontFamily
            : "";
        const computedCandidates = FontProbe.splitFontFamilyList(
            computedPreviewFontFamily,
        );

        const firstExistingFontName = this.renderFontProbes(
            probesElement,
            computedCandidates,
            token === "tm-font-mono" ? "monospace" : "sans-serif",
        );

        if (statusElement) {
            if (!firstRequested) {
                statusElement.className = `${tmClassNames.ThemeFontStatus} text-small text-muted`;
                statusElement.textContent = THEME_FONT_STATUS_EMPTY_HINT;
            } else {
                statusElement.className =
                    firstExistingFontName !== ""
                        ? `${tmClassNames.ThemeFontStatus} text-small text-pos`
                        : `${tmClassNames.ThemeFontStatus} text-small text-warn`;
                statusElement.textContent = `First available font from stack: ${firstExistingFontName || "generic (available not detected)"}.`;
            }
        }
    }

    private renderFontProbes(
        probesElement: HTMLElement | null,
        fontCandidates: string[],
        fallbackFamily: string,
    ): string {
        let firstExistingFontName = "";

        if (!probesElement) {
            return firstExistingFontName;
        }
        if (!fontCandidates.length) {
            return firstExistingFontName;
        }

        probesElement.innerHTML = "";
        const grouped = new Map<
            string,
            Array<{ fontName: string; className: string; sampleFamily: string }>
        >();

        fontCandidates.forEach((fontName) => {
            const signal = FontProbe.getFontDistinctSignal(fontName);
            if (signal.label !== "available") {
                return;
            }
            if (!firstExistingFontName) {
                firstExistingFontName = fontName;
            }

            const available = grouped.get(signal.label) ?? [];
            available.push({
                fontName: fontName,
                className: signal.className,
                sampleFamily: `"${fontName}"`,
            });
            grouped.set(signal.label, available);
        });

        const sampleText =
            fallbackFamily === "monospace"
                ? "AaBb 0O1l {}[] () => +-*/ #_"
                : "The quick brown fox jumps over the lazy dog 1234567890.";
        grouped.forEach((items, groupLabel) => {
            const group = this.generateProbeGroup(
                groupLabel,
                sampleText,
                items,
            );
            probesElement.appendChild(group);
        });

        return firstExistingFontName;
    }

    private generateProbeGroup(
        label: string,
        sampleText: string,
        items: { fontName: string; className: string; sampleFamily: string }[],
    ): HTMLElement {
        const group = document.createElement("div");
        group.className = tmClassNames.ProbeGroup;

        const title = document.createElement("div");
        title.className = `${tmClassNames.ProbeTitle} text-small`;
        title.textContent = label;
        group.appendChild(title);

        const list = document.createElement("div");
        list.className = tmClassNames.ProbeList;

        items.forEach((item) => {
            const row = this.generateProbeRow(item, sampleText);
            list.appendChild(row);
        });
        group.appendChild(list);
        return group;
    }

    private generateProbeRow(
        item: { fontName: string; className: string; sampleFamily: string },
        text: string,
    ): HTMLElement {
        const row = document.createElement("div");
        row.className = `${tmClassNames.ProbeRow} ${item.className}`;

        const name = document.createElement("span");
        name.className = tmClassNames.ProbeName;
        name.textContent = `${item.fontName}: `;
        row.appendChild(name);

        const sample = document.createElement("span");
        sample.className = tmClassNames.ProbeSample;
        sample.style.fontFamily = item.sampleFamily;
        sample.textContent = text;
        row.appendChild(sample);
        return row;
    }

    private persistSettings(): void {
        try {
            localStorage.setItem(
                THEME_SETTINGS_STORAGE_KEY,
                JSON.stringify(this.currentSettings),
            );
        } catch (error) {
            console.warn(
                "[Tinymist Theme] Failed to store theme settings",
                error,
            );
        }
    }

    private readStoredSettings(): ThemeSettingValues {
        try {
            const raw = localStorage.getItem(THEME_SETTINGS_STORAGE_KEY);
            if (!raw) {
                return {};
            }

            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                return parsed as ThemeSettingValues;
            }
        } catch (error) {
            console.warn(
                "[Tinymist Theme] Failed to read stored theme settings",
                error,
            );
        }

        return {};
    }

    private readDefaultsFromStylesheet(): ThemeSettingValues {
        const root = document.querySelector<HTMLElement>(tmSelectors.Root);
        const computedRootStyle = getComputedStyle(root!);
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
                value =
                    this.normalizeColorValue(value) ??
                    this.readComputedHighlightColor(token) ??
                    THEME_FALLBACK_SETTINGS[token] ??
                    "";
            }

            defaults[token] = value || THEME_FALLBACK_SETTINGS[token] || "";
        });

        return defaults;
    }

    private readComputedHighlightColor(token: string): string | null {
        const type = token
            .replace(tmClassNames.TokenTypePrefix, "")
            .replace(/-dark$/, "");
        const probe = document.createElement("span");
        probe.className = `${tmClassNames.TokenHighlight} ${tmClassNames.TokenTypePrefix}${type}`;
        probe.textContent = "x";
        probe.style.position = "absolute";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.inset = "0";
        document.querySelector<HTMLElement>(tmSelectors.Root)?.appendChild(probe);

        const color = getComputedStyle(probe).color;
        probe.remove();
        return this.normalizeColorValue(color);
    }

    private readComputedCodeFont(): string {
        const root = document.querySelector<HTMLElement>(tmSelectors.Root);
        const editorLine = root?.querySelector<HTMLElement>(
            ".cm-editor .cm-line, .cm-editor .cm-gutter",
        );
        if (editorLine) {
            return getComputedStyle(editorLine).fontFamily.trim();
        }
        return getComputedStyle(root!)
            .getPropertyValue("--font-code")
            .trim();
    }

    private readComputedUiFont(): string {
        const previewPane = document.querySelector<HTMLElement>(
            `${tmSelectors.Root} ${tmSelectors.PreviewPane}`,
        );
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
                return `#${normalized
                    .split("")
                    .map((char) => `${char}${char}`)
                    .join("")}`;
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

        const channels = rgb[1]
            .split(",")
            .slice(0, 3)
            .map((part) => Number.parseFloat(part.trim()));
        if (
            channels.length !== 3 ||
            channels.some((value) => Number.isNaN(value))
        ) {
            return null;
        }

        const [red, green, blue] = channels.map((channel) =>
            Math.max(0, Math.min(255, Math.round(channel))),
        );
        return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    }

    private normalizeFontSizeValue(value: string): string | null {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }

        const parsed = Number.parseFloat(trimmed.replace(/px$/i, "").trim());
        if (Number.isNaN(parsed)) {
            return null;
        }

        const clamped = Math.max(8, Math.min(48, parsed));
        const rounded = Math.round(clamped * 100) / 100;
        return `${rounded}px`;
    }
}
