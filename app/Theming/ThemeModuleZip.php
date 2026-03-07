<?php

namespace BookStack\Theming;

use ZipArchive;

readonly class ThemeModuleZip
{
    public function __construct(
        protected string $path
    ) {
    }

    public function extractTo(string $destinationPath): void
    {
        $zip = new ZipArchive();
        $zip->open($this->path);
        $zip->extractTo($destinationPath);
        $zip->close();
    }

    /**
     * Read the module's JSON metadata to read it into a ThemeModule instance.
     * @throws ThemeModuleException
     */
    public function getModuleInstance(): ThemeModule
    {
        $zip = new ZipArchive();
        $open = $zip->open($this->path);
        if ($open !== true) {
            throw new ThemeModuleException("Unable to open zip file at {$this->path}");
        }

        $moduleJsonText = $zip->getFromName('bookstack-module.json');
        $zip->close();

        if ($moduleJsonText === false) {
            throw new ThemeModuleException("bookstack-module.json not found within module ZIP at {$this->path}");
        }

        $moduleJson = json_decode($moduleJsonText, true);
        if ($moduleJson === null) {
            throw new ThemeModuleException("Could not read JSON from bookstack-module.json within module ZIP at {$this->path}");
        }

        return ThemeModule::fromJson($moduleJson, '_temp');
    }

    /**
     * Get the path to the zip file.
     */
    public function getPath(): string
    {
        return $this->path;
    }

    /**
     * Check if the zip file exists and that it appears to be a valid zip file.
     */
    public function exists(): bool
    {
        if (!file_exists($this->path)) {
            return false;
        }

        $zip = new ZipArchive();
        $open = $zip->open($this->path, ZipArchive::RDONLY);
        if ($open === true) {
            $zip->close();
            return true;
        }
        return false;
    }

    /**
     * Get the total size of the zip file contents when uncompressed.
     */
    public function getContentsSize(): int
    {
        $zip = new ZipArchive();

        if ($zip->open($this->path) !== true) {
            return 0;
        }

        $totalSize = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);
            if ($stat !== false) {
                $totalSize += $stat['size'];
            }
        }

        $zip->close();

        return $totalSize;
    }
}
