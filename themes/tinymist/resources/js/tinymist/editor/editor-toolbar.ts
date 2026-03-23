import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import {
    LanguageDescription,
    LanguageSupport,
    StreamLanguage,
    defaultHighlightStyle,
    syntaxHighlighting,
} from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { php } from "@codemirror/lang-php";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { toml } from "@codemirror/legacy-modes/mode/toml";


import { ENTRY_FILE_NAME, tmEvents, tmSelectors } from "../constants";
import { TinymistSearchReplace } from "./search-replace";
import { TinymistFileDropdown } from "./file-dropdown";
import { TinymistThemeSettings } from "./theme-settings";

function getMarkdownLanguageExtension(): Extension {
    return markdown({
        codeLanguages: [
            LanguageDescription.of({
                name: "javascript",
                alias: ["js", "jsx", "ts", "tsx"],
                load: async () => javascript(),
            }),
            LanguageDescription.of({
                name: "python",
                alias: ["py"],
                load: async () => python(),
            }),
            LanguageDescription.of({
                name: "php",
                load: async () => php(),
            }),
            LanguageDescription.of({
                name: "shell",
                alias: ["sh", "bash", "zsh", "shell"],
                load: async () =>
                    new LanguageSupport(StreamLanguage.define(shell)),
            }),
        ],
    });
}

function getFileExtension(fileName: string): string {
    const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
    const dotIndex = baseName.lastIndexOf(".");
    if (dotIndex <= 0 || dotIndex >= baseName.length - 1) {
        return "";
    }

    return baseName.slice(dotIndex + 1).toLowerCase();
}

export function isImageFile(fileName: string): boolean {
    return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(fileName);
}

export function getLanguageExtensionForFile(fileName: string): Extension {
        const ext = getFileExtension(fileName);

        switch (ext) {
            case "md":
                return getMarkdownLanguageExtension();
            case "toml":
                return StreamLanguage.define(toml);
            case "bib":
                return StreamLanguage.define(stex);
            case "sh":
            case "bash":
                return StreamLanguage.define(shell);
            case "html":
                return html();
            case "css":
                return css();
            case "json":
                return json();
            case "ts":
                return javascript({ typescript: true });
            case "js":
                return javascript();
            case "php":
                return php();
            case "py":
                return python();
            case "txt":
                return [];
            default:
                return getMarkdownLanguageExtension();
        }
    }

export function getHighlightExtension(isDarkMode: boolean): Extension {
    return syntaxHighlighting(
        isDarkMode ? oneDarkHighlightStyle : defaultHighlightStyle,
        { fallback: true },
    );
}

export class EditorToolbar {
    editor: HTMLTextAreaElement;
    editorView: EditorView | null = null;
    private activeFileName = ENTRY_FILE_NAME;
    private isOffline: boolean = !navigator.onLine;

    private readonly searchReplace: TinymistSearchReplace;

    private imageViewSelector: string;
    private imageSelector: string;
    private imageMessageSelector: string;


    constructor(editor: HTMLTextAreaElement, editorView: EditorView) {
        this.editor = editor;
        this.editorView = editorView;

        this.imageViewSelector = `${tmSelectors.Root} ${tmSelectors.ImageView}`;
        this.imageSelector = `${tmSelectors.Root} ${tmSelectors.Image}`;
        this.imageMessageSelector = `${tmSelectors.Root} ${tmSelectors.ImageMessage}`;

        this.insertFromEditorEvent = this.insertFromEditorEvent.bind(this);
        this.buttonsListener = this.buttonsListener.bind(this);

        new TinymistThemeSettings();
        new TinymistFileDropdown(`${tmSelectors.Root} ${tmSelectors.FileDropDown}`);
        this.searchReplace = new TinymistSearchReplace(() => this.editorView);

        this.setupListeners();
    }

    setupListeners() {
        window.addEventListener("online", this.onBrowserOnline);
        window.addEventListener("offline", this.onBrowserOffline);

        window.$tmEventBus.listen(
            tmEvents.ActiveFileChange,
            this.setActiveFile,
        );

        // Button actions, it counts on event bubbling to the container
        this.editor
            .closest(tmSelectors.EditorPane)
            ?.addEventListener("click", this.buttonsListener);

        window.$tmEventBus.listen(tmEvents.Insert, this.insertFromEditorEvent);
    }

    removeListeners() {
        this.editor
            .closest(tmSelectors.EditorPane)
            ?.removeEventListener("click", this.buttonsListener);
    }

