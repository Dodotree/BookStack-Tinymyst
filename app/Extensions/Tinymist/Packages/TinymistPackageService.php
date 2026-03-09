<?php

declare(strict_types=1);

namespace BookStack\Extensions\Tinymist\Packages;

use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use RuntimeException;
use Symfony\Component\HttpFoundation\File\UploadedFile;
use Symfony\Component\Process\Process;
use ZipArchive;

class TinymistPackageService
{
    protected const MAX_ZIP_FILES = 1000;
    protected const GIT_ENV_KEYS = [
        'PATH',
        'HOME',
        'USERPROFILE',
        'HOMEDRIVE',
        'HOMEPATH',
        'TMP',
        'TEMP',
        'SystemRoot',
        'ComSpec',
        'PATHEXT',
        'MSYSTEM',
        'LANG',
        'LC_ALL',
    ];

    /**
     * @return array<int, array{namespace: string, name: string, version: string, path: string}>
     */
    public function listInstalledPackages(): array
    {
        $packages = [];
        $root = $this->getPackagesRootPath();
        if (!is_dir($root)) {
            return [];
        }

        foreach (scandir($root) ?: [] as $namespace) {
            if ($namespace === '.' || $namespace === '..') {
                continue;
            }

            $namespacePath = $root . DIRECTORY_SEPARATOR . $namespace;
            if (!is_dir($namespacePath)) {
                continue;
            }

            foreach (scandir($namespacePath) ?: [] as $name) {
                if ($name === '.' || $name === '..') {
                    continue;
                }

                $namePath = $namespacePath . DIRECTORY_SEPARATOR . $name;
                if (!is_dir($namePath)) {
                    continue;
                }

                foreach (scandir($namePath) ?: [] as $version) {
                    if ($version === '.' || $version === '..') {
                        continue;
                    }

                    $versionPath = $namePath . DIRECTORY_SEPARATOR . $version;
                    if (!is_dir($versionPath) || !is_file($versionPath . DIRECTORY_SEPARATOR . 'typst.toml')) {
                        continue;
                    }

                    $packages[] = [
                        'namespace' => $namespace,
                        'name' => $name,
                        'version' => $version,
                        'path' => $versionPath,
                    ];
                }
            }
        }

        usort($packages, function (array $a, array $b): int {
            return [$a['namespace'], $a['name'], $a['version']] <=> [$b['namespace'], $b['name'], $b['version']];
        });

        return $packages;
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function listGithubPackages(): array
    {
        if (!$this->hasGithubRepo()) {
            return [];
        }

        $branch = $this->getGithubBranch();
        $output = $this->runGitCommand([
            'ls-tree',
            '-r',
            '--name-only',
            'origin/' . $branch,
            'packages/preview',
        ], $this->getGithubRepoPath());

        $packages = [];
        foreach (preg_split('/\r?\n/', $output) as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }

            if (!preg_match('#^packages/preview/([^/]+)/([^/]+)/typst\.toml$#', $line, $matches)) {
                continue;
            }

            $name = $matches[1];
            $version = $matches[2];
            $packages[$name] ??= [];
            $packages[$name][] = $version;
        }

        ksort($packages, SORT_NATURAL | SORT_FLAG_CASE);
        foreach ($packages as &$versions) {
            $versions = array_values(array_unique($versions));
            usort($versions, [$this, 'compareVersionsDescending']);
        }

        return $packages;
    }

    /**
     * @return array{namespace: string, name: string, version: string, path: string}
     */
    public function installGithubPackage(string $name, ?string $version = null): array
    {
        $name = $this->sanitizePackageSegment($name, 'name');

        $this->ensureGithubRepositoryExists();

        $availableVersions = $this->listGithubPackages()[$name] ?? [];
        $version = $this->resolveGithubPackageVersion($availableVersions, $version);

        $sourcePath = $this->getGithubRepoPath() . DIRECTORY_SEPARATOR . 'packages' . DIRECTORY_SEPARATOR . 'preview' . DIRECTORY_SEPARATOR . $name . DIRECTORY_SEPARATOR . $version;

        if ($this->hasGitGithubRepo()) {
            $this->runGitCommand([
                'sparse-checkout',
                'set',
                'packages/preview/' . $name . '/' . $version,
            ], $this->getGithubRepoPath());

            $this->runGitCommand([
                'reset',
                '--hard',
                'origin/' . $this->getGithubBranch(),
            ], $this->getGithubRepoPath());
        }

        if (!is_file($sourcePath . DIRECTORY_SEPARATOR . 'typst.toml')) {
            throw new RuntimeException(trans('entities.tinymist_packages_github_checkout_failed'));
        }

        $destinationPath = $this->buildInstalledPackagePath('preview', $name, $version);
        $this->replaceDirectoryWithCopy($sourcePath, $destinationPath);

        return [
            'namespace' => 'preview',
            'name' => $name,
            'version' => $version,
            'path' => $destinationPath,
        ];
    }

