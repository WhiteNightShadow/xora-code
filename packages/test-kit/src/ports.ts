import { MessageChannel, type MessagePort } from 'node:worker_threads';

/** The shape of Electron's `MessagePortMain`, the kind of port the host and the engine get in the app. */
export interface MainPort {
    postMessage(message: unknown): void;
    on(event: 'message', listener: (event: { data: unknown }) => void): this;
    on(event: 'close', listener: () => void): this;
    start(): void;
    close(): void;
}

class NodeMainPort implements MainPort {
    readonly #port: MessagePort;

    constructor(port: MessagePort) {
        this.#port = port;
    }

    postMessage(message: unknown): void {
        this.#port.postMessage(message);
    }

    on(event: 'message', listener: (event: { data: unknown }) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'message' | 'close', listener: (event: { data: unknown }) => void): this {
        if (event === 'message') {
            this.#port.on('message', (data: unknown) => listener({ data }));
        } else {
            this.#port.on('close', () => (listener as () => void)());
        }
        return this;
    }

    start(): void {
        this.#port.start();
    }

    close(): void {
        this.#port.close();
    }
}

/**
 * A channel whose ports behave like Electron's `MessagePortMain`, for testing what runs over one in the app:
 * `message` listeners get an event with `data` (Node's own ports pass the value itself), and closing either end
 * emits `close`.
 */
export function mainPortChannel(): { readonly port1: MainPort; readonly port2: MainPort } {
    const { port1, port2 } = new MessageChannel();
    return { port1: new NodeMainPort(port1), port2: new NodeMainPort(port2) };
}
