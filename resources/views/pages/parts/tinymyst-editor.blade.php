<div id="tinymyst-editor"
     component="tinymyst-editor"
     class="flex-container-column code-fill">

    {{-- Top Row: Editor and Preview (70% height in landscape) --}}
    <div class="tinymyst-top-row flex-container-row items-stretch">
        {{-- Editor Pane --}}
        <div class="tinymyst-editor-pane flex-fill flex-container-column">
            <div class="editor-toolbar flex-container-row items-stretch justify-space-between">
                <div class="editor-toolbar-label text-mono bold px-m py-xs">
                    <span>{{ trans('entities.pages_tinymyst_editor') ?? 'Typst Editor' }}</span>
                </div>
                <div class="buttons flex-container-row items-stretch">
                    <button class="text-button" type="button" data-action="insertHeading" title="Insert Heading">
                        @icon('header')
                    </button>
                    <button class="text-button" type="button" data-action="insertBold" title="Bold">
                        <strong>B</strong>
                    </button>
                    <button class="text-button" type="button" data-action="insertItalic" title="Italic">
                        <em>I</em>
                    </button>
                    <button class="text-button" type="button" data-action="insertMath" title="Math Formula">
                        <span class="text-mono">$x$</span>
                    </button>
                </div>
            </div>

            <div class="flex flex-fill" dir="ltr">
                <textarea id="tinymyst-editor-input"
                          refs="tinymyst-editor@editor"
                          @if($errors->has('tinymyst')) class="text-neg" @endif
                          name="tinymyst"
                          rows="20"
                          class="tinymyst-source-editor"
                          placeholder="Enter Typst source code here...">@if(isset($model) || old('tinymyst')){{ old('tinymyst') ?? $model->markdown ?? '' }}@endif</textarea>
            </div>
        </div>

        {{-- Vertical Panel Divider --}}
        <div class="tinymyst-panel-divider-vertical"></div>

        {{-- Preview Pane --}}
        <div class="tinymyst-preview-pane flex-container-column">
            <div class="editor-toolbar">
                <div class="editor-toolbar-label text-mono bold px-m py-xs">
                    <span>{{ trans('entities.pages_tinymyst_preview') ?? 'Live Preview' }}</span>
                </div>
            </div>

            <div refs="tinymyst-editor@preview"
                 class="tinymyst-preview-content flex flex-fill">
                <div class="text-muted p-m">Loading preview...</div>
            </div>
        </div>
    </div>

    {{-- Horizontal Divider --}}
    <div class="tinymyst-panel-divider-horizontal"></div>

    {{-- Console Panel (30% height in landscape) --}}
    <div class="tinymyst-console-panel flex-container-column">
        <div class="editor-toolbar flex-container-row items-stretch justify-space-between">
            <div class="editor-toolbar-label text-mono bold px-m py-xs">
                <span>{{ trans('entities.pages_tinymyst_console') ?? 'Console' }}</span>
            </div>
            <div class="buttons flex-container-row items-stretch">
                <button class="text-button" type="button" data-action="clearConsole" title="Clear Console">
                    @icon('delete')
                </button>
            </div>
        </div>

        <div refs="tinymyst-editor@console"
             class="tinymyst-console-content flex flex-fill">
            <div class="text-muted p-m text-small">Ready. Waiting for compilation...</div>
        </div>
    </div>
</div>

