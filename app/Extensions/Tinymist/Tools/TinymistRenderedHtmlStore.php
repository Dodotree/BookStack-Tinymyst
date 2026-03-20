<?php

namespace BookStack\Extensions\Tinymist\Tools;

use BookStack\Entities\Models\Page;

class TinymistRenderedHtmlStore
{
    public function storePageHtml(Page $page, string $html): void
    {
        $directory = $this->getPreviewDirectory();
        if (!is_dir($directory)) {
            mkdir($directory, 0755, true);
        }

        $filePath = $this->getPagePreviewPath($page);
        $tempPath = $filePath . '.tmp';

        file_put_contents($tempPath, $html, LOCK_EX);
        @rename($tempPath, $filePath);
    }

    public function getPageHtml(Page $page): string
    {
        $filePath = $this->getPagePreviewPath($page);
        if (!is_file($filePath)) {
            return '';
        }

        $content = @file_get_contents($filePath);
        return is_string($content) ? $content : '';
    }

    /**
     * @param string[] $svgFiles
     */
    public function storePageHtmlFromSvgFiles(Page $page, array $svgFiles): void
    {
        $directory = $this->getPreviewDirectory();
        if (!is_dir($directory)) {
            mkdir($directory, 0755, true);
        }

        $filePath = $this->getPagePreviewPath($page);
        $tempPath = $filePath . '.tmp';
        $output = fopen($tempPath, 'wb');
        if ($output === false) {
            throw new \RuntimeException('Failed to open temporary preview html file for writing');
        }

        try {
            fwrite($output, '<div class="tinymist-document">');

            foreach ($svgFiles as $index => $svgFile) {
                $input = fopen($svgFile, 'rb');
                if ($input === false) {
                    continue;
                }

                stream_copy_to_stream($input, $output);
                fclose($input);

                if ($index < (count($svgFiles) - 1)) {
                    fwrite($output, "\n");
                }
            }

            fwrite($output, '</div>');
        } finally {
            fclose($output);
        }

        @rename($tempPath, $filePath);
    }

    protected function getPagePreviewPath(Page $page): string
    {
        return $this->getPreviewDirectory() . DIRECTORY_SEPARATOR . 'page_' . $page->id . '.html';
    }

    protected function getPreviewDirectory(): string
    {
        return storage_path('app/tinymist/preview');
    }
}
