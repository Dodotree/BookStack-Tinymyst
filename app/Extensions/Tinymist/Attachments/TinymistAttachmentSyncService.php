<?php

namespace BookStack\Extensions\Tinymist\Attachments;

use BookStack\Entities\Models\Page;
use BookStack\Entities\Tools\Tinymist\TinymistPreviewManager;
use BookStack\Exceptions\FileUploadException;
use BookStack\Uploads\Attachment;
use BookStack\Uploads\FileStorage;

class TinymistAttachmentSyncService
{
    public function __construct(
        protected FileStorage $storage,
        protected TinymistPreviewManager $previewManager,
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

        $this->storage->writeFromLocalPath($attachment->path, $previewPath);
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
}
