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
    | Tinymyst CLI Path
    |--------------------------------------------------------------------------
    |
    | Path to tinymyst CLI executable (for LSP features).
    |
    */
    'tinymyst_cli_path' => env('TINYMYST_CLI_PATH', base_path('vendor/bin/tinymist' . (DIRECTORY_SEPARATOR === '\\' ? '.exe' : ''))),

    /*
    |--------------------------------------------------------------------------
    | Enable Tinymyst Editor
    |--------------------------------------------------------------------------
    |
    | Enable or disable the Tinymyst editor option.
    | Requires typst CLI to be installed and accessible.
    |
    */
    'enabled' => env('TINYMYST_ENABLED', true),

    /*
    |--------------------------------------------------------------------------
    | Compilation Timeout
    |--------------------------------------------------------------------------
    |
    | Maximum time (in seconds) to wait for typst compilation.
    |
    */
    'timeout' => env('TINYMYST_TIMEOUT', 30),

    /*
    |--------------------------------------------------------------------------
    | Max Document Size
    |--------------------------------------------------------------------------
    |
    | Maximum size (in KB) of Typst document to compile.
    |
    */
    'max_document_size' => env('TINYMYST_MAX_SIZE', 1024),

];
