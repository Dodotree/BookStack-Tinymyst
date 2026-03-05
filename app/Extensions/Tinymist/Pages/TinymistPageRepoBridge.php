<?php

namespace BookStack\Extensions\Tinymist\Pages;

use BookStack\Entities\Tools\PageContent;

class TinymistPageRepoBridge
{
    public function getTinymistInput(array $input): ?string
    {
        $value = $input['tinymist'] ?? null;
        if (!is_string($value) || trim($value) === '') {
            return null;
        }

        return $value;
    }

    public function applyTinymistContent(PageContent $pageContent, array $input): bool
    {
        $tinymistSource = $this->getTinymistInput($input);
        if ($tinymistSource === null) {
            return false;
        }

        $pageContent->setNewTinymist($tinymistSource, user());
        return true;
    }

    public function applyTinymistDraft(object $draft, array $input): bool
    {
        $tinymistSource = $this->getTinymistInput($input);
        if ($tinymistSource === null) {
            return false;
        }

        $draft->markdown = $tinymistSource;
        $draft->html = '';

        return true;
    }
}
