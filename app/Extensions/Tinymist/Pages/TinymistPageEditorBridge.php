<?php

namespace BookStack\Extensions\Tinymist\Pages;

use BookStack\Entities\Models\Page;
use BookStack\Extensions\Tinymist\Tools\TinymistPreviewManager;
use BookStack\Extensions\Tinymist\Tools\TinymistRenderedHtmlStore;
use Illuminate\Support\Facades\Log;
use Throwable;

class TinymistPageEditorBridge
{
    public function __construct(
        protected TinymistPreviewManager $previewManager,
        protected TinymistRenderedHtmlStore $renderedHtmlStore,
    ) {
    }

    /**
     * Start Tinymist preview server for the page and return connection info.
     */
    public function startPreview(Page $page): ?array
    {
        try {
            $token = $this->previewManager->generateTinymistWsToken($page);

            $content = $page->markdown ?? '== Empty document from PageEditorData';
            $content = $this->previewManager->ensurePreviewFileContent($page, $content, $page->updated_at);
            $page->markdown = $content;

            Log::info('Starting Tinymist preview', [
                'page_id' => $page->id,
                'content_length' => strlen($content),
                'has_markdown' => !empty($page->markdown),
                'content_preview' => substr($content, 0, 100),
                'ws_token' => $token['ws_token'],
            ]);

            return [
                'ws_token' => $token['ws_token'],
                'status' => 'token_ready',
                'initial_html' => $this->renderedHtmlStore->getPageHtml($page),
            ];
        } catch (Throwable $exception) {
            Log::error('Failed to start Tinymist preview', [
                'page_id' => $page->id,
                'error' => $exception->getMessage(),
            ]);

            return null;
        }
    }
}
