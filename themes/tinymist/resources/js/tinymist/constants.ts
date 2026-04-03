export { tmEvents } from "./constants/custom-events";
export type {
    TinymistConsoleLocation,
    SemanticTokensDeltaEdit,
    DiagnosticsPayload,
} from "./constants/custom-events";

export {
    THEME_SETTINGS_STORAGE_KEY,
    THEME_FONT_TOKENS,
    THEME_FONT_SIZE_TOKENS,
    THEME_FALLBACK_SETTINGS,
    THEME_COLOR_SPLIT_TITLE,
    THEME_COLOR_INPUT_DEFAULT,
    THEME_FONT_PREVIEW_TEXT,
    THEME_FONT_STATUS_EMPTY_HINT,
    LIGHT_OWNER_CURSOR_COLOR,
    LIGHT_UNKNOWN_CURSOR_COLOR,
    LIGHT_REMOTE_CURSOR_COLORS,
    DARK_OWNER_CURSOR_COLOR,
    DARK_UNKNOWN_CURSOR_COLOR,
    DARK_REMOTE_CURSOR_COLORS,
} from "./constants/theme-settings";

export {
    PREVIEW_SETTINGS_STORAGE_KEY,
    PREVIEW_FALLBACK_SETTINGS,
} from "./constants/preview-settings";

export {
    DEFAULT_WS_TIMINGS,
    LOCAL_WS_HOSTNAMES,
    SYNC_AND_LSP_URI,
    SYNC_AND_LSP_PORT,
    SYNC_AND_LSP_STATUS_KEY,
    PREVIEW_URI,
    PREVIEW_PORT,
    PREVIEW_STATUS_KEY,
} from "./constants/ws-constants";

export { tmSelectors, tmClassNames } from "./constants/ui-selectors";

export {
    TOKEN_TYPES,
    TOKEN_MODIFIERS,
    HIGHLIGHT_COLORS,
} from "./constants/semantic-tokens";

export const ENTRY_FILE_NAME = "entry.typ";

export const FALLBACK_COMPILE_URL = "/ajax/tinymist/compile";
export const AUTH_TOKEN_RENEWAL_URL = "/ajax/tinymist/renew-ws-token";
