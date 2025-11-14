// preview element initially gets filled from database
// that saves ready to insert svg in html field if it's not empty

// receives 'new' or 'diff-v1' binary messages from preview_ws
// or ready to insert svg from fallback compiler
// WASM module renders binary  to svg

// in any case preview element updates
// cursor should be alerted upon update and try to reinsert itself
// (if svg structure didn't change former cursor paths)
