<?php

namespace BookStack\Theming;

use BookStack\Facades\Theme;
use BookStack\Http\Controller;
use BookStack\Util\FilePathNormalizer;
use Symfony\Component\HttpFoundation\StreamedResponse;

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
    public function publicFile(string $theme, string $path): StreamedResponse
    {
        $cleanPath = FilePathNormalizer::normalize($path);
        if ($theme !== Theme::getTheme() || !$cleanPath) {
            abort(404);
        }

        $filePath = Theme::findFirstFile("public/{$cleanPath}");
        if (!$filePath) {
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
