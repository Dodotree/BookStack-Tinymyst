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
    }

    attachEditorView(view: EditorView): void {
        this.editorView = view;
    }

    detachEditorView(): void {
        this.editorView = null;
    }

    triggerLinting(): void {
        if (this.editorView) {
            this.editorView.dispatch(
                setDiagnostics(this.editorView.state, this.cachedDiagnostics)
            );
        }
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
    updateDiagnostics(diagnostics: any[], sourceText: string): void {
        if (!Array.isArray(diagnostics)) {
            return;
        }

        // Calculate positions for CodeMirror
        this.cachedDiagnostics = diagnostics.map((diag: any) => {
            const from = this.positionToOffsetInText(sourceText, diag.line - 1, diag.column - 1);
            const to = this.positionToOffsetInText(sourceText, diag.line - 1, Math.max(diag.column - 1, diag.column));

            return {
                from: from,
                to: Math.max(from + 1, to),
                severity: this.mapSeverity(diag.severity),
                message: diag.message,
            };
        });
    }
}
