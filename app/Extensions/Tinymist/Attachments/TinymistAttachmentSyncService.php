<?php

namespace BookStack\Extensions\Tinymist\Attachments;

use BookStack\Entities\Models\Page;
use BookStack\Entities\Tools\Tinymist\TinymistPreviewManager;
use BookStack\Exceptions\FileUploadException;
use BookStack\Uploads\Attachment;
use BookStack\Uploads\FileStorage;
use BookStack\Util\FilePathNormalizer;
use Exception;
use Illuminate\Filesystem\FilesystemManager;

class TinymistAttachmentSyncService
{
    public function __construct(
        protected FileStorage $storage,
        protected TinymistPreviewManager $previewManager,
        protected FilesystemManager $fileSystem,
    ) {
    }

    public function syncAttachmentIfNeeded(Attachment $attachment, ?int $pageId = null): void
    {
        if ($attachment->external) {
            return;
        }

        $page = $attachment->page;
        if (!$page && $pageId) {
            $page = Page::query()->find($pageId);
        }

        if (!$page || $page->editor !== 'tinymist') {
            return;
        }

        $this->previewManager->syncNewAttachmentToPreviewDir($page, $attachment);
    }

    public function removeAttachmentIfNeeded(Attachment $attachment, ?string $attachmentFileName = null): void
    {
        $fileName = $attachmentFileName ?? ($attachment->external ? null : $attachment->getFileName());
        if (!$fileName) {
            return;
        }

        $page = $attachment->page;
        if (!$page || $page->editor !== 'tinymist') {
            return;
        }

        $this->previewManager->removeAttachmentFromPreviewDir($page, $fileName);
    }

    public function saveFromPreview(Attachment $attachment): Attachment
    {
        $page = $attachment->page;
        if ($attachment->external || !$page || $page->editor !== 'tinymist') {
            return $attachment;
        }

        $fileName = basename($attachment->getFileName());
        if ($fileName === '' || $fileName === 'entry.typ') {
            return $attachment;
        }

        $previewPath = storage_path("app/tinymist/page_{$page->id}/{$fileName}");
        if (!is_file($previewPath)) {
            throw new FileUploadException(trans('errors.path_not_writable', ['filePath' => $previewPath]));
        }

        $this->writeFromLocalPath($attachment->path, $previewPath);
        $attachment->updated_by = user()->id;
        $attachment->save();

        return $attachment->refresh();
    }

    public function undoPreviewChanges(Attachment $attachment): Attachment
    {
        $page = $attachment->page;
        if ($attachment->external || !$page || $page->editor !== 'tinymist') {
            return $attachment;
        }

        $this->previewManager->restoreAttachmentToPreviewDir($page, $attachment);

        return $attachment;
    }

    /**
     * @return array<string, bool>
     */
    public function getDirtyMap(Page $page): array
    {
        $dirtyMap = [];
        if ($page->editor !== 'tinymist') {
            return $dirtyMap;
        }

        foreach ($page->attachments as $attachment) {
            /** @var Attachment $attachment */
            if ($attachment->external) {
                continue;
            }

            $fileName = basename($attachment->getFileName());
            if ($fileName === '' || $fileName === 'entry.typ') {
                continue;
            }

            $storedPath = $this->storage->getSystemPath($attachment->path);
            $previewPath = storage_path("app/tinymist/page_{$page->id}/{$fileName}");

            $storedExists = $storedPath !== '' && is_file($storedPath);
            $previewExists = is_file($previewPath);

            if (!$storedExists && !$previewExists) {
                $dirtyMap[$fileName] = false;
                continue;
            }

            if ($storedExists !== $previewExists) {
                $dirtyMap[$fileName] = true;
                continue;
            }

            $storedHash = @hash_file('sha256', $storedPath) ?: null;
            $previewHash = @hash_file('sha256', $previewPath) ?: null;
            $dirtyMap[$fileName] = $storedHash !== $previewHash;
        }

        return $dirtyMap;
    }

    protected function writeFromLocalPath(string $targetPath, string $localSourcePath): void
    {
        $sourceStream = @fopen($localSourcePath, 'r');
        if (!is_resource($sourceStream)) {
            throw new FileUploadException(trans('errors.path_not_writable', ['filePath' => $localSourcePath]));
        }

        $diskName = $this->getAttachmentDiskName();
        $adjustedPath = $this->adjustPathForStorageDisk($targetPath, $diskName);

        try {
            $this->fileSystem->disk($diskName)->writeStream($adjustedPath, $sourceStream);
        } catch (Exception $e) {
            throw new FileUploadException(trans('errors.path_not_writable', ['filePath' => $targetPath]));
        } finally {
            fclose($sourceStream);
        }
    }

    protected function getAttachmentDiskName(): string
    {
        $storageType = trim(strtolower(config('filesystems.attachments')));

        if ($storageType === 'local' || $storageType === 'local_secure' || $storageType === 'local_secure_restricted') {
            $storageType = 'local_secure_attachments';
        }

        return $storageType;
    }

    protected function adjustPathForStorageDisk(string $path, string $diskName): string
    {
        $trimmed = str_replace('uploads/files/', '', $path);
        $normalized = FilePathNormalizer::normalize($trimmed);

        if ($diskName === 'local_secure_attachments') {
            return $normalized;
        }

        return 'uploads/files/' . $normalized;
    }
}
