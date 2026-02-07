// diagnostics receives data either from LSP via editor_ws
// or from fallback typst compiler output, parsed

// it inserts red wavy underlines for errors as decorations
// and reports to console if applicable
// semantic highlights have to be translucent to not obscure the underlines

import { EditorView, Decoration, DecorationSet } from "@codemirror/view";
import { Diagnostic, setDiagnostics } from "@codemirror/lint";


export class DiagnosticsProcessor {
    private editorView: EditorView | null;
    private cachedDiagnostics: Diagnostic[] = [];

    constructor(editorView: EditorView | null = null) {
        this.editorView = editorView;

        this.updateDiagnosticsFromFallback = this.updateDiagnosticsFromFallback.bind(this);
        this.updateDiagnosticsFromLsp = this.updateDiagnosticsFromLsp.bind(this);
        window.$events.listen("tinymist-diagnostics", this.updateDiagnosticsFromFallback);
        window.$events.listen("tinymist-lsp-diagnostics", this.updateDiagnosticsFromLsp);
    }

    attachEditorView(view: EditorView): void {
        this.editorView = view;
    }

    detachEditorView(): void {
        this.editorView = null;
    }

    private mapSeverity(severity: string): 'error' | 'warning' | 'info' {
        switch (severity.toLowerCase()) {
            case 'error': return 'error';
            case 'warning': return 'warning';
            case 'information':
            case 'info':
            case 'hint':
                return 'info';
            default: return 'error';
        }
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

    /**
     * Update diagnostics from (fallback) compilation response and the text that triggered it
     */
    updateDiagnosticsFromFallback(diagnostics: any[], sourceText: string): void {
        if (!Array.isArray(diagnostics)) {
            return;
        }
        this.cachedDiagnostics = diagnostics.map((d: any) => {
            const from = this.positionToOffsetInText(sourceText, d.line - 1, d.column - 1);
            const to = this.positionToOffsetInText(sourceText, d.line - 1, d.column);

            return {
                from,
                to: Math.max(from + 1, to),
                severity: this.mapSeverity(d.severity),
                message: d.message,
            };
        });
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

        this.editorView.dispatch(
            setDiagnostics(this.editorView.state, cmDiagnostics)
        );
    }

    triggerLinting(): void {
        if (this.editorView) {
            this.editorView.dispatch(
                setDiagnostics(this.editorView.state, this.cachedDiagnostics)
            );
        }
    }

    logToConsole(diagnostics: Diagnostic[]): void {
        diagnostics.forEach(diag => {
            const logMessage = `[Diagnostic] ${diag.message} (from ${diag.severity})`;
            if (diag.severity === 'error') {
                window.$events.emit("tinymist-console-log", { type: "error", message: `[Typst]Line ${diag.line}, Col ${diag.column}: ${diag.message}` });
            } else if (diag.severity === 'warning') {
                window.$events.emit("tinymist-console-log", { type: "warning", message: logMessage });
            } else {
                window.$events.emit("tinymist-console-log", { type: "info", message: logMessage });
            }
        });
    }

}
