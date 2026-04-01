// Semantic tokens in encoded format come from LSP server
// They are not pushed from LSP server automatically, so they have to be requested
// Preview server will request them after new/diff-v1 updates received

// This module decodes tokens into ranges with types and modifiers
// and applies syntax highlighting in the editor

import { EditorView, Decoration, DecorationSet } from "@codemirror/view";
import {
    ChangeSet,
    StateEffect,
    StateField,
    RangeSetBuilder,
} from "@codemirror/state";
import {
    ENTRY_FILE_NAME,
    TOKEN_TYPES,
    TOKEN_MODIFIERS,
    HIGHLIGHT_COLORS,
    tmClassNames,
    tmEvents,
    SemanticTokensDeltaEdit,
} from "../constants";

// Highlight region interface
interface HighlightRegion {
    line: number; // 1-based line number
    start: number; // Character offset in line
    len: number; // Length of highlight
    type: string; // Highlight type (math, string, comment, etc.)
    modifiers?: string[]; // Optional modifiers (strong, emph, etc.)
}

// StateEffect to add highlights
const addHighlightsEffect = StateEffect.define<HighlightRegion[]>();
const replaceHighlightsEffect = StateEffect.define<{
    from: number;
    to: number;
    regions: HighlightRegion[];
}>();
// StateEffect to clear highlights
const clearHighlightsEffect = StateEffect.define();

type DecorationEntry = { from: number; to: number; mark: Decoration };

function buildDecorationEntries(
    regions: HighlightRegion[],
    doc: EditorView["state"]["doc"],
): DecorationEntry[] {
    const entries: Array<{
        from: number;
        to: number;
        mark: Decoration;
        region: HighlightRegion;
    }> = [];

    for (const region of regions) {
        try {
            const lineNum = Math.max(0, region.line - 1); // 1-based-line to zero-based-line
            if (lineNum >= doc.lines) continue;

            const line = doc.line(lineNum + 1); // EditorState.line is 1-based
            const from = line.from + region.start;
            const to = Math.min(line.to, from + region.len);

            if (from < to && from >= 0 && to <= doc.length) {
                const classNames = [
                    tmClassNames.TokenHighlight,
                    `${tmClassNames.TokenTypePrefix}${region.type}`,
                    ...(region.modifiers ?? []).map(
                        (modifier) => `${tmClassNames.TokenModPrefix}${modifier}`,
                    ),
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
        .sort((a, b) => a.from - b.from || a.to - b.to)
        .map(({ from, to, mark }) => ({ from, to, mark }));
}

// StateField to store highlight decorations
// highlightField registers the StateField that holds the DecorationSet,
// and SemanticTokenProcessor dispatches effects (addHighlightsEffect, replaceHighlightsEffect, clearHighlightsEffect)
// that update this field.
// Without highlightField in the editor extensions, those effects won’t render any highlights.
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
                entries.forEach(({ from, to, mark }) =>
                    builder.add(from, to, mark),
                );
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
                    .sort((a, b) => a.from - b.from || a.to - b.to)
                    .forEach(({ from, to, mark }) =>
                        builder.add(from, to, mark),
                    );
                highlights = builder.finish();
            }
        }

        return highlights;
    },
    provide: (f) => EditorView.decorations.from(f),
});

export class SemanticTokenProcessor {
    private getEditorView: () => EditorView | null;
    private activeFileName: string = ENTRY_FILE_NAME;

    private encodedTokens: number[] | null = null;
    private lineSignatures: Map<number, string> = new Map();
    private currentResultId: string | null = null;
    private getSnapshotContext: (
        docVersion: number,
        fileName: string,
    ) => { snapshot: string; changeSet: ChangeSet };

    constructor(getEditorView: () => EditorView | null, getSnapshotContext: (
        docVersion: number,
        fileName: string,
    ) => { snapshot: string; changeSet: ChangeSet }) {

        this.getEditorView = getEditorView;
        this.getSnapshotContext = getSnapshotContext;

        this.processSemanticTokens = this.processSemanticTokens.bind(this);
        this.processSemanticTokensDelta =
            this.processSemanticTokensDelta.bind(this);
        window.$tmEventBus.listen(
            tmEvents.LspSemanticTokens,
            this.processSemanticTokens,
        );
        window.$tmEventBus.listen(
            tmEvents.LspSemanticTokensDelta,
            this.processSemanticTokensDelta,
        );
        window.$tmEventBus.listen(
            tmEvents.ActiveFileChange,
            (payload: { fileName: string; url: string }) => {
                this.activeFileName = payload.fileName;
                const editorView = this.getEditorView();
                editorView?.dispatch({
                    effects: clearHighlightsEffect.of(null),
                });
            },
        );
        window.$tmEventBus.listen(
            tmEvents.ResetFile,
            (_payload: { fileName?: string }) => {
                const editorView = this.getEditorView();
                editorView?.dispatch({
                    effects: clearHighlightsEffect.of(null),
                });
            },
        );
        window.$tmEventBus.listen(tmEvents.Destroy, () => {
            this.getSnapshotContext = () => ({
                snapshot: "Destroyed",
                changeSet: ChangeSet.empty(0),
            });
            this.getEditorView = () => null;
            this.encodedTokens = null;
            this.lineSignatures.clear();
        });
    }

