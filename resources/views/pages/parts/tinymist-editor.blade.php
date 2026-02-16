@push('body-end')
<script type="module" src="{{ versioned_asset('dist/tinymist.js') }}" nonce="{{ $cspNonce }}"></script>
@endpush

<div id="tinymist-editor"
    component="tinymist-editor"
    option:tinymist-editor:page-id="{{ $page->id }}"
    option:tinymist-editor:use-web-socket="true"
    @if(isset($tinymistPreview) && $tinymistPreview)
        @if(!empty($tinymistPreview['ws_token']))
    option:tinymist-editor:ws-token="{{ $tinymistPreview['ws_token'] }}"
        @endif
    @endif
    class="flex-container-row code-fill">

    {{-- Left Side: Editor + Console --}}
    <div class="tinymist-left-column flex-container-column">
        {{-- Editor Pane --}}
        <div class="tinymist-editor-pane flex-fill flex-container-column">
            <div class="editor-toolbar flex-container-row items-stretch justify-space-between">
                <div class="editor-toolbar-label text-mono bold px-m py-xs">
                    <span>{{ trans('entities.pages_tinymist_editor') ?? 'Typst Editor' }}</span>
                </div>
                <div class="buttons flex-container-row items-stretch">
                    <button class="text-button" type="button" data-action="insertImage" title="Insert Image">
                        @icon('image')
                    </button>
                    <button class="text-button" type="button" data-action="insertLink" title="Insert Link">
                        @icon('editor/link')
                    </button>
                    <button class="text-button" type="button" data-action="insertHeading" title="Insert Heading">
                        @icon('editor/header')
                    </button>
                    <button class="text-button" type="button" data-action="insertBold" title="Bold">
                        @icon('editor/bold')
                    </button>
                    <button class="text-button" type="button" data-action="insertItalic" title="Italic">
                        @icon('editor/italic')
                    </button>
                    <button class="text-button" type="button" data-action="insertMath" title="Math Formula">
                        @icon('editor/paragraph')
                    </button>
                    <button class="text-button" type="button" data-action="insertCodeBlock" title="Code Block">
                        @icon('editor/code-block')
                    </button>
                    <button class="text-button" type="button" data-action="changeCodeMirrorSettings" title="Editor Settings">
                        @icon('settings')
                    </button>
                </div>
            </div>

            <div class="flex flex-fill" dir="ltr">
                <textarea id="tinymist-editor-input"
                    refs="tinymist-editor@editor"
                    @if($errors->has('tinymist')) class="text-neg" @endif
                          name="tinymist"
                          rows="20"
                          class="tinymist-source-editor"
                          placeholder="Enter Typst source code here...">@if(isset($model) || old('tinymist')){{ old('tinymist') ?? $model->markdown ?? '' }}@endif</textarea>
            </div>
        </div>

        {{-- Horizontal Divider (between editor and console) --}}
        <div class="tinymist-panel-divider-horizontal"></div>

        {{-- Console Panel --}}
        <div id="tinymist-console-panel" class="tinymist-console-panel flex-container-column">
            <div class="editor-toolbar flex-container-row items-stretch justify-space-between">
                <div class="editor-toolbar-label text-mono bold px-m py-xs">
                    <span>{{ trans('entities.pages_tinymist_console') ?? 'Console' }}</span>
                </div>
                <div class="buttons flex-container-row items-stretch">
                    <button class="text-button" type="button" data-action="toggleConsole" title="Collapse Console" aria-expanded="true" aria-controls="tinymist-console-panel">
                        @icon('chevron-down')
                    </button>
                    <button class="text-button" type="button" data-action="clearConsole" title="Clear Console">
                        @icon('delete')
                    </button>
                </div>
            </div>

            <div refs="tinymist-editor@console"
                class="tinymist-console-content flex flex-fill">
                <div class="text-muted p-m text-small">Ready. Waiting for compilation...</div>
            </div>
        </div>
    </div>

    {{-- Vertical Divider (between left column and preview) --}}
    <div class="tinymist-panel-divider-vertical"></div>

    {{-- Right Side: Preview (full height) --}}
    <div class="tinymist-preview-pane flex-container-column">
        <div class="editor-toolbar flex-container-row items-stretch justify-space-between">
            <div class="editor-toolbar-label text-mono bold px-m py-xs">
                <span>{{ trans('entities.pages_tinymist_preview') ?? 'Live Preview' }}</span>
            </div>
            <div class="buttons flex-container-row items-stretch">
                <button class="text-button" type="button" data-action="previewZoomOut" title="Zoom Out">
                    @icon('zoom-out')
                </button>
                <button class="text-button" type="button" data-action="previewZoomIn" title="Zoom In">
                    @icon('zoom-in')
                </button>
                <button class="text-button" type="button" data-action="previewZoomReset" title="Reset Zoom">
                    @icon('zoom-1')
                </button>
                <button class="text-button" type="button" data-action="previewPanToggle" title="Enable Hand Tool" aria-pressed="false">
                    @icon('hand')
                </button>
            </div>
        </div>

        <div refs="tinymist-editor@preview"
            class="tinymist-preview-content flex flex-fill">
            @if(isset($model) && !empty($model->html))
            {!! $model->html !!}
            @else
            <div class="text-muted p-m">Loading preview...</div>
            @endif
        </div>
    </div>
