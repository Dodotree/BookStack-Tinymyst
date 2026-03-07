<?php

namespace BookStack\Extensions\Tinymist\Pages;

use BookStack\Entities\Models\Page;
use BookStack\Entities\Tools\PageEditorType;
use BookStack\Extensions\Tinymist\Tools\TinymistService;

class TinymistPageContentHandler
{
    public function __construct(
        protected TinymistService $tinymistService,
    ) {
    }

    public function shouldBypassDomRender(Page $page): bool
    {
        return $page->editor === PageEditorType::Tinymist->value;
    }

    public function apply(Page $page, string $source): void
    {
        $page->markdown = $source;

        $result = $this->tinymistService->compileToSvg($source, ['pageId' => $page->id]);

        if ($result['success']) {
            $page->html = '<div class="tinymist-document">' . $result['svg'] . '</div>';
        } else {
            $page->html = $this->buildErrorHtml($result['errors'] ?? []);
        }

        $page->text = $this->toPlainTextFromTypst($source);
    }

    /**
     * @param string[] $errors
     */
    protected function buildErrorHtml(array $errors): string
    {
        $errorHtml = '<div class="tinymist-error">';
        $errorHtml .= '<h3>Typst Compilation Errors:</h3>';
        foreach ($errors as $error) {
            $errorHtml .= '<p>' . htmlspecialchars((string) $error) . '</p>';
        }
        $errorHtml .= '</div>';

        return $errorHtml;
    }

    protected function toPlainTextFromTypst(string $source): string
    {
        $text = preg_replace('/^#.*$/m', '', $source);
        $text = preg_replace('/\$.*?\$/', '', $text);
        $text = preg_replace('/\*{1,2}(.*?)\*{1,2}/', '$1', $text);
        $text = preg_replace('/\[(.*?)\]\(.*?\)/', '$1', $text);
        $text = html_entity_decode(strip_tags($text));
        $text = preg_replace('/#(set|show)\s+[^\n]+/', '', $text);
        $text = preg_replace('/#\w+(?:\([^\]]*\))?\[([^\]]+)\]/', '$1', $text);
        $text = preg_replace('/`[^`]+`/', '', $text);
        $text = preg_replace('/\/\/.*$/m', '', $text);
        $text = preg_replace('/\/\*.*?\*\//s', '', $text);
        $text = preg_replace('/\s+/', ' ', $text);

        return trim((string) $text);
    }
}
