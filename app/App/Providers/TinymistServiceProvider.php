<?php

namespace BookStack\App\Providers;

use BookStack\Entities\Tools\Tinymist\TinymistPreviewManager;
use Illuminate\Support\ServiceProvider;

class TinymistServiceProvider extends ServiceProvider
{
    public function register()
    {
        $this->app->singleton(TinymistPreviewManager::class);
    }

    public function boot()
    {
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
}
