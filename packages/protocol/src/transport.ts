/** Minimal message transport used by {@link RpcPeer}. */
export interface RpcTransport {
    send(message: unknown): void;
    /** Starts delivery and returns an unsubscribe function. */
    subscribe(listener: (message: unknown) => void): () => void;
    close?(): void;
}

/** A DOM `MessagePort` (renderer) or a port from Node's global `MessageChannel`. */
export function domPortTransport(port: MessagePort): RpcTransport {
    return {
        send: (message) => port.postMessage(message),
        subscribe: (listener) => {
            const handler = (event: MessageEvent) => listener(event.data);
            port.addEventListener('message', handler);
            port.start();
            return () => port.removeEventListener('message', handler);
        },
        close: () => port.close(),
    };
}

/** The subset of Electron's `MessagePortMain` that the transport needs. */
export interface MessagePortMainLike {
    postMessage(message: unknown): void;
    on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
    off(event: 'message', listener: (event: { data: unknown }) => void): unknown;
    start(): void;
    close(): void;
}

/** An Electron `MessagePortMain`, as received by the main process or a utility process. */
export function electronPortTransport(port: MessagePortMainLike): RpcTransport {
    return {
        send: (message) => port.postMessage(message),
        subscribe: (listener) => {
            const handler = (event: { data: unknown }) => listener(event.data);
            port.on('message', handler);
            port.start();
            return () => port.off('message', handler);
        },
        close: () => port.close(),
    };
}
