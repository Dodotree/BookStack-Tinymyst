<?php

namespace BookStack\Extensions\Tinymist\Attachments;

use BookStack\Entities\Queries\PageQueries;
use BookStack\Http\Controller;
use BookStack\Permissions\Permission;
use BookStack\Uploads\Attachment;

class TinymistAttachmentController extends Controller
{
    public function __construct(
        protected TinymistAttachmentSyncService $tinymistAttachmentSyncService,
        protected PageQueries $pageQueries,
    ) {
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
