<?php

namespace BookStack\Theming;

use BookStack\Facades\Theme;
use BookStack\Http\Controller;
use BookStack\Util\FilePathNormalizer;

class ThemeController extends Controller
{
    /**
     * @var array<string, string>
     */
    protected array $assetMimeByExtension = [
        'js' => 'text/javascript',
        'mjs' => 'text/javascript',
        'css' => 'text/css',
        'map' => 'application/json',
        'json' => 'application/json',
        'svg' => 'image/svg+xml',
    ];

    /**
     * Serve a public file from the configured theme.
     */
    public function publicFile(string $theme, string $path)
    {
        $cleanPath = FilePathNormalizer::normalize($path);
        if ($theme !== Theme::getTheme() || !$cleanPath) {
            abort(404);
        }

        $filePath = theme_path("public/{$cleanPath}");
        if (!file_exists($filePath)) {
            abort(404);
        }

        $response = $this->download()->streamedFileInline($filePath);
        $extension = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
        $mime = $this->assetMimeByExtension[$extension] ?? null;
        if ($mime) {
            $response->headers->set('Content-Type', $mime);
            $response->headers->set('Content-Disposition', 'inline; filename="' . basename($filePath) . '"');
        }
        $response->setMaxAge(86400);

        return $response;
    }
}
