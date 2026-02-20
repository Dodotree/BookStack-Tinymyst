// One websocket with both Control and Data Plane messages
// On the backend preview_server bridges both planes

import {TinymistWebSocketClient} from './ws-base';

export class PreviewBridgeClient extends TinymistWebSocketClient {

    constructor(
        pageId: number,
        token: string,
        uniqueTabId?: string
    ) {
        super(pageId, token, uniqueTabId, {
            name: 'Preview WS',
            statusKey: 'preview-ws',
            connectEvent: 'tinymist-preview-connect',
            disconnectEvent: 'tinymist-preview-disconnect',
            localPort: 4020,
            remotePath: '/ws/tinymist/preview/',
            binaryType: 'arraybuffer',
        });

        this.handleOutgoingControl = this.handleOutgoingControl.bind(this);
        this.handleOutgoingData = this.handleOutgoingData.bind(this);
        window.$events.listen("tinymist-preview-send-control", this.handleOutgoingControl);
        window.$events.listen("tinymist-preview-send-data", this.handleOutgoingData);
    }

    protected handleMessage(data: any): void {
        const forwardControl = (payload: string) => {
            // console.log(`[Preview WS] Forwarding control payload length: ${payload.length}`);
            if (payload.length === '{"type":"pong"}'.length && payload.includes('"type":"pong"')) {
                console.log(`[Preview WS] Received pong`);
                return;
            }
            window.$events.emit("tinymist-preview-control-message", payload);
        };

        const forwardData = (buffer: ArrayBuffer) => {
            // console.log(`[Preview WS] Forwarding data buffer length: ${buffer.byteLength}`);
            window.$events.emit("tinymist-preview-data-message", new Uint8Array(buffer));
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
            console.warn("[Preview WS] Message unknown type:", data);
        }
    }

    private handleOutgoingControl(message: string): void {
        console.log(`[Preview WS] Sending control message length: ${message.length}`);
        this.sendRaw(message);
    }

    private handleOutgoingData(message: string | Uint8Array): void {
        const bytes = typeof message === "string" ? message.length : message.byteLength;
        console.log(`[Preview WS] Sending data message bytes: ${bytes}`);
        this.sendRaw(message);
    }
}