    public function refreshGithubRepository(): void
    {
        $repoPath = $this->getGithubRepoPath();
        $branch = $this->getGithubBranch();
        $parentPath = dirname($repoPath);
        $this->ensureDirectory($parentPath);

        if (!$this->hasGitGithubRepo()) {
            if (is_dir($repoPath) && count(scandir($repoPath) ?: []) > 2) {
                $this->deleteDirectory($repoPath);
                $this->ensureDirectory($parentPath);
            }

            $this->runGitCommand([
                'clone',
                '--depth',
                '1',
                '--filter=blob:none',
                '--sparse',
                $this->getGithubRepoUrl(),
                $repoPath,
            ], $parentPath);
        }

        $this->runGitCommand([
            'fetch',
            '--depth=1',
            '--filter=blob:none',
            'origin',
            $branch,
        ], $repoPath);

        $this->runGitCommand([
            'reset',
            '--hard',
            'origin/' . $branch,
        ], $repoPath);
    }

    /**
     * @param array{namespace: string, name: string, version: string, path: string} $package
     * @return array{
     *     package: array{namespace: string, name: string, version: string, path: string},
     *     full_scan: bool,
     *     scanned_packages: int,
     *     dependency_count: int,
     *     satisfied_dependencies: array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}>,
     *     installable_dependencies: array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}>,
     *     unchecked_dependencies: array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}>,
     *     missing_dependencies: array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}>,
     *     github_index_error: string|null,
     *     last_install_result?: array{
     *         installed_packages: array<int, array{namespace: string, name: string, version: string, path: string}>,
     *         failed_installs: array<int, array{reference: string, namespace: string, name: string, version: string, error: string}>
     *     }
     * }
     */
    public function scanPackageDependencies(array $package, bool $fullScan = false): array
    {
        $installedPackages = $this->buildPackageIndex($this->listInstalledPackages());
        $githubPackages = [];
        $githubIndexError = null;

        if ($fullScan) {
            try {
                $this->ensureGithubRepositoryExists();
                $githubPackages = $this->listGithubPackages();
            } catch (RuntimeException $exception) {
                $githubIndexError = $exception->getMessage();
            }
        }

        [$dependencies, $scannedPackages] = $this->collectPackageDependencies(
            $package,
            $installedPackages,
            $githubPackages,
            $fullScan,
            $githubIndexError,
        );

        $satisfiedDependencies = [];
        $unresolvedDependencies = [];

        foreach ($dependencies as $dependency) {
            $packageKey = $this->buildPackageKey($dependency['namespace'], $dependency['name'], $dependency['version']);
            if (isset($installedPackages[$packageKey])) {
                $satisfiedDependencies[] = $dependency;
                continue;
            }

            $unresolvedDependencies[] = $dependency;
        }

        if (!$fullScan && count($unresolvedDependencies) > 0) {
            try {
                $this->ensureGithubRepositoryExists();
                $githubPackages = $this->listGithubPackages();
            } catch (RuntimeException $exception) {
                $githubIndexError = $exception->getMessage();
            }
        }

        $installableDependencies = [];
        $uncheckedDependencies = [];
        $missingDependencies = [];

        foreach ($unresolvedDependencies as $dependency) {
            if ($githubIndexError !== null && $dependency['namespace'] === 'preview') {
                $uncheckedDependencies[] = $dependency;
                continue;
            }

            $isGithubInstallable = $dependency['namespace'] === 'preview'
                && isset($githubPackages[$dependency['name']])
                && in_array($dependency['version'], $githubPackages[$dependency['name']], true);

            if ($isGithubInstallable) {
                $installableDependencies[] = $dependency;
                continue;
            }

            $missingDependencies[] = $dependency;
        }

        $this->sortDependencyList($satisfiedDependencies);
        $this->sortDependencyList($installableDependencies);
        $this->sortDependencyList($uncheckedDependencies);
        $this->sortDependencyList($missingDependencies);

        return [
            'package' => $package,
            'full_scan' => $fullScan,
            'scanned_packages' => $scannedPackages,
            'dependency_count' => count($dependencies),
            'satisfied_dependencies' => $satisfiedDependencies,
            'installable_dependencies' => $installableDependencies,
            'unchecked_dependencies' => $uncheckedDependencies,
            'missing_dependencies' => $missingDependencies,
            'github_index_error' => $githubIndexError,
        ];
    }

