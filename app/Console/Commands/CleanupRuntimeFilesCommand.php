<?php

namespace BookStack\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\File;
use SplFileInfo;

class CleanupRuntimeFilesCommand extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'bookstack:cleanup-runtime-files';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Clean up old runtime files (clockwork, logs, and stale Tinymist preview storage)';

    /**
     * Execute the console command.
     */
    public function handle(): int
    {
        $clockworkDeleted = $this->cleanupClockwork();
        $tinymistLogsDeleted = $this->cleanupTinymistLogs();
        $logsDeleted = $this->cleanupLogs();
        [$previewFilesDeleted, $previewDirsDeleted] = $this->cleanupTinymistPreviewStorage();

        $this->comment("Deleted {$clockworkDeleted} old clockwork file(s)");
        $this->comment("Deleted {$tinymistLogsDeleted} old Tinymist log file(s)");
        $this->comment("Deleted {$logsDeleted} old log file(s)");
        $this->comment("Deleted {$previewFilesDeleted} old preview file(s) and {$previewDirsDeleted} idle preview directory(ies)");

        return 0;
    }

    protected function cleanupClockwork(): int
    {
        $path = storage_path('clockwork');
        $cutoff = time() - (60 * 60);

        return $this->deleteFilesOlderThan($path, $cutoff);
    }

    protected function cleanupLogs(): int
    {
        $path = storage_path('logs');
        $cutoff = time() - (60 * 60 * 24);

        return $this->deleteFilesOlderThan($path, $cutoff, function (SplFileInfo $file): bool {
            $basename = $file->getBasename();

            if ($basename === '.gitignore') {
                return false;
            }

            if ($basename === 'tinymist-php-typst.log') {
                return false;
            }

            if ($basename === 'tinymist-lsp-unhandled-notifications.log') {
                return false;
            }

            if (str_starts_with($basename, 'tinymist-lsp-')) {
                return false;
            }

            return true;
        });
    }

    protected function cleanupTinymistLogs(): int
    {
        $path = storage_path('logs');
        $cutoff = time() - (60 * 60 * 24);

        if (!is_dir($path)) {
            return 0;
        }

        $patterns = [
            'tinymist-php-typst.log',
            'tinymist-lsp-unhandled-notifications.log',
            'tinymist-lsp-*.log',
        ];

        $targets = [];
        foreach ($patterns as $pattern) {
            foreach (File::glob($path . DIRECTORY_SEPARATOR . $pattern) as $filePath) {
                if (is_file($filePath)) {
                    $targets[$filePath] = true;
                }
            }
        }

        $deleted = 0;
        foreach (array_keys($targets) as $filePath) {
            $fileMtime = $this->safeFileMtime($filePath);
            if (is_null($fileMtime) || $fileMtime >= $cutoff) {
                continue;
            }

            if (@unlink($filePath)) {
                $deleted++;
            }
        }

        return $deleted;
    }

    /**
     * @return array{int,int}
     */
    protected function cleanupTinymistPreviewStorage(): array
    {
        $storagePath = trim((string) config('tinymist.document_storage_path', 'tinymist'), '/\\');
        $tinymistRoot = storage_path('app/' . $storagePath);
        $cutoff = time() - (60 * 60 * 24 * 2);

        if (!is_dir($tinymistRoot)) {
            return [0, 0];
        }

        $deletedFiles = 0;
        $deletedDirs = 0;

        foreach (File::glob($tinymistRoot . DIRECTORY_SEPARATOR . 'page_*') as $pagePath) {
            $name = basename($pagePath);

            if (is_file($pagePath) && str_ends_with($name, '.typ')) {
                if (($this->safeFileMtime($pagePath) ?? 0) < $cutoff) {
                    if (@unlink($pagePath)) {
                        $deletedFiles++;
                    }
                }

                continue;
            }

            if (!is_dir($pagePath)) {
                continue;
            }

            $latestChange = $this->getLatestDirectoryMtime($pagePath);
            if ($latestChange < $cutoff && File::deleteDirectory($pagePath)) {
                $deletedDirs++;
            }
        }

        return [$deletedFiles, $deletedDirs];
    }

    protected function deleteFilesOlderThan(string $path, int $cutoff, ?callable $filter = null): int
    {
        if (!is_dir($path)) {
            return 0;
        }

        $deleted = 0;

        foreach (File::allFiles($path) as $file) {
            $filePath = $file->getPathname();
            $fileMtime = $this->safeFileMtime($filePath);

            if (is_null($fileMtime) || $fileMtime >= $cutoff) {
                continue;
            }

            if ($filter && !$filter($file)) {
                continue;
            }

            if (@unlink($filePath)) {
                $deleted++;
            }
        }

        return $deleted;
    }

    protected function getLatestDirectoryMtime(string $directoryPath): int
    {
        $latest = $this->safeFileMtime($directoryPath) ?? 0;

        foreach (File::allFiles($directoryPath) as $file) {
            $latest = max($latest, $this->safeFileMtime($file->getPathname()) ?? 0);
        }

        return $latest;
    }

    protected function safeFileMtime(string $path): ?int
    {
        $mtime = @filemtime($path);
        return $mtime === false ? null : $mtime;
    }
}