<style>
    /* Match markdown editor structure */

    .title-input.page-title input[type="text"] {
        max-width: 100%;
    }

    /* Main container - vertical stack in landscape */
    #tinymyst-editor {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
    }

    /* Top row (Editor + Preview) - 70% height */
    .tinymyst-top-row {
        display: flex;
        flex-direction: row;
        flex: 7;
        min-height: 0;
        overflow: hidden;
    }

    /* Editor Pane (left side of top row) */
    .tinymyst-editor-pane {
        border-top: 1px solid #ddd;
        border-bottom: 1px solid #ddd;
        position: relative;
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    html.dark-mode .tinymyst-editor-pane {
        border-color: #000;
    }

    /* Preview Pane (right side of top row) */
    .tinymyst-preview-pane {
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

    html.dark-mode .tinymyst-preview-pane {
        border-color: #000;
    }

    /* Console Panel (bottom) - 30% height */
    .tinymyst-console-panel {
        border-top: 1px solid #ddd;
        border-bottom: 1px solid #ddd;
        flex: 3;
        min-height: 150px;
        display: flex;
        flex-direction: column;
        position: relative;
        overflow: hidden;
    }

    html.dark-mode .tinymyst-console-panel {
        border-color: #000;
    }

    /* Vertical divider (between editor and preview) */
    .tinymyst-panel-divider-vertical {
        width: 2px;
        background-color: #ddd;
        cursor: col-resize;
        flex-shrink: 0;
    }

    html.dark-mode .tinymyst-panel-divider-vertical {
        background-color: #000;
    }

    /* Horizontal divider (between top row and console) */
    .tinymyst-panel-divider-horizontal {
        height: 2px;
        background-color: #ddd;
        cursor: row-resize;
        flex-shrink: 0;
    }

    html.dark-mode .tinymyst-panel-divider-horizontal {
        background-color: #000;
    }

    /* Fix textarea wrapper to fill height */
    .tinymyst-editor-pane > .flex.flex-fill {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: auto;
    }

    /* Textarea editor */
    .tinymyst-source-editor {
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

    .tinymyst-source-editor:focus {
        outline: 2px solid #0288d1;
        outline-offset: -2px;
    }

    /* CodeMirror editor styling */
    .tinymyst-editor-pane .cm-editor {
        flex: 1;
        font-size: 14px;
        border: none;
    }

    .tinymyst-editor-pane .cm-scroller {
        overflow: auto;
    }

    /* Dark mode for CodeMirror */
    html.dark-mode .tinymyst-editor-pane .cm-editor {
        background-color: #1e1e1e;
        color: #d4d4d4;
    }

    html.dark-mode .tinymyst-editor-pane .cm-content {
        caret-color: #ffffff; /* Bright white cursor */
    }

    html.dark-mode .tinymyst-editor-pane .cm-gutters {
        background-color: #252526;
        color: #858585;
        border-right: 1px solid #3e3e42;
    }

    html.dark-mode .tinymyst-editor-pane .cm-activeLineGutter {
        background-color: #2a2a2a;
        color: #c6c6c6;
    }

    html.dark-mode .tinymyst-editor-pane .cm-activeLine {
        background-color: #2a2d2e;
    }

    html.dark-mode .tinymyst-editor-pane .cm-selectionBackground {
        background-color: #264f78 !important;
    }

    html.dark-mode .tinymyst-editor-pane .cm-focused .cm-selectionBackground {
        background-color: #264f78 !important;
    }

    /* Light mode active line */
    .tinymyst-editor-pane .cm-activeLine {
        background-color: #f5f5f5;
    }

    .tinymyst-editor-pane .cm-activeLineGutter {
        background-color: #e8e8e8;
    }

    /* Preview content area - scrollable */
    .tinymyst-preview-content {
        flex: 1;
        padding: 20px;
        overflow: auto;
        background-color: #fff;
    }

    html.dark-mode .tinymyst-preview-content {
        background-color: #222;
    }

    .tinymyst-preview-content.loading {
        opacity: 0.6;
        pointer-events: none;
    }

    /* SVG output - fill panel width, scrollable height */
    .tinymyst-preview-content svg {
        width: 100%;        /* Fill available width */
        display: block;
        margin: 0;
    }

    /* Invert SVG colors in dark mode for better readability */
    html.dark-mode .tinymyst-preview-content svg {
        filter: invert(1) hue-rotate(180deg);
    }

    /* Console content area - scrollable */
    .tinymyst-console-content {
        flex: 1;
        padding: 8px 12px;
        overflow: auto;
        background-color: #fff;
        font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
        font-size: 12px;
        line-height: 1.5;
        display: block; /* Override flex to show messages in rows */
    }

    html.dark-mode .tinymyst-console-content {
        background-color: #1a1a1a;
        color: #ddd;
    }

    /* Console message types */
    .console-message {
        display: block; /* Ensure each message is on its own row */
        padding: 6px 8px;
        margin: 4px 0;
        border-left: 3px solid transparent;
    }

    .console-message pre {
        display: inline; /* Keep pre inline with timestamp */
        margin: 0;
        font-family: inherit;
        font-size: inherit;
        white-space: pre-wrap; /* Preserve line breaks and wrap */
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

    /* Legacy error container (kept for compatibility) */
    .tinymyst-error-container {
        background: #fee;
        border-bottom: 1px solid #f88;
    }

    html.dark-mode .tinymyst-error-container {
        background: #422;
        border-bottom-color: #811;
        color: #fcc;
    }

    /* Mobile/Portrait mode - stack all three panels vertically */
    @media (max-width: 1000px) {
        .tinymyst-top-row {
            flex-direction: column;
            flex: 6;
        }

        .tinymyst-editor-pane,
        .tinymyst-preview-pane {
            width: 100%;
            flex-basis: auto !important;
            min-height: 250px;
            flex: 1;
        }

        .tinymyst-console-panel {
            flex: 4;
            min-height: 200px;
        }

        .tinymyst-panel-divider-vertical {
            display: none;
        }

        .tinymyst-panel-divider-horizontal {
            height: 2px;
        }
    }
</style>

@if($errors->has('tinymyst'))
    <div class="text-neg text-small">{{ $errors->first('tinymyst') }}</div>
@endif