    /**
     * @param array{namespace: string, name: string, version: string, path: string} $package
     * @return array{
     *     report: array{
     *         package: array{namespace: string, name: string, version: string, path: string},
     *         full_scan: bool,
     *         scanned_packages: int,
     *         dependency_count: int,
     *         satisfied_dependencies: array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}>,
     *         installable_dependencies: array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}>,
     *         unchecked_dependencies: array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}>,
     *         missing_dependencies: array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}>,
     *         github_index_error: string|null,
     *         last_install_result: array{
     *             installed_packages: array<int, array{namespace: string, name: string, version: string, path: string}>,
     *             failed_installs: array<int, array{reference: string, namespace: string, name: string, version: string, error: string}>
     *         }
     *     },
     *     installed_packages: array<int, array{namespace: string, name: string, version: string, path: string}>,
     *     failed_installs: array<int, array{reference: string, namespace: string, name: string, version: string, error: string}>
     * }
     */
    public function installAllDependencies(array $package): array
    {
        $installedPackages = [];
        $failedInstalls = [];
        $attemptedDependencies = [];

        while (true) {
            $report = $this->scanPackageDependencies($package, true);
            $dependenciesToInstall = [];

            foreach ($report['installable_dependencies'] as $dependency) {
                $dependencyKey = $this->buildPackageKey($dependency['namespace'], $dependency['name'], $dependency['version']);
                if (isset($attemptedDependencies[$dependencyKey])) {
                    continue;
                }

                $dependenciesToInstall[] = $dependency;
            }

            if (count($dependenciesToInstall) === 0) {
                break;
            }

            $installedThisRound = 0;

            foreach ($dependenciesToInstall as $dependency) {
                $dependencyKey = $this->buildPackageKey($dependency['namespace'], $dependency['name'], $dependency['version']);
                $attemptedDependencies[$dependencyKey] = true;

                try {
                    $installedPackages[$dependencyKey] = $this->installGithubPackage($dependency['name'], $dependency['version']);
                    $installedThisRound++;
                } catch (RuntimeException $exception) {
                    $failedInstalls[$dependencyKey] = [
                        'reference' => $dependency['reference'],
                        'namespace' => $dependency['namespace'],
                        'name' => $dependency['name'],
                        'version' => $dependency['version'],
                        'error' => $exception->getMessage(),
                    ];
                }
            }

            if ($installedThisRound === 0) {
                break;
            }
        }

        $report = $this->scanPackageDependencies($package, true);
        $report['last_install_result'] = [
            'installed_packages' => array_values($installedPackages),
            'failed_installs' => array_values($failedInstalls),
        ];

        return [
            'report' => $report,
            'installed_packages' => array_values($installedPackages),
            'failed_installs' => array_values($failedInstalls),
        ];
    }

    /**
     * @return array{namespace: string, name: string, version: string, path: string}
     */
    public function installZipPackage(UploadedFile $file): array
    {
        $zipPath = $file->getRealPath();
        if (!$zipPath || !is_readable($zipPath)) {
            throw new RuntimeException(trans('entities.tinymist_packages_zip_read_failed'));
        }

        $tempDir = $this->createTempDir();

        try {
            $files = $this->extractZip($zipPath, $tempDir);
            $package = $this->detectPackageFromZipFiles($files);
            $destinationPath = $this->buildInstalledPackagePath($package['namespace'], $package['name'], $package['version']);

            $this->copyExtractedPackageFiles($files, $package['root_relative'], $destinationPath);

            if (!is_file($destinationPath . DIRECTORY_SEPARATOR . 'typst.toml')) {
                throw new RuntimeException(trans('entities.tinymist_packages_zip_manifest_missing'));
            }

            return [
                'namespace' => $package['namespace'],
                'name' => $package['name'],
                'version' => $package['version'],
                'path' => $destinationPath,
            ];
        } finally {
            $this->deleteDirectory($tempDir);
        }
    }

