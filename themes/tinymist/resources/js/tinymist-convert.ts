async function readEditorContent(form: HTMLFormElement): Promise<{ content: string; sourceFormat: "markdown" | "html"; sourceOrigin: string } | null> {
    const components = (window as unknown as { $components?: { first?: (name: string) => unknown } }).$components;

    try {
        const markdownEditor = components?.first?.("markdown-editor") as { getContent?: () => Promise<{ markdown?: string }> } | undefined;
        if (markdownEditor?.getContent) {
            const markdownContent = await markdownEditor.getContent();
            return {
                content: String(markdownContent?.markdown || ""),
                sourceFormat: "markdown",
                sourceOrigin: "markdown-editor-component",
            };
        }

        const wysiwygEditor = components?.first?.("wysiwyg-editor") as { getContent?: () => Promise<{ html?: string }> } | undefined;
        if (wysiwygEditor?.getContent) {
            const htmlContent = await wysiwygEditor.getContent();
            return {
                content: String(htmlContent?.html || ""),
                sourceFormat: "html",
                sourceOrigin: "wysiwyg-editor-component",
            };
        }

        const tinymceEditor = components?.first?.("wysiwyg-editor-tinymce") as { getContent?: () => Promise<{ html?: string }> } | undefined;
        if (tinymceEditor?.getContent) {
            const htmlContent = await tinymceEditor.getContent();
            return {
                content: String(htmlContent?.html || ""),
                sourceFormat: "html",
                sourceOrigin: "wysiwyg-editor-tinymce-component",
            };
        }
    } catch {
        // Fallback to direct inputs below when component APIs are unavailable.
    }

    const markdownInput = form.querySelector<HTMLTextAreaElement>('textarea[name="markdown"]');
    if (markdownInput) {
        return {
            content: markdownInput.value || "",
            sourceFormat: "markdown",
            sourceOrigin: "markdown-textarea-fallback",
        };
    }

    const htmlInput = form.querySelector<HTMLTextAreaElement>('textarea[name="html"]');
    if (htmlInput) {
        return {
            content: htmlInput.value || "",
            sourceFormat: "html",
            sourceOrigin: "html-textarea-fallback",
        };
    }

    return null;
}

function getErrorMessage(error: unknown, fallback: string): string {
    const unknownError = error as {
        response?: { data?: { error?: string; message?: string } };
        message?: string;
    };

    return unknownError?.response?.data?.error
        || unknownError?.response?.data?.message
        || unknownError?.message
        || fallback;
}

async function runConvertToTinymist(button: HTMLButtonElement): Promise<void> {
    const pageId = Number(button.dataset.pageId || "0");
    const targetUrl = String(button.dataset.targetUrl || "").trim();
    const root = document.querySelector('[component="page-editor"]') as HTMLElement | null;
    const form = root?.closest("form") as HTMLFormElement | null;
    const titleInput = root?.querySelector<HTMLInputElement>('input[name="name"]');

    if (!form || pageId <= 0 || targetUrl === "") {
        window.$events.error("Failed to prepare conversion request.");
        return;
    }

    const editorPayload = await readEditorContent(form);
    if (!editorPayload || editorPayload.content.trim() === "") {
        window.$events.error("No source content found to convert.");
        return;
    }

    button.disabled = true;
    button.setAttribute("aria-busy", "true");

    try {
        const convertResponse = await window.$http.post("/ajax/tinymist/convert-to-typst", {
            page_id: pageId,
            content: editorPayload.content,
            source_format: editorPayload.sourceFormat,
            source_origin: editorPayload.sourceOrigin,
        });

        const responseData = convertResponse?.data as { typst?: string } | undefined;
        const typst = String(responseData?.typst || "").trim();
        if (typst === "") {
            window.$events.error("Conversion returned no Typst content.");
            return;
        }

        await window.$http.put(`/ajax/page/${pageId}/save-draft`, {
            name: (titleInput?.value || "").trim(),
            tinymist: typst,
        });

        window.location.href = targetUrl;
    } catch (error) {
        window.$events.error(getErrorMessage(error, "Failed to convert page to Typst."));
    } finally {
        button.disabled = false;
        button.removeAttribute("aria-busy");
    }
}

document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    const button = target?.closest('button[data-tm-convert-to-tinymist="true"]') as HTMLButtonElement | null;
    if (!button) {
        return;
    }

    event.preventDefault();
    runConvertToTinymist(button);
});
