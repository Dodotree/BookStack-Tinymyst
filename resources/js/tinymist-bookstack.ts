/**
 * Tinymist BookStack Entry Point
 *
 * This bundle is code-split from the main app.js to avoid loading
 * the Tinymist stack on every page. It's loaded only on Tinymist pages.
 */

import { TinymistEditor } from "./components/tinymist-editor";

if (window.$components) {
    window.$components.register({ TinymistEditor });
    const tinymistElement = document.querySelector('[component="tinymist-editor"]');
    if (tinymistElement instanceof HTMLElement) {
        window.$components.init(tinymistElement);
    }
}

export { TinymistEditor };
