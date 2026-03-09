<?php

declare(strict_types=1);

namespace BookStack\Extensions\Tinymist\Packages;

use Illuminate\Contracts\View\View;
use Illuminate\Support\Facades\Log;

class TinymistPackageSettingsComposer
{
    public function __construct(
        protected TinymistPackageService $packages,
    ) {
    }

    public function compose(View $view): void
    {
        try {
            $view->with('tinymistPackageManager', [
                'installed_packages' => $this->packages->listInstalledPackages(),
                'github_packages' => $this->packages->listGithubPackages(),
                'load_error' => null,
            ]);
        } catch (\Throwable $exception) {
            Log::warning('Failed to build Tinymist package settings view data', [
                'error' => $exception->getMessage(),
            ]);

            $view->with('tinymistPackageManager', [
                'installed_packages' => [],
                'github_packages' => [],
                'load_error' => $exception->getMessage(),
            ]);
        }
    }
}
