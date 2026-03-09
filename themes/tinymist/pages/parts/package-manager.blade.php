@php
    $tinymistPackageSelector = $tinymistPackageSelector ?? [];
    $packages = $tinymistPackageSelector['packages'] ?? [];
    $loadError = $tinymistPackageSelector['load_error'] ?? null;
    $settingsUrl = $tinymistPackageSelector['settings_url'] ?? url('/settings/customization#tinymist-packages');
@endphp

<div component="tinymist-package-selector">
    @if($loadError)
        <p class="text-neg small mb-m">{{ $loadError }}</p>
    @endif

    <p class="text-muted small mb-m">{{ trans('entities.tinymist_editor_packages_explain') }}</p>

    <div class="search-box flexible mb-m" style="display: {{ count($packages) > 0 ? 'block' : 'none' }}">
        <input refs="tinymist-package-selector@searchInput" type="text" name="tinymist-package-search" placeholder="{{ trans('entities.tinymist_editor_packages_search_placeholder') }}">
        <button refs="tinymist-package-selector@searchButton" tabindex="-1" type="button">@icon('search')</button>
        <button refs="tinymist-package-selector@searchCancel" class="search-box-cancel text-neg" tabindex="-1" type="button" style="display: none">@icon('close')</button>
    </div>

    <div refs="tinymist-package-selector@list">
        @if(count($packages) === 0)
            <p class="text-muted small">{{ trans('entities.tinymist_editor_packages_none') }}</p>
        @else
            @foreach($packages as $package)
                <div class="card template-item border-card p-m mb-m tinymist-package-item"
                     tabindex="0"
                     role="button"
                     data-package-item="true"
                     data-package-namespace="{{ $package['namespace'] }}"
                     data-package-name="{{ $package['name'] }}"
                     data-package-version="{{ $package['version'] }}"
                     data-package-search="{{ $package['search_text'] }}"
                     aria-label="{{ trans('entities.tinymist_editor_packages_insert_label', ['name' => $package['display_name'], 'version' => $package['version']]) }}">
                    <div class="template-item-content" title="{{ trans('entities.tinymist_editor_packages_insert') }}">
                        <div>{{ $package['display_name'] }}</div>
                        <div class="text-muted">{{ $package['version'] }}</div>
                        <div class="text-muted text-small">{{ $package['reference'] }}</div>
                    </div>
                    <div class="template-item-actions">
                        <button type="button"
                                data-package-action="insert"
                                title="{{ trans('entities.tinymist_editor_packages_insert') }}"
                                aria-label="{{ trans('entities.tinymist_editor_packages_insert_label', ['name' => $package['display_name'], 'version' => $package['version']]) }}">@icon('add')</button>
                    </div>
                </div>
            @endforeach

            <p refs="tinymist-package-selector@noResults" class="text-muted small" hidden>{{ trans('entities.tinymist_editor_packages_no_results') }}</p>
        @endif
    </div>

    <hr>

    @if(userCan(\BookStack\Permissions\Permission::SettingsManage))
        <p class="text-muted small mb-none">{{ trans('entities.tinymist_editor_packages_admin_hint') }} <a href="{{ $settingsUrl }}">{{ trans('entities.tinymist_editor_packages_admin_link') }}</a></p>
    @else
        <p class="text-muted small mb-none">{{ trans('entities.tinymist_editor_packages_non_admin_hint') }}</p>
    @endif
</div>
