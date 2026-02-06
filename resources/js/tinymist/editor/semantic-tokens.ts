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

// Styling is provided via CSS classes (tinymist-highlight-* and tinymist-mod-*)
// Keep token keys to validate CSS coverage.
const highlightColors = [
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

// StateEffect to add highlights
const addHighlightsEffect = StateEffect.define<HighlightRegion[]>();
const replaceHighlightsEffect = StateEffect.define<{ from: number; to: number; regions: HighlightRegion[] }>();

// StateEffect to clear highlights
const clearHighlightsEffect = StateEffect.define();

type SemanticTokensDeltaEdit = { start: number; deleteCount: number; data?: number[] };

type DecorationEntry = { from: number; to: number; mark: Decoration };

function buildDecorationEntries(
    regions: HighlightRegion[],
    doc: EditorView["state"]["doc"]
): DecorationEntry[] {
    const entries: Array<{ from: number; to: number; mark: Decoration; region: HighlightRegion }> = [];

    for (const region of regions) {
        try {
            const lineNum = Math.max(0, region.line - 1); // 1-based-line to zero-based-line
            if (lineNum >= doc.lines) continue;

            const line = doc.line(lineNum + 1); // EditorState.line is 1-based
            const from = line.from + region.start;
            const to = Math.min(line.to, from + region.len);

            if (from < to && from >= 0 && to <= doc.length) {
                const classNames = [
                    "tinymist-highlight",
                    `tinymist-highlight-${region.type}`,
                    ...(region.modifiers ?? []).map((modifier) => `tinymist-mod-${modifier}`),
                ].join(" ");
                const mark = Decoration.mark({
                    class: classNames,
                });
                entries.push({ from, to, mark, region });
            }
        } catch (e) {
            console.warn("[Highlight] Failed to add highlight:", region, e);
        }
    }

    return entries
        .sort((a, b) => (a.from - b.from) || (a.to - b.to))
        .map(({ from, to, mark }) => ({ from, to, mark }));
}


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
                const entries = buildDecorationEntries(effect.value, doc);
                entries.forEach(({ from, to, mark }) => builder.add(from, to, mark));
                highlights = builder.finish();
            } else if (effect.is(replaceHighlightsEffect)) {
                const builder = new RangeSetBuilder<Decoration>();
                const doc = tr.state.doc;
                const { from, to, regions } = effect.value;
                const entries: DecorationEntry[] = [];

                highlights.between(0, doc.length, (decFrom, decTo, value) => {
                    if (decTo <= from || decFrom >= to) {
                        entries.push({ from: decFrom, to: decTo, mark: value });
                    }
                });

                entries.push(...buildDecorationEntries(regions, doc));
                entries
                    .sort((a, b) => (a.from - b.from) || (a.to - b.to))
                    .forEach(({ from, to, mark }) => builder.add(from, to, mark));
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
    private encodedTokens: number[] | null = null;
    private lineSignatures: Map<number, string> = new Map();
    private currentResultId: string | null = null;

    constructor(editorView: EditorView | null = null) {
        this.editorView = editorView;

        this.processSemanticTokens = this.processSemanticTokens.bind(this);
        this.processSemanticTokensDelta = this.processSemanticTokensDelta.bind(this);
        window.$events.listen("tinymist-lsp-semantic-tokens", this.processSemanticTokens);
        window.$events.listen("tinymist-lsp-semantic-tokens-delta", this.processSemanticTokensDelta);
    }

    attachEditorView(view: EditorView): void {
        this.editorView = view;
        this.flushPendingHighlights();
    }

    detachEditorView(): void {
        this.editorView = null;
    }

    processSemanticTokens(
        payload: number[] | { tokens: number[]; resultId?: string }
    ) {
        const tokens = Array.isArray(payload) ? payload : payload.tokens;
        if (!Array.isArray(tokens)) {
            return;
        }
        const highlights = this.buildHighlights(tokens);
        this.encodedTokens = tokens.slice();
        this.lineSignatures = this.buildLineSignatures(highlights);
        this.currentResultId = Array.isArray(payload) ? null : payload.resultId ?? null;
        this.renderSemanticHighlights(highlights);
    }

    processSemanticTokensDelta(payload: {
        edits: SemanticTokensDeltaEdit[];
        resultId?: string;
        previousResultId?: string;
    }) {
        if (!payload || !Array.isArray(payload.edits) || !this.encodedTokens) {
            return;
        }

        if (payload.previousResultId && this.currentResultId && payload.previousResultId !== this.currentResultId) {
            console.warn("[Semantic Tokens] Delta resultId mismatch", {
                expected: this.currentResultId,
                received: payload.previousResultId,
            });
            return;
        }

        const updatedTokens = this.applySemanticTokensEdits(this.encodedTokens, payload.edits);
        const highlights = this.buildHighlights(updatedTokens);
        const nextSignatures = this.buildLineSignatures(highlights);
        const changedLines = this.getChangedLines(this.lineSignatures, nextSignatures);

        this.encodedTokens = updatedTokens;
        this.lineSignatures = nextSignatures;
        this.currentResultId = payload.resultId ?? this.currentResultId;

        if (!changedLines.length) {
            return;
        }

        if (!this.editorView) {
            this.pendingSemanticHighlights = highlights;
            return;
        }

        this.replaceHighlightsForLines(highlights, changedLines);
    }

    private resolveSemanticTokenType(tokenType: string): string | null {

        if (!tokenType || tokenType === "text") {
            return null;
        }
        if (tokenType === "identifier") {
            return "variable";
        }
        if (highlightColors.includes(tokenType)) {
            return tokenType;
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

    private replaceHighlightsForLines(highlights: HighlightRegion[], lines: number[]): void {
        if (!this.editorView) {
            return;
        }

        const doc = this.editorView.state.doc;
        const regionsByLine = this.groupRegionsByLine(highlights);
        const sortedLines = [...lines].sort((a, b) => a - b);

        let rangeStart = sortedLines[0];
        let prev = sortedLines[0];

        const flushRange = (startLine: number, endLine: number) => {
            const from = doc.line(startLine).from;
            const to = doc.line(endLine).to;
            const regions: HighlightRegion[] = [];
            for (let line = startLine; line <= endLine; line++) {
                const lineRegions = regionsByLine.get(line);
                if (lineRegions) {
                    regions.push(...lineRegions);
                }
            }
            this.editorView!.dispatch({
                effects: replaceHighlightsEffect.of({ from, to, regions }),
            });
        };

        for (let i = 1; i < sortedLines.length; i++) {
            const line = sortedLines[i];
            if (line === prev + 1) {
                prev = line;
                continue;
            }

            flushRange(rangeStart, prev);
            rangeStart = line;
            prev = line;
        }

        flushRange(rangeStart, prev);
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
     * Applied to semantic tokens in LSP delta format: { start, deleteCount, data? }
     * to the saved version of (undecoded) token array to produce an updated token array
     * @param prev
     * @param edits
     * @returns
     */
    applySemanticTokensEdits(prev: number[], edits: SemanticTokensDeltaEdit[]): number[] {
        // Edits are in ascending order of start per LSP spec.
        let result = prev.slice();
        let offset = 0;

        for (const e of edits) {
            const insert = e.data ?? [];
            result.splice(e.start + offset, e.deleteCount, ...insert);
            offset += insert.length - e.deleteCount;
        }

        return result;
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
            if (deltaLine === 0) { // Another token on the same line, update start char
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

    private buildHighlights(tokens: number[]): HighlightRegion[] {
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

        return highlights;
    }

    private buildLineSignatures(highlights: HighlightRegion[]): Map<number, string> {
        const lineMap = this.groupRegionsByLine(highlights);
        const signatures = new Map<number, string>();
        for (const [line, regions] of lineMap.entries()) {
            const signature = regions
                .map((region) => [
                    region.start,
                    region.len,
                    region.type,
                    ...(region.modifiers ?? []),
                ].join(":"))
                .join("|");
            signatures.set(line, signature);
        }
        return signatures;
    }

    private getChangedLines(
        previous: Map<number, string>,
        next: Map<number, string>
    ): number[] {
        const lines = new Set<number>();
        for (const [line, signature] of previous.entries()) {
            if (next.get(line) !== signature) {
                lines.add(line);
            }
        }
        for (const [line, signature] of next.entries()) {
            if (previous.get(line) !== signature) {
                lines.add(line);
            }
        }
        return [...lines].sort((a, b) => a - b);
    }

    private groupRegionsByLine(highlights: HighlightRegion[]): Map<number, HighlightRegion[]> {
        const lineMap = new Map<number, HighlightRegion[]>();
        for (const region of highlights) {
            const list = lineMap.get(region.line);
            if (list) {
                list.push(region);
            } else {
                lineMap.set(region.line, [region]);
            }
        }
        return lineMap;
    }
}
