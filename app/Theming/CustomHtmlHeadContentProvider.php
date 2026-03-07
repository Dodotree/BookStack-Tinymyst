<?php

namespace BookStack\Theming;

use BookStack\Util\CspService;
use BookStack\Util\HtmlContentFilter;
use BookStack\Util\HtmlContentFilterConfig;
use BookStack\Util\HtmlNonceApplicator;
use Illuminate\Contracts\Cache\Repository as Cache;

class CustomHtmlHeadContentProvider
{
    public function __construct(
        protected CspService $cspService,
        protected Cache $cache
    ) {
    }

    /**
     * Fetch our custom HTML head content prepared for use on web pages.
     * Content has a nonce applied for CSP.
     */
    public function forWeb(): string
    {
        $content = $this->getSourceContent();
        $hash = md5($content);
        $html = $this->cache->remember('custom-head-web:' . $hash, 86400, function () use ($content) {
            return HtmlNonceApplicator::prepare($content);
        });

        return HtmlNonceApplicator::apply($html, $this->cspService->getNonce());
    }

    /**
     * Fetch our custom HTML head content prepared for use in export formats.
     * Scripts are stripped to avoid potential issues.
     */
    public function forExport(): string
    {
        $content = $this->getSourceContent();
        $hash = md5($content);

        return $this->cache->remember('custom-head-export:' . $hash, 86400, function () use ($content) {
            $config = new HtmlContentFilterConfig(filterOutNonContentElements: false, useAllowListFilter: false);
            return (new HtmlContentFilter($config))->filterString($content);
        });
    }

    /**
     * Get the original custom head content to use.
     */
    protected function getSourceContent(): string
    {
        return setting('app-custom-head', '');
    }
}
