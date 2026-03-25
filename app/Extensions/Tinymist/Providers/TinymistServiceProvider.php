<?php

namespace BookStack\Extensions\Tinymist\Providers;

use BookStack\Entities\Models\Page;
use BookStack\Extensions\Tinymist\Pages\TinymistEditorToolboxComposer;
use BookStack\Extensions\Tinymist\Packages\TinymistPackageSettingsComposer;
use BookStack\Extensions\Tinymist\Tools\TinymistPageStorageCleaner;
use BookStack\Extensions\Tinymist\Tools\TinymistPreviewManager;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\View;
use Illuminate\Support\ServiceProvider;

class TinymistServiceProvider extends ServiceProvider
{
    public function register()
    {
        $this->app->singleton(TinymistPreviewManager::class);
        $this->app->singleton(TinymistPageStorageCleaner::class);
    }

    public function boot()
    {
        $this->registerRoutes();

        // Register cleanup on shutdown
        // $this->app->terminating(function () {
        //     $manager = app(TinymistPreviewManager::class);
        //     $manager->shutdownAll();
        // });

        // Schedule periodic cleanup of idle servers
        // if ($this->app->runningInConsole()) {
        //     $this->app->make(TinymistPreviewManager::class);
        // }

        $this->app->make(TinymistPreviewManager::class);
        $this->app->make(TinymistPageStorageCleaner::class);

        Page::deleted(static function (Page $page): void {
            app(TinymistPageStorageCleaner::class)->cleanupPage((int) $page->id);
        });

        View::composer('settings.categories.customization', TinymistPackageSettingsComposer::class);
        View::composer('pages.parts.editor-toolbox', TinymistEditorToolboxComposer::class);
    }

    protected function registerRoutes(): void
    {
        /** @var object $app */
        $app = app();
        if (method_exists($app, 'routesAreCached') && $app->routesAreCached()) {
            return;
        }

        Route::middleware(['web', 'auth'])->group(base_path('routes/tinymist.php'));
    }
}
