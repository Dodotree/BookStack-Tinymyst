@php
    $tinymistPackageManager = $tinymistPackageManager ?? [];
    $githubPackages = $tinymistPackageManager['github_packages'] ?? [];
    $installedPackages = $tinymistPackageManager['installed_packages'] ?? [];
    $githubPackagesJson = json_encode($githubPackages, JSON_HEX_TAG | JSON_HEX_APOS | JSON_HEX_AMP | JSON_HEX_QUOT);
@endphp

<div class="setting-list">
    @if(!empty($tinymistPackageManager['load_error']))
        <p class="small">{{ $tinymistPackageManager['load_error'] }}</p>
    @endif

    <div refs="tinymist-package-admin@reportState">
        @if(is_array($dependencyReport ?? null) && is_array($dependencyReport['package'] ?? null))
            <div
                data-current-report="true"
                data-report-package-namespace="{{ $dependencyReport['package']['namespace'] }}"
                data-report-package-name="{{ $dependencyReport['package']['name'] }}"
                data-report-package-version="{{ $dependencyReport['package']['version'] }}"
                data-full-scan="{{ !empty($dependencyReport['full_scan']) ? '1' : '0' }}"></div>
        @endif
    </div>

    @include('settings.parts.tinymist-package-dependency-report', ['dependencyReport' => $dependencyReport ?? null])

    <div class="grid half gap-xl mt-l">
        <div>
            <label class="setting-list-label">{{ trans('entities.tinymist_packages_upload_heading') }}</label>
            <p class="small">{{ trans('entities.tinymist_packages_upload_desc') }}</p>
        </div>
        <div>
            <form action="{{ url('/settings/customization/tinymist/packages/upload') }}" method="POST" enctype="multipart/form-data" data-tinymist-package-form="upload">
                {{ csrf_field() }}
                <div class="form-group">
                    <label for="tinymist-package-zip">{{ trans('entities.tinymist_packages_upload_file') }}</label>
                    <input id="tinymist-package-zip" type="file" name="package_zip" accept=".zip" required>
                </div>
                <button type="submit" class="button">{{ trans('entities.tinymist_packages_upload_button') }}</button>
            </form>
        </div>
    </div>

    <div class="grid half gap-xl mt-xl">
        <div>
            <label class="setting-list-label">{{ trans('entities.tinymist_packages_github_heading') }}</label>
            <p class="small">{{ trans('entities.tinymist_packages_github_desc') }}</p>
            <p class="small">{{ trans('entities.tinymist_packages_github_version_help') }}</p>
        </div>
        <div>
            <form action="{{ url('/settings/customization/tinymist/packages/github/refresh') }}" method="POST" class="mb-m" data-tinymist-package-form="refresh">
                {{ csrf_field() }}
                <button type="submit" class="button outline">{{ trans('entities.tinymist_packages_github_refresh') }}</button>
            </form>

            @if(empty($githubPackages))
                <p class="small">{{ trans('entities.tinymist_packages_github_none') }}</p>
            @else
                <div component="tinymist-package-manager"
                     option:tinymist-package-manager:package-map="{{ $githubPackagesJson ?: '{}' }}"
                     option:tinymist-package-manager:pick-version-text="{{ trans('entities.tinymist_packages_github_pick_version') }}">
                    <form action="{{ url('/settings/customization/tinymist/packages/github/install') }}" method="POST" data-tinymist-package-form="install-github">
                        {{ csrf_field() }}
                        <div class="form-group">
                            <label for="tinymist-github-package-name">{{ trans('entities.tinymist_packages_github_name') }}</label>
                            <select id="tinymist-github-package-name" name="github_package_name" refs="tinymist-package-manager@packageName" required>
                                @foreach($githubPackages as $name => $versions)
                                    <option value="{{ $name }}">{{ $name }}</option>
                                @endforeach
                            </select>
                        </div>
                        <div class="form-group">
                            <label for="tinymist-github-package-version">{{ trans('entities.tinymist_packages_github_version_optional') }}</label>
                            <select id="tinymist-github-package-version" name="github_package_version" refs="tinymist-package-manager@packageVersion"></select>
                        </div>
                        <button type="submit" class="button">{{ trans('entities.tinymist_packages_github_install') }}</button>
                    </form>
                </div>
            @endif
        </div>
    </div>

    <div class="mt-xl">
        <label class="setting-list-label">{{ trans('entities.tinymist_packages_installed_heading') }}</label>
        @if(empty($installedPackages))
            <p class="small">{{ trans('entities.tinymist_packages_installed_none') }}</p>
        @else
            <ul>
                @foreach($installedPackages as $package)
                    <li class="mb-m">
                        <strong>{{ $package['namespace'] }}/{{ $package['name'] }}/{{ $package['version'] }}</strong><br>
                        <span class="small">{{ $package['path'] }}</span>
                    </li>
                @endforeach
            </ul>
        @endif
    </div>
</div>
