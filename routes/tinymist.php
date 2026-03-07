<?php

use BookStack\Extensions\Tinymist\Attachments\TinymistAttachmentController;
use BookStack\Extensions\Tinymist\Controllers\TinymistController;
use BookStack\Extensions\Tinymist\Imports\TinymistImportController;
use Illuminate\Support\Facades\Route;

// Tinymist/Typst routes
Route::post('/ajax/tinymist/compile', [TinymistController::class, 'compile']);
Route::post('/ajax/tinymist/check', [TinymistController::class, 'check']);
Route::get('/ajax/tinymist/status', [TinymistController::class, 'status']);
Route::post('/ajax/tinymist/renew-ws-token', [TinymistController::class, 'renewWsToken']);

// Tinymist attachment integration routes (legacy paths kept stable)
Route::get('/attachments/dirty/page/{pageId}', [TinymistAttachmentController::class, 'dirtyMapForPage']);
Route::put('/attachments/{id}/save-from-preview', [TinymistAttachmentController::class, 'saveFromPreview']);
Route::put('/attachments/{id}/undo-from-preview', [TinymistAttachmentController::class, 'undoFromPreview']);

// Tinymist single-page import route
Route::post('/import/single', [TinymistImportController::class, 'uploadSingle']);
