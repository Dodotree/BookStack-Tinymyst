<?php

namespace BookStack\Entities\Controllers;

use BookStack\Entities\Models\Page;
use BookStack\Entities\Tools\Tinymist\TinymistPreviewManager;
use BookStack\Entities\Tools\Tinymist\TinymistService;
use BookStack\Http\Controller;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class TinymistController extends Controller
{
    public function __construct(
        protected TinymistService $tinymist
    ) {
    }

    /**
     * Compile Typst content to SVG (AJAX endpoint).
     * POST /ajax/tinymist/compile
     */
    public function compile(Request $request)
    {
        $content = $request->input('content', '');
        $pageId = (int)$request->input('page_id', 0);
        $docVersion = $request->input('docVersion');

        // Validate content is not empty
        if (empty($content)) {
            return response()->json([
                'success' => false,
                'svg' => null,
                'errors' => ['No Typst content provided'],
                'docVersion' => $docVersion,
            ]);
        }

        // Check document size limit
        $maxSize = config('tinymist.max_document_size', 1024) * 1024; // Convert KB to bytes
        if (strlen($content) > $maxSize) {
            return response()->json([
                'success' => false,
                'svg' => null,
                'errors' => ['Document exceeds maximum size limit'],
                'docVersion' => $docVersion,
            ]);
        }

        // Compile the content
        $options = $pageId > 0 ? ['pageId' => $pageId] : [];
        $result = $this->tinymist->compileToSvg($content, $options);

        if (!is_null($docVersion)) {
            $result['docVersion'] = $docVersion;
        }

        return response()->json($result);
    }

    /**
     * Check Typst content (AJAX endpoint).
     * POST /ajax/tinymist/check
     */
    public function check(Request $request)
    {
        $content = $request->input('content', '');
        $diagnostics = $this->tinymist->validate($content);

        return response()->json($diagnostics);
    }

    /**
     * Check if Tinymist/Typst is available.
     * GET /ajax/tinymist/status
     */
    public function status()
    {
        $available = $this->tinymist->isTypstAvailable();

        return response()->json([
            'available' => $available,
            'enabled' => config('tinymist.enabled', false),
        ]);
    }

    /**
     * Renew WebSocket token for file sync
     * POST /ajax/tinymist/renew-ws-token
     */
    public function renewWsToken(Request $request)
    {
        $request->validate([
            'page_id' => 'required|integer|exists:pages,id',
        ]);

        $pageId = $request->input('page_id');

        try {
            // Get the page to verify access
            $page = Page::findOrFail($pageId);

            // Check if user has edit permission
            $this->checkOwnablePermission('page-update', $page);

            $manager = app(TinymistPreviewManager::class);
            $token = $manager->generateTinymistWsToken($page);

            return response()->json([
                'success' => true,
                'token' => $token['ws_token'],
                'expires_at' => $token['expires_at'],
            ]);
        } catch (\Exception $e) {
            Log::error('Failed to renew WebSocket token', [
                'page_id' => $pageId,
                'user_id' => user()->id ?? null,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'error' => $e->getMessage(),
            ], 500);
        }
    }
}
