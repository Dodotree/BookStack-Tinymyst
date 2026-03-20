<?php

namespace BookStack\Extensions\Tinymist\Tools;

use Illuminate\Support\Facades\Log;

/**
 * Service for compiling Typst documents using typst CLI or Tinymist LSP.
 * Supports both full recompilation (CLI) and incremental compilation (LSP).
 */
class TinymistService
{
    protected string $typstPath;
    protected ?string $packagePath;
    protected string $tempDir;
    protected int $timeout;

    public function __construct()
    {
        // Fall back to base_path if config is not set
        $this->typstPath = config('tinymist.typst_cli_path')
            ?? base_path('vendor/bin/typst' . (DIRECTORY_SEPARATOR === '\\' ? '.exe' : ''));
        $packagePath = config('tinymist.package_path');
        $this->packagePath = is_string($packagePath) && trim($packagePath) !== '' ? $packagePath : null;
        $this->timeout = config('tinymist.timeout', 30);
        $this->tempDir = sys_get_temp_dir();
    }

    /**
     * Compile Typst source to SVG.
     *
     * @param string $source Typst source code
     * @param array $options Compilation options
     * @return array{success: bool, svg: string|null, errors: array, diagnostics: array, svg_files?: array, artifacts?: array}
     */
    public function compileToSvg(string $source, array $options = []): array
    {
        $pageId = isset($options['pageId']) ? (int)$options['pageId'] : 0;
        $returnSvgFiles = !empty($options['returnSvgFiles']);
        $useStorage = $pageId > 0;
        $commandId = uniqid('typst_', true);
        $outputDir = null;

        if ($useStorage) {
            $inputFile = $this->writeSourceToStorage($pageId, $source);
            $outputDir = $this->createTempDirectory('tinymist_svg_' . $pageId . '_');
            $outputTemplate = $outputDir . DIRECTORY_SEPARATOR . 'render-{p}.svg';
        } else {
            $inputFile = $this->createTempFile($source, '.typ');
            $outputTemplate = $inputFile . '-{p}.svg';
        }
        $outputGlob = $useStorage
            ? ($outputDir . DIRECTORY_SEPARATOR . 'render-*.svg')
            : ($inputFile . '-*.svg');

        try {
            // Use typst CLI for compilation with short diagnostic format
            $command = sprintf(
                '"%s" compile "%s" "%s" --format svg --diagnostic-format short%s 2>&1',
                str_replace('"', '\\"', $this->typstPath),
                str_replace('"', '\\"', $inputFile),
                str_replace('"', '\\"', $outputTemplate),
                $this->buildPackagePathArgument()
            );

            // To prevent typst from loading packages on our server, we run it under
            // a dedicated user tinymist which only can access localhost
            // switching from www-data to tinymist user (Linux-specific) - requires sudo setup:
            // visudo -f /etc/sudoers.d/bookstack-typst
            // www-data ALL=(tinymist) NOPASSWD: /var/www/bookstack/vendor/bin/typst
            $command = DIRECTORY_SEPARATOR === '\\' ?  $command : "sudo -n -u tinymist -- " . $command;

            $startedAt = microtime(true);
            $this->logTypstCommand([
                'event' => 'start',
                'command_id' => $commandId,
                'page_id' => $pageId,
                'input_file' => $inputFile,
                'output_template' => $outputTemplate,
                'command' => $command,
            ]);

            exec($command, $output, $returnCode);
            $durationMs = (int) round((microtime(true) - $startedAt) * 1000);

            $svgFiles = glob($outputGlob) ?: [];

            $this->logTypstCommand([
                'event' => 'finish',
                'command_id' => $commandId,
                'page_id' => $pageId,
                'return_code' => $returnCode,
                'duration_ms' => $durationMs,
                'svg_file_count' => count($svgFiles),
                'output_line_count' => count($output),
                'output_tail' => $this->tailOutput($output),
            ]);

            if ($returnCode !== 0 || count($svgFiles) === 0) {
                // Parse errors from short diagnostic format
                $diagnostics = $this->parseDiagnostics($output);

                return [
                    'success' => false,
                    'svg' => null,
                    'errors' => $output, // Keep raw output for display
                    'diagnostics' => $diagnostics, // Parsed for highlighting
                ];
            }

            usort($svgFiles, function (string $a, string $b): int {
                $pageA = (int)preg_replace('/^.*-(\d+)\.svg$/', '$1', $a);
                $pageB = (int)preg_replace('/^.*-(\d+)\.svg$/', '$1', $b);
                return $pageA <=> $pageB;
            });

            if ($returnSvgFiles) {
                if (!$useStorage) {
                    @unlink($inputFile);
                }

                return [
                    'success' => true,
                    'svg' => null,
                    'errors' => [],
                    'diagnostics' => [],
                    'svg_files' => $svgFiles,
                    'artifacts' => [
                        'use_storage' => $useStorage,
                        'output_dir' => $outputDir,
                    ],
                ];
            }

            $svgParts = [];
            foreach ($svgFiles as $svgFile) {
                $svgContent = file_get_contents($svgFile);
                if ($svgContent !== false) {
                    $svgParts[] = $svgContent;
                }
            }

            $svg = implode("\n", $svgParts);

            // Cleanup
            if (!$useStorage) {
                @unlink($inputFile);
            }
            foreach ($svgFiles as $svgFile) {
                @unlink($svgFile);
            }
            if ($outputDir && is_dir($outputDir)) {
                @rmdir($outputDir);
            }

            return [
                'success' => true,
                'svg' => $svg,
                'errors' => [],
                'diagnostics' => [],
            ];
        } catch (\Exception $e) {
            Log::error('Typst compilation failed', [
                'error' => $e->getMessage(),
                'source_length' => strlen($source),
            ]);

            $this->logTypstCommand([
                'event' => 'exception',
                'command_id' => $commandId,
                'page_id' => $pageId,
                'error' => $e->getMessage(),
            ]);

            // Cleanup on error
            if (!$useStorage) {
                @unlink($inputFile);
            }
            foreach (glob($outputGlob) ?: [] as $svgFile) {
                @unlink($svgFile);
            }
            if ($outputDir && is_dir($outputDir)) {
                @rmdir($outputDir);
            }

            return [
                'success' => false,
                'svg' => null,
                'errors' => [$e->getMessage()],
                'diagnostics' => [],
            ];
        }
    }

