<?php

declare(strict_types=1);

namespace BookStack\Extensions\Tinymist\Imports;

use BookStack\Entities\Models\Book;
use BookStack\Entities\Models\Chapter;
use BookStack\Entities\Models\Page;
use BookStack\Entities\Queries\EntityQueries;
use BookStack\Entities\Repos\PageRepo;
use BookStack\Entities\Tools\Markdown\HtmlToMarkdown;
use BookStack\Permissions\Permission;
use BookStack\Uploads\Attachment;
use BookStack\Uploads\AttachmentService;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use RuntimeException;
use Symfony\Component\HttpFoundation\File\UploadedFile;
use ZipArchive;

class SinglePageImportService
{
    protected const MAX_ZIP_FILES = 500;
    protected const MAX_NESTED_ZIP_DEPTH = 3;
    protected const MAX_NESTED_ZIP_ARCHIVES = 12;

    public function __construct(
        protected PageRepo $pageRepo,
        protected EntityQueries $entityQueries,
        protected AttachmentService $attachmentService,
        protected TinymistImportBridge $tinymistImportBridge,
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

        if ($this->tinymistImportBridge->supportsExtension($extension)) {
            return $this->tinymistImportBridge->importFromUpload(
                $extension,
                $file,
                $draft,
                $baseName,
                fn (UploadedFile $zipFile, Page $draftPage, string $pageName): Page => $this->createTinymistFromZip($zipFile, $draftPage, $pageName),
                fn (UploadedFile $uploadedFile): string => $this->readFileContents($uploadedFile),
            ) ?? throw new RuntimeException(trans('entities.import_single_type_invalid'));
        }

        return match ($extension) {
            'md', 'markdown', 'txt' => $this->publishMarkdown($draft, $baseName, $this->readFileContents($file)),
            'html', 'htm' => $this->publishHtmlAsMarkdown($draft, $baseName, $this->readFileContents($file)),
            default => throw new RuntimeException(trans('entities.import_single_type_invalid')),
        };
    }

