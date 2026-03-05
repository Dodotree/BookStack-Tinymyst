<?php

namespace BookStack\Uploads;

use BookStack\Entities\Models\Page;
use BookStack\Extensions\Tinymist\Attachments\TinymistAttachmentSyncService;
use BookStack\Exceptions\FileUploadException;
use Exception;
use Symfony\Component\HttpFoundation\File\UploadedFile;

class AttachmentService
{
    public function __construct(
        protected FileStorage $storage,
        protected TinymistAttachmentSyncService $tinymistAttachmentSyncService,
    ) {
    }

    /**
     * Stream an attachment from storage.
     *
     * @return resource|null
     */
    public function streamAttachmentFromStorage(Attachment $attachment)
    {
        return $this->storage->getReadStream($attachment->path);
    }

    /**
     * Read the file size of an attachment from storage, in bytes.
     */
    public function getAttachmentFileSize(Attachment $attachment): int
    {
        return $this->storage->getSize($attachment->path);
    }

    /**
     * Store a new attachment upon user upload.
     *
     * @throws FileUploadException
     */
    public function saveNewUpload(UploadedFile $uploadedFile, int $pageId): Attachment
    {
        $attachmentName = $uploadedFile->getClientOriginalName();
        $attachmentPath = $this->putFileInStorage($uploadedFile);
        $largestExistingOrder = Attachment::query()->where('uploaded_to', '=', $pageId)->max('order');

        /** @var Attachment $attachment */
        $attachment = Attachment::query()->forceCreate([
            'name'        => $attachmentName,
            'path'        => $attachmentPath,
            'extension'   => $uploadedFile->getClientOriginalExtension(),
            'uploaded_to' => $pageId,
            'created_by'  => user()->id,
            'updated_by'  => user()->id,
            'order'       => $largestExistingOrder + 1,
        ]);

        $this->tinymistAttachmentSyncService->syncAttachmentIfNeeded($attachment, $pageId);

        return $attachment;
    }

    /**
     * Store an upload, saving to a file and deleting any existing uploads
     * attached to that file.
     *
     * @throws FileUploadException
     */
    public function saveUpdatedUpload(UploadedFile $uploadedFile, Attachment $attachment): Attachment
    {
        $oldFileName = $attachment->external ? null : $attachment->getFileName();

        if (!$attachment->external) {
            $this->tinymistAttachmentSyncService->removeAttachmentIfNeeded($attachment, $oldFileName);
            $this->deleteFileInStorage($attachment);
        }

        $attachmentName = $uploadedFile->getClientOriginalName();
        $attachmentPath = $this->putFileInStorage($uploadedFile);

        $attachment->name = $attachmentName;
        $attachment->path = $attachmentPath;
        $attachment->external = false;
        $attachment->extension = $uploadedFile->getClientOriginalExtension();
        $attachment->save();

        $this->tinymistAttachmentSyncService->syncAttachmentIfNeeded($attachment);

        return $attachment;
    }

    /**
     * Save updated attachment content from Tinymist preview storage back to BookStack attachment storage.
     */
    public function saveAttachmentFromTinymistPreview(Attachment $attachment): Attachment
    {
        return $this->tinymistAttachmentSyncService->saveFromPreview($attachment);
    }

    /**
     * Undo Tinymist preview edits in storage/page_num/ folder, restoring the preview copy from saved attachment content.
     */
    public function undoTinymistPreviewAttachmentChanges(Attachment $attachment): Attachment
    {
        return $this->tinymistAttachmentSyncService->undoPreviewChanges($attachment);
    }

    /**
     * Build a dirty-state map for page attachments by comparing Tinymist preview and stored attachment content.
     *
     * @return array<string, bool>
     */
    public function getTinymistAttachmentDirtyMap(Page $page): array
    {
        return $this->tinymistAttachmentSyncService->getDirtyMap($page);
    }

    /**
     * Save a new File attachment from a given link and name.
     */
    public function saveNewFromLink(string $name, string $link, int $page_id): Attachment
    {
        $largestExistingOrder = Attachment::where('uploaded_to', '=', $page_id)->max('order');

        return Attachment::forceCreate([
            'name'        => $name,
            'path'        => $link,
            'external'    => true,
            'extension'   => '',
            'uploaded_to' => $page_id,
            'created_by'  => user()->id,
            'updated_by'  => user()->id,
            'order'       => $largestExistingOrder + 1,
        ]);
    }

    /**
     * Updates the ordering for a listing of attached files.
     */
    public function updateFileOrderWithinPage(array $attachmentOrder, string $pageId)
    {
        foreach ($attachmentOrder as $index => $attachmentId) {
            Attachment::query()->where('uploaded_to', '=', $pageId)
                ->where('id', '=', $attachmentId)
                ->update(['order' => $index]);
        }
    }

    /**
     * Update the details of a file.
     */
    public function updateFile(Attachment $attachment, array $requestData): Attachment
    {
        $oldFileName = $attachment->external ? null : $attachment->getFileName();
        $oldExternal = $attachment->external;

        if (isset($requestData['name'])) {
            $attachment->name = $requestData['name'];
        }

        $link = trim($requestData['link'] ?? '');
        if (!empty($link)) {
            if (!$attachment->external) {
                $this->tinymistAttachmentSyncService->removeAttachmentIfNeeded($attachment, $oldFileName);
                $this->deleteFileInStorage($attachment);
                $attachment->external = true;
                $attachment->extension = '';
            }
            $attachment->path = $link;
        }

        $attachment->save();

        if (!$attachment->external && !$oldExternal) {
            $newFileName = $attachment->getFileName();
            if ($oldFileName && $oldFileName !== $newFileName) {
                $this->tinymistAttachmentSyncService->removeAttachmentIfNeeded($attachment, $oldFileName);
                $this->tinymistAttachmentSyncService->syncAttachmentIfNeeded($attachment);
            }
        }

        return $attachment->refresh();
    }

    /**
     * Delete a File from the database and storage.
     *
     * @throws Exception
     */
    public function deleteFile(Attachment $attachment)
    {
        $fileName = $attachment->external ? null : $attachment->getFileName();

        if (!$attachment->external) {
            $this->tinymistAttachmentSyncService->removeAttachmentIfNeeded($attachment, $fileName);
            $this->deleteFileInStorage($attachment);
        }

        $attachment->delete();
    }

    /**
     * Delete a file from the filesystem it sits on.
     * Cleans any empty leftover folders.
     */
    public function deleteFileInStorage(Attachment $attachment): void
    {
        $this->storage->delete($attachment->path);
    }

    /**
     * Store a file in storage with the given filename.
     *
     * @throws FileUploadException
     */
    protected function putFileInStorage(UploadedFile $uploadedFile): string
    {
        $basePath = 'uploads/files/' . date('Y-m-M') . '/';

        return $this->storage->uploadFile(
            $uploadedFile,
            $basePath,
            $uploadedFile->getClientOriginalExtension(),
            ''
        );
    }

    /**
     * Get the file validation rules for attachments.
     */
    public static function getFileValidationRules(): array
    {
        return ['file', 'max:' . (config('app.upload_limit') * 1000)];
    }
}
