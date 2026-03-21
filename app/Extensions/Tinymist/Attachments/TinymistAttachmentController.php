<?php

namespace BookStack\Extensions\Tinymist\Attachments;

use BookStack\Entities\Queries\PageQueries;
use BookStack\Http\Controller;
use BookStack\Permissions\Permission;
use BookStack\Uploads\Attachment;
use BookStack\Entities\EntityExistsRule;
use BookStack\Entities\Tools\PageEditorType;
use BookStack\Exceptions\FileUploadException;
use Illuminate\Http\Request;
use Illuminate\Support\MessageBag;
use Illuminate\Validation\ValidationException;

class TinymistAttachmentController extends Controller
{
    public function __construct(
        protected TinymistAttachmentSyncService $tinymistAttachmentSyncService,
        protected TinymistBlankAttachmentFileService $tinymistBlankAttachmentFileService,
        protected PageQueries $pageQueries,
    ) {
    }

    public function createBlankFile(Request $request)
    {
        $pageId = (int) $request->get('attachment_new_uploaded_to');
        $extensions = TinymistBlankAttachmentFileService::getBlankFileExtensions();

        try {
            $this->validate($request, [
                'attachment_new_uploaded_to' => ['required', 'integer', new EntityExistsRule('page')],
                'attachment_new_name' => ['required', 'string', 'min:1', 'max:200', 'not_regex:/[\\/]/'],
                'attachment_new_extension' => ['required', 'string', 'in:' . implode(',', $extensions)],
            ]);
        } catch (ValidationException $exception) {
            return response()->view('attachments.manager-new-file-form', array_merge($request->only([
                'attachment_new_name',
                'attachment_new_extension',
            ]), [
                'pageId' => $pageId,
                'extensions' => $extensions,
                'errors' => new MessageBag($exception->errors()),
            ]), 422);
        }

        $page = $this->pageQueries->findVisibleByIdOrFail($pageId);

        if ($page->editor !== PageEditorType::Tinymist->value) {
            return response()->view('attachments.manager-new-file-form', array_merge($request->only([
                'attachment_new_name',
                'attachment_new_extension',
            ]), [
                'pageId' => $pageId,
                'extensions' => $extensions,
                'errors' => new MessageBag([
                    'attachment_new_name' => [trans('entities.attachments_new_file_only_tinymist')],
                ]),
            ]), 422);
        }

        $this->checkPermission(Permission::AttachmentCreateAll);
        $this->checkOwnablePermission(Permission::PageUpdate, $page);

        $name = trim((string) $request->get('attachment_new_name'));
        $extension = strtolower(trim((string) $request->get('attachment_new_extension')));
        $fileName = $name . '.' . $extension;

        if ($this->tinymistBlankAttachmentFileService->attachmentFileNameExists($pageId, $fileName)) {
            return response()->view('attachments.manager-new-file-form', array_merge($request->only([
                'attachment_new_name',
                'attachment_new_extension',
            ]), [
                'pageId' => $pageId,
                'extensions' => $extensions,
                'errors' => new MessageBag([
                    'attachment_new_name' => [trans('entities.attachments_new_file_exists')],
                ]),
            ]), 422);
        }

        try {
            $this->tinymistBlankAttachmentFileService->saveNewBlankFile($fileName, $pageId);
        } catch (FileUploadException $e) {
            return response($e->getMessage(), 500);
        }

        return view('attachments.manager-new-file-form', [
            'pageId' => $pageId,
            'extensions' => $extensions,
        ]);
    }

    public function dirtyMapForPage(int $pageId)
    {
        $page = $this->pageQueries->findVisibleByIdOrFail($pageId);
        $this->checkOwnablePermission(Permission::PageUpdate, $page);

        return response()->json([
            'dirtyMap' => $this->tinymistAttachmentSyncService->getDirtyMap($page),
        ]);
    }

    public function saveFromPreview(string $attachmentId)
    {
        /** @var Attachment $attachment */
        $attachment = Attachment::query()->findOrFail($attachmentId);
        $this->checkOwnablePermission(Permission::PageView, $attachment->page);
        $this->checkOwnablePermission(Permission::PageUpdate, $attachment->page);
        $this->checkOwnablePermission(Permission::AttachmentUpdate, $attachment);

        $attachment = $this->tinymistAttachmentSyncService->saveFromPreview($attachment);

        return response()->json([
            'message' => trans('entities.attachments_preview_saved'),
            'fileName' => $attachment->external ? '' : $attachment->getFileName(),
            'pageId' => (int) $attachment->uploaded_to,
        ]);
    }

    public function undoFromPreview(string $attachmentId)
    {
        /** @var Attachment $attachment */
        $attachment = Attachment::query()->findOrFail($attachmentId);
        $this->checkOwnablePermission(Permission::PageView, $attachment->page);
        $this->checkOwnablePermission(Permission::PageUpdate, $attachment->page);
        $this->checkOwnablePermission(Permission::AttachmentUpdate, $attachment);

        $attachment = $this->tinymistAttachmentSyncService->undoPreviewChanges($attachment);

        return response()->json([
            'message' => trans('entities.attachments_preview_undone'),
            'fileName' => $attachment->external ? '' : $attachment->getFileName(),
            'pageId' => (int) $attachment->uploaded_to,
        ]);
    }
}