    public function cleanupCompileArtifacts(array $result): void
    {
        $svgFiles = $result['svg_files'] ?? [];
        foreach ($svgFiles as $svgFile) {
            @unlink((string) $svgFile);
        }

        $outputDir = $result['artifacts']['output_dir'] ?? null;
        if (is_string($outputDir) && is_dir($outputDir)) {
            @rmdir($outputDir);
        }
    }

    protected function logTypstCommand(array $payload): void
    {
        try {
            $logFile = storage_path('logs/tinymist-php-typst.log');
            $line = '[' . date('Y-m-d H:i:s') . '] ' . json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL;
            @file_put_contents($logFile, $line, FILE_APPEND | LOCK_EX);
        } catch (\Throwable $logError) {
            Log::warning('Failed to write tinymist php typst log', [
                'error' => $logError->getMessage(),
            ]);
        }
    }

    protected function tailOutput(array $output, int $maxLines = 20): array
    {
        $lines = array_values($output);
        if (count($lines) <= $maxLines) {
            return $lines;
        }

        return array_slice($lines, -$maxLines);
    }

    /**
     * Validate Typst source without full compilation.
     * Returns diagnostics (errors, warnings).
     */
    public function validate(string $source): array
    {
        // compilation and capture errors
        $result = $this->compileToSvg($source);

        return [
            'valid' => $result['success'],
            'errors' => $result['errors'],
        ];
    }

    /**
     * Create temporary file with content.
     */
    protected function createTempFile(string $content, string $extension = ''): string
    {
        $tempFile = tempnam($this->tempDir, 'tinymist_') . $extension;
        file_put_contents($tempFile, $content);
        return $tempFile;
    }

    protected function createTempDirectory(string $prefix = 'tinymist_'): string
    {
        $tempBase = tempnam($this->tempDir, $prefix);
        if ($tempBase === false) {
            throw new \RuntimeException('Failed to create temporary directory path');
        }

        @unlink($tempBase);
        if (!mkdir($tempBase, 0777, true) && !is_dir($tempBase)) {
            throw new \RuntimeException('Failed to create temporary directory');
        }
        @chmod($tempBase, 0777);

        return $tempBase;
    }

    protected function writeSourceToStorage(int $pageId, string $content): string
    {
        $directory = storage_path("app/tinymist/page_{$pageId}");
        if (!is_dir($directory)) {
            mkdir($directory, 0755, true);
        }

        $filePath = $directory . DIRECTORY_SEPARATOR . 'entry.typ';
        file_put_contents($filePath, $content);
        return $filePath;
    }

