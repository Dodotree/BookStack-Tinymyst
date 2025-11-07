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
            'restart' => 'boolean',
        ]);

        $pageId = $request->input('page_id');
        $content = $request->input('content', '// Empty document');
        $restart = $request->input('restart', false);
        $pid = $request->input('pid', 0);

        try {
            // Get the page
            $page = Page::findOrFail($pageId);

            $manager = app(TinymistPreviewManager::class);
            $manager->updateTinymistPreviewFile($pageId, $content);
            $result = $manager->startPreviewServer($pageId, $restart, $pid);

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
            'pid' => 'required|integer|min:1',
        ]);

        $pid = $request->input('pid');

        try {
            $manager = app(TinymistPreviewManager::class);
            $manager->stopPreviewServer($pid);

            return response()->json(['success' => true]);

        } catch (\Exception $e) {
            Log::error('Failed to stop preview server', [
                'pid' => $pid,
                'error' => $e->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'error' => $e->getMessage(),
            ], 500);
        }
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

            // Generate new token
            $userId = user()->id;
            $secret = config('tinymist.ws_token_secret');
            $ttl = config('tinymist.ws_token_ttl', 900);

            if (!$secret) {
                throw new \Exception('WebSocket token secret not configured');
            }

            $issuedAt = time();
            $payload = [
                'user_id' => $userId,
                'page_id' => $pageId,
                'iat' => $issuedAt,
                'exp' => $issuedAt + max($ttl, 60),
            ];

            // Encode JWT token (HS256)
            $header = ['alg' => 'HS256', 'typ' => 'JWT'];
            $headerEncoded = $this->base64UrlEncode(json_encode($header));
            $payloadEncoded = $this->base64UrlEncode(json_encode($payload));
            $signature = hash_hmac('sha256', "$headerEncoded.$payloadEncoded", $secret, true);
            $signatureEncoded = $this->base64UrlEncode($signature);
            $token = "$headerEncoded.$payloadEncoded.$signatureEncoded";

            return response()->json([
                'success' => true,
                'token' => $token,
                'expires_at' => $payload['exp'],
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

    /**
     * Base64 URL-safe encode
     */
    protected function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }
}
