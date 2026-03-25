export const THEME_SETTINGS_STORAGE_KEY = "tinymist-theme-settings-v1";

export const THEME_FONT_TOKENS = ["tm-font-mono", "tm-font-ui"] as const;

export const THEME_FONT_SIZE_TOKENS = [
    "tm-font-size-mono",
    "tm-font-size-ui",
] as const;

export const THEME_FALLBACK_SETTINGS: Record<string, string> = {
    "tm-font-mono": '"Monaco", "Menlo", "Ubuntu Mono", "Consolas", monospace',
    "tm-font-ui": '"-apple-system", BlinkMacSystemFont, "Segoe UI", "Oxygen", "Ubuntu", "Roboto", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
    "tm-font-size-mono": "14px",
    "tm-font-size-ui": "14px",
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

export const THEME_COLOR_SPLIT_TITLE = "Left = Light, Right = Dark";
export const THEME_COLOR_INPUT_DEFAULT = "#000000";

export const THEME_FONT_PREVIEW_TEXT = {
    mono: "Monospace preview: AaBb 0O1l {}[] () => +-*/ #_",
    ui: "UI preview: The quick brown fox jumps over 1234567890.",
};

export const THEME_FONT_STATUS_EMPTY_HINT = "Type a font name or stack (for example: Inter, Segoe UI, sans-serif).";
