<?php

use BookStack\Entities\Controllers as EntityControllers;
use BookStack\Extensions\Tinymist\Attachments\TinymistAttachmentController;
use Illuminate\Support\Facades\Route;

// Tinymist/Typst routes
Route::post('/ajax/tinymist/compile', [EntityControllers\TinymistController::class, 'compile']);
Route::post('/ajax/tinymist/check', [EntityControllers\TinymistController::class, 'check']);
Route::get('/ajax/tinymist/status', [EntityControllers\TinymistController::class, 'status']);
Route::post('/ajax/tinymist/renew-ws-token', [EntityControllers\TinymistController::class, 'renewWsToken']);

// Tinymist attachment integration routes (legacy paths kept stable)
Route::get('/attachments/dirty/page/{pageId}', [TinymistAttachmentController::class, 'dirtyMapForPage']);
Route::put('/attachments/{id}/save-from-preview', [TinymistAttachmentController::class, 'saveFromPreview']);
Route::put('/attachments/{id}/undo-from-preview', [TinymistAttachmentController::class, 'undoFromPreview']);
