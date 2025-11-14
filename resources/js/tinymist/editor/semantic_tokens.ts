// Semantic tokens in encoded format come from LSP server
// They are not pushed from LSP server automatically, so they have to be requested
// Preview server will request them after new/diff-v1 updates received

// This module decodes tokens into ranges with types and modifiers
// and applies syntax highlighting in the editor

import { EditorView, Decoration, DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";

// Highlight region interface
interface HighlightRegion {
    line: number; // 1-based line number
    start: number; // Character offset in line
    len: number; // Length of highlight
    type: string; // Highlight type (math, string, comment, etc.)
    modifiers?: string[]; // Optional modifiers (strong, emph, etc.)
}

// Arrays needed to decode semantic tokens coming from LSP server init response
// Get token legend from server capabilities
// const tokenLegend = initResult.capabilities.semanticTokensProvider?.legend;
// const tokenTypes = tokenLegend?.tokenTypes || [];
// const tokenModifiers = tokenLegend?.tokenModifiers || [];
const tokenTypes = [
    "comment", "string", "keyword", "operator", "number",
    "function", "decorator", "type", "namespace", "bool",
    "punct", "escape", "link", "raw", "label", "ref",
    "heading", "marker", "term", "delim", "pol", "error", "text"
];
const tokenModifiers = [
    "strong", "emph", "math", "readonly", "static", "defaultLibrary"
];

// Color mapping for highlight types (text colors, not backgrounds)
const highlightColors: Record<string, string> = {
    math: "#5DADE2", // Light blue for math
    string: "#52BE80", // Green for strings
    comment: "#808080", // Gray for comments
    keyword: "#BB8FCE", // Purple for keywords
    operator: "#E06C75", // Red for operators
    number: "#D6863E", // Brown for numbers
    function: "#5DADE2", // Blue for functions
    method: "#5DADE2", // Blue for methods
    macro: "#5DADE2", // Blue for macros
    decorator: "#5DADE2", // Blue for decorators
    type: "#56B6C2", // Cyan for types
    class: "#56B6C2", // Cyan for classes
    enum: "#56B6C2", // Cyan for enums
    interface: "#56B6C2", // Cyan for interfaces
    struct: "#56B6C2", // Cyan for structs
    typeParameter: "#56B6C2", // Cyan for generic parameters
    namespace: "#56B6C2", // Cyan for namespaces
    variable: "#E5C07B", // Yellow for variables
    property: "#E5C07B", // Yellow for properties
    enumMember: "#E5C07B", // Yellow for enum members
    parameter: "#E5C07B", // Yellow for parameters
    punct: "#D19A66", // Orange for punctuation
    bool: "#C678DD", // Pink for booleans
    escape: "#E06C75", // Red for escape sequences
    link: "#61AFEF", // Light blue for links
    raw: "#E06C75", // Red for raw
    label: "#E5C07B", // Yellow for labels
    ref: "#61AFEF", // Light blue for references
    heading: "#61AFEF", // Light blue for headings
    marker: "#E06C75", // Red for list markers
    term: "#E5C07B", // Yellow for list terms
    delim: "#D19A66", // Orange for delimiters
    pol: "#C678DD", // Pink for list interpolations
    error: "#E74C3C", // Red for errors
    text: "#FFFFFF", // White for normal text
};

const tokenModifierStyles: Record<string, string> = {
    strong: "font-weight: bold;",
    emph: "font-style: italic;",
    math: "background-color: #0b3049ff;",
    readonly: "pointer-events: none; opacity: 0.6;",
    static: "background-color: #333355;",
    defaultLibrary: "background-color: #333333;"
};

// StateEffect to add highlights
const addHighlightsEffect = StateEffect.define<HighlightRegion[]>();

// StateEffect to clear highlights
const clearHighlightsEffect = StateEffect.define();

// StateField to store highlight decorations
export const highlightField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(highlights, tr) {
        // Map existing highlights through document changes
        highlights = highlights.map(tr.changes);

        for (const effect of tr.effects) {
            if (effect.is(clearHighlightsEffect)) {
                highlights = Decoration.none;
            } else if (effect.is(addHighlightsEffect)) {
                const builder = new RangeSetBuilder<Decoration>();
                const doc = tr.state.doc;

                for (const region of effect.value) {
                    try {
                        // Convert 1-based line to 0-based
                        const lineNum = Math.max(0, region.line - 1);
                        if (lineNum >= doc.lines) continue;

                        const line = doc.line(lineNum + 1); // doc.line is 1-based
                        const from = line.from + region.start;
                        const to = Math.min(line.to, from + region.len);

                        if (from < to && from >= 0 && to <= doc.length) {
                            const color = highlightColors[region.type] || "#FFD700";
                            const baseStyle = `color: ${color};`;
                            const modifierStyle = (region.modifiers ?? [])
                                .map((modifier) => tokenModifierStyles[modifier])
                                .filter((style): style is string => Boolean(style?.trim()))
                                .join(" ");
                            const combinedStyle = modifierStyle
                                ? `${baseStyle} ${modifierStyle}`
                                : baseStyle;
                            const classNames = [
                                "tinymist-highlight",
                                `tinymist-highlight-${region.type}`,
                                ...(region.modifiers ?? []).map((modifier) => `tinymist-mod-${modifier}`),
                            ].join(" ");
                            const mark = Decoration.mark({
                                class: classNames,
                                attributes: { style: combinedStyle },
                            });
                            builder.add(from, to, mark);
                        }
                    } catch (e) {
                        console.warn("[Highlight] Failed to add highlight:", region, e);
                    }
                }

                highlights = builder.finish();
            }
        }

        return highlights;
    },
    provide: (f) => EditorView.decorations.from(f),
});

