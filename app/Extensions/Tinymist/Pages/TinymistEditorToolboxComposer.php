<?php

namespace BookStack\Extensions\Tinymist\Pages;

use BookStack\Entities\Tools\PageEditorType;
use BookStack\Extensions\Tinymist\Packages\TinymistPackageService;
use BookStack\Extensions\Tinymist\Tools\TinymistFontService;
use Illuminate\Support\Facades\Log;
use Illuminate\View\View;

class TinymistEditorToolboxComposer
{
    public function __construct(
        protected TinymistPackageService $packages,
        protected TinymistFontService $fonts,
    ) {
    }

    public function compose(View $view): void
    {
        $editor = $view->getData()['editor'] ?? null;
        if ($editor !== PageEditorType::Tinymist || !config('tinymist.enabled', false)) {
            return;
        }

        try {
            $view->with('tinymistPackageSelector', [
                'packages' => $this->listLatestInstalledPackages(),
                'load_error' => null,
                'settings_url' => url('/settings/customization#tinymist-packages'),
            ]);
        } catch (\Throwable $exception) {
            Log::warning('Failed to build Tinymist editor package selector data', [
                'error' => $exception->getMessage(),
            ]);

            $view->with('tinymistPackageSelector', [
                'packages' => [],
                'load_error' => $exception->getMessage(),
                'settings_url' => url('/settings/customization#tinymist-packages'),
            ]);
        }

        try {
            $view->with('tinymistFontSelector', [
                'fonts' => $this->listAvailableFonts(),
                'load_error' => null,
            ]);
        } catch (\Throwable $exception) {
            Log::warning('Failed to build Tinymist editor font selector data', [
                'error' => $exception->getMessage(),
            ]);

            $view->with('tinymistFontSelector', [
                'fonts' => [],
                'load_error' => $exception->getMessage(),
            ]);
        }
    }

    /**
     * @return array<int, array{name: string, search_text: string}>
     */
    protected function listAvailableFonts(): array
    {
        return array_map(static function (string $font): array {
            return [
                'name' => $font,
                'search_text' => mb_strtolower($font),
            ];
        }, $this->fonts->listAvailableFonts());
    }

    /**
     * @return array<int, array{
     *     namespace: string,
     *     name: string,
     *     version: string,
     *     path: string,
     *     reference: string,
     *     display_name: string,
     *     search_text: string
     * }>
     */
    protected function listLatestInstalledPackages(): array
    {
        $latestPackages = [];

        foreach ($this->packages->listInstalledPackages() as $package) {
            $key = strtolower($package['namespace'] . '/' . $package['name']);

            if (!isset($latestPackages[$key]) || $this->isVersionNewer($package['version'], $latestPackages[$key]['version'])) {
                $latestPackages[$key] = $package;
            }
        }

        uasort($latestPackages, function (array $a, array $b): int {
            return [$a['namespace'], $a['name']] <=> [$b['namespace'], $b['name']];
        });

        return array_values(array_map(function (array $package): array {
            $reference = '@' . $package['namespace'] . '/' . $package['name'] . ':' . $package['version'];

            return $package + [
                'reference' => $reference,
                'display_name' => $package['namespace'] . '/' . $package['name'],
                'search_text' => strtolower(implode(' ', [
                    $package['namespace'],
                    $package['name'],
                    $package['version'],
                    $reference,
                ])),
            ];
        }, $latestPackages));
    }

    protected function isVersionNewer(string $candidate, string $current): bool
    {
        if (preg_match('/^[0-9A-Za-z.\-_+]+$/', $candidate) && preg_match('/^[0-9A-Za-z.\-_+]+$/', $current)) {
            return version_compare($candidate, $current, '>');
        }

        return strnatcasecmp($candidate, $current) > 0;
    }
}
