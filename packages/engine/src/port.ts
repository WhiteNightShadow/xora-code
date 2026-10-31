import type * as acp from '@agentclientprotocol/sdk';

/** The part of Electron's `MessagePortMain` that ACP over a port needs. */
export interface AcpPort {
    postMessage(message: unknown): void;
    on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
    start(): void;
    close(): void;
}

/**
 * ACP over a MessagePort, between the host and an engine that the shell forked as a utility process. Each port
 * message carries one JSON-RPC message as JSON text, exactly what a line on stdio would carry. The stream ends
 * when either end closes the port, which also happens when the process on the other end dies.
 */
export function portStream(port: AcpPort): acp.Stream {
    let open = true;
    const close = () => {
        if (open) {
            open = false;
            port.close();
        }
    };
    const readable = new ReadableStream<acp.AnyMessage>({
        start(controller) {
            port.on('message', ({ data }) => {
                if (!open || typeof data !== 'string') {
                    return;
                }
                let message: unknown;
                try {
                    message = JSON.parse(data);
                } catch {
                    return;
                }
                if (typeof message === 'object' && message !== null) {
                    controller.enqueue(message as acp.AnyMessage);
                }
            });
            port.on('close', () => {
                if (open) {
                    open = false;
                    controller.close();
                }
            });
            port.start();
        },
        cancel: close,
    });
    const writable = new WritableStream<acp.AnyMessage>({
        write(message) {
            if (!open) {
                throw new Error('the ACP port is closed');
            }
            port.postMessage(JSON.stringify(message));
        },
        close,
        abort: close,
    });
    return { readable, writable };
}
