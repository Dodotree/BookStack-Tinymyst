<?php

use BookStack\Extensions\Tinymist\Attachments\TinymistAttachmentController;
use BookStack\Extensions\Tinymist\Controllers\TinymistController;
use BookStack\Extensions\Tinymist\Imports\TinymistImportController;
use BookStack\Extensions\Tinymist\Packages\TinymistPackageController;
use Illuminate\Support\Facades\Route;

// Tinymist/Typst routes
Route::post('/ajax/tinymist/compile', [TinymistController::class, 'compile']);
Route::get('/ajax/tinymist/{pageId}/pdf/{pdfPage}', [TinymistController::class, 'previewPdf']);
Route::post('/ajax/tinymist/check', [TinymistController::class, 'check']);
Route::post('/ajax/tinymist/convert-to-typst', [TinymistController::class, 'convertToTypst']);
Route::post('/ajax/tinymist/fonts/refresh', [TinymistController::class, 'refreshFonts']);
Route::get('/ajax/tinymist/status', [TinymistController::class, 'status']);
Route::post('/ajax/tinymist/renew-ws-token', [TinymistController::class, 'renewWsToken']);

// Tinymist attachment integration routes (legacy paths kept stable)
Route::get('/attachments/dirty/page/{pageId}', [TinymistAttachmentController::class, 'dirtyMapForPage']);
Route::put('/attachments/{id}/save-from-preview', [TinymistAttachmentController::class, 'saveFromPreview']);
Route::put('/attachments/{id}/undo-from-preview', [TinymistAttachmentController::class, 'undoFromPreview']);
Route::post('/attachments/new-file', [TinymistAttachmentController::class, 'createBlankFile']);

// Tinymist single-page import route
Route::post('/ajax/tinymist/import/single', [TinymistImportController::class, 'uploadSingle']);

// Tinymist package admin routes
Route::post('/settings/customization/tinymist/packages/upload', [TinymistPackageController::class, 'uploadZip']);
Route::post('/settings/customization/tinymist/packages/github/install', [TinymistPackageController::class, 'installGithub']);
Route::post('/settings/customization/tinymist/packages/github/refresh', [TinymistPackageController::class, 'refreshGithub']);
Route::post('/settings/customization/tinymist/packages/dependencies/report', [TinymistPackageController::class, 'dependencyReport']);
Route::post('/settings/customization/tinymist/packages/dependencies/install', [TinymistPackageController::class, 'dependencyInstall']);
Route::post('/settings/customization/tinymist/packages/dependencies/install-all', [TinymistPackageController::class, 'dependencyInstallAll']);
