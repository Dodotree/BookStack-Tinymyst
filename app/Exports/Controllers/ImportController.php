<?php

declare(strict_types=1);

namespace BookStack\Exports\Controllers;

use BookStack\Exceptions\ZipImportException;
use BookStack\Exceptions\ZipValidationException;
use BookStack\Exports\SinglePageImportService;
use BookStack\Exports\ImportRepo;
use BookStack\Http\Controller;
use BookStack\Permissions\Permission;
use BookStack\Uploads\AttachmentService;
use Illuminate\Http\Request;
use RuntimeException;

class ImportController extends Controller
{
    public function __construct(
        protected ImportRepo $imports,
        protected SinglePageImportService $singleImports,
    ) {
        $this->middleware(Permission::ContentImport->middleware());
    }

    /**
     * Show the view to start a new import, and also list out the existing
     * in progress imports that are visible to the user.
     */
    public function start()
    {
        $imports = $this->imports->getVisibleImports();

        $this->setPageTitle(trans('entities.import'));

        return view('exports.import', [
            'imports' => $imports,
            'zipErrors' => session()->pull('validation_errors') ?? [],
        ]);
    }

    /**
     * Upload, validate and store an import file.
     */
    public function upload(Request $request)
    {
        $this->validate($request, [
            'file' => ['required', ...AttachmentService::getFileValidationRules()]
        ]);

        $file = $request->file('file');
        try {
            $import = $this->imports->storeFromUpload($file);
        } catch (ZipValidationException $exception) {
            return redirect('/import')->with('validation_errors', $exception->errors);
        }

        return redirect($import->getUrl());
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

    /**
     * Show a pending import, with a form to allow progressing
     * with the import process.
     */
    public function show(int $id)
    {
        $import = $this->imports->findVisible($id);

        $this->setPageTitle(trans('entities.import_continue'));

        return view('exports.import-show', [
            'import' => $import,
            'data' => $import->decodeMetadata(),
        ]);
    }

    /**
     * Run the import process against an uploaded import ZIP.
     */
    public function run(int $id, Request $request)
    {
        $import = $this->imports->findVisible($id);
        $parent = null;

        if ($import->type === 'page' || $import->type === 'chapter') {
            session()->setPreviousUrl($import->getUrl());
            $data = $this->validate($request, [
                'parent' => ['required', 'string'],
            ]);
            $parent = $data['parent'];
        }

        try {
            $entity = $this->imports->runImport($import, $parent);
        } catch (ZipImportException $exception) {
            session()->forget(['success', 'warning']);
            $this->showErrorNotification(trans('errors.import_zip_failed_notification'));
            return redirect($import->getUrl())->with('import_errors', $exception->errors);
        }

        return redirect($entity->getUrl());
    }

    /**
     * Delete an active pending import from the filesystem and database.
     */
    public function delete(int $id)
    {
        $import = $this->imports->findVisible($id);
        $this->imports->deleteImport($import);

        return redirect('/import');
    }
}
