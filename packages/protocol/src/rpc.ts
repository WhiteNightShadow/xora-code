import { z } from 'zod';
import type { RpcTransport } from './transport.ts';

export const RpcErrorCode = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
    Timeout: -32000,
    Disposed: -32001,
    /** The host refused: the action is not allowed in the current state. */
    Rejected: -32010,
    NotFound: -32011,
} as const;

export class RpcError extends Error {
    readonly code: number;
    readonly data: unknown;

    constructor(code: number, message: string, data?: unknown) {
        super(message);
        this.name = 'RpcError';
        this.code = code;
        this.data = data;
    }
}

export interface MethodSpec {
    readonly params: z.ZodType;
    readonly result: z.ZodType;
}

export type MethodRegistry = { readonly [method: string]: MethodSpec };
export type NotificationRegistry = { readonly [method: string]: z.ZodType };

export type ParamsOf<M extends MethodRegistry, K extends keyof M> = z.input<M[K]['params']>;
export type ResultOf<M extends MethodRegistry, K extends keyof M> = z.output<M[K]['result']>;
export type HandlerResultOf<M extends MethodRegistry, K extends keyof M> = z.input<M[K]['result']>;
export type NotificationOf<N extends NotificationRegistry, K extends keyof N> = z.output<N[K]>;

const RpcIdSchema = z.union([z.string(), z.number()]);

const RequestSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: RpcIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
});

const NotificationSchema = z.object({
    jsonrpc: z.literal('2.0'),
    method: z.string().min(1),
    params: z.unknown().optional(),
});

const ResponseSchema = z.object({
    jsonrpc: z.literal('2.0'),
    id: RpcIdSchema,
    result: z.unknown().optional(),
    error: z
        .object({
            code: z.number().int(),
            message: z.string(),
            data: z.unknown().optional(),
        })
        .optional(),
});

type Handler = (params: unknown) => Promise<unknown>;

interface Pending {
    readonly method: string;
    readonly timer: ReturnType<typeof setTimeout> | undefined;
    readonly resolve: (raw: unknown) => void;
    readonly reject: (error: Error) => void;
}

export interface RpcPeerOptions<M extends MethodRegistry, N extends NotificationRegistry> {
    /** Methods either side may call. Each side registers handlers for the ones it serves. */
    readonly methods: M;
    readonly notifications?: N;
    /** Default request timeout; `0` disables it. */
    readonly timeoutMs?: number;
    /** Skip validating results this peer receives. Only for a trusted peer that validates before sending. */
    readonly trustResults?: boolean;
    /** Called for messages that are not valid JSON-RPC 2.0 or fail notification validation. */
    readonly onProtocolError?: (error: Error, message: unknown) => void;
}

/**
 * One side of a JSON-RPC 2.0 connection. Requests, results and notifications are validated against the
 * registries, so a peer can neither call nor serve anything that is not part of the protocol.
 */
export class RpcPeer<M extends MethodRegistry, N extends NotificationRegistry = NotificationRegistry> {
    readonly #transport: RpcTransport;
    readonly #options: RpcPeerOptions<M, N>;
    readonly #handlers = new Map<string, Handler>();
    readonly #notificationListeners = new Map<string, Set<(params: unknown) => void>>();
    readonly #pending = new Map<string, Pending>();
    readonly #disposeListeners = new Set<() => void>();
    readonly #unsubscribe: () => void;
    #nextId = 1;
    #disposed = false;

    constructor(transport: RpcTransport, options: RpcPeerOptions<M, N>) {
        this.#transport = transport;
        this.#options = options;
        this.#unsubscribe = transport.subscribe((message) => this.#receive(message));
    }

    get disposed(): boolean {
        return this.#disposed;
    }

