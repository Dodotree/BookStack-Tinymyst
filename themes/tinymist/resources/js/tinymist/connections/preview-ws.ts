// One websocket with both Control and Data Plane messages
// On the backend preview_server bridges both planes

import { TinymistWebSocketClient } from "./ws-base";
import {
    PREVIEW_URI,
    PREVIEW_PORT,
    PREVIEW_STATUS_KEY,
    tmEvents,
} from "../constants";

export class PreviewBridgeClient extends TinymistWebSocketClient {
    constructor(pageId: number, token: string, uniqueTabId?: string) {
        super(pageId, token, uniqueTabId, {
            name: "Preview WS",
            statusKey: PREVIEW_STATUS_KEY,
            connectEvent: tmEvents.PreviewConnect,
            disconnectEvent: tmEvents.PreviewDisconnect,
            localPort: PREVIEW_PORT,
            remotePath: PREVIEW_URI,
            binaryType: "arraybuffer",
        });

        this.sendRaw = this.sendRaw.bind(this);
        window.$tmEventBus.listen(
            tmEvents.PreviewSendControl,
            this.sendRaw,
        );
        window.$tmEventBus.listen(
            tmEvents.PreviewSendData,
            this.sendRaw,
        );
        // connect/disconnect events handled by superclass, do not override here!
    }

    protected handleMessage(data: any): void {
        const forwardControl = (payload: string) => {
            window.$tmEventBus.emit(tmEvents.PreviewControlMessage, payload);
        };

        const forwardData = (buffer: ArrayBuffer) => {
            window.$tmEventBus.emit(
                tmEvents.PreviewDataMessage,
                new Uint8Array(buffer),
            );
        };

        // Check data type
        if (data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(data);
            if (bytes.length === 0) {
                return;
            }

            // Some control-plane messages arrive as binary buffers (JSON strings)
            if (bytes[0] === 0x7b) {
                const text = new TextDecoder().decode(bytes);
                forwardControl(text);
                return;
            }

            forwardData(data);
        } else if (data instanceof Blob) {
            data.arrayBuffer().then((buffer) => {
                const bytes = new Uint8Array(buffer);
                if (bytes.length === 0) {
                    return;
                }

                if (bytes[0] === 0x7b) {
                    const text = new TextDecoder().decode(bytes);
                    forwardControl(text);
                    return;
                }

                forwardData(buffer);
            });
        } else if (typeof data === "string") {
            forwardControl(data);
        } else {
            console.warn("[Preview WS] Message unknown data type:", data);
        }
    }
}
