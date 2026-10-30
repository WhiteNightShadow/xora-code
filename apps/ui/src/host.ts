import {
    domPortTransport,
    type HostMethods,
    type HostNotifications,
    methods,
    notifications,
    type ParamsOf,
    type ResultOf,
    RpcPeer,
} from '@xora/protocol';
import { nextPort } from './shell.ts';

type Peer = RpcPeer<HostMethods, HostNotifications>;
type MethodName = keyof HostMethods & string;
type NotificationName = keyof HostNotifications & string;
type Listener = (params: never) => void;

/**
 * The UI's connection to the host. It survives host restarts: the bootstrap restarts a crashed host and the
 * UI asks for a fresh port, then re-registers every notification listener on the new peer.
 */
export class HostClient {
    #peer: Peer | undefined;
    readonly #listeners = new Map<NotificationName, Set<Listener>>();
    readonly #state = new Set<(connected: boolean) => void>();
    #connecting: Promise<void> | undefined;

    get connected(): boolean {
        return this.#peer !== undefined && !this.#peer.disposed;
    }

    onConnection(listener: (connected: boolean) => void): () => void {
        this.#state.add(listener);
        return () => {
            this.#state.delete(listener);
        };
    }

    connect(): Promise<void> {
        this.#connecting ??= this.#connect().finally(() => {
            this.#connecting = undefined;
        });
        return this.#connecting;
    }

    async #connect(): Promise<void> {
        const shell = window.xoraShell;
        if (!shell) {
            throw new Error('window.xoraShell is missing: the UI must run inside the Xora Code shell');
        }
        this.#peer?.dispose();
        const portPromise = nextPort();
        shell.requestPort();
        const port = await portPromise;
        const peer: Peer = new RpcPeer(domPortTransport(port), {
            methods,
            notifications,
            timeoutMs: 30_000,
            // The host validates every result before sending; skip re-validating large snapshots here.
            trustResults: true,
        });
        this.#peer = peer;
        for (const [name, listeners] of this.#listeners) {
            for (const listener of listeners) {
                peer.onNotification(name, listener as (params: unknown) => void);
            }
        }
        for (const listener of this.#state) listener(true);
    }

    handleHostRestart(): void {
        for (const listener of this.#state) listener(false);
        void this.connect();
    }

    call<M extends MethodName>(
        method: M,
        params: ParamsOf<HostMethods, M>,
        options?: { timeoutMs?: number },
    ): Promise<ResultOf<HostMethods, M>> {
        if (!this.#peer) {
            return Promise.reject(new Error('not connected to the host'));
        }
        return this.#peer.request(method, params, options);
    }

    on<N extends NotificationName>(
        name: N,
        listener: (params: import('@xora/protocol').NotificationParams<N>) => void,
    ): () => void {
        let listeners = this.#listeners.get(name);
        if (!listeners) {
            listeners = new Set();
            this.#listeners.set(name, listeners);
        }
        listeners.add(listener as Listener);
        const off = this.#peer?.onNotification(name, listener as (params: unknown) => void);
        return () => {
            listeners.delete(listener as Listener);
            off?.();
        };
    }
}

export const host = new HostClient();

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
