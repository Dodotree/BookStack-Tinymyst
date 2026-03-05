<?php

declare(strict_types=1);

namespace BookStack\Extensions\Tinymist\Imports;

use BookStack\Http\Controller;
use BookStack\Permissions\Permission;
use Illuminate\Http\Request;
use RuntimeException;

class TinymistImportController extends Controller
{
    public function __construct(
        protected SinglePageImportService $singleImports,
    ) {
        $this->middleware(Permission::ContentImport->middleware());
    }

    /**
     * Upload a single file to create a new page.
     */
    public function uploadSingle(Request $request)
    {
        $this->validate($request, [
            'single_file' => [
                'required',
                'file',
                'max:' . (config('app.upload_limit') * 1000),
                'mimes:zip,typ,md,markdown,html,txt,htm',
            ],
            'parent' => ['required', 'string'],
            'name' => ['nullable', 'string', 'max:255'],
        ]);

        $file = $request->file('single_file');
        $parent = $request->get('parent');
        $name = $request->get('name');

        try {
            $page = $this->singleImports->createFromUpload($file, $parent, $name);
        } catch (RuntimeException $exception) {
            return redirect('/import')
                ->with('single_upload_error', $exception->getMessage())
                ->withInput();
        }

        return redirect($page->getUrl());
    }
}
