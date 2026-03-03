// diagnostics receives data either from LSP via websocket
// or from fallback typst compiler output, parsed
// it inserts red wavy underlines for errors as decorations
// and reports to console if applicable
// Note: semantic highlights backgrounds have to be translucent to not obscure the underlines

import { EditorView } from "@codemirror/view";
import { Diagnostic, setDiagnostics } from "@codemirror/lint";
import { ChangeSet } from "@codemirror/state";
import { ENTRY_FILE_NAME, tmEvents } from "../constants";


export class DiagnosticsProcessor {
    private editorView: EditorView | null;
    private getSnapshotContext: ((docVersion: number, fileName: string) => { snapshot: string; changeSet: ChangeSet });
    private activeFileName: string;

    constructor(editorView: EditorView | null = null) {
        this.editorView = editorView;
        this.getSnapshotContext = () => ({ snapshot: "should be overridden", changeSet: ChangeSet.empty(0) });
        this.activeFileName = ENTRY_FILE_NAME;

        this.mapDiagnosticsToCurrent = this.mapDiagnosticsToCurrent.bind(this);
        window.$tmEventBus.listen(tmEvents.Diagnostics, this.mapDiagnosticsToCurrent);
        window.$tmEventBus.listen(tmEvents.ActiveFileChange, (payload: { fileName: string; url: string }) => {
            this.activeFileName = payload.fileName;
            this.triggerLinting([]);
        });
        window.$tmEventBus.listen(tmEvents.ResetFile, (_payload: { fileName?: string }) => {
            this.triggerLinting([]);
        });
        window.$tmEventBus.listen(tmEvents.Destroy, () => {
            this.editorView = null;
            this.getSnapshotContext = () => ({ snapshot: "Destroyed", changeSet: ChangeSet.empty(0) });
        });
    }

    attachEditorView(
        view: EditorView,
        getSnapshotContext: (docVersion: number, fileName: string) => { snapshot: string; changeSet: ChangeSet },
    ): void {
        this.editorView = view;
        this.getSnapshotContext = getSnapshotContext;
    }

    private mapLspSeverity(severity: number | undefined): "error" | "warning" | "info" {
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

    private mapDiagnosticsToCurrent = (payload: { diagnostics: any[]; docVersion?: number; fileName?: string }) => {
        if (!payload || !Array.isArray(payload.diagnostics) ||!this.editorView || typeof payload.docVersion !== "number") {
            return;
        }

        if (payload.fileName && payload.fileName !== this.activeFileName) {
            return;
        }

        const fileName = payload.fileName ?? this.activeFileName;
        const context = this.getSnapshotContext(payload.docVersion, fileName);
        const snapshotLineLen = context.snapshot.split('\n').map(line => line.length + 1); // +1 for newline
        const snapshotOffsets = snapshotLineLen
            .reduce((acc, len, idx) => {
                acc[idx] = (acc[idx - 1] || 0) + len;
                return acc;
            }, [] as number[]);

        const currentDoc = this.editorView.state.doc;

        const mappedDiagnostics = payload.diagnostics.map((diag) => {
            const range = diag.range || {};
            const start = range.start || {};
            const end = range.end || {};
            const startLine = typeof start.line === "number" ? start.line : 0;
            const endLine = typeof end.line === "number" ? end.line : startLine;
            const startChar = typeof start.character === "number" ? start.character : 0;
            const endChar = typeof end.character === "number" ? end.character : startChar;

            // [line,char] to offset in snapshot, line ending new line is ignored
            let startOffset = (snapshotOffsets[startLine - 1] || 0) + Math.min(startChar, snapshotLineLen[startLine] - 1);
            let endOffset = (snapshotOffsets[endLine - 1] || 0) + Math.min(endChar, snapshotLineLen[endLine] - 1);
            // Map offsets through changes to current document
            startOffset = context.changeSet.mapPos(startOffset, 1);
            endOffset = context.changeSet.mapPos(endOffset, -1);
            // Get current CodeMirror lines. Guard against offsets that exceed current document length
            const fromLine = currentDoc.lineAt(Math.min(startOffset, currentDoc.length));
            const toLine = currentDoc.lineAt(Math.min(endOffset, currentDoc.length));
            // Guard against character that exceeds line length
            const from = Math.min(fromLine.from + Math.max(0, startOffset - fromLine.from), fromLine.to);
            const to = Math.min(toLine.from + Math.max(0, endOffset - toLine.from), toLine.to);

            return {
                from,
                to: Math.max(from + 1, to), // Ensure at least 1 character is underlined
                severity: this.mapLspSeverity(diag.severity),
                message: diag.message || "LSP diagnostic",
            };
        });

        this.triggerLinting(mappedDiagnostics);
    }

    triggerLinting(newDiagnostics: Diagnostic[]): void {
        if (this.editorView) {
            this.editorView.dispatch(
                setDiagnostics(this.editorView.state, newDiagnostics)
            );
        }
        this.logToConsole(newDiagnostics);
    }

    logToConsole(diagnostics: Diagnostic[]): void {
        diagnostics.forEach(diag => {
            const logMessage = `[Diagnostic] ${diag.message} ${diag.severity} (from ${diag.from}, to ${diag.to})`;
            window.$tmEventBus.emit(tmEvents.ConsoleLog, { type: diag.severity, message: logMessage });
        });
    }

}