    buttonsListener(event: Event) {
        if (!event.target) return;
        const button = (event.target as Element).closest(tmSelectors.ActionButton);
        if (button === null) return;

        const action = button.getAttribute("data-action");
        switch (action) {
            case "insertImage":
                this.insertImage();
                break;
            case "insertLink":
                this.insertLink();
                break;
            case "insertBold":
                this.insertMarkup("*", "*");
                break;
            case "insertItalic":
                this.insertMarkup("_", "_");
                break;
            case "insertMath":
                this.insertMarkup("$", "$");
                break;
            case "insertCodeBlock":
                this.insertCodeBlock();
                break;
            case "insertHeading":
                this.insertHeading();
                break;
            case "changeCodeMirrorSettings":
                window.$tmEventBus.emit(tmEvents.ThemeSettingsOpen);
                break;
            case "openSearchReplace":
                this.searchReplace.open(false);
                break;
            default:
                console.warn(`[Editor]Unknown button action: ${action}`);
        }
    }

    public setActiveFile(payload: { fileName: string; url: string }): void {
        const { fileName, url } = payload;
        if (fileName === this.activeFileName) {
            return;
        }

        this.activeFileName = fileName;
        this.searchReplace.close();

        if (isImageFile(fileName)) {
            this.showImagePreview(fileName, url);
            return;
        }

        this.showTextEditor();
        window.$tmEventBus.emit(tmEvents.SyncOpenFile, { fileName: fileName });
    }

    private showImagePreview(fileName: string, url: string): void {
        const imageViewContainer = document.querySelector(this.imageViewSelector) as HTMLDivElement | null;
        const imageViewElement = document.querySelector(this.imageSelector) as HTMLImageElement | null;
        const imageViewMessage = document.querySelector(this.imageMessageSelector) as HTMLDivElement | null;
        if (
            !imageViewContainer ||
            !imageViewElement ||
            !imageViewMessage
        ) {
            return;
        }

        imageViewContainer.hidden = false;
        if (this.editorView) {
            this.editorView.dom.style.setProperty(
                "display",
                "none",
                "important",
            );
        }
        this.editor.style.display = "none";

        if (!url) {
            imageViewElement.hidden = true;
            imageViewElement.removeAttribute("src");
            imageViewMessage.hidden = false;
            imageViewMessage.textContent = `Image preview unavailable for ${fileName}.`;
            return;
        }

        imageViewElement.src = url;
        imageViewElement.hidden = false;
        imageViewMessage.hidden = true;
    }

    private showTextEditor(): void {
        const imageViewContainer = document.querySelector(this.imageViewSelector) as HTMLDivElement | null;
        const imageViewElement = document.querySelector(this.imageSelector) as HTMLImageElement | null;
        const imageViewMessage = document.querySelector(this.imageMessageSelector) as HTMLDivElement | null;
        if (imageViewContainer) {
            imageViewContainer.hidden = true;
        }
        if (imageViewElement) {
            imageViewElement.hidden = true;
            imageViewElement.removeAttribute("src");
        }
        if (imageViewMessage) {
            imageViewMessage.hidden = true;
        }
        if (this.editorView) {
            this.editorView.dom.style.display = "";
            return;
        }
        this.editor.style.display = "block";
    }

    private getSelectionInfo(): {
        selectedText: string;
        from: number;
        to: number;
    } {
        if (this.editorView) {
            const selection = this.editorView.state.selection.main;
            return {
                selectedText: this.editorView.state.doc.sliceString(
                    selection.from,
                    selection.to,
                ),
                from: selection.from,
                to: selection.to,
            };
        }

        return {
            selectedText: this.editor.value.substring(
                this.editor.selectionStart,
                this.editor.selectionEnd,
            ),
            from: this.editor.selectionStart,
            to: this.editor.selectionEnd,
        };
    }

    private replaceSelection(replacement: string): void {
        if (this.editorView) {
            const selection = this.editorView.state.selection.main;
            this.editorView.dispatch({
                changes: {
                    from: selection.from,
                    to: selection.to,
                    insert: replacement,
                },
                selection: {
                    anchor: selection.from + replacement.length,
                },
            });
            this.editorView.focus();
            return;
        }

        this.editor.setRangeText(
            replacement,
            this.editor.selectionStart,
            this.editor.selectionEnd,
            "end",
        );
        this.editor.focus();
    }

    private escapeTypstString(value: string): string {
        return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }

