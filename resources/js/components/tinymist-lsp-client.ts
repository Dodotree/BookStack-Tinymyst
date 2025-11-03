import { LSPClient, Transport, languageServerExtensions } from '@codemirror/lsp-client';
import { EditorView } from '@codemirror/view';
import { Extension } from '@codemirror/state';

export class TinymistControl {
    private client: LSPClient | null = null;
    private controlWs: WebSocket | null = null;
    private fileUri: string;
    private maxReconnectAttempts: number = 5;
    private reconnectAttempts: number = 0;
    private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
    private controlPort: number;
    private host: string;
    private onControlMessage?: (message: any) => void;

    constructor(
        pageId: number,
        content: string,
        host: string = '127.0.0.1',
        controlPort: number = 23627,
        onControlMessage?: (message: any) => void
    ) {
        this.fileUri = `file:///virtual/${pageId}.typ`;
        this.host = host;
        this.controlPort = controlPort;
        this.onControlMessage = onControlMessage;
    }

    connect(): Promise<Extension> {
        return new Promise((resolve, reject) => {
            try {
                // Connect to Tinymist control plane WebSocket
                const wsUrl = `ws://${this.host}:${this.controlPort}`;
                this.controlWs = new WebSocket(wsUrl);

                this.controlWs.onopen = () => {
                    console.log(`✓ Control Plane WebSocket connected to Tinymist Preview at ${wsUrl}`);
                    this.reconnectAttempts = 0;
                    this.connectionTimeout = null;

                    // TODO: Uncomment below to enable full LSP features (autocomplete, diagnostics, etc.)
                    // Create transport wrapper
                    // const transport: Transport = {
                    //     send: (message: string) => {
                    //         if (this.controlWs?.readyState === WebSocket.OPEN) {
                    //             this.controlWs.send(message);
                    //         }
                    //     },
                    //     subscribe: (handler: (message: string) => void) => {
                    //         if (this.controlWs) {
                    //             this.controlWs.onmessage = (event) => {
                    //                 handler(event.data);
                    //             };
                    //         }
                    //     },
                    //     unsubscribe: () => {
                    //         if (this.controlWs) {
                    //             this.controlWs.onmessage = null;
                    //         }
                    //     }
                    // };

                    // // Create LSP client
                    // this.client = new LSPClient({
                    //     rootUri: 'file:///virtual',
                    //     extensions: languageServerExtensions(),
                    // });

                    // // Connect client to transport (returns this, not a Promise)
                    // this.client.connect(transport);

                    // // Wait for initialization to complete
                    // this.client.initializing.then(() => {
                    //     console.log('✓ LSP client initialized');

                    //     // Create editor plugin
                    //     const plugin = this.client!.plugin(this.fileUri, 'typst');
                    //     resolve(plugin);
                    // }).catch(reject);

                    // For now, resolve with empty extension array
                    // LSP features will be added later when fully implemented
                    resolve([]);
                };

                this.controlWs.onmessage = (event) => {
                    const message = JSON.parse(event.data);
                    // Call the callback if provided
                    if (this.onControlMessage) {
                        this.onControlMessage(message);
                    }
                };

                this.controlWs.onerror = (error) => {
                    console.error('Control Plane WebSocket error:', error);
                    reject(error);
                };

                this.controlWs.onclose = (event) => {
                    console.warn(`Control Plane WebSocket disconnected: code=${event.code}, reason=${event.reason}`);
                    // Common close codes:
                    // 1000 = Normal closure
                    // 1001 = Going away
                    // 1006 = Abnormal closure (no close frame)
                    if (event.code !== 1000) {
                        this.handleReconnect();
                    }
                };

            } catch (error) {
                reject(error);
            }
        });
    }

    private handleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Control Plane WebSocket Reconnecting... Attempt ${this.reconnectAttempts}`);

            this.connectionTimeout = setTimeout(() => {
                this.connect().catch(err => {
                    console.error('Control Plane WebSocket Reconnection failed:', err);
                });
            }, 1000 * this.reconnectAttempts);
        } else {
            console.error('Control Plane WebSocket Max reconnection attempts reached');
        }
    }

    disconnect() {
        // TODO: prevent reconnect
        if (this.client) {
            this.client.disconnect();
        }
        if (this.controlWs) {
            this.controlWs.close();
        }
    }
}
