/**
 * Tinymist Editor Entry Point
 *
 * This bundle is code-split from the main app.js to avoid loading
 * the 1.3MB WASM module on every page. It's only loaded on pages
 * that use the Tinymist editor.
 */

import { TinymistEditor } from '../components/tinymist-editor';

if (window.$components) {
    window.$components.register({TinymistEditor});
    window.$components.init();
}

export { TinymistEditor };
