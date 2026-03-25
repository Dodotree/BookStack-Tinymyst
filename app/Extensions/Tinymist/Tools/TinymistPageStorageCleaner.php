<?php

namespace BookStack\Extensions\Tinymist\Tools;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class TinymistPageStorageCleaner
{
    public function cleanupPage(int $pageId): void
    {
        if ($pageId <= 0) {
            return;
        }

        $this->cleanupRenderedHtml($pageId);
        $this->cleanupWorkspaceDirectory($pageId);
        $this->cleanupLegacyWorkspaceFile($pageId);
    }

    protected function cleanupRenderedHtml(int $pageId): void
    {
        $previewDirectory = storage_path('app/tinymist/preview');
        $previewHtmlPath = $previewDirectory . DIRECTORY_SEPARATOR . "page_{$pageId}.html";
        $previewTempPath = $previewHtmlPath . '.tmp';

        $this->deleteFileIfExists($previewHtmlPath);
        $this->deleteFileIfExists($previewTempPath);
    }

    protected function cleanupWorkspaceDirectory(int $pageId): void
    {
        $workspaceDirectory = storage_path("app/tinymist/page_{$pageId}");

        if (!is_dir($workspaceDirectory)) {
            return;
        }

        try {
            File::deleteDirectory($workspaceDirectory);
        } catch (\Throwable $exception) {
            Log::warning('Tinymist page workspace cleanup failed', [
                'page_id' => $pageId,
                'path' => $workspaceDirectory,
                'error' => $exception->getMessage(),
            ]);
        }
    }

    protected function cleanupLegacyWorkspaceFile(int $pageId): void
    {
        $legacyPath = storage_path("app/tinymist/page_{$pageId}.typ");
        $this->deleteFileIfExists($legacyPath);
    }

    protected function deleteFileIfExists(string $path): void
    {
        if (!is_file($path)) {
            return;
        }

        try {
            @unlink($path);
        } catch (\Throwable $exception) {
            Log::warning('Tinymist page file cleanup failed', [
                'path' => $path,
                'error' => $exception->getMessage(),
            ]);
        }
    }
}
