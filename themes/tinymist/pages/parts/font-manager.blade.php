@php
    $tinymistFontSelector = $tinymistFontSelector ?? [];
    $fonts = $tinymistFontSelector['fonts'] ?? [];
    $loadError = $tinymistFontSelector['load_error'] ?? null;
@endphp

<div component="tinymist-font-selector">
    @if($loadError)
        <p class="text-neg small mb-m">{{ $loadError }}</p>
    @endif

    @if(userCan(\BookStack\Permissions\Permission::SettingsManage))
        <div class="mb-s">
            <button type="button"
                    refs="tinymist-font-selector@refreshButton"
                    data-font-action="refresh"
                    data-refresh-url="{{ url('/ajax/tinymist/fonts/refresh') }}"
                    class="text-button text-small">{{ trans('entities.tinymist_editor_fonts_refresh') }}</button>
        </div>
    @endif

    <div class="search-box flexible mb-s" @if(count($fonts) === 0) style="display: none" @endif>
        <input refs="tinymist-font-selector@searchInput" type="text" name="tinymist-font-search" placeholder="{{ trans('entities.tinymist_editor_fonts_search_placeholder') }}">
        <button refs="tinymist-font-selector@searchButton" tabindex="-1" type="button">@icon('search')</button>
        <button refs="tinymist-font-selector@searchCancel" class="search-box-cancel text-neg" tabindex="-1" type="button" style="display: none">@icon('close')</button>
    </div>

    <div refs="tinymist-font-selector@list">
        @if(count($fonts) === 0)
            <p data-font-empty-state="true" class="text-muted small">{{ trans('entities.tinymist_editor_fonts_none') }}</p>
        @else
            @foreach($fonts as $font)
                <div class="card template-item border-card p-s mb-s tinymist-font-item"
                     tabindex="0"
                     role="button"
                     data-font-item="true"
                     data-font-name="{{ $font['name'] }}"
                     data-font-search="{{ $font['search_text'] }}"
                     aria-label="{{ trans('entities.tinymist_editor_fonts_insert_label', ['name' => $font['name']]) }}">
                    <div class="template-item-content" title="{{ trans('entities.tinymist_editor_fonts_insert') }}">
                        <div class="text-small">{{ $font['name'] }}</div>
                    </div>
                    <div class="template-item-actions">
                        <button type="button"
                                data-font-action="insert"
                                title="{{ trans('entities.tinymist_editor_fonts_insert') }}"
                                aria-label="{{ trans('entities.tinymist_editor_fonts_insert_label', ['name' => $font['name']]) }}">@icon('add')</button>
                    </div>
                </div>
            @endforeach
        @endif

        <p refs="tinymist-font-selector@noResults" class="text-muted small" hidden>{{ trans('entities.tinymist_editor_fonts_no_results') }}</p>
    </div>
</div>
