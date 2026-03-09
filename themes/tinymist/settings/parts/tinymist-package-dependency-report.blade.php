@if(is_array($dependencyReport))
    @php
        $scannedPackage = $dependencyReport['package'] ?? null;
        $satisfiedDependencies = $dependencyReport['satisfied_dependencies'] ?? [];
        $installableDependencies = $dependencyReport['installable_dependencies'] ?? [];
        $uncheckedDependencies = $dependencyReport['unchecked_dependencies'] ?? [];
        $missingDependencies = $dependencyReport['missing_dependencies'] ?? [];
        $lastInstallResult = $dependencyReport['last_install_result'] ?? null;
        $isFullScan = !empty($dependencyReport['full_scan']);
    @endphp

    <div class="mt-l">
        <label class="setting-list-label">{{ trans('entities.tinymist_packages_dependencies_heading') }}</label>
        @if(is_array($scannedPackage))
            <p class="small">
                {{ trans('entities.tinymist_packages_dependencies_desc', [
                    'namespace' => $scannedPackage['namespace'],
                    'name' => $scannedPackage['name'],
                    'version' => $scannedPackage['version'],
                ]) }}
            </p>
        @endif

        @if(is_array($scannedPackage) && !$isFullScan)
            <div class="mt-s mb-m">
                <p class="small">{{ trans('entities.tinymist_packages_dependencies_dry_run_disclaimer') }}</p>
                <button
                    type="button"
                    class="button outline mt-s"
                    data-dependency-action="scan-full"
                    data-report-package-namespace="{{ $scannedPackage['namespace'] }}"
                    data-report-package-name="{{ $scannedPackage['name'] }}"
                    data-report-package-version="{{ $scannedPackage['version'] }}"
                    data-full-scan="1">{{ trans('entities.tinymist_packages_dependencies_scan_full_button') }}</button>
            </div>
        @elseif(!empty($dependencyReport['scanned_packages']))
            <p class="small">{{ trans('entities.tinymist_packages_dependencies_full_scan_complete', ['count' => $dependencyReport['scanned_packages']]) }}</p>
        @endif

        @if(is_array($lastInstallResult) && (!empty($lastInstallResult['installed_packages']) || !empty($lastInstallResult['failed_installs'])))
            <div class="mt-m">
                @if(!empty($lastInstallResult['installed_packages']))
                    <strong>{{ trans('entities.tinymist_packages_dependencies_install_result_heading') }}</strong>
                    <ul class="mt-s">
                        @foreach($lastInstallResult['installed_packages'] as $installedPackage)
                            <li class="mb-m">
                                <span>{{ $installedPackage['namespace'] }}/{{ $installedPackage['name'] }}/{{ $installedPackage['version'] }}</span>
                            </li>
                        @endforeach
                    </ul>
                @endif

                @if(!empty($lastInstallResult['failed_installs']))
                    <strong>{{ trans('entities.tinymist_packages_dependencies_failed_installs_heading') }}</strong>
                    <ul class="mt-s">
                        @foreach($lastInstallResult['failed_installs'] as $failedInstall)
                            <li class="mb-m">
                                <span>{{ $failedInstall['reference'] }}</span><br>
                                <span class="small">{{ $failedInstall['error'] }}</span>
                            </li>
                        @endforeach
                    </ul>
                @endif
            </div>
        @endif

        @if(($dependencyReport['dependency_count'] ?? 0) === 0)
            <p class="small">{{ trans('entities.tinymist_packages_dependencies_none') }}</p>
        @else
            @if(!empty($satisfiedDependencies))
                <div class="mt-m">
                    <strong>{{ trans('entities.tinymist_packages_dependencies_installed_heading') }}</strong>
                    <ul class="mt-s">
                        @foreach($satisfiedDependencies as $dependency)
                            <li class="mb-m">
                                <span>{{ $dependency['reference'] }}</span><br>
                                <span class="small">{{ trans('entities.tinymist_packages_dependencies_required_by', ['files' => implode(', ', $dependency['files'])]) }}</span>
                            </li>
                        @endforeach
                    </ul>
                </div>
            @endif

            @if(!empty($installableDependencies))
                <div class="mt-m">
                    <strong>{{ trans('entities.tinymist_packages_dependencies_installable_heading') }}</strong>
                    @if(is_array($scannedPackage))
                        <div class="mt-s mb-m">
                            <button
                                type="button"
                                class="button"
                                data-dependency-action="install-all"
                                data-report-package-namespace="{{ $scannedPackage['namespace'] }}"
                                data-report-package-name="{{ $scannedPackage['name'] }}"
                                data-report-package-version="{{ $scannedPackage['version'] }}"
                                data-full-scan="1">{{ trans('entities.tinymist_packages_dependencies_load_all_button') }}</button>
                        </div>
                    @endif
                    <ul class="mt-s">
                        @foreach($installableDependencies as $dependency)
                            <li class="mb-m">
                                <div><span>{{ $dependency['reference'] }}</span></div>
                                <div class="small mb-xs">{{ trans('entities.tinymist_packages_dependencies_required_by', ['files' => implode(', ', $dependency['files'])]) }}</div>
                                @if(is_array($scannedPackage))
                                    <button
                                        type="button"
                                        class="button outline"
                                        data-dependency-action="install-single"
                                        data-github-package-name="{{ $dependency['name'] }}"
                                        data-github-package-version="{{ $dependency['version'] }}"
                                        data-report-package-namespace="{{ $scannedPackage['namespace'] }}"
                                        data-report-package-name="{{ $scannedPackage['name'] }}"
                                        data-report-package-version="{{ $scannedPackage['version'] }}"
                                        data-full-scan="{{ $isFullScan ? '1' : '0' }}">{{ trans('entities.tinymist_packages_dependencies_load_button') }}</button>
                                @endif
                            </li>
                        @endforeach
                    </ul>
                </div>
            @endif

            @if(!empty($uncheckedDependencies))
                <div class="mt-m">
                    <strong>{{ trans('entities.tinymist_packages_dependencies_unchecked_heading') }}</strong>
                    <ul class="mt-s">
                        @foreach($uncheckedDependencies as $dependency)
                            <li class="mb-m">
                                <span>{{ $dependency['reference'] }}</span><br>
                                <span class="small">{{ trans('entities.tinymist_packages_dependencies_required_by', ['files' => implode(', ', $dependency['files'])]) }}</span>
                            </li>
                        @endforeach
                    </ul>
                </div>
            @endif

            @if(!empty($missingDependencies))
                <div class="mt-m">
                    <strong>{{ trans('entities.tinymist_packages_dependencies_missing_heading') }}</strong>
                    <ul class="mt-s">
                        @foreach($missingDependencies as $dependency)
                            <li class="mb-m">
                                <span>{{ $dependency['reference'] }}</span><br>
                                <span class="small">{{ trans('entities.tinymist_packages_dependencies_required_by', ['files' => implode(', ', $dependency['files'])]) }}</span>
                            </li>
                        @endforeach
                    </ul>
                </div>
            @endif

            @if(!empty($dependencyReport['github_index_error']))
                <p class="small mt-m">{{ trans('entities.tinymist_packages_dependencies_github_lookup_failed', ['error' => $dependencyReport['github_index_error']]) }}</p>
            @endif
        @endif
    </div>
@endif
