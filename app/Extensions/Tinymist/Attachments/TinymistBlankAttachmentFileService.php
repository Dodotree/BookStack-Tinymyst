<?php

namespace BookStack\Extensions\Tinymist\Attachments;

use BookStack\Exceptions\FileUploadException;
use BookStack\Uploads\Attachment;
use BookStack\Uploads\AttachmentService;
use Symfony\Component\HttpFoundation\File\UploadedFile;

class TinymistBlankAttachmentFileService
{
    public function __construct(
        protected AttachmentService $attachmentService,
    ) {
    }

    /**
     * Extensions available for creating blank attachment files from Tinymist pages.
     *
     * @return string[]
     */
    public static function getBlankFileExtensions(): array
    {
        return [
            'txt', 'md', 'sh', 'bash', 'zsh', 'fish',
            'json', 'yaml', 'yml', 'toml', 'ini',
            'xml', 'html', 'css', 'scss',
            'js', 'ts', 'php', 'py', 'rb', 'go', 'rs',
            'c', 'h', 'cpp', 'hpp', 'java', 'kt', 'swift', 'cs',
            'sql', 'tex', 'typ',
        ];
    }

    /**
     * @throws FileUploadException
     */
    public function saveNewBlankFile(string $fileName, int $pageId): Attachment
    {
        $tempFile = tempnam(sys_get_temp_dir(), 'bs_blank_attachment_');

        if ($tempFile === false) {
            throw new FileUploadException(trans('errors.path_not_writable', ['filePath' => sys_get_temp_dir()]));
        }

        file_put_contents($tempFile, '');

        $upload = new UploadedFile(
            $tempFile,
            $fileName,
            'text/plain',
            null,
            true
        );

        try {
            return $this->attachmentService->saveNewUpload($upload, $pageId);
        } finally {
            @unlink($tempFile);
        }
    }

    public function attachmentFileNameExists(int $pageId, string $fileName): bool
    {
        $target = mb_strtolower(trim($fileName));
        if ($target === '') {
            return false;
        }

        $attachments = Attachment::query()
            ->where('uploaded_to', '=', $pageId)
            ->get(['name', 'extension']);

        foreach ($attachments as $attachment) {
            $existingName = mb_strtolower($attachment->getFileName());
            if ($existingName === $target) {
                return true;
            }
        }

        return false;
    }
}
