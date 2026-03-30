import { tmEvents } from "../constants";

export class PreviewDataPlane {
    private processingQueue: Promise<void> = Promise.resolve();
    private textDecoder: TextDecoder = new TextDecoder();
    private cursorSpotlightEnabled: boolean = true;

    private debugOn: boolean = false;
    private debugLog: (...args: any[]) => void;

    constructor() {

        this.handleBridgeDataMessage = this.handleBridgeDataMessage.bind(this);
        this.debugLog = this.debugOn ? console.debug : () => {};

        window.$tmEventBus.listen(
            tmEvents.PreviewDataMessage,
            this.handleBridgeDataMessage,
        );
        window.$tmEventBus.listen(
            tmEvents.CursorSpotlightToggle,
            ({ enabled }: { enabled?: boolean }) => {
                this.cursorSpotlightEnabled = Boolean(enabled);
            },
        );

        window.$tmEventBus.listen(tmEvents.Destroy, () => {
            this.textDecoder = null as any;
            this.processingQueue = Promise.resolve();
        });
    }

    private handleBridgeDataMessage(msg: Uint8Array): void {
        this.debugLog(
            `[Preview Data] Data message (length: ${msg.byteLength} bytes) adding to processing queue`,
        );
        this.processingQueue = this.processingQueue
            .then(async () => {
                await this.handleBinaryMessage(msg);
            })
            .catch((err) => {
                console.error("[Preview Data] Failed to process message:", err);
            });
    }

    private async handleBinaryMessage(msg: Uint8Array) {
        try {
            const rawLength = msg.length;

            // Parse message format: "type,payload"
            const commaIndex = msg.indexOf(44); // ASCII for ','
            if (commaIndex === -1) {
                console.warn(
                    "[Preview Data] Invalid data plane message format",
                    msg,
                );
                return;
            }

            const command = this.textDecoder.decode(msg.slice(0, commaIndex));
            const payload = msg.slice(commaIndex + 1);

            this.debugLog(`[Preview Data] Processing command: "${command}"`);

            switch (command) {
                case "diff-v1":
                    window.$tmEventBus.emit(tmEvents.DataBinary, {
                        command,
                        payload,
                    });
                    break;

                case "new":
                    window.$tmEventBus.emit(tmEvents.DataBinary, {
                        command,
                        payload,
                    });
                    break;

                // Successful reply to Control Plane "changeCursorPosition" request
                case "cursor-paths": {
                    if (!this.cursorSpotlightEnabled) {
                        return;
                    }
                    const decoded = this.textDecoder.decode(payload);
                    try {
                        const parsed = JSON.parse(decoded);
                        window.$tmEventBus.emit(
                            tmEvents.DataCursorPaths,
                            parsed,
                        );
                    } catch (err) {
                        console.error(
                            "[Preview Data] Cursor paths not valid JSON:",
                            err,
                        );
                    }
                    break;
                }

                case "partial-rendering":
                    const enabled = this.textDecoder.decode(payload) === "true";
                    this.debugLog(`[Preview Data] Partial rendering: ${enabled}`);
                    break;

                case "jump":
                    const coords = this.textDecoder.decode(payload).split(" ");
                    const [page, x, y] = coords.map(Number);
                    this.debugLog(
                        `[Preview Data] Jump to page ${page}, x: ${x}, y: ${y}`,
                    );
                    break;

                case "viewport":
                    const decoded = this.textDecoder.decode(payload);
                    this.debugLog(
                        `[Preview Data] Viewport payload (${payload.length} bytes):`,
                        decoded,
                    );
                    break;

                case "cursor":
                    const cursorDecoded = this.textDecoder.decode(payload);
                    this.debugLog(
                        `[Preview Data] Cursor payload (${payload.length} bytes):`,
                        cursorDecoded,
                    );
                    break;

                case "invert-colors":
                    const invertColorsDecoded =
                        this.textDecoder.decode(payload);
                    this.debugLog(
                        `[Preview Data] Invert colors payload (${payload.length} bytes):`,
                        invertColorsDecoded,
                    );
                    break;

                // Not sure what kind of outline is that, usually Control Plane receives "outline" events
                case "outline":
                    const outlineDecoded = this.textDecoder.decode(payload);
                    this.debugLog(
                        `[Preview Data] Outline payload (${payload.length} bytes):`,
                        outlineDecoded,
                    );
                    break;

                default:
                    console.warn(
                        `[Preview Data] Unknown data plane command: ${command}`,
                    );
            }
        } catch (error) {
            console.error(
                "[Preview Data] Failed to handle binary message:",
                error,
            );
        }
    }
}
