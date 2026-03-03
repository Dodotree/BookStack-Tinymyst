export const tmSelectors = {
	ActionButton: "button[data-action]",

	EditorPane: ".tinymist-editor-pane",

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

	PreviewPane: ".tinymist-preview-pane",
	PreviewMutedMessage: ".text-muted.p-m",
	PreviewError: ".tinymist-error",
	PreviewDocumentHost: ".tinymist-document",
	PreviewPanToggleButton: 'button[data-action="previewPanToggle"]',
	PreviewCursorSpotlightToggleButton:
		'button[data-action="previewCursorSpotlightToggle"]',
	PreviewScrollIntoViewToggleButton:
		'button[data-action="previewScrollIntoViewToggle"]',
};

export const tmClassNames = {
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
    ProbeGroup: "probe-group",
    ProbeTitle: "probe-title",
    ProbeList: "probe-list",
    ProbeRow: "probe-row",
    ProbeName: "probe-name",
    ProbeSample: "probe-sample",
};
