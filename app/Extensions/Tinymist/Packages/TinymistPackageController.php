<?php

declare(strict_types=1);

namespace BookStack\Extensions\Tinymist\Packages;

use BookStack\Http\Controller;
use BookStack\Permissions\Permission;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use RuntimeException;

class TinymistPackageController extends Controller
{
    public function __construct(
        protected TinymistPackageService $packages,
    ) {
        $this->middleware(Permission::SettingsManage->middleware());
    }

    public function uploadZip(Request $request): JsonResponse
    {
        $this->preventAccessInDemoMode();

        $this->validate($request, [
            'package_zip' => [
                'required',
                'file',
                'max:' . (config('app.upload_limit') * 1000),
                'mimes:zip',
            ],
        ]);

        try {
            $package = $this->packages->installZipPackage($request->file('package_zip'));
            $report = $this->packages->scanPackageDependencies($package, $request->boolean('full_scan'));

            return response()->json([
                'message' => trans('entities.tinymist_packages_upload_success', $package),
                'html' => $this->renderPackageManager($report),
            ]);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        } catch (\Throwable $exception) {
            Log::error('Tinymist package ZIP upload failed', ['error' => $exception->getMessage()]);

            return response()->json(['message' => trans('entities.tinymist_packages_request_failed')], 500);
        }
    }

    public function installGithub(Request $request): JsonResponse
    {
        $this->preventAccessInDemoMode();

        $this->validate($request, [
            'github_package_name' => ['required', 'string', 'max:255'],
            'github_package_version' => ['nullable', 'string', 'max:255'],
        ]);

        try {
            $installedPackage = $this->packages->installGithubPackage(
                (string) $request->input('github_package_name'),
                $request->filled('github_package_version') ? (string) $request->input('github_package_version') : null,
            );

            $reportPackage = $this->resolveReportPackageFromRequest($request) ?? $installedPackage;
            $report = $this->packages->scanPackageDependencies($reportPackage, $request->boolean('full_scan'));

            return response()->json([
                'message' => trans('entities.tinymist_packages_github_install_success', $installedPackage),
                'html' => $this->renderPackageManager($report),
            ]);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        } catch (\Throwable $exception) {
            Log::error('Tinymist GitHub package install failed', ['error' => $exception->getMessage()]);

            return response()->json(['message' => trans('entities.tinymist_packages_request_failed')], 500);
        }
    }

    public function dependencyReport(Request $request): JsonResponse
    {
        $this->preventAccessInDemoMode();

        try {
            $package = $this->resolveRequiredReportPackageFromRequest($request);
            $report = $this->packages->scanPackageDependencies($package, $request->boolean('full_scan'));

            return response()->json([
                'message' => $report['full_scan']
                    ? trans('entities.tinymist_packages_dependencies_full_scan_success')
                    : trans('entities.tinymist_packages_dependencies_scan_success'),
                'html' => $this->renderPackageManager($report),
            ]);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        } catch (\Throwable $exception) {
            Log::error('Tinymist dependency report failed', ['error' => $exception->getMessage()]);

            return response()->json(['message' => trans('entities.tinymist_packages_request_failed')], 500);
        }
    }

    public function dependencyInstall(Request $request): JsonResponse
    {
        $this->preventAccessInDemoMode();

        $this->validate($request, [
            'github_package_name' => ['required', 'string', 'max:255'],
            'github_package_version' => ['required', 'string', 'max:255'],
        ]);

        try {
            $installedPackage = $this->packages->installGithubPackage(
                (string) $request->input('github_package_name'),
                (string) $request->input('github_package_version'),
            );

            $reportPackage = $this->resolveRequiredReportPackageFromRequest($request);
            $report = $this->packages->scanPackageDependencies($reportPackage, $request->boolean('full_scan'));
            $report['last_install_result'] = [
                'installed_packages' => [$installedPackage],
                'failed_installs' => [],
            ];

            return response()->json([
                'message' => trans('entities.tinymist_packages_github_install_success', $installedPackage),
                'html' => $this->renderPackageManager($report),
            ]);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        } catch (\Throwable $exception) {
            Log::error('Tinymist dependency install failed', ['error' => $exception->getMessage()]);

            return response()->json(['message' => trans('entities.tinymist_packages_request_failed')], 500);
        }
    }

