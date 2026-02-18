<?php

declare(strict_types=1);

namespace BookStack\Exports;

use BookStack\Entities\Models\Book;
use BookStack\Entities\Models\Chapter;
use BookStack\Entities\Models\Page;
use BookStack\Entities\Queries\EntityQueries;
use BookStack\Entities\Repos\PageRepo;
use BookStack\Entities\Tools\Markdown\HtmlToMarkdown;
use BookStack\Entities\Tools\PageEditorType;
use BookStack\Permissions\Permission;
use BookStack\Uploads\AttachmentService;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use RuntimeException;
use Symfony\Component\HttpFoundation\File\UploadedFile;
use ZipArchive;

class SinglePageImportService
{
    protected const MAX_ZIP_FILES = 500;

    public function __construct(
        protected PageRepo $pageRepo,
        protected EntityQueries $entityQueries,
        protected AttachmentService $attachmentService,
    ) {
    }

    /**
     * @throws RuntimeException
     */
    public function createFromUpload(UploadedFile $file, string $parentIdentifier, ?string $name = null): Page
    {
        $parent = $this->entityQueries->findVisibleByStringIdentifier($parentIdentifier);
        if (!$parent || !($parent instanceof Book || $parent instanceof Chapter)) {
            throw new RuntimeException(trans('entities.import_single_parent_invalid'));
        }
        if (!userCan(Permission::PageCreate, $parent)) {
            throw new RuntimeException(trans('errors.import_perms_pages'));
        }

        $draft = $this->pageRepo->getNewDraftPage($parent);
        $baseName = $name ?: pathinfo($file->getClientOriginalName(), PATHINFO_FILENAME);
        $baseName = trim($baseName) !== '' ? $baseName : trans('entities.pages_initial_name');
        $extension = strtolower($file->getClientOriginalExtension());

        return match ($extension) {
            'zip' => $this->createTinymistFromZip($file, $draft, $baseName),
            'typ' => $this->publishTinymist($draft, $baseName, $this->readFileContents($file)),
            'md', 'markdown', 'txt' => $this->publishMarkdown($draft, $baseName, $this->readFileContents($file)),
            'html', 'htm' => $this->publishHtmlAsMarkdown($draft, $baseName, $this->readFileContents($file)),
            default => throw new RuntimeException(trans('entities.import_single_type_invalid')),
        };
    }

    protected function publishTinymist(Page $draft, string $name, string $content): Page
    {
        return $this->pageRepo->publishDraft($draft, [
            'name' => $name,
            'tinymist' => $content,
        ]);
    }

    protected function publishMarkdown(Page $draft, string $name, string $content): Page
    {
        return $this->pageRepo->publishDraft($draft, [
            'name' => $name,
            'markdown' => $content,
        ]);
    }

    protected function publishHtmlAsMarkdown(Page $draft, string $name, string $content): Page
    {
        $markdown = (new HtmlToMarkdown($content))->convert();

        return $this->publishMarkdown($draft, $name, $markdown);
    }

    protected function readFileContents(UploadedFile $file): string
    {
        $path = $file->getRealPath();
        if (!$path || !is_readable($path)) {
            throw new RuntimeException(trans('entities.import_single_read_failed'));
        }

        $content = file_get_contents($path);
        if (!is_string($content)) {
            throw new RuntimeException(trans('entities.import_single_read_failed'));
        }

        return $content;
    }

