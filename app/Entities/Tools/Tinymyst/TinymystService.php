<?php

namespace BookStack\Entities\Tools\Tinymyst;

use Illuminate\Support\Facades\Log;

/**
 * Service for compiling Typst documents using typst CLI.
 * This is the simplest implementation using direct CLI compilation.
 */
class TinymystService
{
    protected string $typstPath;
    protected string $tempDir;
    protected int $timeout;

    public function __construct()
    {
        // Use typst CLI for compilation (simpler than full Tinymyst LSP)
        // Fall back to base_path if config is not set
        $this->typstPath = config('tinymyst.typst_cli_path')
            ?? base_path('vendor/bin/typst.exe');
        $this->timeout = config('tinymyst.timeout', 30);
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
            // Use typst CLI for compilation
            // Build command array for proper escaping on all platforms
            $command = sprintf(
                '"%s" compile "%s" "%s" --format svg 2>&1',
                str_replace('"', '\"', $this->typstPath),
                str_replace('"', '\"', $inputFile),
                str_replace('"', '\"', $outputFile)
            );

            exec($command, $output, $returnCode);

            if ($returnCode !== 0 || !file_exists($outputFile)) {
                return [
                    'success' => false,
                    'svg' => null,
                    'errors' => $output,
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
            ];
        }
    }

    /**
     * Validate Typst source without full compilation.
     * Returns diagnostics (errors, warnings).
     */
    public function validate(string $source): array
    {
        // For now, attempt compilation and capture errors
        // In the future, could use tinymyst LSP for faster diagnostics
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
        $tempFile = tempnam($this->tempDir, 'tinymyst_') . $extension;
        file_put_contents($tempFile, $content);
        return $tempFile;
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
