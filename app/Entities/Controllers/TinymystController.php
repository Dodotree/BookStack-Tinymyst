<?php

namespace BookStack\Entities\Controllers;

use BookStack\Entities\Tools\Tinymyst\TinymystService;
use BookStack\Http\Controller;
use Illuminate\Http\Request;

class TinymystController extends Controller
{
    public function __construct(
        protected TinymystService $tinymyst
    ) {
    }

    /**
     * Compile Typst source to SVG (AJAX endpoint).
     * POST /ajax/tinymyst/compile
     */
    public function compile(Request $request)
    {
        $source = $request->input('source', '');

        // Validate source is not empty
        if (empty($source)) {
            return response()->json([
                'success' => false,
                'svg' => null,
                'errors' => ['No Typst source provided'],
            ]);
        }

        // Check document size limit
        $maxSize = config('tinymyst.max_document_size', 1024) * 1024; // Convert KB to bytes
        if (strlen($source) > $maxSize) {
            return response()->json([
                'success' => false,
                'svg' => null,
                'errors' => ['Document exceeds maximum size limit'],
            ]);
        }

        // Compile the source
        $result = $this->tinymyst->compileToSvg($source);

        return response()->json($result);
    }

    /**
     * Check Typst source (AJAX endpoint).
     * POST /ajax/tinymyst/check
     */
    public function check(Request $request)
    {
        $source = $request->input('source', '');
        $diagnostics = $this->tinymyst->validate($source);

        return response()->json($diagnostics);
    }

    /**
     * Check if Tinymyst/Typst is available.
     * GET /ajax/tinymyst/status
     */
    public function status()
    {
        $available = $this->tinymyst->isAvailable();

        return response()->json([
            'available' => $available,
            'enabled' => config('tinymyst.enabled', false),
        ]);
    }
}
