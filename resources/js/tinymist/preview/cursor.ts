// This is visualization for cursor positions in the preview pane
// Request for its position are initiated from:
// 1) back end preview_server when Data Plane receives new/diff-v1 updates
// 2) explicitly requested by editor->preview_ws on clicks/cursor moves

// Gets cursorPaths from preview websocket
// queries the current svg.typst-doc to match cursor paths
// appends cursor circles to those elements
// keeps the state so that svg re-renders can re-apply the cursor positions
