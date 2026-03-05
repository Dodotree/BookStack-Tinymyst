<?php

return [
    'import_single' => 'Import Single Page',
    'import_single_desc' => 'Create a new page by uploading a single .typ, .md, .html, .txt file or a Typst template ZIP. ZIP uploads must contain a .typ entry file (entry.typ, main.typ, or a single .typ file).',
    'import_single_file' => 'Select file to upload',
    'import_single_parent' => 'Page Location',
    'import_single_name' => 'Page Name (optional)',
    'import_single_upload' => 'Create Page',
    'import_single_type_invalid' => 'Unsupported file type for single-page import.',
    'import_single_read_failed' => 'Could not read the uploaded file.',
    'import_single_zip_invalid' => 'Could not read the uploaded ZIP file.',
    'import_single_zip_empty' => 'The uploaded ZIP file contains no files.',
    'import_single_zip_unsafe' => 'The uploaded ZIP file contains unsafe paths.',
    'import_single_zip_too_many' => 'The uploaded ZIP file contains too many files.',
    'import_single_zip_too_large' => 'The uploaded ZIP file is too large after extraction.',
    'import_single_entry_missing' => 'No entry .typ file could be found in the uploaded ZIP file.',
    'import_single_entry_ambiguous' => 'Multiple .typ files found. Please include entry.typ, main.typ, or only one .typ file.',
    'import_single_entry_conflict' => 'The uploaded ZIP file contains an entry.typ conflict.',
    'import_single_flatten_conflict' => 'The uploaded ZIP file contains duplicate file names.',
    'import_single_parent_invalid' => 'The selected parent location is not valid for a page import.',

    'pages_edit_switch_to_tinymist' => 'Switch to Tinymist Editor',
    'pages_edit_switch_to_tinymist_desc' => '(Typst Documents)',

    'pages_tinymist_editor' => 'Typst Editor',
    'pages_tinymist_preview' => 'Live Preview',
    'pages_tinymist_console' => 'Console',

    'attachments_discard_changes_confirm' => 'Are you sure you want to discard unsaved changes for this attachment?',
    'attachments_preview_saved' => 'Attachment changes saved from editor preview',
    'attachments_preview_undone' => 'Attachment changes discarded and preview restored',
];
