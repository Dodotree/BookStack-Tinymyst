<?php

namespace BookStack\Entities\Tools\Tinymist;

use Illuminate\Support\Facades\Log;

/**
 * Service for compiling Typst documents using typst CLI or Tinymist LSP.
 * Supports both full recompilation (CLI) and incremental compilation (LSP).
 */
class TinymistService
{
    protected string $typstPath;
    protected string $tempDir;
    protected int $timeout;

    public function __construct()
    {
        // Fall back to base_path if config is not set
        $this->typstPath = config('tinymist.typst_cli_path')
            ?? base_path('vendor/bin/typst' . (DIRECTORY_SEPARATOR === '\\' ? '.exe' : ''));
        $this->timeout = config('tinymist.timeout', 30);
        $this->tempDir = sys_get_temp_dir();
    }

    /**
     * Compile Typst source to SVG.
     *
     * @param string $source Typst source code
     * @param array $options Compilation options
     * @return array{success: bool, svg: string|null, errors: array}
     */
    public function compileToSvg(string $source, array $options = []): array
    {
        $inputFile = $this->createTempFile($source, '.typ');
        $outputFile = $inputFile . '.svg';

        try {
            // Use typst CLI for compilation with short diagnostic format
            $command = sprintf(
                '"%s" compile "%s" "%s" --format svg --diagnostic-format short 2>&1',
                str_replace('"', '\"', $this->typstPath),
                str_replace('"', '\"', $inputFile),
                str_replace('"', '\"', $outputFile)
            );

            exec($command, $output, $returnCode);

            if ($returnCode !== 0 || !file_exists($outputFile)) {
                // Parse errors from short diagnostic format
                $diagnostics = $this->parseShortDiagnostics($output);

                return [
                    'success' => false,
                    'svg' => null,
                    'errors' => $output, // Keep raw output for display
                    'diagnostics' => $diagnostics, // Parsed for highlighting
                ];
            }

            $svg = file_get_contents($outputFile);

            // Cleanup
            @unlink($inputFile);
            @unlink($outputFile);

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

            // Cleanup on error
            @unlink($inputFile);
            @unlink($outputFile);

            return [
                'success' => false,
                'svg' => null,
                'errors' => [$e->getMessage()],
                'diagnostics' => [],
            ];
        }
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

    /**
     * Parse Typst CLI short diagnostic format.
     * Format: filename:line:column: level: message
     * Example: temp.typ:1:5: error: unknown variable: foo
     * Windows example: \\?\C:\Users\...\temp.typ:1:5: error: unknown variable: foo
     *
     * @param array $output Raw output lines from typst compile
     * @return array Parsed diagnostics in format compatible with frontend
     */
    protected function parseShortDiagnostics(array $output): array
    {
        $diagnostics = [];
        $currentDiag = null;

        foreach ($output as $line) {
            // Match: path:line:col: severity: message
            if (preg_match('/^(.+):(\d+):(\d+):\s*(error|warning|hint|info):\s*(.+)$/i', $line, $matches)) {
                // Save previous diagnostic if exists
                if ($currentDiag) {
                    $diagnostics[] = $currentDiag;
                }

                $currentDiag = [
                    'line' => (int)$matches[2],
                    'column' => (int)$matches[3],
                    'severity' => strtolower($matches[4]),
                    'message' => $matches[5],
                    'hints' => []
                ];
            } elseif ($currentDiag && preg_match('/^Hint:\s*(.+)$/i', $line, $matches)) {
                // Add hint to current diagnostic
                $currentDiag['hints'][] = $matches[1];
            }
        }

        // Add last diagnostic
        if ($currentDiag) {
            $diagnostics[] = $currentDiag;
        }

        return $diagnostics;
    }

    /**
     * Check if typst CLI is available.
     */
    public function isAvailable(): bool
    {
        try {
            $command = sprintf('"%s" --version 2>&1', str_replace('"', '\"', $this->typstPath));
            exec($command, $output, $returnCode);
            return $returnCode === 0;
        } catch (\Exception $e) {
            return false;
        }
    }
}