    protected function createTinymistFromZip(UploadedFile $file, Page $draft, string $name): Page
    {
        $zipPath = $file->getRealPath();
        if (!$zipPath || !is_readable($zipPath)) {
            throw new RuntimeException(trans('entities.import_single_read_failed'));
        }

        $tempDir = $this->createTempDir();
        try {
            $files = $this->extractZip($zipPath, $tempDir);
            $templateConfig = $this->readTypstToml($files);
            $templateEntry = $this->buildTemplateEntryPath($templateConfig);
            $entryPath = $this->selectEntryTyp($files, $templateEntry);
            $this->createAttachmentsFromZipFiles($files, $entryPath, $draft);

            $entryContent = file_get_contents($entryPath);
            if (!is_string($entryContent)) {
                throw new RuntimeException(trans('entities.import_single_entry_missing'));
            }

            Log::info('Single-page import typst template details', [
                'page_id' => $draft->id,
                'entry_path' => $entryPath,
                'toml_path' => $templateConfig['toml_path'] ?? null,
                'package_name' => $templateConfig['package_name'] ?? null,
                'package_version' => $templateConfig['package_version'] ?? null,
                'package_entry' => $templateConfig['package_entry'] ?? null,
                'template_path' => $templateConfig['template_path'] ?? null,
                'template_entry' => $templateConfig['template_entry'] ?? null,
            ]);

            $rewritten = $this->rewriteTemplateImport(
                $entryContent,
                $templateConfig['package_name'] ?? null,
                $templateConfig['package_version'] ?? null,
                $templateConfig['package_entry'] ?? null
            );

            Log::info('Single-page import typst entry rewrite', [
                'page_id' => $draft->id,
                'changed' => $rewritten !== $entryContent,
            ]);

            $entryContent = $rewritten;

            return $this->publishTinymist($draft, $name, $entryContent);
        } finally {
            $this->deleteDirectory($tempDir);
        }
    }

