import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { ChangeSet, Text } from "@codemirror/state";

export class FileManager {
  private storageRoot: string;

  constructor(storageRoot: string) {
    this.storageRoot = storageRoot;
  }

  /**
   * Load document from disk
   */
  loadDocument(pageId: number): string {
    const filePath = this.getFilePath(pageId);
    try {
      const content = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
      return content
    } catch (err) {
      console.error("Failed to read document", { pageId, err });
      throw new Error("DOC_READ_FAILED");
    }
  }

  /**
   * Persist document to disk
   */
  persistDocument(pageId: number, content: string): void {
    const filePath = this.getFilePath(pageId);
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
    changeSetJson: unknown
  ): string {

    const currentContent = this.loadDocument(pageId);
    const text = Text.of(currentContent.split("\n"));

    let changeSet: ChangeSet;
    try {
      changeSet = ChangeSet.fromJSON(changeSetJson as any);
    } catch (err) {
      console.error("Failed to parse changeset", { pageId, err });
      throw new Error("INVALID_CHANGESET");
    }

    try {
      return changeSet.apply(text).toString();
    } catch (err) {
      console.error("Failed to apply changeset", { pageId, err });
      throw new Error("CHANGESET_APPLY_FAILED");
    }
  }

  /**
   * Get file path for a page
   */
  private getFilePath(pageId: number): string {
    return join(this.storageRoot, `page_${pageId}.typ`);
  }
}
