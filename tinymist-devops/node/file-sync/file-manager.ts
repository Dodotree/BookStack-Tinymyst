import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { ChangeSet, Text } from "@codemirror/state";

export type LspPosition = { line: number; character: number };
export type LspContentChange = {
    range: { start: LspPosition; end: LspPosition };
    rangeLength: number;
    text: string;
};

export class FileManager {
    private storageRoot: string;

    private marker = `\n#box(width: 0pt, height: 0pt)[
  #rect(width: 0.01pt, height: 0.01pt, fill: rgb("#00000000"), stroke: none,)
] <doc-version-`;

    constructor(storageRoot: string) {
        this.storageRoot = storageRoot;
    }

    /**
     * Load document from disk
     */
    loadDocument(pageId: number, fileName: string = "entry.typ"): string {
        const filePath = this.getFilePath(pageId, fileName);
        try {
            let content = existsSync(filePath)
                ? readFileSync(filePath, "utf8")
                : "";
            // Normalize line endings to avoid ChangeSet length mismatches on Windows.
            if (fileName === "entry.typ") {
                content = content.split(this.marker)[0] || content;
            }
            return content.replace(/\r\n?/g, "\n");
        } catch (err) {
            console.error("Failed to read document", { pageId, err });
            throw new Error("DOC_READ_FAILED");
        }
    }

    /**
     * Persist document to disk
     */
    persistDocument(
        pageId: number,
        content: string,
        fileName: string = "entry.typ",
        docVersion: number,
    ): void {
        const filePath = this.getFilePath(pageId, fileName);
        try {
            mkdirSync(dirname(filePath), { recursive: true });
            const versionedContent =
                fileName === "entry.typ"
                    ? content + this.marker + docVersion + ">"
                    : content;
            writeFileSync(filePath, versionedContent, "utf8");
        } catch (err) {
            console.error("Failed to write document", { pageId, err });
            throw new Error("DOC_WRITE_FAILED");
        }
    }

    /**
     * Apply a changeset to document content
     */
    applyChanges(
        pageId: number,
        fileName: string,
        changeSetJson: unknown,
    ): { updated: string; contentChanges: LspContentChange[] } {
        const currentContent = this.loadDocument(pageId, fileName);
        const text = Text.of(currentContent.split("\n"));

        let changeSet: ChangeSet;
        try {
            changeSet = ChangeSet.fromJSON(changeSetJson as any);
        } catch (err) {
            console.error("Failed to parse changeset", { pageId, err });
            throw new Error("INVALID_CHANGESET");
        }

        try {
            const updated = changeSet.apply(text).toString();
            const contentChanges: LspContentChange[] = [];
            changeSet.iterChanges((fromA, toA, _fromB, _toB, insert) => {
                contentChanges.push({
                    range: {
                        start: this.positionFromOffset(text, fromA),
                        end: this.positionFromOffset(text, toA),
                    },
                    rangeLength: toA - fromA,
                    text: insert.toString(),
                });
            });

            return { updated, contentChanges };
        } catch (err) {
            console.error("Failed to apply changeset", { pageId, err });
            throw new Error("CHANGESET_APPLY_FAILED", { cause: changeSetJson });
        }
    }

    private positionFromOffset(text: Text, pos: number): LspPosition {
        const line = text.lineAt(pos);
        return { line: line.number - 1, character: pos - line.from };
    }

    /**
     * Get file path for a page
     */
    private getFilePath(pageId: number, fileName: string): string {
        const safeFileName = this.normalizeFileName(fileName);
        return join(this.storageRoot, `page_${pageId}`, safeFileName);
    }

    private normalizeFileName(fileName: string): string {
        const trimmed = (fileName || "").trim();
        if (trimmed.length === 0) {
            throw new Error("INVALID_FILE_NAME");
        }

        const normalized = trimmed.replace(/\\/g, "/");
        if (normalized.includes("/") || normalized.includes("..")) {
            throw new Error("INVALID_FILE_NAME");
        }

        return normalized;
    }
}
