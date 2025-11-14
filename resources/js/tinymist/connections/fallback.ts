// Gets svg and diagnostics from the typst compiler service
// via AJAX when editor_sync or preview_ws WebSocket connections are unavailable
// polls the compile endpoint with debouncing
// parses diagnostics and provides it to editor for display and console
// when compilations succeed, provides SVG to fill the preview pane
