<?php

namespace BookStack\Extensions\Tinymist\Attachments;

use BookStack\Entities\Tools\PageEditorType;
use BookStack\Uploads\Attachment;

class TinymistAttachmentEditorContentService
{
    /**
     * Get a Tinymist-specific insert payload when applicable.
     * Returns null when the attachment should use core/default editor content.
     *
     * @return array<string, string>|null
     */
    public function getEditorContentOverride(Attachment $attachment): ?array
    {
        if ($attachment->external || strtolower($attachment->extension) !== 'typ') {
            return null;
        }

        $page = $attachment->page;
        if (!$page || $page->editor !== PageEditorType::Tinymist->value) {
            return null;
        }

        $fileName = basename($attachment->getFileName());
        $escapedFileName = addcslashes($fileName, "\\\"");
        $importLine = '#import "' . $escapedFileName . '": *';

        return [
            'text/html' => '<code>' . e($importLine) . '</code>',
            'text/plain' => $importLine,
            'text/typst' => $importLine,
        ];
    }
}
