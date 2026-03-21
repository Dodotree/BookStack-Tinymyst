export const tmSelectors: Record<string, string> = {
    Root: "#tinymist-editor",
    FileDropDown: ".tinymist-file-select",

	ActionButton: "button[data-action]",

	EditorPane: ".tinymist-editor-pane",
    TextArea: "#tinymist-editor-input",
    ImageView: ".tinymist-editor-image-view",
    Image: ".tinymist-editor-image",
    ImageMessage: ".tinymist-editor-image-message",

    ConsolePanel: "#tinymist-console-panel",
    ConsoleContent: ".tinymist-console-content",

	ThemeSettingsOverlay: ".tinymist-theme-settings-overlay",
	ThemeColorSplit: ".color-split",
	ThemeCloseButton: 'button[data-action="closeThemeSettings"]',
	ThemeTokenInputs: "[data-tm-token]",
	ThemeResetButton: 'button[data-action="resetThemeSettings"]',
	ThemeSettingsGrid: ".settings-grid",
	ThemeFontTextInputs: 'input[type="text"][data-tm-token]',
	ThemeSettingRow: ".setting-row",
	ThemeFontStatus: ".font-status",
	ThemeFontPreview: ".font-preview",
	ThemeFontProbes: ".font-probes",
	ThemeEditorLineOrGutter: ".cm-editor .cm-line, .cm-editor .cm-gutter",

	SearchPanel: ".tinymist-search-panel",
	SearchInput: 'input[data-tm-search="query"]',
	SearchReplaceInput: 'input[data-tm-search="replace"]',
	SearchMatchCount: ".tinymist-search-count",
	SearchReplaceRow: ".tinymist-search-replace-row",
	SearchReplaceToggle: 'button[data-tm-search-action="toggleReplace"]',

	PreviewPane: ".tinymist-preview-pane",
    PreviewContent: ".tinymist-preview-content",
	PreviewMutedMessage: ".text-muted.p-m",
	PreviewError: ".tinymist-error",
	PreviewDocumentHost: ".tinymist-document",
	PreviewModeSelect: 'select[data-action="previewModeSelect"]',
	PreviewPdfFrame: '.tinymist-preview-pdf-frame',
	PreviewPan: 'button[data-action="previewPanToggle"]',
	PreviewCursorSpotlight:
		'button[data-action="previewCursorSpotlightToggle"]',
	PreviewScrollIntoView:
		'button[data-action="previewScrollIntoViewToggle"]',
};

export const tmClassNames: Record<string, string> = {
	EditorPane: "tinymist-editor-pane",
	ConsoleCollapsed: "tinymist-console-collapsed",
    TokenHighlight: "tm-hlt", // plus "tm-hlt-{type}" "tm-mod-{modifier}"
    TokenTypePrefix: "tm-hlt-",
    TokenModPrefix: "tm-mod-",

	PreviewPane: "tinymist-preview-pane",
	PreviewError: "tinymist-error",
	PreviewDocumentHost: "tinymist-document", // svgHost div
    PreviewCursorOverlay: "tinymist-cursor-overlay",
    PreviewPanEnabled: "tinymist-preview-pan-enabled",
    PreviewPanning: "tinymist-preview-panning",

    ConsoleMessage: "console-message", //plus "error" | "warning" | "info" | "success" | "hint"

	ThemeSettingsOverlay: "tinymist-theme-settings-overlay",
    ThemeVisible: "is-visible",
	ThemeColorSplit: "color-split",
    ColorHalfWrap: "color-half-wrap",
    ColorHalf: "color-half",
    ColorBadge: "color-badge",
	ThemeSettingsGrid: "settings-grid",
	ThemeSettingRow: "setting-row",
	ThemeFontStatus: "font-status",
	ThemeFontPreview: "font-preview",
	ThemeFontProbes: "font-probes",
    SearchPanel: "tinymist-search-panel",
    SearchVisible: "is-visible",
    ProbeGroup: "probe-group",
    ProbeTitle: "probe-title",
    ProbeList: "probe-list",
    ProbeRow: "probe-row",
    ProbeName: "probe-name",
    ProbeSample: "probe-sample",
};

// other classes: "text-muted", "p-m", "text-small", "aria-hidden", "aria-expanded"
