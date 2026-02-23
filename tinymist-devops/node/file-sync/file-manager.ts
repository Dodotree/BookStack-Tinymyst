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

  constructor(storageRoot: string) {
    this.storageRoot = storageRoot;
  }

  /**
   * Load document from disk
   */
  loadDocument(pageId: number, fileName: string = "entry.typ"): string {
    const filePath = this.getFilePath(pageId, fileName);
    try {
      const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
      // Normalize line endings to avoid ChangeSet length mismatches on Windows.
      return content.replace(/\r\n?/g, "\n");
    } catch (err) {
      console.error("Failed to read document", { pageId, err });
      throw new Error("DOC_READ_FAILED");
    }
  }

  /**
   * Persist document to disk
   */
  persistDocument(pageId: number, content: string, fileName: string = "entry.typ"): void {
    const filePath = this.getFilePath(pageId, fileName);
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
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
    changeSetJson: unknown
  ): { updated: string; contentChanges: LspContentChange[] } {

    const currentContent = this.loadDocument(pageId, fileName);
    const text = Text.of(currentContent.split("\n"));

    console.log("[WS IN changes]", {
        changesType: typeof changeSetJson,
        isArray: Array.isArray(changeSetJson),
        tag: Object.prototype.toString.call(changeSetJson),
        value: changeSetJson,
        text,
    });

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