    public function hasGithubRepo(): bool
    {
        return $this->hasGitGithubRepo();
    }

    /**
     * @return array{namespace: string, name: string, version: string, path: string}|null
     */
    public function findInstalledPackage(string $namespace, string $name, string $version): ?array
    {
        $packagePath = $this->buildInstalledPackagePath(
            $this->sanitizePackageSegment($namespace, 'name'),
            $this->sanitizePackageSegment($name, 'name'),
            $this->sanitizePackageSegment($version, 'version'),
        );

        if (!is_file($packagePath . DIRECTORY_SEPARATOR . 'typst.toml')) {
            return null;
        }

        return [
            'namespace' => $namespace,
            'name' => $name,
            'version' => $version,
            'path' => $packagePath,
        ];
    }

    public function getPackagesRootPath(): string
    {
        $configuredPath = trim((string) config('tinymist.package_path', ''));

        if ($configuredPath !== '') {
            return $configuredPath;
        }

        return storage_path('app/' . trim((string) config('tinymist.packages_storage_path', 'tinymist/packages'), '/'));
    }

    public function getGithubRepoPath(): string
    {
        return storage_path('app/' . trim((string) config('tinymist.github_packages_storage_path', 'tinymist/github/packages'), '/'));
    }

    protected function getGithubRepoUrl(): string
    {
        return (string) config('tinymist.github_packages_repo', 'https://github.com/typst/packages.git');
    }

    protected function getGithubBranch(): string
    {
        return (string) config('tinymist.github_packages_branch', 'main');
    }

    protected function hasGitGithubRepo(): bool
    {
        return is_dir($this->getGithubRepoPath() . DIRECTORY_SEPARATOR . '.git');
    }

    protected function ensureGithubRepositoryExists(): void
    {
        if (!$this->hasGithubRepo()) {
            $this->refreshGithubRepository();
        }
    }

    protected function buildInstalledPackagePath(string $namespace, string $name, string $version): string
    {
        return $this->getPackagesRootPath()
            . DIRECTORY_SEPARATOR . $namespace
            . DIRECTORY_SEPARATOR . $name
            . DIRECTORY_SEPARATOR . $version;
    }

    protected function compareVersionsDescending(string $a, string $b): int
    {
        if (preg_match('/^[0-9A-Za-z.\-_+]+$/', $a) && preg_match('/^[0-9A-Za-z.\-_+]+$/', $b)) {
            return version_compare($b, $a);
        }

        return strnatcasecmp($b, $a);
    }

    /**
     * @param array<int, string> $availableVersions
     */
    protected function resolveGithubPackageVersion(array $availableVersions, ?string $version): string
    {
        if (count($availableVersions) === 0) {
            throw new RuntimeException(trans('entities.tinymist_packages_github_version_missing'));
        }

        $version = trim((string) $version);
        if ($version === '') {
            return $availableVersions[0];
        }

        $version = $this->sanitizePackageSegment($version, 'version');
        if (!in_array($version, $availableVersions, true)) {
            throw new RuntimeException(trans('entities.tinymist_packages_github_version_missing'));
        }

        return $version;
    }

    /**
     * @return array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}>
     */
    protected function findPackageDependencies(string $packagePath): array
    {
        if (!is_dir($packagePath)) {
            return [];
        }

        $dependencies = [];
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($packagePath, \FilesystemIterator::SKIP_DOTS)
        );

        foreach ($iterator as $item) {
            if (!$item->isFile() || strtolower($item->getExtension()) !== 'typ') {
                continue;
            }

            $content = @file_get_contents($item->getPathname());
            if (!is_string($content) || $content === '') {
                continue;
            }

            if (!preg_match_all('/#\s*(?:import|include)\s+"(@[^"\r\n]+)"/i', $content, $matches)) {
                continue;
            }

            $relativePath = str_replace('\\', '/', substr($item->getPathname(), strlen($packagePath) + 1));

            foreach ($matches[1] as $reference) {
                $dependency = $this->parsePackageReference($reference);
                if ($dependency === null) {
                    continue;
                }

                $packageKey = $this->buildPackageKey($dependency['namespace'], $dependency['name'], $dependency['version']);
                if (!isset($dependencies[$packageKey])) {
                    $dependencies[$packageKey] = $dependency + ['files' => []];
                }

                if (!in_array($relativePath, $dependencies[$packageKey]['files'], true)) {
                    $dependencies[$packageKey]['files'][] = $relativePath;
                }
            }
        }

