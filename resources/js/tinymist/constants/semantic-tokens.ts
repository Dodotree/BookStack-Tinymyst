
// Arrays needed to decode semantic tokens coming from LSP server init response
// Get token legend from server capabilities
// const tokenLegend = initResult.capabilities.semanticTokensProvider?.legend;
// const tokenTypes = tokenLegend?.tokenTypes || [];
// const tokenModifiers = tokenLegend?.tokenModifiers || [];
export const TOKEN_TYPES = [
    "comment", "string", "keyword", "operator", "number",
    "function", "decorator", "type", "namespace", "bool",
    "punct", "escape", "link", "raw", "label", "ref",
    "heading", "marker", "term", "delim", "pol", "error", "text"
];
export const TOKEN_MODIFIERS = [
    "strong", "emph", "math", "readonly", "static", "defaultLibrary"
];

// Styling is provided via CSS classes (tm-hlt-* and tm-mod-*)
// Keep token keys to validate CSS coverage.
export const HIGHLIGHT_COLORS = [
    "math",
    "string",
    "comment",
    "keyword",
    "operator",
    "number",
    "function",
    "method",
    "macro",
    "decorator",
    "type",
    "class",
    "enum",
    "interface",
    "struct",
    "typeParameter",
    "namespace",
    "variable",
    "property",
    "enumMember",
    "parameter",
    "punct",
    "bool",
    "escape",
    "link",
    "raw",
    "label",
    "ref",
    "heading",
    "marker",
    "term",
    "delim",
    "pol",
    "error",
    "text",
];
