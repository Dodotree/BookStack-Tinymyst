"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileManager = void 0;
const fs_1 = require("fs");
const path_1 = require("path");
const state_1 = require("@codemirror/state");
class FileManager {
    storageRoot;
    constructor(storageRoot) {
        this.storageRoot = storageRoot;
    }
    /**
     * Load document from disk
     */
    loadDocument(pageId) {
        const filePath = this.getFilePath(pageId);
        try {
            const content = (0, fs_1.existsSync)(filePath) ? (0, fs_1.readFileSync)(filePath, "utf8") : "";
            return content;
        }
        catch (err) {
            console.error("Failed to read document", { pageId, err });
            throw new Error("DOC_READ_FAILED");
        }
    }
    /**
     * Persist document to disk
     */
    persistDocument(pageId, content) {
        const filePath = this.getFilePath(pageId);
        try {
            (0, fs_1.mkdirSync)((0, path_1.dirname)(filePath), { recursive: true });
            (0, fs_1.writeFileSync)(filePath, content, "utf8");
        }
        catch (err) {
            console.error("Failed to write document", { pageId, err });
            throw new Error("DOC_WRITE_FAILED");
        }
    }
    /**
     * Apply a changeset to document content
     */
    applyChanges(pageId, changeSetJson) {
        const currentContent = this.loadDocument(pageId);
        const text = state_1.Text.of(currentContent.split("\n"));
        let changeSet;
        try {
            changeSet = state_1.ChangeSet.fromJSON(changeSetJson);
        }
        catch (err) {
            console.error("Failed to parse changeset", { pageId, err });
            throw new Error("INVALID_CHANGESET");
        }
        try {
            return changeSet.apply(text).toString();
        }
        catch (err) {
            console.error("Failed to apply changeset", { pageId, err });
            throw new Error("CHANGESET_APPLY_FAILED");
        }
    }
    /**
     * Get file path for a page
     */
    getFilePath(pageId) {
        return (0, path_1.join)(this.storageRoot, `page_${pageId}.typ`);
    }
}
exports.FileManager = FileManager;
