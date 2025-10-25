<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Typst CLI Path
    |--------------------------------------------------------------------------
    |
    | Path to typst CLI executable. Can be absolute path or command name
    | if available in system PATH.
    |
    */
    'typst_cli_path' => env('TYPST_CLI_PATH', base_path('vendor/bin/typst' . (DIRECTORY_SEPARATOR === '\\' ? '.exe' : ''))),

    /*
    |--------------------------------------------------------------------------
    | Tinymist CLI Path
    |--------------------------------------------------------------------------
    |
    | Path to tinymist CLI executable (for LSP features).
    |
    */
    'tinymist_cli_path' => env('TINYMIST_CLI_PATH', base_path('vendor/bin/tinymist' . (DIRECTORY_SEPARATOR === '\\' ? '.exe' : ''))),

    /*
    |--------------------------------------------------------------------------
    | Enable Tinymist Editor
    |--------------------------------------------------------------------------
    |
    | Enable or disable the Tinymist editor option.
    | Requires typst CLI to be installed and accessible.
    |
    */
    'enabled' => env('TINYMIST_ENABLED', true),

    /*
    |--------------------------------------------------------------------------
    | Compilation Timeout
    |--------------------------------------------------------------------------
    |
    | Maximum time (in seconds) to wait for typst compilation.
    |
    */
    'timeout' => env('TINYMIST_TIMEOUT', 30),

    /*
    |--------------------------------------------------------------------------
    | Max Document Size
    |--------------------------------------------------------------------------
    |
    | Maximum size (in KB) of Typst document to compile.
    |
    */
    'max_document_size' => env('TINYMIST_MAX_SIZE', 1024),

    /*
    |--------------------------------------------------------------------------
    | LSP Mode
    |--------------------------------------------------------------------------
    |
    | Enable Tinymist LSP mode for incremental compilation.
    | When enabled, uses persistent LSP process instead of spawning
    | typst CLI for each compilation.
    |
    */
    'lsp_enabled' => env('TINYMIST_LSP_ENABLED', true),

    /*
    |--------------------------------------------------------------------------
    | LSP Max Processes
    |--------------------------------------------------------------------------
    |
    | Maximum number of concurrent LSP processes.
    | Additional requests will be queued or fall back to typst CLI.
    |
    */
    'lsp_max_processes' => env('TINYMIST_LSP_MAX_PROCESSES', 10),

    /*
    |--------------------------------------------------------------------------
    | LSP Process Idle Timeout
    |--------------------------------------------------------------------------
    |
    | Time (in minutes) before an idle LSP process is terminated.
    | Matches draft autosave expiry time.
    |
    */
    'lsp_idle_timeout' => env('TINYMIST_LSP_IDLE_TIMEOUT', 60),

    /*
    |--------------------------------------------------------------------------
    | Document Storage Path
    |--------------------------------------------------------------------------
    |
    | Directory where temporary .typ files are stored for LSP processing.
    | Relative to storage/app/
    |
    */
    'document_storage_path' => 'tinymist',

];
