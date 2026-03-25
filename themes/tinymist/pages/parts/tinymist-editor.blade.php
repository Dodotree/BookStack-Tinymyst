@push('head')
<link rel="stylesheet" href="{{ url('/theme/tinymist/tinymist.css') }}">
<link rel="stylesheet" href="{{ url('/theme/tinymist/tinymist-svg.css') }}">
@endpush

@push('body-end')
<script type="module" src="{{ url('/theme/tinymist/tinymist.js') }}" nonce="{{ $cspNonce }}"></script>
@endpush

<!-- Theme override marker: themes/tinymist/pages/parts/tinymist-editor.blade.php -->
<div id="tinymist-editor"
    component="tinymist-editor"
    data-theme-source="tinymist-theme-override"
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
                <div class="tinymist-toolbar-title-wrap flex-container-row items-center">
                    <div class="editor-toolbar-label text-mono bold px-m py-xs">
                        <span>{{ trans('entities.pages_tinymist_editor') ?? 'Typst Editor' }}</span>
                        <select refs="tinymist-editor@fileList"
                                class="tinymist-file-select text-small"
                                aria-label="Typst files">
                            <option value="entry.typ">entry.typ</option>
                            @foreach($page->attachments as $attachment)
                                @if(!$attachment->external)
                                    @php($fileName = $attachment->getFileName())
                                    @if($fileName !== 'entry.typ')
                                        <option
                                            value="{{ $fileName }}"
                                            data-file-url="{{ $attachment->getUrl() }}"
                                        >{{ $fileName }}</option>
                                    @endif
                                @endif
                            @endforeach
                        </select>
                    </div>
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
                    <button class="text-button" type="button" data-action="openSearchReplace" title="Search & Replace">
                        @icon('search')
                    </button>
                    <button class="text-button" type="button" data-action="changeCodeMirrorSettings" title="Editor Settings">
                        @icon('settings')
                    </button>
                </div>
            </div>

            <div class="tinymist-search-panel" hidden>
                <button class="text-button tinymist-search-toggle" type="button" data-tm-search-action="toggleReplace" title="Toggle replace" aria-expanded="false" aria-label="Toggle replace">
                    <span class="when-collapsed">@icon('chevron-right')</span>
                    <span class="when-expanded">@icon('chevron-down')</span>
                </button>
                <button class="text-button tinymist-search-close-button" type="button" data-tm-search-action="close" title="Close search" aria-label="Close search">@icon('close')</button>
                <div class="tinymist-search-row tinymist-search-main-row">
                    <input type="text" data-tm-search="query" placeholder="Find" aria-label="Find">
                    <span class="tinymist-search-count text-small text-muted">0 / 0</span>
                    <button class="text-button" type="button" data-tm-search-action="previous" title="Previous match" aria-label="Previous match">@icon('sort-up')</button>
                    <button class="text-button" type="button" data-tm-search-action="next" title="Next match" aria-label="Next match">@icon('sort-down')</button>
                </div>
                <div class="tinymist-search-row tinymist-search-replace-row" hidden>
                    <input type="text" data-tm-search="replace" placeholder="Replace" aria-label="Replace">
                    <button class="text-button" type="button" data-tm-search-action="replace" title="Replace next" aria-label="Replace next">@icon('editor/replace')</button>
                    <button class="text-button" type="button" data-tm-search-action="replaceAll" title="Replace all" aria-label="Replace all">@icon('editor/replace-all')</button>
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
                <div refs="tinymist-editor@image-preview" class="tinymist-editor-image-view flex flex-fill items-center justify-center" hidden>
                    <div refs="tinymist-editor@image-preview-message" class="tinymist-editor-image-message text-muted p-m text-small">Image preview unavailable.</div>
                    <img refs="tinymist-editor@image-preview-image" class="tinymist-editor-image" alt="Attachment preview" hidden>
                </div>
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
                Preview
                <select class="tinymist-preview-mode-select text-small"
                        data-action="previewModeSelect"
                        title="Preview mode"
                        aria-label="Preview mode">
                    <option value="live-preview">Live <output role="status">Connecting...</output></option>
                    <option value="toggle-live-preview">Pause Live</option>
                </select>
            </div>
            <div class="buttons flex-container-row items-stretch">
                <button class="text-button" type="button" data-action="previewZoomOut" title="Zoom Out, hot key: Z -">
                    @icon('zoom-out')
                </button>
                <button class="text-button" type="button" data-action="previewZoomIn" title="Zoom In, hot key: Z =">
                    @icon('zoom-in')
                </button>
                <button class="text-button" type="button" data-action="previewZoomReset" title="Reset Zoom">
                    @icon('zoom-1')
                </button>
                <button class="text-button" type="button" data-action="previewScrollIntoViewToggle" title="Disable Scroll Into View" aria-pressed="true">
                    @icon('editor/auto-scroll')
                </button>
                <button class="text-button" type="button" data-action="previewPanToggle" title="Enable Hand Tool (Hold Space to temporarily enable)" aria-pressed="false">
                    @icon('hand')
                </button>
                <button class="text-button" type="button" data-action="previewCursorSpotlightToggle" title="Disable Caret Spotlight" aria-pressed="true">
                    @icon('editor/caret-spotlight')
                </button>
            </div>
        </div>

        <div refs="tinymist-editor@preview"
            class="tinymist-preview-content flex flex-fill">
            <iframe class="tinymist-preview-pdf-frame" title="Tinymist PDF Preview" hidden>Loading...</iframe>
            @if(isset($tinymistPreview['initial_html']) && !empty($tinymistPreview['initial_html']))
            {!! $tinymistPreview['initial_html'] !!}
            @elseif(isset($model) && !empty($model->html))
            {!! $model->html !!}
            @else
            <div class="text-muted p-m">Loading preview...</div>
            @endif
        </div>

        <div class="tinymist-theme-settings-overlay" hidden>
            <div class="settings-panel" role="dialog" aria-modal="true" aria-label="Editor theme settings">
                <div class="settings-header">
                    <div class="text-mono bold">Editor Theme Settings</div>
                    <button class="text-button" type="button" data-action="closeThemeSettings" title="Close settings">
                        @icon('close')
                    </button>
                </div>

                <div class="settings-body">
                    <label class="setting-row">
                        <span class="text-muted text-small">Code Font</span>
                        <input type="text" data-tm-token="tm-font-mono" placeholder="Consolas, monospace">
                        <div class="font-status text-small text-pos"></div>
                        <div class="font-preview"></div>
                        <div class="font-probes"></div>
                    </label>

                    <label class="setting-row">
                        <span class="text-muted text-small">UI Font</span>
                        <input type="text" data-tm-token="tm-font-ui" placeholder="Segoe UI, sans-serif">
                        <div class="font-status text-small text-pos"></div>
                        <div class="font-preview"></div>
                        <div class="font-probes"></div>
                    </label>

                    <div class="settings-grid">
                    </div>
                </div>

                <div class="settings-footer">
                    <button class="text-button" type="button" data-action="resetThemeSettings">Reset</button>
                    <button class="button outline" type="button" data-action="closeThemeSettings">Done</button>
                </div>
            </div>
        </div>
    </div>
</div>

@if($errors->has('tinymist'))
<div class="text-neg text-small">{{ $errors->first('tinymist') }}</div>
@endif