export class SemanticTokenProcessor {
    private editorView: EditorView | null;
    private pendingSemanticHighlights: HighlightRegion[] | null = null;

    constructor(editorView: EditorView | null = null) {
        this.editorView = editorView;
    }

    attachEditorView(view: EditorView): void {
        this.editorView = view;
        this.flushPendingHighlights();
    }

    detachEditorView(): void {
        this.editorView = null;
    }

    processSemanticTokens(
        tokens: number[]
    ) {
        if (!Array.isArray(tokens)) {
            return;
        }

        const highlights: HighlightRegion[] = [];
        const decodedTokens = this.decodeSemanticTokens(tokens);

        for (const token of decodedTokens) {
            if (!token) {
                continue;
            }

            const { line, start, len, type, modifiers } = token;

            if (
                typeof line !== "number" ||
                typeof start !== "number" ||
                typeof len !== "number" ||
                !Number.isFinite(len) ||
                len <= 0
            ) {
                console.warn("[Semantic Tokens] Invalid token data:", token);
                continue;
            }

            const resolvedType = this.resolveSemanticTokenType(type);
            if (!resolvedType) {
                // Ignored "text" type or unresolvable type
                continue;
            }

            highlights.push({
                line: line + 1,
                start,
                len,
                type: resolvedType,
                modifiers: Array.isArray(modifiers) && modifiers.length
                    ? [...new Set(
                        modifiers.filter(
                            (modifier): modifier is string =>
                                typeof modifier === "string" && modifier.length > 0
                        )
                    )]
                    : undefined,
            });
        }

        this.renderSemanticHighlights(highlights);
    }

    private resolveSemanticTokenType(tokenType: string): string | null {

        if (!tokenType) {
            return null;
        }

        if (tokenType === "text") {
            return null;
        }

        if (highlightColors[tokenType]) {
            return tokenType;
        }

        if (tokenType === "identifier" && highlightColors["variable"]) {
            return "variable";
        }

        return null;
    }

    private renderSemanticHighlights(highlights: HighlightRegion[]): void {
        if (!this.editorView) {
            this.pendingSemanticHighlights = highlights;
            return;
        }

        this.pendingSemanticHighlights = null;

        if (!highlights.length) {
            this.clearHighlights();
            return;
        }

        this.addHighlights(highlights);
    }

    flushPendingHighlights(): void {
        if (!this.editorView) {
            return;
        }

        if (this.pendingSemanticHighlights === null) {
            return;
        }

        const highlights = this.pendingSemanticHighlights;
        this.pendingSemanticHighlights = null;

        if (!highlights.length) {
            // not sure if we should allow clearing here
            // this.clearHighlights();
            return;
        }

        this.addHighlights(highlights);
    }

    /**
     * Add highlights to the editor
     * @param regions Array of highlight regions
     * Example: addHighlights([{line: 17, start: 0, len: 10, type: "math"}])
     */
    addHighlights(regions: HighlightRegion[]) {
        if (!this.editorView) {
            console.warn("[Highlight] Editor view not available");
            return;
        }

        this.editorView.dispatch({
            effects: addHighlightsEffect.of(regions),
        });
    }

    /**
     * Clear all highlights from the editor
     */
    clearHighlights() {
        if (!this.editorView) {
            this.pendingSemanticHighlights = null;
            return;
        }

        this.editorView.dispatch({
            effects: clearHighlightsEffect.of(null),
        });
    }

    /**
     * Update highlight color mapping
     */
    static setHighlightColor(type: string, color: string) {
        highlightColors[type] = color;
    }

    /**
     * Decode semantic tokens from LSP format
     * The data is encoded as [deltaLine, deltaStartChar, length, tokenType, tokenModifiers]
     */
    decodeSemanticTokens(
        data: number[],
    ): Array<HighlightRegion> {
        const tokens = [];
        let line = 0;
        let startChar = 0;

        for (let i = 0; i < data.length; i += 5) {
            const deltaLine = data[i];
            const deltaStartChar = data[i + 1];
            const length = data[i + 2];
            const tokenType = data[i + 3];
            const tokenModifierBits = data[i + 4];

            // Update position
            line += deltaLine;
            if (deltaLine === 0) {
                startChar += deltaStartChar;
            } else {
                startChar = deltaStartChar;
            }

            // Decode token modifiers from bitmask
            const modifiers: string[] = [];
            for (let j = 0; j < tokenModifiers.length; j++) {
                if (tokenModifierBits & (1 << j)) {
                    modifiers.push(tokenModifiers[j]);
                }
            }

            tokens.push({
                line,
                start: startChar,
                len:length,
                type: tokenTypes[tokenType] || `unknown(${tokenType})`,
                modifiers: modifiers,
            });
        }

        return tokens;
    }
}
