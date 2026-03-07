<?php

namespace BookStack\Extensions\Tinymist\Providers;

use BookStack\Extensions\Tinymist\Tools\TinymistPreviewManager;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

class TinymistServiceProvider extends ServiceProvider
{
    public function register()
    {
        $this->app->singleton(TinymistPreviewManager::class);
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