    handle<K extends keyof M & string>(
        method: K,
        handler: (params: z.output<M[K]['params']>) => HandlerResultOf<M, K> | Promise<HandlerResultOf<M, K>>,
    ): () => void {
        const spec = this.#options.methods[method];
        if (!spec) {
            throw new Error(`unknown method ${method}`);
        }
        this.#handlers.set(method, async (raw) => {
            const parsed = spec.params.safeParse(raw ?? {});
            if (!parsed.success) {
                throw new RpcError(RpcErrorCode.InvalidParams, `invalid params for ${method}: ${parsed.error.message}`);
            }
            const result = await handler(parsed.data as z.output<M[K]['params']>);
            return spec.result.parse(result);
        });
        return () => {
            this.#handlers.delete(method);
        };
    }

    request<K extends keyof M & string>(
        method: K,
        params: ParamsOf<M, K>,
        options: { readonly timeoutMs?: number } = {},
    ): Promise<ResultOf<M, K>> {
        if (this.#disposed) {
            return Promise.reject(new RpcError(RpcErrorCode.Disposed, 'rpc peer is disposed'));
        }
        const spec = this.#options.methods[method];
        if (!spec) {
            return Promise.reject(new RpcError(RpcErrorCode.MethodNotFound, `unknown method ${method}`));
        }
        const checked = spec.params.parse(params);
        const id = String(this.#nextId++);
        return new Promise<ResultOf<M, K>>((resolve, reject) => {
            const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs ?? 15_000;
            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          this.#pending.delete(id);
                          reject(new RpcError(RpcErrorCode.Timeout, `${method} timed out after ${timeoutMs}ms`));
                      }, timeoutMs)
                    : undefined;
            this.#pending.set(id, {
                method,
                timer,
                resolve: (raw) => {
                    if (this.#options.trustResults) {
                        resolve(raw as ResultOf<M, K>);
                        return;
                    }
                    const parsed = spec.result.safeParse(raw);
                    if (parsed.success) {
                        resolve(parsed.data as ResultOf<M, K>);
                    } else {
                        reject(new RpcError(RpcErrorCode.InternalError, `invalid result for ${method}`, parsed.error));
                    }
                },
                reject,
            });
            this.#transport.send({ jsonrpc: '2.0', id, method, params: checked });
        });
    }

    notify<K extends keyof N & string>(method: K, params: z.input<N[K]>): void {
        if (!this.#disposed) {
            this.#transport.send({ jsonrpc: '2.0', method, params });
        }
    }

    onNotification<K extends keyof N & string>(
        method: K,
        listener: (params: NotificationOf<N, K>) => void,
    ): () => void {
        let listeners = this.#notificationListeners.get(method);
        if (!listeners) {
            listeners = new Set();
            this.#notificationListeners.set(method, listeners);
        }
        const wrapped = listener as (params: unknown) => void;
        listeners.add(wrapped);
        return () => {
            listeners.delete(wrapped);
        };
    }

    onDispose(listener: () => void): () => void {
        this.#disposeListeners.add(listener);
        return () => {
            this.#disposeListeners.delete(listener);
        };
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#unsubscribe();
        this.#transport.close?.();
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new RpcError(RpcErrorCode.Disposed, `${pending.method} cancelled: rpc peer disposed`));
        }
        this.#pending.clear();
        this.#handlers.clear();
        this.#notificationListeners.clear();
        for (const listener of this.#disposeListeners) {
            listener();
        }
        this.#disposeListeners.clear();
    }

    #receive(message: unknown): void {
        if (this.#disposed) {
            return;
        }
        if (typeof message === 'object' && message !== null && 'method' in message) {
            if ('id' in message) {
                const request = RequestSchema.safeParse(message);
                if (request.success) {
                    void this.#serve(request.data.id, request.data.method, request.data.params);
                } else {
                    this.#protocolError(new Error('malformed request'), message);
                }
                return;
            }
            const notification = NotificationSchema.safeParse(message);
            if (notification.success) {
                this.#dispatchNotification(notification.data.method, notification.data.params);
            } else {
                this.#protocolError(new Error('malformed notification'), message);
            }
            return;
        }
        const response = ResponseSchema.safeParse(message);
        if (!response.success) {
            this.#protocolError(new Error('malformed message'), message);
            return;
        }
        const id = String(response.data.id);
        const pending = this.#pending.get(id);
        if (!pending) {
            return;
        }
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (response.data.error) {
            const { code, message: text, data } = response.data.error;
            pending.reject(new RpcError(code, text, data));
        } else {
            pending.resolve(response.data.result);
        }
    }

    #dispatchNotification(method: string, params: unknown): void {
        const listeners = this.#notificationListeners.get(method);
        if (!listeners || listeners.size === 0) {
            return;
        }
        const schema = this.#options.notifications?.[method];
        let value = params;
        if (schema) {
            const parsed = schema.safeParse(params);
            if (!parsed.success) {
                this.#protocolError(new Error(`invalid notification ${method}: ${parsed.error.message}`), params);
                return;
            }
            value = parsed.data;
        }
        for (const listener of [...listeners]) {
            listener(value);
        }
    }

    async #serve(id: string | number, method: string, params: unknown): Promise<void> {
        const handler = this.#handlers.get(method);
        if (!handler) {
            this.#transport.send({
                jsonrpc: '2.0',
                id,
                error: { code: RpcErrorCode.MethodNotFound, message: `method not found: ${method}` },
            });
            return;
        }
        try {
            const result = await handler(params);
            if (!this.#disposed) {
                this.#transport.send({ jsonrpc: '2.0', id, result });
            }
        } catch (error) {
            if (this.#disposed) {
                return;
            }
            const code = error instanceof RpcError ? error.code : RpcErrorCode.InternalError;
            const text = error instanceof Error ? error.message : String(error);
            const data = error instanceof RpcError ? error.data : undefined;
            this.#transport.send({
                jsonrpc: '2.0',
                id,
                error: data === undefined ? { code, message: text } : { code, message: text, data },
            });
        }
    }

    #protocolError(error: Error, message: unknown): void {
        this.#options.onProtocolError?.(error, message);
    }
}