</div>

<style>
    /* Match markdown editor structure */

    .title-input.page-title input[type="text"] {
        max-width: 100%;
    }

    /* Main container - horizontal layout (left column + preview) */
    #tinymist-editor {
        display: flex;
        flex-direction: row;
        width: 100%;
        height: 100%;
    }

    /* Left column (Editor + Console) - 50% width */
    .tinymist-left-column {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
        overflow: hidden;
    }

    /* Editor Pane (top of left column) - 2/3 height */
    .tinymist-editor-pane {
        border-top: 1px solid #ddd;
        border-bottom: 1px solid #ddd;
        position: relative;
        flex: 2;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    html.dark-mode .tinymist-editor-pane {
        border-color: #000;
    }

    /* Console Panel (bottom of left column) - 1/3 height */
    .tinymist-console-panel {
        border-top: 1px solid #ddd;
        border-bottom: 1px solid #ddd;
        flex: 1;
        min-height: 150px;
        display: flex;
        flex-direction: column;
        position: relative;
        overflow: hidden;
    }

    #tinymist-editor.tinymist-console-collapsed .tinymist-console-panel {
        flex: 0 0 auto;
        min-height: 0;
    }

    #tinymist-editor.tinymist-console-collapsed .tinymist-console-content {
        display: none;
    }

    #tinymist-editor.tinymist-console-collapsed .tinymist-panel-divider-horizontal {
        display: none;
    }

    html.dark-mode .tinymist-console-panel {
        border-color: #000;
    }

    /* Preview Pane (right side, full height) - 50% width */
    .tinymist-preview-pane {
        border-top: 1px solid #ddd;
        border-bottom: 1px solid #ddd;
        flex-basis: 50%;
        flex-shrink: 0;
        flex-grow: 0;
        min-width: 0;
        display: flex;
        flex-direction: column;
        position: relative;
        overflow: hidden;
    }

    html.dark-mode .tinymist-preview-pane {
        border-color: #000;
    }

    /* Vertical divider (between left column and preview) */
    .tinymist-panel-divider-vertical {
        width: 2px;
        background-color: #ddd;
        cursor: col-resize;
        flex-shrink: 0;
    }

    html.dark-mode .tinymist-panel-divider-vertical {
        background-color: #000;
    }

    /* Horizontal divider (between editor and console in left column) */
    .tinymist-panel-divider-horizontal {
        height: 2px;
        background-color: #ddd;
        cursor: row-resize;
        flex-shrink: 0;
    }

    html.dark-mode .tinymist-panel-divider-horizontal {
        background-color: #000;
    }

    /* Fix textarea wrapper to fill height */
    .tinymist-editor-pane>.flex.flex-fill {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: auto;
    }

    /* Textarea editor */
    .tinymist-source-editor {
        flex: 1;
        width: 100%;
        min-height: 200px;
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
        font-size: 14px;
        line-height: 1.6;
        padding: 12px;
        border: none;
        resize: none;
        margin: 0;
    }

    .tinymist-source-editor:focus {
        outline: 2px solid #0288d1;
        outline-offset: -2px;
    }

    /* CodeMirror editor styling */
    .tinymist-editor-pane .cm-editor {
        flex: 1;
        font-size: 14px;
        border: none;
    }

    .tinymist-editor-pane .cm-scroller {
        overflow: auto;
    }

    /* Dark mode for CodeMirror */
    html.dark-mode .tinymist-editor-pane .cm-editor {
        background-color: #1e1e1e;
        color: #d4d4d4;
    }

    html.dark-mode .tinymist-editor-pane .cm-content {
        caret-color: #ffffff;
        /* Bright white cursor */
    }

    html.dark-mode .tinymist-editor-pane .cm-gutters {
        background-color: #252526;
        color: #858585;
        border-right: 1px solid #3e3e42;
    }

    html.dark-mode .tinymist-editor-pane .cm-activeLineGutter {
        background-color: #2a2a2a;
        color: #c6c6c6;
    }

    html.dark-mode .tinymist-editor-pane .cm-activeLine {
        background-color: #2a2d2e;
    }

    html.dark-mode .tinymist-editor-pane .cm-selectionBackground {
        background-color: #264f78 !important;
    }

    html.dark-mode .tinymist-editor-pane .cm-focused .cm-selectionBackground {
        background-color: #264f78 !important;
    }

    /* Light mode active line */
    .tinymist-editor-pane .cm-activeLine {
        background-color: #f5f5f5;
    }

    .tinymist-editor-pane .cm-activeLineGutter {
        background-color: #e8e8e8;
    }

    /* Preview content area - scrollable */
    .tinymist-preview-content {
        flex: 1;
        padding: 20px;
        overflow: auto;
        background-color: #fff;
    }



    .tinymist-preview-content.loading {
        opacity: 0.6;
        pointer-events: none;
    }

    .tinymist-preview-content.tinymist-preview-pan-enabled {
        cursor: grab;
    }

    .tinymist-preview-content.tinymist-preview-panning {
        cursor: grabbing;
    }

    /* SVG output - fill panel width, scrollable height */
    .tinymist-preview-content svg {
        width: 100%;
        max-width: none;
        /* Fill available width */
        display: block;
        margin: 0;
    }

    /* Invert SVG colors in dark mode for better readability */
    html.dark-mode .tinymist-preview-content {
        background-color: #222;
    }
    html.dark-mode .tinymist-preview-content svg {
        filter: invert(1) hue-rotate(180deg);
    }
    /* Inverting only the text and shapes makes them blurry, for now images are double inverted */
    html.dark-mode .tinymist-preview-content svg image{
        filter: invert(1) hue-rotate(180deg);
    }


    /* Console content area - scrollable */
    .tinymist-console-content {
        flex: 1;
        padding: 8px 12px;
        overflow: auto;
        background-color: #fff;
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
        font-size: 12px;
        line-height: 1.5;
        display: block;
        /* Override flex to show messages in rows */
    }

    html.dark-mode .tinymist-console-content {
        background-color: #1a1a1a;
        color: #ddd;
    }

    .tinymist-console-panel button[data-action="toggleConsole"] svg {
        transition: transform 0.15s ease-in-out;
    }

    #tinymist-editor.tinymist-console-collapsed .tinymist-console-panel button[data-action="toggleConsole"] svg {
        transform: rotate(180deg);
    }

    /* Console message types */
    .console-message {
        display: block;
        /* Ensure each message is on its own row */
        padding: 6px 8px;
        margin: 4px 0;
        border-left: 3px solid transparent;
    }

    .console-message pre {
        display: inline;
        /* Keep pre inline with timestamp */
        margin: 0;
        font-family: inherit;
        font-size: inherit;
        white-space: pre-wrap;
        /* Preserve line breaks and wrap */
        word-wrap: break-word;
    }

    .console-message.error {
        color: #d32f2f;
        border-left-color: #d32f2f;
    }

    html.dark-mode .console-message.error {
        color: #ff6b6b;
        border-left-color: #ff6b6b;
    }

    .console-message.warning {
        color: #f57c00;
        border-left-color: #f57c00;
    }

    html.dark-mode .console-message.warning {
        color: #ffa726;
        border-left-color: #ffa726;
    }

    .console-message.info {
        color: #0288d1;
        border-left-color: #0288d1;
    }

    html.dark-mode .console-message.info {
        color: #4fc3f7;
        border-left-color: #4fc3f7;
    }

    .console-message.success {
        color: #388e3c;
        border-left-color: #388e3c;
    }

    html.dark-mode .console-message.success {
        color: #66bb6a;
        border-left-color: #66bb6a;
    }

    /* Semantic token highlighting (Tinymist) */
    .tinymist-highlight { color: inherit; }
    .tinymist-highlight-comment { color: #808080; }
    .tinymist-highlight-string { color: #52BE80; }
    .tinymist-highlight-keyword { color: #BB8FCE; }
    .tinymist-highlight-operator { color: #E06C75; }
    .tinymist-highlight-number { color: #D6863E; }
    .tinymist-highlight-function,
    .tinymist-highlight-method,
    .tinymist-highlight-macro,
    .tinymist-highlight-decorator { color: #5DADE2; }
    .tinymist-highlight-type,
    .tinymist-highlight-class,
    .tinymist-highlight-enum,
    .tinymist-highlight-interface,
    .tinymist-highlight-struct,
    .tinymist-highlight-typeParameter,
    .tinymist-highlight-namespace { color: #56B6C2; }
    .tinymist-highlight-variable,
    .tinymist-highlight-property,
    .tinymist-highlight-enumMember,
    .tinymist-highlight-parameter,
    .tinymist-highlight-label,
    .tinymist-highlight-term { color: #E5C07B; }
    .tinymist-highlight-punct,
    .tinymist-highlight-delim { color: #D19A66; }
    .tinymist-highlight-bool,
    .tinymist-highlight-pol { color: #C678DD; }
    .tinymist-highlight-escape,
    .tinymist-highlight-raw,
    .tinymist-highlight-marker { color: #E06C75; }
    .tinymist-highlight-link,
    .tinymist-highlight-ref,
    .tinymist-highlight-heading { color: #61AFEF; }
    .tinymist-highlight-error { color: #E74C3C; }
    .tinymist-highlight-text { color: inherit; }

    .tinymist-mod-strong { font-weight: bold; }
    .tinymist-mod-emph { font-style: italic; }
    .tinymist-mod-math { background-color: #0b3049ff; }
    .tinymist-mod-readonly { pointer-events: none; opacity: 0.6; }
    .tinymist-mod-static { background-color: #333355; }
    .tinymist-mod-defaultLibrary { background-color: #333333; }

    /* Legacy error container (kept for compatibility) */
    .tinymist-error-container {
        background: #fee;
        border-bottom: 1px solid #f88;
    }

    html.dark-mode .tinymist-error-container {
        background: #422;
        border-bottom-color: #811;
        color: #fcc;
    }

    /* Mobile/Portrait mode - stack all three panels vertically */
    @media (max-width: 1000px) {
        #tinymist-editor {
            flex-direction: column;
        }

        .tinymist-left-column {
            width: 100%;
            flex: 6;
        }

        .tinymist-editor-pane {
            min-height: 250px;
            flex: 1;
        }

        .tinymist-console-panel {
            flex: 1;
            min-height: 200px;
        }

        .tinymist-preview-pane {
            width: 100%;
            flex-basis: auto !important;
            min-height: 250px;
            flex: 4;
        }

        .tinymist-panel-divider-vertical {
            display: none;
        }

        .tinymist-panel-divider-horizontal {
            height: 2px;
        }
    }

    /* Typst preview SVG styles from typst.svg.css           */
    /* that is appended to the SVG output on each iteration  */
    /* Included here to avoid load on each iteration         */

    .typst-text {
        pointer-events: bounding-box;
    }

    .tsel span,
    .tsel {
        left: 0;
        position: fixed;
        text-align: justify;
        white-space: nowrap;
        width: 100%;
        height: 100%;
        text-align-last: justify;
        color: transparent;
        white-space: pre;
    }

    .tsel span::-moz-selection,
    .tsel::-moz-selection {
        color: transparent;
        background: #7db9dea0;
    }

    .tsel span::selection,
    .tsel::selection {
        color: transparent;
        background: #7db9dea0;
    }

    .pseudo-link {
        fill: transparent;
        cursor: pointer;
        pointer-events: all;
    }

    svg {
        fill: none;
    }

    .outline_glyph path,
    path.outline_glyph {
        fill: var(--glyph_fill);
        stroke: var(--glyph_stroke);
    }

    .outline_glyph path,
    path.outline_glyph {
        transition: 0.2s fill stroke;
    }

    .hover .typst-text {
        --glyph_fill: #66bab7;
        --glyph_stroke: #66bab7;
    }

    .typst-jump-ripple,
    .typst-debug-react-ripple {
        width: 0;
        height: 0;
        background-color: transparent;
        position: absolute;
        border-radius: 50%;
    }

    .typst-jump-ripple {
        border: 1px solid #66bab7;
    }

    .typst-debug-react-ripple {
        border: 1px solid #cb1b45;
    }

    @keyframes typst-jump-ripple-effect {
        to {
            width: 10vw;
            height: 10vw;
            opacity: 0.01;
            margin: -5vw;
        }
    }

    @keyframes typst-debug-react-ripple-effect {
        to {
            width: 3vw;
            height: 3vw;
            opacity: 0.01;
            margin: -1.5vw;
        }
    }
</style>

@if($errors->has('tinymist'))
<div class="text-neg text-small">{{ $errors->first('tinymist') }}</div>
@endif