    private mapRegionsToCurrent(
        regions: Array<{
            line: number;
            start: number;
            len: number;
            type: string;
            modifiers?: string[];
        }>,
        baseText: string,
        changeSet: ChangeSet,
    ) {
        const editorView = this.getEditorView();
        if (!editorView) {
            return regions;
        }
        const snapshotLineLen = baseText
            .split("\n")
            .map((line) => line.length + 1); // +1 for newline
        const snapshotOffsets = snapshotLineLen.reduce((acc, len, idx) => {
            acc[idx] = (acc[idx - 1] || 0) + len;
            return acc;
        }, [] as number[]);
        const currentDoc = editorView.state.doc;

        return regions.map((region) => {
            const lineIndex = Math.max(0, region.line - 1);
            const lineStart = snapshotOffsets[lineIndex - 1] ?? 0;
            const lineLength = snapshotLineLen[lineIndex] - 1; // -1 to ignore newline here
            const baseStartOffset =
                lineStart + Math.min(region.start, lineLength);
            const baseEndOffset =
                lineStart + Math.min(region.start + region.len, lineLength);

            const mappedStart = changeSet.mapPos(baseStartOffset, 1);
            const mappedEnd = changeSet.mapPos(baseEndOffset, -1);

            const startLineInfo = currentDoc.lineAt(
                Math.min(mappedStart, currentDoc.length),
            );
            const endLineInfo = currentDoc.lineAt(
                Math.min(mappedEnd, currentDoc.length),
            );

            const startChar = Math.max(0, mappedStart - startLineInfo.from);
            const endChar = Math.max(0, mappedEnd - endLineInfo.from);
            const len = Math.max(1, endChar - startChar);

            return {
                line: startLineInfo.number,
                start: startChar,
                len,
                type: region.type,
                modifiers: region.modifiers,
            };
        });
    }

    processSemanticTokens(payload: {
        tokens: number[];
        resultId?: string;
        docVersion: number;
        fileName: string;
    }) {
        if (payload.fileName !== this.activeFileName) {
            return;
        }
        const tokens = Array.isArray(payload) ? payload : payload.tokens;
        const editorView = this.getEditorView();
        if (!Array.isArray(tokens) || !editorView) {
            return;
        }
        const highlights = this.buildHighlights(tokens);
        const snapshotCtx = this.getSnapshotContext(
            payload.docVersion,
            payload.fileName,
        );
        const mappedHighlights = this.mapRegionsToCurrent(
            highlights,
            snapshotCtx.snapshot,
            snapshotCtx.changeSet,
        );

        this.encodedTokens = tokens.slice();
        this.lineSignatures = this.buildLineSignatures(mappedHighlights);
        this.currentResultId = Array.isArray(payload)
            ? null
            : (payload.resultId ?? null);

        if (!editorView) {
            return;
        }
        if (!highlights.length) {
            // Not sure if we should remove all highlights if semantic tokens come back empty
            // editorView.dispatch({
            //     effects: clearHighlightsEffect.of(null),
            // });
            return;
        }

        // addHighlights[{line: 17, start: 0, len: 10, type: "math"}]
        editorView.dispatch({
            effects: addHighlightsEffect.of(highlights),
        });
    }

