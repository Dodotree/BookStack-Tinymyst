<?php

namespace BookStack\Extensions\Tinymist\Controllers;

use BookStack\Entities\Models\Page;
use BookStack\Extensions\Tinymist\Tools\TinymistPandocService;
use BookStack\Extensions\Tinymist\Tools\TinymistPreviewManager;
use BookStack\Extensions\Tinymist\Tools\TinymistService;
use BookStack\Uploads\Attachment;
use BookStack\Http\Controller;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use RuntimeException;

class TinymistController extends Controller
{
    public function __construct(
        protected TinymistService $tinymist,
        protected TinymistPandocService $pandoc,
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
            'page_id' => 'required|integer|min:1',
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

    /**
     * Convert Markdown/HTML content to Typst via Pandoc.
     * POST /ajax/tinymist/convert-to-typst
     */
    public function convertToTypst(Request $request)
    {
        $request->validate([
            'page_id' => 'required|integer|min:1',
            'content' => 'required|string',
            'source_format' => 'required|in:markdown,html',
            'source_origin' => 'nullable|string|max:80',
        ]);

        $pageId = (int) $request->input('page_id');
        $content = (string) $request->input('content', '');
        $sourceFormat = (string) $request->input('source_format', 'markdown');
        $sourceOrigin = trim((string) $request->input('source_origin', ''));
        $sourceGuess = $this->guessSourceFormat($content);

        Log::info('Tinymist convert-to-typst request', [
            'page_id' => $pageId,
            'user_id' => user()->id ?? null,
            'source_format' => $sourceFormat,
            'source_origin' => $sourceOrigin !== '' ? $sourceOrigin : null,
            'source_guess' => $sourceGuess,
            'content_length' => strlen($content),
            'content_sample' => mb_substr(trim($content), 0, 140),
        ]);

        if (in_array($sourceGuess, ['markdown', 'html'], true) && $sourceGuess !== $sourceFormat) {
            Log::warning('Tinymist convert-to-typst source mismatch', [
                'page_id' => $pageId,
                'user_id' => user()->id ?? null,
                'source_format' => $sourceFormat,
                'source_guess' => $sourceGuess,
                'source_origin' => $sourceOrigin !== '' ? $sourceOrigin : null,
            ]);
        }

        $maxSize = config('tinymist.max_document_size', 1024) * 1024;
        if (strlen($content) > $maxSize) {
            return response()->json([
                'success' => false,
                'error' => trans('entities.tinymist_convert_too_large'),
            ], 422);
        }

        try {
            $page = Page::query()->findOrFail($pageId);
            $this->checkOwnablePermission('page-update', $page);

            $typst = $this->pandoc->convertToTypst($content, $sourceFormat);
            $typst = $this->rewriteTypstAttachmentUrls($typst, $page);

            Log::info('Tinymist convert-to-typst success', [
                'page_id' => $pageId,
                'user_id' => user()->id ?? null,
                'source_format' => $sourceFormat,
                'source_guess' => $sourceGuess,
                'source_origin' => $sourceOrigin !== '' ? $sourceOrigin : null,
                'output_length' => strlen($typst),
            ]);

            return response()->json([
                'success' => true,
                'typst' => $typst,
            ]);
        } catch (RuntimeException $exception) {
            Log::warning('Tinymist convert-to-typst rejected', [
                'page_id' => $pageId,
                'user_id' => user()->id ?? null,
                'source_format' => $sourceFormat,
                'source_guess' => $sourceGuess,
                'source_origin' => $sourceOrigin !== '' ? $sourceOrigin : null,
                'error' => $exception->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'error' => $exception->getMessage(),
            ], 422);
        } catch (\Throwable $exception) {
            Log::error('Tinymist convert-to-typst failed', [
                'page_id' => $pageId,
                'user_id' => user()->id ?? null,
                'source_format' => $sourceFormat,
                'source_guess' => $sourceGuess,
                'source_origin' => $sourceOrigin !== '' ? $sourceOrigin : null,
                'error' => $exception->getMessage(),
            ]);

            return response()->json([
                'success' => false,
                'error' => trans('entities.tinymist_convert_failed'),
            ], 500);
        }
    }

    protected function guessSourceFormat(string $content): string
    {
        $trimmed = trim($content);
        if ($trimmed === '') {
            return 'unknown';
        }

        $hasHtml = preg_match('/<\s*(p|div|h[1-6]|ul|ol|li|table|blockquote|span|img|a)\b/i', $trimmed) === 1;
        $hasMarkdown = preg_match('/(^|\n)\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s+|```|\d+\.\s+)/m', $trimmed) === 1;

        if ($hasHtml && $hasMarkdown) {
            return 'mixed';
        }

        if ($hasHtml) {
            return 'html';
        }

        if ($hasMarkdown) {
            return 'markdown';
        }

        return 'unknown';
    }

    protected function rewriteTypstAttachmentUrls(string $typst, Page $page): string
    {
        /** @var \Illuminate\Support\Collection<int, Attachment> $attachments */
        $attachments = $page->attachments()->get();
        if ($attachments->isEmpty()) {
            return $typst;
        }

        $fileNameById = [];
        /** @var Attachment $attachment */
        foreach ($attachments as $attachment) {
            if ($attachment->external) {
                continue;
            }

            $fileNameById[(int) $attachment->id] = $attachment->getFileName();
        }

        if (empty($fileNameById)) {
            return $typst;
        }

        $rewrites = 0;
        $unresolvedIds = [];
        $rewritten = preg_replace_callback(
            '/(["\"])([^"\']*?attachments\/(\d+)(?:\?open=true)?[^"\']*)\1/i',
            function (array $matches) use ($fileNameById, &$rewrites, &$unresolvedIds): string {
                $quote = $matches[1];
                $attachmentId = (int) $matches[3];
                $fileName = $fileNameById[$attachmentId] ?? null;

                if ($fileName === null) {
                    $unresolvedIds[$attachmentId] = true;
                    return $matches[0];
                }

                $rewrites++;
                $escaped = addcslashes($fileName, "\\{$quote}");

                return $quote . $escaped . $quote;
            },
            $typst,
        );

        if ($rewrites > 0) {
            Log::info('Tinymist convert-to-typst attachment URL rewrite', [
                'page_id' => $page->id,
                'rewrites' => $rewrites,
            ]);
        }

        if (!empty($unresolvedIds)) {
            Log::warning('Tinymist convert-to-typst unresolved attachment URLs', [
                'page_id' => $page->id,
                'attachment_ids' => array_keys($unresolvedIds),
            ]);
        }

        return is_string($rewritten) ? $rewritten : $typst;
    }
}
