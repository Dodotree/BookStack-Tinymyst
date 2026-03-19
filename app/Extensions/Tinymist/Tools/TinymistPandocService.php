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

        $preCleanedContent = $this->preCleanContentForPandoc($content);

        $process = new Process([
            $this->pandocPath,
            '-f', $normalizedFormat,
            '-t', 'typst',
            '--wrap=preserve',
        ]);
        $process->setTimeout($this->timeout);
        $process->setInput($preCleanedContent);
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

        return $this->postCleanTypstOutput($output);
    }

    protected function preCleanContentForPandoc(string $content): string
    {
        $content = $this->preCleanListMarkersForPandoc($content);

        return $this->transformMathSegments($content, function (string $mathBody): string {
            $mathBody = str_replace(['&lt;', '&gt;', '&amp;'], ['<', '>', '&'], $mathBody);

            $patterns = [
                '/\\\\\\\\/u',
                '/\\\\html(?:Class|Id|Style|Data)\{[^}]*\}\{([^}]*)\}/u',
                '/\\\\(?:display|text|script|scriptscript)style\b/u',
                '/\\\\tag\*?\{[^}]*\}/u',
                '/\\\\kern\{([^}]*)\}/u',
                '/\\\\left\s*/u',
                '/\\\\right\s*/u',
                '/\\\\operatorname\*/u',
                '/\\\\([()|])/u',
                '/([+\-])\s*(?:\\\\\\\\|\/\/+)\s*\1/u',
            ];

            $replacements = [
                ' ',
                '$1',
                '',
                '',
                '\\\\hspace{$1}',
                '',
                '',
                '\\\\operatorname',
                '$1',
                '$1',
            ];

            return preg_replace($patterns, $replacements, $mathBody) ?? $mathBody;
        });
    }

    protected function preCleanListMarkersForPandoc(string $content): string
    {
        $content = preg_replace('/(^|\R)[ \t]*\((\d{1,2})\)[ \t]*/u', "$1$2. ", $content) ?? $content;
        $content = preg_replace('/([^\r\n])\R([ \t]*1\. )/u', "$1\n\n$2", $content) ?? $content;

        return $content;
    }

    protected function postCleanTypstOutput(string $content): string
    {
        $cleaned = $this->transformMathSegments($content, function (string $mathBody): string {
            $mathBody = str_replace(['&lt;', '&gt;', '&amp;'], ['<', '>', '&'], $mathBody);

            $patterns = [
                '/\\\\(?:display|text|script|scriptscript)style\b/u',
                '/\\\\tag\*?\{[^}]*\}/u',
                '/\\\\html(?:Class|Id|Style|Data)\{[^}]*\}\{([^}]*)\}/u',
                '/\\\\operatorname\*/u',
                '/\\\\,/u',
                '/\\\\([()\[\]|])/u',
                '/\\\\\//u',
                '/([+\-])\s*(?:\\\\\\\\|\/\/+)\s*\1/u',
                '/\bl\s*o\s*g(?=\s*(?:_|\(?))/iu',
                '/\bl\s*n(?=\s*(?:_|\(?))/iu',
            ];

            $replacements = [
                '',
                '',
                '$1',
                '\\\\operatorname',
                ', ',
                '$1',
                '/',
                '$1',
                'log',
                'ln',
            ];

            return preg_replace($patterns, $replacements, $mathBody) ?? $mathBody;
        });

        return preg_replace(
            ['~\\\\([()\[\]|])~u', '~\\\\/~u'],
            ['$1', '/'],
            $cleaned,
        ) ?? $cleaned;
    }
    /**
     * Applies a transformation to math body content while preserving delimiters.
     */
    protected function transformMathSegments(string $content, callable $transform): string
    {
        $length = strlen($content);
        if ($length === 0) {
            return $content;
        }

        $output = '';
        $cursor = 0;

        while ($cursor < $length) {
            $segment = $this->findNextMathSegment($content, $cursor);
            if ($segment === null) {
                $output .= substr($content, $cursor);
                break;
            }

            $start = $segment['start'];
            $end = $segment['end'];
            $openLen = $segment['openLen'];
            $closeLen = $segment['closeLen'];

            $output .= substr($content, $cursor, $start - $cursor);

            $open = substr($content, $start, $openLen);
            $body = substr($content, $start + $openLen, $end - $start - $openLen - $closeLen);
            $close = substr($content, $end - $closeLen, $closeLen);

            $output .= $open . $transform($body) . $close;
            $cursor = $end;
        }

        return $output;
    }

    /**
     * @return array{start:int,end:int,openLen:int,closeLen:int}|null
     */
    protected function findNextMathSegment(string $content, int $offset): ?array
    {
        $length = strlen($content);
        for ($i = $offset; $i < $length; $i++) {
            $char = $content[$i];

            if ($char === '$' && !$this->isEscapedAt($content, $i)) {
                $isDisplay = ($i + 1 < $length && $content[$i + 1] === '$');
                $openLen = $isDisplay ? 2 : 1;
                $closePos = $this->findClosingDollar($content, $i + $openLen, $isDisplay);
                if ($closePos !== null) {
                    return [
                        'start' => $i,
                        'end' => $closePos + $openLen,
                        'openLen' => $openLen,
                        'closeLen' => $openLen,
                    ];
                }
            }

            if ($char === '\\' && $i + 1 < $length) {
                $next = $content[$i + 1];
                if ($next === '(' || $next === '[') {
                    $closeSeq = $next === '(' ? '\\)' : '\\]';
                    $closePos = $this->findClosingSequence($content, $i + 2, $closeSeq);
                    if ($closePos !== null) {
                        return [
                            'start' => $i,
                            'end' => $closePos + 2,
                            'openLen' => 2,
                            'closeLen' => 2,
                        ];
                    }
                }
            }
        }

        return null;
    }

    protected function findClosingDollar(string $content, int $offset, bool $display): ?int
    {
        $length = strlen($content);
        for ($i = $offset; $i < $length; $i++) {
            if ($content[$i] !== '$' || $this->isEscapedAt($content, $i)) {
                continue;
            }

            if ($display) {
                if ($i + 1 < $length && $content[$i + 1] === '$' && !$this->isEscapedAt($content, $i + 1)) {
                    return $i;
                }

                continue;
            }

            return $i;
        }

        return null;
    }

    protected function findClosingSequence(string $content, int $offset, string $needle): ?int
    {
        $pos = strpos($content, $needle, $offset);
        while ($pos !== false) {
            if (!$this->isEscapedAt($content, $pos)) {
                return $pos;
            }

            $pos = strpos($content, $needle, $pos + 1);
        }

        return null;
    }

    protected function isEscapedAt(string $content, int $index): bool
    {
        $slashCount = 0;
        for ($i = $index - 1; $i >= 0; $i--) {
            if ($content[$i] !== '\\') {
                break;
            }

            $slashCount++;
        }

        return ($slashCount % 2) === 1;
    }
}
