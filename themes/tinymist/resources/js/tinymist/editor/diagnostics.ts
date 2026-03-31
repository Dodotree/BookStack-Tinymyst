// diagnostics receives data either from LSP via websocket
// or from fallback typst compiler output, parsed
// it inserts red wavy underlines for errors as decorations
// and reports to console if applicable
// Note: semantic highlights backgrounds have to be translucent to not obscure the underlines

import { EditorView } from "@codemirror/view";
import { Diagnostic, setDiagnostics } from "@codemirror/lint";
import { ChangeSet } from "@codemirror/state";
import { ENTRY_FILE_NAME, tmEvents, TinymistConsoleLocation, DiagnosticsPayload } from "../constants";

type DiagnosticLocationMap = Map<number, TinymistConsoleLocation>;

export class DiagnosticsProcessor {
    private activeFileName: string = ENTRY_FILE_NAME;

    private getEditorView: () => EditorView | null;
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

        this.mapDiagnosticsToCurrent = this.mapDiagnosticsToCurrent.bind(this);

        window.$tmEventBus.listen(
            tmEvents.Diagnostics,
            this.mapDiagnosticsToCurrent,
        );
        window.$tmEventBus.listen(
            tmEvents.ActiveFileChange,
            (payload: { fileName: string; url: string }) => {
                this.activeFileName = payload.fileName;
                this.triggerLinting([]);
            },
        );
        window.$tmEventBus.listen(
            tmEvents.ResetFile,
            (_payload: { fileName?: string }) => {
                this.triggerLinting([]);
            },
        );
        window.$tmEventBus.listen(tmEvents.Destroy, () => {
            this.getSnapshotContext = () => ({
                snapshot: "Destroyed",
                changeSet: ChangeSet.empty(0),
            });
            this.getEditorView = () => null;
        });
    }

    private mapLspSeverity(
        severity: number | undefined,
    ): "error" | "warning" | "info" {
        switch (severity) {
            case 1:
                return "error";
            case 2:
                return "warning";
            case 3:
            case 4:
                return "info";
            default:
                return "error";
        }
    }

    private mapDiagnosticsToCurrent = (payload: {
        diagnostics: DiagnosticsPayload;
        docVersion?: number;
        fileName?: string;
    }) => {
        const editorView = this.getEditorView();
        if (
            !payload ||
            !Array.isArray(payload.diagnostics) ||
            !editorView ||
            typeof payload.docVersion !== "number"
        ) {
            return;
        }

        if (payload.fileName && payload.fileName !== this.activeFileName) {
            this.logAnotherFileDiagnostics(payload.fileName, payload.diagnostics);
            return;
        }

        const fileName = payload.fileName ?? this.activeFileName;
        const context = this.getSnapshotContext(payload.docVersion, fileName);
        const snapshotLineLen = context.snapshot
            .split("\n")
            .map((line) => line.length + 1); // +1 for newline
        const snapshotOffsets = snapshotLineLen.reduce((acc, len, idx) => {
            acc[idx] = (acc[idx - 1] || 0) + len;
            return acc;
        }, [] as number[]);

        const currentDoc = editorView.state.doc;

        const mappedDiagnostics: Diagnostic[] = [];
        const diagnosticLocations: DiagnosticLocationMap = new Map();

        payload.diagnostics.forEach((diag, index) => {
            const range = diag.range || {};
            const start = range.start || {};
            const end = range.end || {};
            const startLine = typeof start.line === "number" ? start.line : 0;
            const endLine = typeof end.line === "number" ? end.line : startLine;
            const startChar =
                typeof start.character === "number" ? start.character : 0;
            const endChar =
                typeof end.character === "number" ? end.character : startChar;

            // [line,char] to offset in snapshot, line ending new line is ignored
            let startOffset =
                (snapshotOffsets[startLine - 1] || 0) +
                Math.min(startChar, snapshotLineLen[startLine] - 1);
            let endOffset =
                (snapshotOffsets[endLine - 1] || 0) +
                Math.min(endChar, snapshotLineLen[endLine] - 1);
            // Map offsets through changes to current document
            startOffset = context.changeSet.mapPos(startOffset, 1);
            endOffset = context.changeSet.mapPos(endOffset, -1);
            // Get current CodeMirror lines. Guard against offsets that exceed current document length
            const fromLine = currentDoc.lineAt(
                Math.min(startOffset, currentDoc.length),
            );
            const toLine = currentDoc.lineAt(
                Math.min(endOffset, currentDoc.length),
            );
            // Guard against character that exceeds line length
            const from = Math.min(
                fromLine.from + Math.max(0, startOffset - fromLine.from),
                fromLine.to,
            );
            const to = Math.min(
                toLine.from + Math.max(0, endOffset - toLine.from),
                toLine.to,
            );

            const line = fromLine.number;
            const character = Math.max(1, from - fromLine.from + 1);
            const endLineNumber = toLine.number;
            const endCharacter = Math.max(1, to - toLine.from + 1);

            mappedDiagnostics.push({
                from,
                to: Math.max(from + 1, to), // Ensure at least 1 character is underlined
                severity: this.mapLspSeverity(diag.severity),
                message: diag.message || "LSP diagnostic",
            });

            diagnosticLocations.set(index, {
                fileName,
                line,
                character,
                endLine: endLineNumber,
                endCharacter,
            });
        });

        this.triggerLinting(mappedDiagnostics, diagnosticLocations);
    };

    triggerLinting(
        newDiagnostics: Diagnostic[],
        diagnosticLocations?: DiagnosticLocationMap,
    ): void {
        const editorView = this.getEditorView();
        if (editorView) {
            editorView.dispatch(
                setDiagnostics(editorView.state, newDiagnostics),
            );
        }
        this.logToConsole(newDiagnostics, diagnosticLocations);
    }

    logToConsole(
        diagnostics: Diagnostic[],
        diagnosticLocations?: DiagnosticLocationMap,
    ): void {
        diagnostics.forEach((diag, index) => {
            const location = diagnosticLocations?.get(index);
            const locationLabel = location
                ? ` (line ${location.line}, position ${location.character})`
                : "";
            const logMessage = `[Diagnostic] ${diag.message} ${diag.severity}${locationLabel}`;
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: diag.severity,
                message: logMessage,
                ...(location ? { location } : {}),
            });
        });
    }

    logAnotherFileDiagnostics(fileName: string, diagnostics: DiagnosticsPayload): void {
        diagnostics.forEach((diag, index) => {
            const severity = this.mapLspSeverity(diag.severity);
            window.$tmEventBus.emit(tmEvents.ConsoleLog, {
                type: severity,
                message: `[Diagnostic] ${fileName} ${severity}: ${diag.message} `,
            });
        });
    }
}
