<?php

namespace BookStack\Extensions\Tinymist\Imports;

use BookStack\Entities\Models\Page;
use BookStack\Entities\Repos\PageRepo;
use Symfony\Component\HttpFoundation\File\UploadedFile;

class TinymistImportBridge
{
    public function __construct(
        protected PageRepo $pageRepo,
    ) {
    }

    public function supportsExtension(string $extension): bool
    {
        return in_array(strtolower($extension), ['zip', 'typ'], true);
    }

    /**
     * @param callable(UploadedFile, Page, string): Page $zipImporter
     * @param callable(UploadedFile): string $contentReader
     */
    public function importFromUpload(
        string $extension,
        UploadedFile $file,
        Page $draft,
        string $baseName,
        callable $zipImporter,
        callable $contentReader,
    ): ?Page {
        $extension = strtolower($extension);

        if ($extension === 'zip') {
            return $zipImporter($file, $draft, $baseName);
        }

        if ($extension === 'typ') {
            return $this->publishTinymist($draft, $baseName, $contentReader($file));
        }

        return null;
    }

    public function publishTinymist(Page $draft, string $name, string $content): Page
    {
        return $this->pageRepo->publishDraft($draft, [
            'name' => $name,
            'tinymist' => $content,
        ]);
    }
}