        /**
     * Insert markup around selected text or at cursor position.
     */
    insertMarkup(before: string, after: string) {
        if (this.editorView) {
            const state = this.editorView.state;
            const selection = state.selection.main;
            const selectedText = state.doc.sliceString(
                selection.from,
                selection.to,
            );
            const replacement = before + selectedText + after;

            this.editorView.dispatch({
                changes: {
                    from: selection.from,
                    to: selection.to,
                    insert: replacement,
                },
                selection: {
                    anchor: selection.from + before.length,
                    head: selection.from + before.length + selectedText.length,
                },
            });
            this.editorView.focus();
            return;
        }

        const start = this.editor.selectionStart;
        const end = this.editor.selectionEnd;
        const selectedText = this.editor.value.substring(start, end);
        const replacement = before + selectedText + after;

        this.editor.setRangeText(replacement, start, end, "select");
        this.editor.focus();
    }

    /**
     * Insert heading at cursor position.
     */
    insertHeading() {
        if (this.editorView) {
            const state = this.editorView.state;
            const selection = state.selection.main;
            const before = state.doc.sliceString(0, selection.from);
            const heading =
                before.endsWith("\n") || before === ""
                    ? "= Heading\n"
                    : "\n= Heading\n";

            this.editorView.dispatch({
                changes: { from: selection.from, insert: heading },
                selection: { anchor: selection.from + heading.length - 1 },
            });
            this.editorView.focus();
            return;
        }

        const start = this.editor.selectionStart;
        const before = this.editor.value.substring(0, start);
        const after = this.editor.value.substring(start);

        const heading =
            before.endsWith("\n") || before === ""
                ? "= Heading\n"
                : "\n= Heading\n";
        this.editor.value = before + heading + after;
        this.editor.selectionStart = this.editor.selectionEnd =
            start + heading.length - 1;
        this.editor.focus();
    }

    private insertImage(): void {
        const selection = this.getSelectionInfo();
        const selectedSrc = selection.selectedText.trim();
        const src = selectedSrc.length > 0 ? selectedSrc : "image.png";
        const escapedSrc = this.escapeTypstString(src);
        this.replaceSelection(
            `#image("${escapedSrc}", width: 100%, height: 100%, fit: "cover", scaling: "smooth", alt: "my image description")`,
        );
    }

    private insertLink(): void {
        const selection = this.getSelectionInfo();
        const selectedUrl = selection.selectedText.trim();
        const url =
            selectedUrl.length > 0 ? selectedUrl : "https://example.com";
        const escapedUrl = this.escapeTypstString(url);
        this.replaceSelection(`#link("${escapedUrl}")[\n  See example.com\n]`);
    }

    private insertCodeBlock(): void {
        const selection = this.getSelectionInfo();
        const selectedCode = selection.selectedText;
        if (selectedCode.length > 0) {
            this.replaceSelection(`\`\`\`python\n${selectedCode}\n\`\`\``);
            return;
        }
        this.replaceSelection("```python\n\n```");
    }

    private readonly onBrowserOnline = () => {
        this.isOffline = false;
    };
    private readonly onBrowserOffline = () => {
        this.isOffline = true;
    };

    private insertFromEditorEvent(eventContent: {
        typst?: string;
        markdown?: string;
        html?: string;
    }): void {
        const insertText = (
            eventContent?.typst ||
            eventContent?.markdown ||
            eventContent?.html ||
            ""
        ).toString();
        if (!insertText) {
            return;
        }
        if (this.activeFileName !== ENTRY_FILE_NAME) {
            console.warn("[Editor] Ignoring insert event for non-active file", {
                activeFile: this.activeFileName,
                eventFile: this.activeFileName,
            });
            return;
        }

        if (this.editorView) {
            const selection = this.editorView.state.selection.main;
            this.editorView.dispatch({
                changes: {
                    from: selection.from,
                    to: selection.to,
                    insert: insertText,
                },
                selection: {
                    anchor: selection.from + insertText.length,
                },
            });
            this.editorView.focus();
            return;
        }

        const start = this.editor.selectionStart;
        const end = this.editor.selectionEnd;
        this.editor.setRangeText(insertText, start, end, "end");
        this.editor.focus();
    }

    destroy() {
        window.removeEventListener("online", this.onBrowserOnline);
        window.removeEventListener("offline", this.onBrowserOffline);

        this.removeListeners();
        this.searchReplace.destroy();

        // dereference editor to release DOM reference, but don't remove
        this.editorView = null;
        this.editor = null as any;
    }
}
