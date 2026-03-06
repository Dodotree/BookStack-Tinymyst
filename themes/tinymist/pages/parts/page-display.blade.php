@php
    $pageHtml = (string) ($page->renderedHTML ?? $page->html ?? '');
    $isTinymistDisplay = (($page->editor ?? null) === 'tinymist') || str_contains($pageHtml, 'tinymist-document');
@endphp

@if($isTinymistDisplay)
    @once
        @push('head')
            <link rel="stylesheet" href="{{ url('/theme/tinymist/tinymist.css') }}">
            <link rel="stylesheet" href="{{ url('/theme/tinymist/tinymist-svg.css') }}">
        @endpush
    @endonce
@endif

<div dir="auto">

    <h1 class="break-text" id="bkmrk-page-title">{{$page->name}}</h1>

    <div style="clear:left;"></div>

    @if (isset($diff) && $diff)
        {!! $diff !!}
    @else
        {!! isset($page->renderedHTML) ? $page->renderedHTML : $page->html !!}
    @endif
</div>
