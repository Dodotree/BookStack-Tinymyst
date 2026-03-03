export const DEFAULT_WS_TIMINGS = {
	heartbeatMs: 20000,
	connectionTimeoutMs: 1000,
	reconnectBaseMs: 5000,
	reconnectMaxMs: 30000,
	reconnectFactor: 1.5,
};

export const LOCAL_WS_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);