    /**
     * Parse Typst CLI diagnostics (short or human-formatted output).
     * Short format: filename:line:column: level: message
     * Human format:
     *   error: message
     *     ┌─ path:line:column
     *     │
     *   12 │ code
     *     │    ^^^^
     *     = hint: ...
     *
     * Returns diagnostics shaped like LSP output while keeping legacy fields.
     *
     * @param array $output Raw output lines from typst compile
     * @return array Parsed diagnostics
     */
    protected function parseDiagnostics(array $output): array
    {
        $diagnostics = [];
        $current = null;

        $flush = function () use (&$diagnostics, &$current) {
            if (!$current) {
                return;
            }

            $line = (int)($current['line'] ?? 1);
            $column = (int)($current['column'] ?? 1);
            $length = (int)($current['length'] ?? 1);
            $severityText = (string)($current['severity'] ?? 'error');

            $severityMap = [
                'error' => 1,
                'warning' => 2,
                'info' => 3,
                'hint' => 4,
            ];
            $severity = $severityMap[$severityText] ?? 1;

            $rangeStart = max($column - 1, 0);
            $rangeEnd = max($rangeStart + max($length, 1), $rangeStart + 1);

            $diagnostics[] = [
                // LSP-like shape
                'range' => [
                    'start' => ['line' => max($line - 1, 0), 'character' => $rangeStart],
                    'end' => ['line' => max($line - 1, 0), 'character' => $rangeEnd],
                ],
                'severity' => $severity,
                'message' => $current['message'] ?? 'Typst diagnostic',
                'source' => 'typst',
                'hints' => $current['hints'] ?? [],
                // Legacy fields
                'line' => $line,
                'column' => $column,
                'length' => max($length, 1),
                'severity_text' => $severityText,
            ];

            $current = null;
        };

        foreach ($output as $line) {
            $trimmed = rtrim($line);

            // Short format: path:line:col: severity: message
            if (preg_match('/^(.+):(\d+):(\d+):\s*(error|warning|hint|info):\s*(.+)$/i', $trimmed, $matches)) {
                $flush();
                $current = [
                    'line' => (int)$matches[2],
                    'column' => (int)$matches[3],
                    'severity' => strtolower($matches[4]),
                    'message' => $matches[5],
                    'hints' => [],
                    'length' => 1,
                ];
                continue;
            }

            // Human format: severity: message
            if (preg_match('/^(error|warning|hint|info):\s*(.+)$/i', ltrim($trimmed), $matches)) {
                $flush();
                $current = [
                    'severity' => strtolower($matches[1]),
                    'message' => $matches[2],
                    'hints' => [],
                    'length' => 1,
                ];
                continue;
            }

            // Human format: file location line
            if ($current && preg_match('/^[\s│]*┌─\s*(.+):(\d+):(\d+)\s*$/u', $trimmed, $matches)) {
                $current['line'] = (int)$matches[2];
                $current['column'] = (int)$matches[3];
                continue;
            }

            // Human format: source line content
            if ($current && preg_match('/^\s*\d+\s*│\s*(.*)$/u', $trimmed, $matches)) {
                $current['source_line'] = $matches[1];
                continue;
            }

            // Human format: caret line indicates range length
            if ($current && strpos($trimmed, '^') !== false) {
                $after = $trimmed;
                if (strpos($trimmed, '│') !== false) {
                    $parts = explode('│', $trimmed, 2);
                    $after = $parts[1] ?? $trimmed;
                }
                $caretStart = strpos($after, '^');
                if ($caretStart !== false) {
                    $caretLen = 0;
                    $afterLen = strlen($after);
                    for ($i = $caretStart; $i < $afterLen; $i++) {
                        if ($after[$i] !== '^') {
                            break;
                        }
                        $caretLen++;
                    }
                    if ($caretLen > 0) {
                        $current['length'] = $caretLen;
                    }
                }
                continue;
            }

            // Human format: hints
            if ($current && preg_match('/^\s*=\s*hint:\s*(.+)$/i', $trimmed, $matches)) {
                $current['hints'][] = $matches[1];
                continue;
            }
        }

        $flush();

        return $diagnostics;
    }

    /**
     * Check if typst CLI is available.
     */
    public function isTypstAvailable(): bool
    {
        try {
            $command = sprintf('"%s" --version 2>&1', str_replace('"', '\\"', $this->typstPath));
            exec($command, $output, $returnCode);
            return $returnCode === 0;
        } catch (\Exception $e) {
            return false;
        }
    }

    protected function buildPackagePathArgument(): string
    {
        if ($this->packagePath === null) {
            return '';
        }

        return sprintf(
            ' --package-path "%s"',
            str_replace('"', '\\"', $this->packagePath)
        );
    }
}
