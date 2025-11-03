<?php

namespace BookStack\Entities\Controllers;

use BookStack\Entities\Models\Page;
use BookStack\Entities\Tools\Tinymist\TinymistPreviewManager;
use BookStack\Entities\Tools\Tinymist\TinymistService;
use BookStack\Http\Controller;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;

class TinymistController extends Controller
{
    public function __construct(
        protected TinymistService $tinymist
    ) {
    }

    /**
     * Compile Typst source to SVG (AJAX endpoint).
     * POST /ajax/tinymist/compile
     */
    public function compile(Request $request)
    {
        $source = $request->input('source', '');

        // Validate source is not empty
        if (empty($source)) {
            return response()->json([
                'success' => false,
                'svg' => null,
                'errors' => ['No Typst source provided'],
            ]);
        }

        // Check document size limit
        $maxSize = config('tinymist.max_document_size', 1024) * 1024; // Convert KB to bytes
        if (strlen($source) > $maxSize) {
            return response()->json([
                'success' => false,
                'svg' => null,
                'errors' => ['Document exceeds maximum size limit'],
            ]);
        }

        // Compile the source
        $result = $this->tinymist->compileToSvg($source);

        return response()->json($result);
    }

    /**
     * Check Typst source (AJAX endpoint).
     * POST /ajax/tinymist/check
     */
    public function check(Request $request)
    {
        $source = $request->input('source', '');
        $diagnostics = $this->tinymist->validate($source);

        return response()->json($diagnostics);
    }

    /**
     * Check if Tinymist/Typst is available.
     * GET /ajax/tinymist/status
     */
    public function status()
    {
        $available = $this->tinymist->isAvailable();

        return response()->json([
            'available' => $available,
            'enabled' => config('tinymist.enabled', false),
        ]);
    }

    /**
     * Start preview server for a page (called when user opens editor)
     */
    public function startPreview(Request $request)
    {
        $request->validate([
            'page_id' => 'required|integer|exists:pages,id',
            'content' => 'string|nullable',
        ]);

        $pageId = $request->input('page_id');
        $content = $request->input('content', '');

        try {
            // Get the page
            $page = Page::findOrFail($pageId);

            // Save current content to temp file
            $typstPath = "tinymist/page_{$pageId}.typ";

            // Write directly to file instead of using Storage facade
            $fullPath = storage_path("app/{$typstPath}");
            $directory = dirname($fullPath);
            if (!is_dir($directory)) {
                mkdir($directory, 0755, true);
            }
            file_put_contents($fullPath, $content ?: 'Empty document from controller');

            // Start preview server
            $manager = app(TinymistPreviewManager::class);
            $result = $manager->startPreviewServer($pageId, $typstPath);

            return response()->json($result);

        } catch (\Exception $e) {
            Log::error('Failed to start preview server', [
                'page_id' => $pageId,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'error' => $e->getMessage(),
            ], 500);
        }
    }

    /**
     * Stop preview server for a page (called when user closes editor or saves)
     */
    public function stopPreview(Request $request)
    {
        $request->validate([
            'page_id' => 'required|integer|exists:pages,id',
        ]);

        $pageId = $request->input('page_id');

        try {
            $manager = app(TinymistPreviewManager::class);
            $manager->stopPreviewServer($pageId);

            return response()->json(['success' => true]);

        } catch (\Exception $e) {
            Log::error('Failed to stop preview server', [
                'page_id' => $pageId,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'error' => $e->getMessage(),
            ], 500);
        }
    }

    /**
     * Update file content (called as user types - debounced)
     */
    public function updatePreviewContent(Request $request)
    {
        $request->validate([
            'page_id' => 'required|integer|exists:pages,id',
            'content' => 'required|string',
        ]);

        $pageId = $request->input('page_id');
        $content = $request->input('content');

        try {
            // Update the temp file that tinymist preview is watching
            $typstPath = "tinymist/page_{$pageId}.typ";
            Storage::put($typstPath, $content);

            // Update activity timestamp
            $manager = app(TinymistPreviewManager::class);
            $manager->updateActivity($pageId);

            // Tinymist will automatically detect file change and push SVG via WebSocket

            return response()->json(['success' => true]);

        } catch (\Exception $e) {
            Log::error('Failed to update preview content', [
                'page_id' => $pageId,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'error' => $e->getMessage(),
            ], 500);
        }
    }
}
