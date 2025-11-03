<?php

namespace BookStack\Entities\Tools;

use BookStack\Activity\Tools\CommentTree;
use BookStack\Entities\Models\Page;
use BookStack\Entities\Queries\EntityQueries;
use BookStack\Entities\Tools\Markdown\HtmlToMarkdown;
use BookStack\Entities\Tools\Markdown\MarkdownToHtml;
use BookStack\Entities\Tools\Tinymist\TinymistPreviewManager;
use BookStack\Permissions\Permission;
use Illuminate\Support\Facades\Storage;

class PageEditorData
{
    protected array $viewData;
    protected array $warnings;

    public function __construct(
        protected Page $page,
        protected EntityQueries $queries,
        protected string $requestedEditor
    ) {
        $this->viewData = $this->build();
    }

    public function getViewData(): array
    {
        return $this->viewData;
    }

    public function getWarnings(): array
    {
        return $this->warnings;
    }

    protected function build(): array
    {
        $page = clone $this->page;
        $isDraft = boolval($this->page->draft);
        $templates = $this->queries->pages->visibleTemplates()
            ->orderBy('name', 'asc')
            ->take(10)
            ->paginate()
            ->withPath('/templates');

        $draftsEnabled = auth()->check();

        $isDraftRevision = false;
        $this->warnings = [];
        $editActivity = new PageEditActivity($page);

        if ($editActivity->hasActiveEditing()) {
            $this->warnings[] = $editActivity->activeEditingMessage();
        }

        // Check for a current draft version for this user
        $userDraft = $this->queries->revisions->findLatestCurrentUserDraftsForPageId($page->id);
        if (!is_null($userDraft)) {
            $page->forceFill($userDraft->only(['name', 'html', 'markdown']));
            $isDraftRevision = true;
            $this->warnings[] = $editActivity->getEditingActiveDraftMessage($userDraft);
        }

        $editorType = $this->getEditorType($page);
        $this->updateContentForEditor($page, $editorType);

        // Start Tinymist preview server if this is a Tinymist page
        $tinymistPreview = null;
        if ($editorType === PageEditorType::Tinymist && config('tinymist.enabled', false)) {
            $tinymistPreview = $this->startTinymistPreview($page);
        }

        return [
            'page'            => $page,
            'book'            => $page->book,
            'isDraft'         => $isDraft,
            'isDraftRevision' => $isDraftRevision,
            'draftsEnabled'   => $draftsEnabled,
            'templates'       => $templates,
            'editor'          => $editorType,
            'comments'        => new CommentTree($page),
            'tinymistPreview' => $tinymistPreview,
        ];
    }

    protected function updateContentForEditor(Page $page, PageEditorType $editorType): void
    {
        $isHtml = !empty($page->html) && empty($page->markdown);

        // HTML to markdown-clean conversion
        if ($editorType === PageEditorType::Markdown && $isHtml && $this->requestedEditor === 'markdown-clean') {
            $page->markdown = (new HtmlToMarkdown($page->html))->convert();
        }

        // Markdown to HTML conversion if we don't have HTML
        if ($editorType->isHtmlBased() && !$isHtml) {
            $page->html = (new MarkdownToHtml($page->markdown))->convert();
        }
    }

    /**
     * Get the type of editor to show for editing the given page.
     * Defaults based upon the current content of the page otherwise will fall back
     * to system default but will take a requested type (if provided) if permissions allow.
     */
    protected function getEditorType(Page $page): PageEditorType
    {
        $editorType = PageEditorType::forPage($page) ?: PageEditorType::getSystemDefault();

        // Use the requested editor if valid and if we have permission
        $requestedType = PageEditorType::fromRequestValue($this->requestedEditor);
        if ($requestedType && userCan(Permission::EditorChange)) {
            $editorType = $requestedType;
        }

        return $editorType;
    }

    /**
     * Start Tinymist preview server for the page and return connection info.
     */
    protected function startTinymistPreview(Page $page): ?array
    {
        try {
            $pageId = $page->id;
            $typstPath = "tinymist/page_{$pageId}.typ";

            // Save current content to file
            $content = $page->markdown ?? '== Empty document from PageEditorData';

            // Debug logging
            \Illuminate\Support\Facades\Log::info('Starting Tinymist preview', [
                'page_id' => $pageId,
                'content_length' => strlen($content),
                'has_markdown' => !empty($page->markdown),
                'content_preview' => substr($content, 0, 100),
            ]);

            // Write directly to file instead of using Storage facade
            // (Storage facade might be configured for public disk)
            $fullPath = storage_path("app/{$typstPath}");
            $directory = dirname($fullPath);
            if (!is_dir($directory)) {
                mkdir($directory, 0755, true);
            }
            file_put_contents($fullPath, $content);

            // Start preview server
            // TODO: Could be in the background?
            $manager = app(TinymistPreviewManager::class);
            $result = $manager->startPreviewServer($pageId, $typstPath);

            if ($result['success'] ?? false) {
                return [
                    'control_port' => $result['control_port'],
                    'data_port' => $result['data_port'],
                    'host' => $result['host'],
                    'status' => $result['status'] ?? 'started',
                ];
            }

            return null;
        } catch (\Exception $e) {
            // Log error but don't fail page load
            \Illuminate\Support\Facades\Log::error('Failed to start Tinymist preview', [
                'page_id' => $page->id,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }
}
