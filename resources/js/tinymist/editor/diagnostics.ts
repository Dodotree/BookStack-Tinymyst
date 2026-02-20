// diagnostics receives data either from LSP via editor_ws
// or from fallback typst compiler output, parsed

// it inserts red wavy underlines for errors as decorations
// and reports to console if applicable
// semantic highlights have to be translucent to not obscure the underlines

import { EditorView } from "@codemirror/view";
import { Diagnostic, setDiagnostics } from "@codemirror/lint";
import { ChangeSet } from "@codemirror/state";


export class DiagnosticsProcessor {
    private editorView: EditorView | null;
    private getSnapshotContext: ((docVersion: number, fileName: string) => { snapshot: string; changeSet: ChangeSet });
    private activeFileName: string;

    constructor(editorView: EditorView | null = null) {
        this.editorView = editorView;
        this.getSnapshotContext = () => ({ snapshot: "", changeSet: ChangeSet.empty(0) });
        this.activeFileName = "entry.typ";

        this.mapDiagnosticsToCurrent = this.mapDiagnosticsToCurrent.bind(this);
        window.$events.listen("tinymist-diagnostics", this.mapDiagnosticsToCurrent);
        window.$events.listen("tinymist-lsp-diagnostics", this.mapDiagnosticsToCurrent);
        window.$events.listen("tinymist-active-file-change", (fileName: string) => {
            this.activeFileName = fileName;
        });
    }

    attachEditorView(
        view: EditorView,
        getSnapshotContext: (docVersion: number, fileName: string) => { snapshot: string; changeSet: ChangeSet },
    ): void {
        this.editorView = view;
        this.getSnapshotContext = getSnapshotContext;
    }

    detachEditorView(): void {
        this.editorView = null;
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

    private positionToOffsetInText(text: string, line: number, column: number): number {
        const lines = text.split('\n');
        if (line < 0 || line >= lines.length) return 0;

        let offset = 0;
        for (let i = 0; i < line; i++) {
            offset += lines[i].length + 1; // +1 for newline
        }
        offset += Math.min(column, lines[line].length);
        return offset;
    }

    private mapDiagnosticsToCurrent = (payload: { diagnostics: any[]; docVersion?: number; fileName: string }) => {
        if (!payload || !Array.isArray(payload.diagnostics) ||!this.editorView || typeof payload.docVersion !== "number") {
            return;
        }

        if (payload.fileName !== this.activeFileName) {
            return;
        }

        const context = this.getSnapshotContext(payload.docVersion, payload.fileName);
        const currentDoc = this.editorView.state.doc;

        const mappedDiagnostics = payload.diagnostics.map((diag) => {
            const range = diag.range || {};
            const start = range.start || {};
            const end = range.end || {};
            const startLine = typeof start.line === "number" ? start.line : 0;
            const endLine = typeof end.line === "number" ? end.line : startLine;
            const startChar = typeof start.character === "number" ? start.character : 0;
            const endChar = typeof end.character === "number" ? end.character : startChar;

            let startOffset = this.positionToOffsetInText(context.snapshot, startLine, startChar);
            let endOffset = this.positionToOffsetInText(context.snapshot, endLine, endChar);
            startOffset = context.changeSet.mapPos(startOffset, 1);
            endOffset = context.changeSet.mapPos(endOffset, -1);

            const startLineInfo = currentDoc.lineAt(Math.min(startOffset, currentDoc.length));
            const endLineInfo = currentDoc.lineAt(Math.min(endOffset, currentDoc.length));

            return {
                ...diag,
                range: {
                    start: {
                        line: startLineInfo.number - 1,
                        character: Math.max(0, startOffset - startLineInfo.from),
                    },
                    end: {
                        line: endLineInfo.number - 1,
                        character: Math.max(0, endOffset - endLineInfo.from),
                    },
                },
            };
        });
        this.updateDiagnosticsFromLsp(mappedDiagnostics);
    }

    updateDiagnosticsFromLsp = (diagnostics: any[]) => {
        if (!this.editorView || !Array.isArray(diagnostics)) {
            return;
        }

        const doc = this.editorView.state.doc;
        const cmDiagnostics = diagnostics.map((d) => {
            const range = d.range || {};
            const start = range.start || {};
            const end = range.end || {};
            const startLine = typeof start.line === "number" ? start.line + 1 : 1;
            const endLine = typeof end.line === "number" ? end.line + 1 : startLine;
            const startChar = typeof start.character === "number" ? start.character : 0;
            const endChar = typeof end.character === "number" ? end.character : startChar;

            const fromLine = doc.line(Math.min(Math.max(startLine, 1), doc.lines));
            const toLine = doc.line(Math.min(Math.max(endLine, 1), doc.lines));
            const from = Math.min(fromLine.from + startChar, fromLine.to);
            const to = Math.min(toLine.from + endChar, toLine.to);

            const severity = this.mapLspSeverity(d.severity);

            return {
                from,
                to: Math.max(from + 1, to),
                severity,
                message: d.message || "LSP diagnostic",
            };
        });

        this.triggerLinting(cmDiagnostics);
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
            window.$events.emit("tinymist-console-log", { type: diag.severity, message: logMessage });
        });
    }

}
