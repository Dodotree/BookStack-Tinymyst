<?php

declare(strict_types=1);

namespace BookStack\Extensions\Tinymist\Tools;

use RuntimeException;
use Symfony\Component\Process\Process;

class TinymistPandocService
{
    protected string $pandocPath;
    protected int $timeout;

    public function __construct()
    {
        $this->pandocPath = config('tinymist.pandoc_cli_path')
            ?? base_path('vendor/bin/pandoc' . (DIRECTORY_SEPARATOR === '\\' ? '.exe' : ''));
        $this->timeout = (int) config('tinymist.timeout', 30);
    }

    /**
     * @throws RuntimeException
     */
    public function convertToTypst(string $content, string $sourceFormat): string
    {
        $normalizedFormat = strtolower(trim($sourceFormat));
        if (!in_array($normalizedFormat, ['markdown', 'html'], true)) {
            throw new RuntimeException(trans('entities.tinymist_convert_invalid_source'));
        }

        $process = new Process([
            $this->pandocPath,
            '-f', $normalizedFormat,
            '-t', 'typst',
            '--wrap=preserve',
        ]);
        $process->setTimeout($this->timeout);
        $process->setInput($content);
        $process->run();

        if (!$process->isSuccessful()) {
            $message = trim($process->getErrorOutput());
            if ($message === '') {
                $message = trim($process->getOutput());
            }
            if ($message === '') {
                $message = trans('entities.tinymist_convert_failed');
            }

            throw new RuntimeException($message);
        }

        $output = trim($process->getOutput());
        if ($output === '') {
            throw new RuntimeException(trans('entities.tinymist_convert_empty_output'));
        }

        return $output;
    }
}