    /**
     * @return array<int, array{path: string, relative: string}>
     */
    protected function extractZip(string $zipPath, string $tempDir): array
    {
        $zip = new ZipArchive();
        if ($zip->open($zipPath, ZipArchive::RDONLY) !== true) {
            throw new RuntimeException(trans('entities.import_single_zip_invalid'));
        }

        $files = [];
        $totalSize = 0;
        $maxSize = (int)(config('app.upload_limit') * 1000000);

        for ($index = 0; $index < $zip->numFiles; $index++) {
            $stat = $zip->statIndex($index);
            if (!is_array($stat) || !isset($stat['name'])) {
                continue;
            }

            $name = (string)$stat['name'];
            if (str_ends_with($name, '/')) {
                continue;
            }

            $safeName = $this->sanitizeZipPath($name);
            if ($safeName === null) {
                throw new RuntimeException(trans('entities.import_single_zip_unsafe'));
            }

            if (count($files) >= self::MAX_ZIP_FILES) {
                throw new RuntimeException(trans('entities.import_single_zip_too_many'));
            }

            $size = (int)($stat['size'] ?? 0);
            $totalSize += $size;
            if ($totalSize > $maxSize) {
                throw new RuntimeException(trans('entities.import_single_zip_too_large'));
            }

            $destPath = $tempDir . DIRECTORY_SEPARATOR . $safeName;
            if (!is_dir(dirname($destPath))) {
                mkdir(dirname($destPath), 0755, true);
            }

            $stream = $zip->getStream($name);
            if (!$stream) {
                throw new RuntimeException(trans('entities.import_single_zip_invalid'));
            }

            $output = fopen($destPath, 'wb');
            if (!$output) {
                fclose($stream);
                throw new RuntimeException(trans('entities.import_single_zip_invalid'));
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
            throw new RuntimeException(trans('entities.import_single_zip_empty'));
        }

        return $files;
    }

    protected function selectEntryTyp(array $files, ?string $templateEntry): string
    {
        if ($templateEntry) {
            $templateEntry = ltrim(str_replace('\\', '/', $templateEntry), '/');
            foreach ($files as $file) {
                if ($file['relative'] === $templateEntry) {
                    return $file['path'];
                }
            }
        }

        $typFiles = array_values(array_filter($files, function (array $file): bool {
            return strtolower(pathinfo($file['relative'], PATHINFO_EXTENSION)) === 'typ';
        }));

        if (empty($typFiles)) {
            throw new RuntimeException(trans('entities.import_single_entry_missing'));
        }

        foreach ($typFiles as $path) {
            if (strtolower(basename($path['relative'])) === 'entry.typ') {
                return $path['path'];
            }
        }

        foreach ($typFiles as $path) {
            if (strtolower(basename($path['relative'])) === 'main.typ') {
                return $path['path'];
            }
        }

        if (count($typFiles) === 1) {
            return $typFiles[0]['path'];
        }

        throw new RuntimeException(trans('entities.import_single_entry_ambiguous'));
    }

    protected function createAttachmentsFromZipFiles(array $files, string $entryPath, Page $draft): void
    {
        $seen = [];
        foreach ($files as $file) {
            $filePath = $file['path'];
            $baseName = basename($file['relative']);
            if ($baseName === '' || $baseName === '.') {
                continue;
            }

            if ($filePath === $entryPath) {
                continue;
            }

            if ($baseName === 'entry.typ') {
                throw new RuntimeException(trans('entities.import_single_entry_conflict'));
            }

            if (isset($seen[$baseName])) {
                throw new RuntimeException(trans('entities.import_single_flatten_conflict'));
            }
            $seen[$baseName] = true;

            $this->createAttachmentFromFile($draft->id, $filePath, $baseName);
        }
    }

    /**
     * @return array{package_name?: string, package_version?: string, package_entry?: string, template_entry?: string, template_path?: string, toml_base_dir?: string, toml_path?: string}
     */
    protected function readTypstToml(array $files): array
    {
        $candidates = array_values(array_filter($files, function (array $file): bool {
            return strtolower(basename($file['relative'])) === 'typst.toml';
        }));

        foreach ($candidates as $candidate) {
            $content = file_get_contents($candidate['path']);
            if (!is_string($content)) {
                continue;
            }

            $section = '';
            $result = [
                'toml_path' => $candidate['relative'],
                'toml_base_dir' => trim(str_replace('\\', '/', dirname($candidate['relative'])), './'),
            ];

            foreach (preg_split('/\r?\n/', $content) as $line) {
                $line = trim($line);
                if ($line === '' || str_starts_with($line, '#')) {
                    continue;
                }
                if (preg_match('/^\[([^\]]+)]$/', $line, $matches)) {
                    $section = strtolower(trim($matches[1]));
                    continue;
                }
                if (!preg_match('/^([a-zA-Z0-9_\-]+)\s*=\s*"(.*)"$/', $line, $matches)) {
                    continue;
                }

                $key = strtolower($matches[1]);
                $value = $matches[2];

                if ($section === 'package') {
                    if ($key === 'name') {
                        $result['package_name'] = $value;
                    } elseif ($key === 'version') {
                        $result['package_version'] = $value;
                    } elseif ($key === 'entrypoint') {
                        $result['package_entry'] = $value;
                    }
                } elseif ($section === 'template') {
                    if ($key === 'entrypoint') {
                        $result['template_entry'] = $value;
                    } elseif ($key === 'path') {
                        $result['template_path'] = $value;
                    }
                }
            }

            if (isset($result['package_name']) || isset($result['template_entry'])) {
                return $result;
            }
        }

        return [];
    }

    protected function buildTemplateEntryPath(array $templateConfig): ?string
    {
        $entry = $templateConfig['template_entry'] ?? null;
        if (!$entry) {
            return null;
        }

        $parts = [];
        $base = trim((string)($templateConfig['toml_base_dir'] ?? ''), '/');
        $path = trim((string)($templateConfig['template_path'] ?? ''), '/');
        $entry = trim((string)$entry, '/');

        if ($base !== '' && $base !== '.') {
            $parts[] = $base;
        }
        if ($path !== '' && $path !== '.') {
            $parts[] = $path;
        }
        if ($entry !== '') {
            $parts[] = $entry;
        }

        return implode('/', $parts);
    }

    protected function rewriteTemplateImport(string $content, ?string $packageName, ?string $packageVersion, ?string $entrypoint): string
    {
        if (!$packageName || !$packageVersion || !$entrypoint) {
            return $content;
        }

        $patterns = [
            sprintf('@preview/%s:%s', $packageName, $packageVersion),
            sprintf('@local/%s:%s', $packageName, $packageVersion),
            sprintf('@preview/%s-%s', $packageName, $packageVersion),
            sprintf('@local/%s-%s', $packageName, $packageVersion),
        ];

        return str_replace($patterns, $entrypoint, $content);
    }

    protected function createAttachmentFromFile(int $pageId, string $filePath, string $originalName): void
    {
        if (!userCan(Permission::AttachmentCreateAll)) {
            throw new RuntimeException(trans('errors.import_perms_attachments'));
        }

        $upload = new UploadedFile(
            $filePath,
            $originalName,
            null,
            null,
            true
        );

        $this->attachmentService->saveNewUpload($upload, $pageId);
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

    protected function createTempDir(): string
    {
        $base = storage_path('app/tmp');
        if (!is_dir($base)) {
            mkdir($base, 0755, true);
        }

        $tempDir = $base . DIRECTORY_SEPARATOR . 'tinymist-import-' . Str::random(12);
        mkdir($tempDir, 0755, true);
        return $tempDir;
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
}
