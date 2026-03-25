/**
 * Tinymist BookStack Entry Point
 *
 * This bundle is code-split from the main app.js to avoid loading
 * the Tinymist stack on every page. It's loaded only on Tinymist pages.
 */

import { TinymistEditor } from "./components/tinymist-editor";
import { TinymistAttachmentsBridge } from "./components/tinymist-attachments-bridge";
import { TinymistPackageSelector } from "./components/tinymist-package-selector";
import { TinymistFontSelector } from "./components/tinymist-font-selector";

if (window.$components) {
    window.$components.register({ TinymistEditor, TinymistPackageSelector, TinymistFontSelector });
    const tinymistElement = document.querySelector('[component="tinymist-editor"]');
    if (tinymistElement instanceof HTMLElement) {
        window.$components.init(tinymistElement);

        document.querySelectorAll('[component="tinymist-package-selector"]').forEach(element => {
            if (element instanceof HTMLElement) {
                window.$components.init(element);
            }
        });

        document.querySelectorAll('[component="tinymist-font-selector"]').forEach(element => {
            if (element instanceof HTMLElement) {
                window.$components.init(element);
            }
        });

        const attachmentsElement = document.querySelector('[component="attachments"]');
        const rawPageId = attachmentsElement?.getAttribute('option:attachments:page-id') || '0';
        const pageId = Number(rawPageId);
        if (Number.isFinite(pageId) && pageId > 0) {
            new TinymistAttachmentsBridge(pageId);
        }
    }
}

export { TinymistEditor };