    processSemanticTokensDelta(payload: {
        edits: SemanticTokensDeltaEdit[];
        resultId?: string;
        previousResultId?: string;
        docVersion: number;
        fileName: string;
    }) {
        if (payload.fileName !== this.activeFileName) {
            return;
        }
        const editorView = this.getEditorView();
        if (
            !payload ||
            !Array.isArray(payload.edits) ||
            !this.encodedTokens ||
            !editorView
        ) {
            return;
        }

        if (
            payload.previousResultId &&
            this.currentResultId &&
            payload.previousResultId !== this.currentResultId
        ) {
            console.warn("[Semantic Tokens] Delta resultId mismatch", {
                fileName: payload.fileName,
                expected: this.currentResultId,
                received: payload.previousResultId,
            });
            return;
        }

        const updatedTokens = this.applySemanticTokensEdits(
            this.encodedTokens,
            payload.edits,
        );
        const highlights = this.buildHighlights(updatedTokens);

        // It looks like updated tokes are already in the current document coordinates for deltas,
        // Or getting there, while mapping updatedTokens throws RangeError (as if attempting to remove already removed position)
        // so no need to map them back from snapshot to current document

        const nextSignatures = this.buildLineSignatures(highlights);
        const changedLines = this.getChangedLines(
            this.lineSignatures,
            nextSignatures,
        );

        this.encodedTokens = updatedTokens;
        this.lineSignatures = nextSignatures;
        this.currentResultId = payload.resultId ?? this.currentResultId;

        if (!changedLines.length) {
            return;
        }

        const doc = editorView.state.doc;
        const regionsByLine = this.groupRegionsByLine(highlights);

        const flushRange = (startLine: number, endLine: number) => {
            const regions = Array.from(
                { length: endLine - startLine + 1 },
                (_, index) => regionsByLine.get(startLine + index) ?? [],
            ).flat();

            try {
                editorView.dispatch({
                    effects: replaceHighlightsEffect.of({
                        from: doc.line(startLine).from,
                        to: doc.line(endLine).to,
                        regions,
                    }),
                });
            } catch (e) {
                console.warn("[Semantic Tokens] Failed to apply highlight delta:", {
                    fileName: payload.fileName,
                    startLine,
                    endLine,
                    regions,
                    error: e,
                });
            }
        };

        let rangeStart = changedLines[0];
        let prev = changedLines[0];
        for (let i = 1; i < changedLines.length; i++) {
            const line = changedLines[i];
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
     * Applied to semantic tokens in LSP delta format: { start, deleteCount, data? }
     * to the saved version of (undecoded) token array to produce an updated token array
     * @param prev
     * @param edits
     * @returns
     */
    applySemanticTokensEdits(
        prev: number[],
        edits: SemanticTokensDeltaEdit[],
    ): number[] {
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
    decodeSemanticTokens(data: number[]): Array<HighlightRegion> {
        return data.reduce(
            (acc, _, idx, arr) => {
                if (idx % 5 !== 0) {
                    return acc;
                }

                const deltaLine = arr[idx];
                const deltaStartChar = arr[idx + 1];
                const length = arr[idx + 2];
                const tokenType = arr[idx + 3];
                const tokenModifierBits = arr[idx + 4];

                acc.line += deltaLine;
                acc.startChar =
                    deltaLine === 0
                        ? acc.startChar + deltaStartChar
                        : deltaStartChar;

                const modifiers = TOKEN_MODIFIERS.flatMap((modifier, j) =>
                    tokenModifierBits & (1 << j) ? [modifier] : [],
                );
                const normalizedModifiers = modifiers.length
                    ? [
                          ...new Set(
                              modifiers.filter(
                                  (modifier): modifier is string =>
                                      typeof modifier === "string" &&
                                      modifier.length > 0,
                              ),
                          ),
                      ]
                    : undefined;

                acc.tokens.push({
                    line: acc.line,
                    start: acc.startChar,
                    len: length,
                    type: TOKEN_TYPES[tokenType] || `unknown(${tokenType})`,
                    modifiers: normalizedModifiers,
                });

                return acc;
            },
            {
                line: 0,
                startChar: 0,
                tokens: [] as HighlightRegion[],
            },
        ).tokens;
    }

    private buildHighlights(tokens: number[]): HighlightRegion[] {
        const decodedTokens = this.decodeSemanticTokens(tokens);

        return decodedTokens.reduce<HighlightRegion[]>((highlights, token) => {
            if (!token) {
                return highlights;
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
                return highlights;
            }

            if (!type || type === "text") {
                return highlights;
            }
            if (type !== "identifier" && !HIGHLIGHT_COLORS.includes(type)) {
                console.warn("[Semantic Tokens] Unknown token type:", type);
                return highlights;
            }

            highlights.push({
                line: line + 1,
                start,
                len,
                type: type === "identifier" ? "variable" : type,
                modifiers,
            });

            return highlights;
        }, []);
    }

    private buildLineSignatures(
        highlights: HighlightRegion[],
    ): Map<number, string> {
        const lineMap = this.groupRegionsByLine(highlights);

        const entries = [...lineMap.entries()].map(
            ([line, regions]) =>
                [
                    line,
                    regions
                        .map((region) =>
                            [
                                region.start,
                                region.len,
                                region.type,
                                ...(region.modifiers ?? []),
                            ].join(":"),
                        )
                        .join("|"),
                ] as const,
        );

        return new Map<number, string>(entries);
    }

    private getChangedLines(
        previous: Map<number, string>,
        next: Map<number, string>,
    ): number[] {
        const lines = [...previous.entries()].reduce<Set<number>>(
            (acc, [line, signature]) => {
                if (next.get(line) !== signature) {
                    acc.add(line);
                }
                return acc;
            },
            new Set<number>(),
        );

        [...next.entries()].reduce<Set<number>>((acc, [line, signature]) => {
            if (previous.get(line) !== signature) {
                acc.add(line);
            }
            return acc;
        }, lines);

        return [...lines].sort((a, b) => a - b);
    }

    private groupRegionsByLine(
        highlights: HighlightRegion[],
    ): Map<number, HighlightRegion[]> {
        return highlights.reduce<Map<number, HighlightRegion[]>>(
            (lineMap, region) => {
                const list = lineMap.get(region.line) ?? [];
                list.push(region);
                lineMap.set(region.line, list);
                return lineMap;
            },
            new Map<number, HighlightRegion[]>(),
        );
    }
}