        return array_values($dependencies);
    }

    /**
     * @return array{reference: string, namespace: string, name: string, version: string}|null
     */
    protected function parsePackageReference(string $reference): ?array
    {
        if (!preg_match('/^@(?<namespace>[A-Za-z0-9._+-]+)\/(?<name>[A-Za-z0-9._+-]+):(?<version>[A-Za-z0-9._+-]+)(?:(?::|\/).*)?$/', $reference, $matches)) {
            return null;
        }

        return [
            'reference' => '@' . $matches['namespace'] . '/' . $matches['name'] . ':' . $matches['version'],
            'namespace' => $this->sanitizePackageSegment($matches['namespace'], 'name'),
            'name' => $this->sanitizePackageSegment($matches['name'], 'name'),
            'version' => $this->sanitizePackageSegment($matches['version'], 'version'),
        ];
    }

    /**
     * @param array<int, array{namespace: string, name: string, version: string, path: string}> $packages
     * @return array<string, array{namespace: string, name: string, version: string, path: string}>
     */
    protected function buildPackageIndex(array $packages): array
    {
        $index = [];

        foreach ($packages as $package) {
            $index[$this->buildPackageKey($package['namespace'], $package['name'], $package['version'])] = $package;
        }

        return $index;
    }

    protected function buildPackageKey(string $namespace, string $name, string $version): string
    {
        return strtolower($namespace . '/' . $name . '/' . $version);
    }

    /**
     * @param array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}> $dependencies
     */
    protected function sortDependencyList(array &$dependencies): void
    {
        usort($dependencies, function (array $a, array $b): int {
            return [$a['namespace'], $a['name'], $a['version']] <=> [$b['namespace'], $b['name'], $b['version']];
        });

        foreach ($dependencies as &$dependency) {
            sort($dependency['files'], SORT_NATURAL | SORT_FLAG_CASE);
        }
    }

    /**
     * @param array{namespace: string, name: string, version: string, path: string} $package
     * @param array<string, array{namespace: string, name: string, version: string, path: string}> $installedPackages
     * @param array<string, array<int, string>> $githubPackages
     * @return array{0: array<int, array{reference: string, namespace: string, name: string, version: string, files: array<int, string>}>, 1: int}
     */
    protected function collectPackageDependencies(
        array $package,
        array $installedPackages,
        array $githubPackages,
        bool $fullScan,
        ?string $githubIndexError,
    ): array {
        $rootPackageKey = $this->buildPackageKey($package['namespace'], $package['name'], $package['version']);
        $dependencyMap = [];
        $scannedPackages = [];
        $queue = [$package];

        while (count($queue) > 0) {
            /** @var array{namespace: string, name: string, version: string, path: string} $currentPackage */
            $currentPackage = array_shift($queue);
            $currentPackageKey = $this->buildPackageKey($currentPackage['namespace'], $currentPackage['name'], $currentPackage['version']);

            if (isset($scannedPackages[$currentPackageKey])) {
                continue;
            }

            $scannedPackages[$currentPackageKey] = true;

            foreach ($this->findPackageDependencies($currentPackage['path']) as $dependency) {
                $dependencyKey = $this->buildPackageKey($dependency['namespace'], $dependency['name'], $dependency['version']);
                $fileReferences = $this->formatDependencyFilesForPackage(
                    $currentPackage,
                    $dependency['files'],
                    $currentPackageKey === $rootPackageKey,
                );

                if (!isset($dependencyMap[$dependencyKey])) {
                    $dependencyMap[$dependencyKey] = $dependency + ['files' => []];
                }

                foreach ($fileReferences as $fileReference) {
                    if (!in_array($fileReference, $dependencyMap[$dependencyKey]['files'], true)) {
                        $dependencyMap[$dependencyKey]['files'][] = $fileReference;
                    }
                }

                if (!$fullScan || isset($scannedPackages[$dependencyKey])) {
                    continue;
                }

                if (isset($installedPackages[$dependencyKey])) {
                    $queue[] = $installedPackages[$dependencyKey];
                    continue;
                }

                if ($dependency['namespace'] !== 'preview' || $githubIndexError !== null) {
                    continue;
                }

                if (!isset($githubPackages[$dependency['name']]) || !in_array($dependency['version'], $githubPackages[$dependency['name']], true)) {
                    continue;
                }

                $githubPackage = $this->findGithubPackage($dependency['name'], $dependency['version']);
                if ($githubPackage !== null) {
                    $queue[] = $githubPackage;
                }
            }
        }

        return [array_values($dependencyMap), count($scannedPackages)];
    }

    /**
     * @param array<int, string> $files
     * @return array<int, string>
     */
    protected function formatDependencyFilesForPackage(array $package, array $files, bool $isRootPackage): array
    {
        if ($isRootPackage) {
            return $files;
        }

        $prefix = $package['namespace'] . '/' . $package['name'] . '/' . $package['version'] . ' :: ';

        return array_map(static fn(string $file): string => $prefix . $file, $files);
    }

    /**
     * @return array{namespace: string, name: string, version: string, path: string}|null
     */
    protected function findGithubPackage(string $name, string $version): ?array
    {
        $packagePath = $this->getGithubRepoPath()
            . DIRECTORY_SEPARATOR . 'packages'
            . DIRECTORY_SEPARATOR . 'preview'
            . DIRECTORY_SEPARATOR . $name
            . DIRECTORY_SEPARATOR . $version;

        if (!is_file($packagePath . DIRECTORY_SEPARATOR . 'typst.toml')) {
            return null;
        }

        return [
            'namespace' => 'preview',
            'name' => $name,
            'version' => $version,
            'path' => $packagePath,
        ];
    }

    /**
     * @return array<int, array{path: string, relative: string}>
     */
    protected function extractZip(string $zipPath, string $tempDir): array
    {
        $zip = new ZipArchive();
        if ($zip->open($zipPath, ZipArchive::RDONLY) !== true) {
            throw new RuntimeException(trans('entities.tinymist_packages_zip_invalid'));
        }

        $files = [];
        $totalSize = 0;
        $maxSize = (int) (config('app.upload_limit') * 1000000);

        for ($index = 0; $index < $zip->numFiles; $index++) {
            $stat = $zip->statIndex($index);
            if (!is_array($stat) || !isset($stat['name'])) {
                continue;
            }

            $name = (string) $stat['name'];
            if (str_ends_with($name, '/')) {
                continue;
            }

            $safeName = $this->sanitizeZipPath($name);
            if ($safeName === null) {
                throw new RuntimeException(trans('entities.tinymist_packages_zip_unsafe'));
            }

            if (count($files) >= self::MAX_ZIP_FILES) {
                throw new RuntimeException(trans('entities.tinymist_packages_zip_too_many'));
            }

            $size = (int) ($stat['size'] ?? 0);
            $totalSize += $size;
            if ($totalSize > $maxSize) {
                throw new RuntimeException(trans('entities.tinymist_packages_zip_too_large'));
            }

            $destPath = $tempDir . DIRECTORY_SEPARATOR . $safeName;
            $this->ensureDirectory(dirname($destPath));

            $stream = $zip->getStream($name);
            if (!$stream) {
                throw new RuntimeException(trans('entities.tinymist_packages_zip_invalid'));
            }

            $output = fopen($destPath, 'wb');
            if (!$output) {
                fclose($stream);
                throw new RuntimeException(trans('entities.tinymist_packages_zip_invalid'));
            }

            stream_copy_to_stream($stream, $output);
            fclose($stream);
            fclose($output);

            $files[] = [
                'path' => $destPath,
                'relative' => str_replace('\\', '/', $safeName),
            ];
        }

        $zip->close();

        if (count($files) === 0) {
            throw new RuntimeException(trans('entities.tinymist_packages_zip_empty'));
        }

        return $files;
    }

    /**
     * @param array<int, array{path: string, relative: string}> $files
     * @return array{namespace: string, name: string, version: string, root_relative: string}
     */
    protected function detectPackageFromZipFiles(array $files): array
    {
        $matches = [];

        foreach ($files as $file) {
            if (strtolower(basename($file['relative'])) !== 'typst.toml') {
                continue;
            }

            $manifest = $this->readPackageManifest($file['path']);
            $relativeDir = trim(str_replace('\\', '/', dirname($file['relative'])), './');
            $segments = $relativeDir === '' ? [] : explode('/', $relativeDir);

            $inferredNamespace = null;
            $inferredName = null;
            $inferredVersion = null;

            if (count($segments) >= 3) {
                $tail = array_slice($segments, -3);
                $tailNamespace = strtolower($tail[0]);
                if ($tailNamespace === 'preview' || $tailNamespace === 'local') {
                    $inferredNamespace = $tailNamespace;
                    $inferredName = $tail[1];
                    $inferredVersion = $tail[2];
                }
            }

            if (!$inferredName && count($segments) >= 2) {
                $tail = array_slice($segments, -2);
                $inferredName = $tail[0];
                $inferredVersion = $tail[1];
            }

            $name = $manifest['name'] ?? $inferredName;
            $version = $manifest['version'] ?? $inferredVersion;
            if (!$name || !$version) {
                continue;
            }

            $name = $this->sanitizePackageSegment($name, 'name');
            $version = $this->sanitizePackageSegment($version, 'version');
            $namespace = $inferredNamespace === 'preview' ? 'preview' : 'local';

            $matches[] = [
                'namespace' => $namespace,
                'name' => $name,
                'version' => $version,
                'root_relative' => $relativeDir,
            ];
        }

        $matches = array_values(array_unique($matches, SORT_REGULAR));

        if (count($matches) === 0) {
            throw new RuntimeException(trans('entities.tinymist_packages_zip_manifest_missing'));
        }

        if (count($matches) > 1) {
            throw new RuntimeException(trans('entities.tinymist_packages_zip_manifest_ambiguous'));
        }

        return $matches[0];
    }

    /**
     * @return array{name?: string, version?: string}
     */
    protected function readPackageManifest(string $path): array
    {
        $content = @file_get_contents($path);
        if (!is_string($content)) {
            return [];
        }

        $section = '';
        $result = [];

        foreach (preg_split('/\r?\n/', $content) as $line) {
            $line = trim($line);
            if ($line === '' || str_starts_with($line, '#')) {
                continue;
            }

            if (preg_match('/^\[([^\]]+)]$/', $line, $matches)) {
                $section = strtolower(trim($matches[1]));
                continue;
            }

            if ($section !== 'package') {
                continue;
            }

            if (!preg_match('/^([a-zA-Z0-9_\-]+)\s*=\s*"(.*)"$/', $line, $matches)) {
                continue;
            }

            $key = strtolower($matches[1]);
            if ($key === 'name' || $key === 'version') {
                $result[$key] = $matches[2];
            }
        }

        return $result;
    }

    /**
     * @param array<int, array{path: string, relative: string}> $files
     */
    protected function copyExtractedPackageFiles(array $files, string $rootRelative, string $destinationPath): void
    {
        $rootRelative = trim($rootRelative, '/');
        $prefix = $rootRelative === '' ? '' : ($rootRelative . '/');

        $this->deleteDirectory($destinationPath);
        $this->ensureDirectory($destinationPath);

        $copiedFileCount = 0;
        foreach ($files as $file) {
            $relative = $file['relative'];
            if ($prefix !== '' && !str_starts_with($relative, $prefix)) {
                continue;
            }

            $packageRelative = $prefix === '' ? $relative : substr($relative, strlen($prefix));
            if ($packageRelative === '' || $packageRelative === false) {
                continue;
            }

            $destPath = $destinationPath . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $packageRelative);
            $this->ensureDirectory(dirname($destPath));
            if (!copy($file['path'], $destPath)) {
                throw new RuntimeException(trans('entities.tinymist_packages_copy_failed'));
            }
            $copiedFileCount++;
        }

        if ($copiedFileCount === 0) {
            throw new RuntimeException(trans('entities.tinymist_packages_zip_empty'));
        }
    }

    protected function replaceDirectoryWithCopy(string $sourcePath, string $destinationPath): void
    {
        if (!is_dir($sourcePath)) {
            throw new RuntimeException(trans('entities.tinymist_packages_copy_failed'));
        }

        $this->deleteDirectory($destinationPath);
        $this->ensureDirectory($destinationPath);

        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($sourcePath, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::SELF_FIRST
        );

        foreach ($items as $item) {
            $relativePath = substr($item->getPathname(), strlen($sourcePath) + 1);
            $destPath = $destinationPath . DIRECTORY_SEPARATOR . $relativePath;

            if ($item->isDir()) {
                $this->ensureDirectory($destPath);
                continue;
            }

            $this->ensureDirectory(dirname($destPath));
            if (!copy($item->getPathname(), $destPath)) {
                throw new RuntimeException(trans('entities.tinymist_packages_copy_failed'));
            }
        }
    }

    protected function sanitizeZipPath(string $name): ?string
    {
        $normalized = str_replace('\\', '/', $name);
        $normalized = ltrim($normalized, '/');
        if ($normalized === '') {
            return null;
        }

        if (preg_match('/^[a-zA-Z]:/', $normalized)) {
            return null;
        }

        $segments = explode('/', $normalized);
        foreach ($segments as $segment) {
            if ($segment === '' || $segment === '.' || $segment === '..') {
                return null;
            }
        }

        return implode('/', $segments);
    }

    protected function sanitizePackageSegment(string $value, string $type): string
    {
        $value = trim($value);
        if ($value === '' || !preg_match('/^[A-Za-z0-9._+-]+$/', $value)) {
            throw new RuntimeException(trans('entities.tinymist_packages_invalid_' . $type));
        }

        return $value;
    }

    protected function createTempDir(): string
    {
        $base = storage_path('app/tmp');
        $this->ensureDirectory($base);

        $tempDir = $base . DIRECTORY_SEPARATOR . 'tinymist-package-' . Str::random(12);
        $this->ensureDirectory($tempDir);

        return $tempDir;
    }

    protected function ensureDirectory(string $path): void
    {
        if ($path !== '' && !is_dir($path)) {
            mkdir($path, 0755, true);
        }
    }

    protected function deleteDirectory(string $path): void
    {
        if (!is_dir($path)) {
            return;
        }

        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );

        foreach ($items as $item) {
            if ($item->isDir()) {
                rmdir($item->getPathname());
            } else {
                unlink($item->getPathname());
            }
        }

        rmdir($path);
    }

    protected function runGitCommand(array $command, ?string $workingDirectory = null): string
    {
        $fullCommand = array_merge(['git'], $command);
        $processEnv = $this->getGitProcessEnvironment();
        $process = new Process($fullCommand, $workingDirectory, $processEnv);
        $process->setTimeout(120);

        // Log::info('Tinymist git command starting', [
        //     'command' => $fullCommand,
        //     'working_directory' => $workingDirectory,
        //     'php_sapi' => PHP_SAPI,
        //     'cwd' => getcwd(),
        //     'env' => $this->getGitEnvironmentDebugSnapshot(),
        // ]);

        $process->run();

        if (!$process->isSuccessful()) {
            Log::error('Tinymist git command failed', [
                'command' => $process->getCommandLine(),
                'working_directory' => $workingDirectory,
                'exit_code' => $process->getExitCode(),
                'stdout' => trim($process->getOutput()),
                'stderr' => trim($process->getErrorOutput()),
                'php_sapi' => PHP_SAPI,
                'cwd' => getcwd(),
                'env' => $this->getGitEnvironmentDebugSnapshot(),
            ]);
            $message = trim($process->getErrorOutput()) ?: trim($process->getOutput()) ?: trans('entities.tinymist_packages_git_failed');
            throw new RuntimeException($message);
        }

        // Log::info('Tinymist git command succeeded', [
        //     'command' => $process->getCommandLine(),
        //     'working_directory' => $workingDirectory,
        //     'exit_code' => $process->getExitCode(),
        //     'php_sapi' => PHP_SAPI,
        // ]);

        return trim($process->getOutput());
    }

    /**
     * @return array<string, string>
     */
    protected function getGitProcessEnvironment(): array
    {
        $env = [];

        foreach (self::GIT_ENV_KEYS as $key) {
            $value = getenv($key);
            if ($value !== false) {
                $env[$key] = $value;
            }
        }

        return $env;
    }

    /**
     * @return array<string, string|null>
     */
    protected function getGitEnvironmentDebugSnapshot(): array
    {
        $snapshot = [];

        foreach (self::GIT_ENV_KEYS as $key) {
            $value = getenv($key);
            $snapshot[$key] = $value === false ? null : $value;
        }

        return $snapshot;
    }
}
