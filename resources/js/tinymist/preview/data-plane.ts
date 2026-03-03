export class PreviewDataPlane {
    private processingQueue: Promise<void> = Promise.resolve();
    private textDecoder = new TextDecoder();
    private cursorSpotlightEnabled = true;

    constructor() {
        this.handleBridgeDataMessage = this.handleBridgeDataMessage.bind(this);
        window.$tmEventBus.listen(
            "preview-data-message",
            this.handleBridgeDataMessage,
        );
        window.$tmEventBus.listen(
            "cursor-spotlight-toggle",
            ({ enabled }: { enabled?: boolean }) => {
                this.cursorSpotlightEnabled = Boolean(enabled);
            },
        );
        window.$tmEventBus.listen("destroy",() => {
            this.textDecoder = null as any;
            this.processingQueue = Promise.resolve();
        });
    }

    private handleBridgeDataMessage(msg: Uint8Array): void {
        console.log(
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
            console.log(
                `[Preview Data] Raw message length: ${rawLength} bytes`,
            );
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

            console.log(
                `[Preview Data] Message command "${command}" (payload ${payload.length} bytes, raw ${rawLength})`,
            );

            switch (command) {
                case "diff-v1":
                    // console.log(`[Preview Data] Received diff-v1 (${payload.length} bytes)`);

                    // Try to peek at the diff content (it's binary, but might have readable parts)
                    // try {
                    //     const sample = new TextDecoder('utf-8', { fatal: false }).decode(payload.slice(0, Math.min(200, payload.length)));
                    //     console.log('[Preview Data] Diff sample:', sample.substring(0, 100));
                    // } catch (e) {
                    //     console.log('[Preview Data] Could not decode diff sample');
                    // }

                    window.$tmEventBus.emit("data-binary", {
                        command,
                        payload,
                    });
                    break;

                case "new":
                    // console.log(`[Preview Data] Received new document (${payload.length} bytes)`);
                    window.$tmEventBus.emit("data-binary", {
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
                        // console.info('[Preview Data] Cursor paths parsed:', parsed);
                        window.$tmEventBus.emit("data-cursor-paths", parsed);
                    } catch (err) {
                        console.error(
                            "[Preview Data] Cursor paths not valid JSON:",
                            err,
                        );
                    }
                    break;
                }

                case "partial-rendering":
                    const enabled =
                        this.textDecoder.decode(payload) === "true";
                    console.log(`[Preview Data] Partial rendering: ${enabled}`);
                    break;

                case "jump":
                    const coords = this.textDecoder.decode(payload).split(" ");
                    const [page, x, y] = coords.map(Number);
                    console.log(
                        `[Preview Data] Jump to page ${page}, x: ${x}, y: ${y}`,
                    );
                    break;

                case "viewport":
                    const decoded = this.textDecoder.decode(payload);
                    console.log(
                        `[Preview Data] Viewport payload (${payload.length} bytes):`,
                        decoded,
                    );
                    break;

                case "cursor":
                    const cursorDecoded = this.textDecoder.decode(payload);
                    console.log(
                        `[Preview Data] Cursor payload (${payload.length} bytes):`,
                        cursorDecoded,
                    );
                    break;

                case "invert-colors":
                    const invertColorsDecoded = this.textDecoder.decode(
                        payload,
                    );
                    console.log(
                        `[Preview Data] Invert colors payload (${payload.length} bytes):`,
                        invertColorsDecoded,
                    );
                    break;

                // Not sure what kind of outline is that, usually Control Plane receives "outline" events
                case "outline":
                    const outlineDecoded = this.textDecoder.decode(payload);
                    console.log(
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