    protected function publishTinymist(Page $draft, string $name, string $content): Page
    {
        return $this->tinymistImportBridge->publishTinymist($draft, $name, $content);
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
            $files = $this->unwrapSingleBranchZipPaths($files);

            if (!$this->hasSupportedEntryFile($files)) {
                $files = $this->expandNestedZipFiles($files, $tempDir);
                $files = $this->unwrapSingleBranchZipPaths($files);
            }

            $templateConfig = $this->readTypstToml($files);
            $templateEntry = $this->buildTemplateEntryPath($templateConfig);
            $entryFile = $this->selectEntryFile($files, $templateEntry);
            $entryPath = $entryFile['path'];
            $entryExtension = $entryFile['extension'];

            $attachmentUrlMap = $this->createAttachmentsFromZipFiles(
                $files,
                $entryPath,
                $draft,
                $entryExtension === 'typ',
            );

            $entryContent = file_get_contents($entryPath);
            if (!is_string($entryContent)) {
                throw new RuntimeException(trans('entities.import_single_entry_missing'));
            }

            if (in_array($entryExtension, ['md', 'markdown', 'txt'], true)) {
                $rewrittenMarkdown = $this->rewriteImportedMarkdownAttachmentLinks($entryContent, $attachmentUrlMap);
                return $this->publishMarkdown($draft, $name, $rewrittenMarkdown);
            }

            if (in_array($entryExtension, ['html', 'htm'], true)) {
                $markdown = (new HtmlToMarkdown($entryContent))->convert();
                $rewrittenMarkdown = $this->rewriteImportedMarkdownAttachmentLinks($markdown, $attachmentUrlMap);
                return $this->publishMarkdown($draft, $name, $rewrittenMarkdown);
            }

            Log::info('Single-page import typst template details', [
                'page_id' => $draft->id,
                'entry_path' => $entryPath,
                'entry_extension' => $entryExtension,
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

    /**
     * @param array<int, array{path: string, relative: string}> $files
     * @return array{path: string, relative: string, extension: string}
     */
    protected function selectEntryFile(array $files, ?string $templateEntry): array
    {
        $supportedExtensions = ['typ', 'md', 'markdown', 'html', 'htm', 'txt'];

        if ($templateEntry) {
            $templateEntry = ltrim(str_replace('\\', '/', $templateEntry), '/');
            foreach ($files as $file) {
                if ($file['relative'] !== $templateEntry) {
                    continue;
                }

                $extension = strtolower(pathinfo($file['relative'], PATHINFO_EXTENSION));
                if (in_array($extension, $supportedExtensions, true)) {
                    return [
                        'path' => $file['path'],
                        'relative' => $file['relative'],
                        'extension' => $extension,
                    ];
                }
            }
        }

        $entryCandidates = array_values(array_filter($files, function (array $file) use ($supportedExtensions): bool {
            $extension = strtolower(pathinfo($file['relative'], PATHINFO_EXTENSION));
            return in_array($extension, $supportedExtensions, true);
        }));

        if (empty($entryCandidates)) {
            throw new RuntimeException(trans('entities.import_single_entry_missing'));
        }

        $preferredEntryNames = [
            'entry.typ', 'main.typ',
            'entry.md', 'main.md', 'index.md', 'readme.md',
            'entry.markdown', 'main.markdown', 'index.markdown', 'readme.markdown',
            'entry.html', 'main.html', 'index.html', 'readme.html',
            'entry.htm', 'main.htm', 'index.htm', 'readme.htm',
            'entry.txt', 'main.txt', 'index.txt', 'readme.txt',
        ];

        foreach ($preferredEntryNames as $preferredName) {
            foreach ($entryCandidates as $file) {
                if (strtolower(basename($file['relative'])) === $preferredName) {
                    return [
                        'path' => $file['path'],
                        'relative' => $file['relative'],
                        'extension' => strtolower(pathinfo($file['relative'], PATHINFO_EXTENSION)),
                    ];
                }
            }
        }

        if (count($entryCandidates) === 1) {
            $file = $entryCandidates[0];
            return [
                'path' => $file['path'],
                'relative' => $file['relative'],
                'extension' => strtolower(pathinfo($file['relative'], PATHINFO_EXTENSION)),
            ];
        }

        $typFiles = array_values(array_filter($entryCandidates, function (array $file): bool {
            return strtolower(pathinfo($file['relative'], PATHINFO_EXTENSION)) === 'typ';
        }));

        if (count($typFiles) === 1) {
            $file = $typFiles[0];
            return [
                'path' => $file['path'],
                'relative' => $file['relative'],
                'extension' => 'typ',
            ];
        }

        throw new RuntimeException(trans('entities.import_single_entry_ambiguous'));
    }

    /**
     * @return array<string, string> filename => root-relative attachment URL
     */
    protected function createAttachmentsFromZipFiles(array $files, string $entryPath, Page $draft, bool $reserveEntryTypName = true): array
    {
        $seen = [];
        $attachmentUrlMap = [];
        foreach ($files as $file) {
            $filePath = $file['path'];
            $baseName = basename($file['relative']);
            if ($baseName === '' || $baseName === '.') {
                continue;
            }

            if ($filePath === $entryPath) {
                continue;
            }

            if ($reserveEntryTypName && $baseName === 'entry.typ') {
                throw new RuntimeException(trans('entities.import_single_entry_conflict'));
            }

            if (isset($seen[$baseName])) {
                throw new RuntimeException(trans('entities.import_single_flatten_conflict'));
            }
            $seen[$baseName] = true;

            $attachment = $this->createAttachmentFromFile($draft->id, $filePath, $baseName);
            $attachmentUrlMap[$baseName] = '/attachments/' . $attachment->id;
        }

        return $attachmentUrlMap;
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

    protected function createAttachmentFromFile(int $pageId, string $filePath, string $originalName): Attachment
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

        return $this->attachmentService->saveNewUpload($upload, $pageId);
    }

    /**
     * Rewrite markdown links/images that point to imported local filenames
     * to root-relative attachment URLs.
     *
     * @param array<string, string> $attachmentUrlMap
     */
    protected function rewriteImportedMarkdownAttachmentLinks(string $content, array $attachmentUrlMap): string
    {
        if (empty($attachmentUrlMap) || trim($content) === '') {
            return $content;
        }

        $normalizedMap = [];
        foreach ($attachmentUrlMap as $fileName => $url) {
            $normalizedMap[strtolower($fileName)] = $url;
        }

        $rewriteUrl = function (string $rawUrl) use ($normalizedMap): string {
            $trimmed = trim($rawUrl);
            if ($trimmed === '') {
                return $rawUrl;
            }

            if (
                str_starts_with($trimmed, 'http://')
                || str_starts_with($trimmed, 'https://')
                || str_starts_with($trimmed, '/')
                || str_starts_with($trimmed, '#')
                || str_starts_with($trimmed, 'mailto:')
                || str_starts_with($trimmed, 'data:')
            ) {
                return $rawUrl;
            }

            $trimmed = trim($trimmed, "<>'\" ");
            $trimmed = ltrim($trimmed, './');

            $pathOnly = explode('?', explode('#', $trimmed, 2)[0], 2)[0];
            $baseName = basename(str_replace('\\\\', '/', $pathOnly));
            $lookup = strtolower(urldecode($baseName));

            if (!isset($normalizedMap[$lookup])) {
                return $rawUrl;
            }

            return $normalizedMap[$lookup];
        };

        $content = preg_replace_callback('/(!?\[[^\]]*\]\()([^\)]+)(\))/', function (array $matches) use ($rewriteUrl): string {
            return $matches[1] . $rewriteUrl($matches[2]) . $matches[3];
        }, $content) ?? $content;

        $content = preg_replace_callback('/(<img\b[^>]*\bsrc\s*=\s*["\'])([^"\']+)(["\'])/i', function (array $matches) use ($rewriteUrl): string {
            return $matches[1] . $rewriteUrl($matches[2]) . $matches[3];
        }, $content) ?? $content;

        return $content;
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

    /**
     * @param array<int, array{path: string, relative: string}> $files
     */
    protected function hasSupportedEntryFile(array $files): bool
    {
        foreach ($files as $file) {
            $extension = strtolower(pathinfo($file['relative'], PATHINFO_EXTENSION));
            if (in_array($extension, ['typ', 'md', 'markdown', 'html', 'htm', 'txt'], true)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Expands nested zip archives in-place within the extracted file map.
     * Useful for export formats that wrap the real content in another zip.
     *
     * @param array<int, array{path: string, relative: string}> $files
     * @return array<int, array{path: string, relative: string}>
     */
    protected function expandNestedZipFiles(array $files, string $tempDir): array
    {
        $result = $files;
        $expandedArchives = 0;

        for ($depth = 0; $depth < self::MAX_NESTED_ZIP_DEPTH; $depth++) {
            $expandedThisPass = false;
            $next = [];

            foreach ($result as $file) {
                $extension = strtolower(pathinfo($file['relative'], PATHINFO_EXTENSION));
                if ($extension !== 'zip') {
                    $next[] = $file;
                    continue;
                }

                if ($expandedArchives >= self::MAX_NESTED_ZIP_ARCHIVES) {
                    throw new RuntimeException(trans('entities.import_single_zip_nested_too_many'));
                }

                $expandedArchives++;
                $expandedThisPass = true;

                $nestedTemp = $tempDir . DIRECTORY_SEPARATOR . 'nested-' . Str::random(8);
                if (!is_dir($nestedTemp)) {
                    mkdir($nestedTemp, 0755, true);
                }

                $nestedFiles = $this->extractZip($file['path'], $nestedTemp);
                $parentDir = trim(str_replace('\\', '/', dirname($file['relative'])), './');

                foreach ($nestedFiles as $nestedFile) {
                    $relative = $nestedFile['relative'];
                    if ($parentDir !== '') {
                        $relative = $parentDir . '/' . ltrim($relative, '/');
                    }

                    $next[] = [
                        'path' => $nestedFile['path'],
                        'relative' => str_replace('\\', '/', $relative),
                    ];
                }
            }

            $result = $next;

            if (!$expandedThisPass || $this->hasSupportedEntryFile($result)) {
                break;
            }
        }

        return $result;
    }

    /**
     * Collapse unnecessary leading folder wrappers when all files are nested
     * under the same single branch (e.g. folder/folder/files -> files).
     *
     * @param array<int, array{path: string, relative: string}> $files
     * @return array<int, array{path: string, relative: string}>
     */
    protected function unwrapSingleBranchZipPaths(array $files): array
    {
        if (count($files) < 2) {
            return $files;
        }

        $relativePaths = array_values(array_map(fn (array $file): string => $file['relative'], $files));
        $stripDepth = 0;

        while (true) {
            $firstSegments = [];

            foreach ($relativePaths as $relativePath) {
                $segments = explode('/', $relativePath);
                if (count($segments) < 2) {
                    $firstSegments = [];
                    break;
                }

                $firstSegments[] = $segments[0];
            }

            if (count($firstSegments) === 0 || count(array_unique($firstSegments)) !== 1) {
                break;
            }

            $stripDepth++;
            $relativePaths = array_values(array_map(function (string $relativePath): string {
                $segments = explode('/', $relativePath);
                array_shift($segments);
                return implode('/', $segments);
            }, $relativePaths));
        }

        if ($stripDepth === 0) {
            return $files;
        }

        return array_values(array_map(function (array $file) use ($stripDepth): array {
            $segments = explode('/', $file['relative']);
            $segments = array_slice($segments, $stripDepth);

            return [
                'path' => $file['path'],
                'relative' => implode('/', $segments),
            ];
        }, $files));
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
