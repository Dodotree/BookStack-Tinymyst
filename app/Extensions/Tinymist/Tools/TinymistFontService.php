<?php

namespace BookStack\Extensions\Tinymist\Tools;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;

class TinymistFontService
{
    protected string $typstPath;

    public function __construct()
    {
        $this->typstPath = config('tinymist.typst_cli_path')
            ?? base_path('vendor/bin/typst' . (DIRECTORY_SEPARATOR === '\\' ? '.exe' : ''));
    }

    /**
     * @return array<int, string>
     */
    public function listAvailableFonts(): array
    {
        $cachePath = $this->getCachePath();
        $cachedFonts = $this->readCache($cachePath);

        if (count($cachedFonts) > 0) {
            return $cachedFonts;
        }

        $fonts = $this->queryFontsFromTypst();
        if (count($fonts) > 0) {
            $this->writeCache($cachePath, $fonts);
        }

        return $fonts;
    }

    /**
     * Force-refresh the cached font list by querying Typst directly.
     * Falls back to existing cache when refresh command yields no results.
     *
     * @return array<int, string>
     */
    public function refreshFontCache(): array
    {
        $cachePath = $this->getCachePath();
        $cachedFonts = $this->readCache($cachePath);
        $fonts = $this->queryFontsFromTypst();

        if (count($fonts) > 0) {
            $this->writeCache($cachePath, $fonts);
            return $fonts;
        }

        return $cachedFonts;
    }

    protected function getCachePath(): string
    {
        return storage_path('app/tinymist/fonts-list.txt');
    }

    /**
     * @return array<int, string>
     */
    protected function readCache(string $cachePath): array
    {
        if (!is_file($cachePath)) {
            return [];
        }

        $raw = file_get_contents($cachePath);
        if (!is_string($raw) || trim($raw) === '') {
            return [];
        }

        $fonts = [];
        foreach (preg_split('/\r?\n/', $raw) ?: [] as $line) {
            $name = trim($line);
            if ($name !== '') {
                $fonts[] = $name;
            }
        }

        return $this->normalizeFontList($fonts);
    }

    /**
     * @param array<int, string> $fonts
     */
    protected function writeCache(string $cachePath, array $fonts): void
    {
        try {
            File::ensureDirectoryExists(dirname($cachePath));
            file_put_contents($cachePath, implode(PHP_EOL, $fonts) . PHP_EOL, LOCK_EX);
        } catch (\Throwable $exception) {
            Log::warning('Failed to write Tinymist font cache', [
                'path' => $cachePath,
                'error' => $exception->getMessage(),
            ]);
        }
    }

    /**
     * @return array<int, string>
     */
    protected function queryFontsFromTypst(): array
    {
        $command = sprintf('"%s" fonts 2>&1', str_replace('"', '\\"', $this->typstPath));
        $command = DIRECTORY_SEPARATOR === '\\' ? $command : "sudo -n -u tinymist -- {$command}";

        try {
            exec($command, $output, $returnCode);
        } catch (\Throwable $exception) {
            Log::warning('Tinymist font listing command failed', [
                'error' => $exception->getMessage(),
            ]);

            return [];
        }

        if ($returnCode !== 0) {
            Log::warning('Tinymist font listing command returned non-zero exit code', [
                'command' => $command,
                'return_code' => $returnCode,
                'output_tail' => array_slice($output, -10),
            ]);

            return [];
        }

        return $this->parseFontOutput($output);
    }

    /**
     * @param array<int, string> $output
     * @return array<int, string>
     */
    protected function parseFontOutput(array $output): array
    {
        $fonts = [];

        foreach ($output as $line) {
            $name = trim($line);
            if ($name === '') {
                continue;
            }

            if (str_starts_with(strtolower($name), 'warning:') || str_starts_with(strtolower($name), 'error:')) {
                continue;
            }

            if (preg_match('/^[*-]\s+(.+)$/', $name, $matches)) {
                $name = trim($matches[1]);
            }

            $name = trim($name, "\"' ");
            $name = preg_replace('/\s+\(\d+\s+fonts?\)$/i', '', $name) ?? $name;

            if ($name !== '') {
                $fonts[] = $name;
            }
        }

        return $this->normalizeFontList($fonts);
    }

    /**
     * @param array<int, string> $fonts
     * @return array<int, string>
     */
    protected function normalizeFontList(array $fonts): array
    {
        $uniqueByLower = [];
        foreach ($fonts as $font) {
            $normalized = trim($font);
            if ($normalized === '') {
                continue;
            }

            $uniqueByLower[mb_strtolower($normalized)] = $normalized;
        }

        $result = array_values($uniqueByLower);
        usort($result, static fn (string $a, string $b): int => strnatcasecmp($a, $b));

        return $result;
    }
}
