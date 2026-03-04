export const DEFAULT_WS_TIMINGS = {
	heartbeatMs: 20000,
	connectionTimeoutMs: 1000,
	reconnectBaseMs: 5000,
	reconnectMaxMs: 30000,
	reconnectFactor: 1.5,
};

export const LOCAL_WS_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

export const SYNC_AND_LSP_URI = "/ws/tinymist/file-sync/";
export const SYNC_AND_LSP_PORT = 4000;
export const SYNC_AND_LSP_STATUS_KEY = "file-lsp-ws";

export const PREVIEW_URI = "/ws/tinymist/preview/";
export const PREVIEW_PORT = 4020;
export const PREVIEW_STATUS_KEY = "preview-ws";