    public function dependencyInstallAll(Request $request): JsonResponse
    {
        $this->preventAccessInDemoMode();

        try {
            $reportPackage = $this->resolveRequiredReportPackageFromRequest($request);
            $result = $this->packages->installAllDependencies($reportPackage);

            return response()->json([
                'message' => trans('entities.tinymist_packages_github_install_all_success', [
                    'count' => count($result['installed_packages']),
                ]),
                'html' => $this->renderPackageManager($result['report']),
            ]);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        } catch (\Throwable $exception) {
            Log::error('Tinymist recursive dependency install failed', ['error' => $exception->getMessage()]);

            return response()->json(['message' => trans('entities.tinymist_packages_request_failed')], 500);
        }
    }

    public function refreshGithub(Request $request): JsonResponse
    {
        $this->preventAccessInDemoMode();

        try {
            $this->packages->refreshGithubRepository();

            $reportPackage = $this->resolveReportPackageFromRequest($request);
            $report = $reportPackage === null ? null : $this->packages->scanPackageDependencies($reportPackage, $request->boolean('full_scan'));

            return response()->json([
                'message' => trans('entities.tinymist_packages_github_refresh_success'),
                'html' => $this->renderPackageManager($report),
            ]);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        } catch (\Throwable $exception) {
            Log::error('Tinymist GitHub refresh failed', ['error' => $exception->getMessage()]);

            return response()->json(['message' => trans('entities.tinymist_packages_request_failed')], 500);
        }
    }

    /**
     * @return array{namespace: string, name: string, version: string, path: string}|null
     */
    protected function resolveReportPackageFromRequest(Request $request): ?array
    {
        $namespace = trim((string) $request->input('report_package_namespace'));
        $name = trim((string) $request->input('report_package_name'));
        $version = trim((string) $request->input('report_package_version'));

        if ($namespace === '' || $name === '' || $version === '') {
            return null;
        }

        return $this->packages->findInstalledPackage($namespace, $name, $version);
    }

    /**
     * @return array{namespace: string, name: string, version: string, path: string}
     */
    protected function resolveRequiredReportPackageFromRequest(Request $request): array
    {
        $package = $this->resolveReportPackageFromRequest($request);
        if ($package === null) {
            throw new RuntimeException(trans('entities.tinymist_packages_report_package_missing'));
        }

        return $package;
    }

    protected function renderPackageManager(?array $dependencyReport): string
    {
        return view('settings.parts.tinymist-package-manager', $this->buildPackageManagerViewData($dependencyReport))->render();
    }

    /**
     * @return array{
     *     tinymistPackageManager: array{
     *         installed_packages: array<int, array{namespace: string, name: string, version: string, path: string}>,
     *         github_packages: array<string, array<int, string>>,
     *         load_error: string|null
     *     },
     *     dependencyReport: array|null
     * }
     */
    protected function buildPackageManagerViewData(?array $dependencyReport): array
    {
        try {
            return [
                'tinymistPackageManager' => [
                    'installed_packages' => $this->packages->listInstalledPackages(),
                    'github_packages' => $this->packages->listGithubPackages(),
                    'load_error' => null,
                ],
                'dependencyReport' => $dependencyReport,
            ];
        } catch (\Throwable $exception) {
            Log::warning('Failed to build Tinymist package manager response data', [
                'error' => $exception->getMessage(),
            ]);

            return [
                'tinymistPackageManager' => [
                    'installed_packages' => [],
                    'github_packages' => [],
                    'load_error' => $exception->getMessage(),
                ],
                'dependencyReport' => $dependencyReport,
            ];
        }
    }
}
