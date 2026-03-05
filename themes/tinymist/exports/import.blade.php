@extends('layouts.simple')

@section('body')

    <div class="container small">

        <main class="card content-wrap auto-height mt-xxl">
            <h2 class="list-heading">{{ trans('entities.import_single') }}</h2>
            <form action="{{ url('/import/single') }}" enctype="multipart/form-data" method="POST">
                {{ csrf_field() }}
                <div class="flex-container-row justify-space-between wrap gap-x-xl gap-y-s">
                    <p class="flex min-width-l text-muted mb-s">{{ trans('entities.import_single_desc') }}</p>
                    <div class="flex-none min-width-l flex-container-row justify-flex-end">
                        <div class="mb-m">
                            <label for="single-file">{{ trans('entities.import_single_file') }}</label>
                            <input type="file"
                                   accept=".zip,.typ,.md,.markdown,.html,.htm,.txt"
                                   name="single_file"
                                   id="single-file"
                                   class="custom-simple-file-input">
                            @include('form.errors', ['name' => 'single_file'])
                        </div>
                    </div>
                </div>

                <div class="flex-container-row justify-space-between wrap gap-x-xl gap-y-s">
                    <div class="flex min-width-l">
                        <label class="setting-list-label">{{ trans('entities.import_single_parent') }}</label>
                        @include('entities.selector', [
                            'name' => 'parent',
                            'entityTypes' => 'chapter,book',
                            'entityPermission' => 'page-create',
                            'selectorSize' => 'compact small',
                        ])
                        @include('form.errors', ['name' => 'parent'])
                    </div>
                    <div class="flex min-width-l">
                        <label class="setting-list-label">{{ trans('entities.import_single_name') }}</label>
                        @include('form.text', ['name' => 'name', 'value' => old('name')])
                        @include('form.errors', ['name' => 'name'])
                    </div>
                </div>

                @if(session()->has('single_upload_error'))
                    <p class="mb-xs"><strong class="text-neg">{{ session()->get('single_upload_error') }}</strong></p>
                @endif

                <div class="text-right">
                    <a href="{{ url('/books') }}" class="button outline">{{ trans('common.cancel') }}</a>
                    <button type="submit" class="button">{{ trans('entities.import_single_upload') }}</button>
                </div>
            </form>
        </main>

        <main class="card content-wrap auto-height mt-xxl">
            <h1 class="list-heading">{{ trans('entities.import') }}</h1>
            <form action="{{ url('/import') }}" enctype="multipart/form-data" method="POST">
                {{ csrf_field() }}
                <div class="flex-container-row justify-space-between wrap gap-x-xl gap-y-s">
                    <p class="flex min-width-l text-muted mb-s">{{ trans('entities.import_desc') }}</p>
                    <div class="flex-none min-width-l flex-container-row justify-flex-end">
                        <div class="mb-m">
                            <label for="file">{{ trans('entities.import_zip_select') }}</label>
                            <input type="file"
                                   accept=".zip,application/zip,application/x-zip-compressed"
                                   name="file"
                                   id="file"
                                   class="custom-simple-file-input">
                            @include('form.errors', ['name' => 'file'])
                        </div>
                    </div>
                </div>

                @if(count($zipErrors) > 0)
                    <p class="mb-xs"><strong class="text-neg">{{ trans('entities.import_zip_validation_errors') }}</strong></p>
                    <ul class="mb-m">
                        @foreach($zipErrors as $key => $error)
                            <li><strong class="text-neg">[{{ $key }}]</strong>: {{ $error }}</li>
                        @endforeach
                    </ul>
                @endif

                <div class="text-right">
                    <a href="{{ url('/books') }}" class="button outline">{{ trans('common.cancel') }}</a>
                    <button type="submit" class="button">{{ trans('entities.import_validate') }}</button>
                </div>
            </form>
        </main>

        <main class="card content-wrap auto-height mt-xxl">
            <h2 class="list-heading">{{ trans('entities.import_pending') }}</h2>
            @if(count($imports) === 0)
                <p>{{ trans('entities.import_pending_none') }}</p>
            @else
                <div class="item-list my-m">
                    @foreach($imports as $import)
                        @include('exports.parts.import', ['import' => $import])
                    @endforeach
                </div>
            @endif
        </main>
    </div>

@stop
