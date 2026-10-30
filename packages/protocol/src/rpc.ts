import { z } from 'zod';
import { type MethodName, type MethodParams, type MethodResult, methods } from './methods.ts';
import type { RpcTransport } from './transport.ts';

export const RpcErrorCode = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
    Timeout: -32000,
    Disposed: -32001,
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
    readonly timer: ReturnType<typeof setTimeout>;
    readonly resolve: (raw: unknown) => void;
    readonly reject: (error: Error) => void;
}

export interface RpcPeerOptions {
    /** Default request timeout. */
    readonly timeoutMs?: number;
    /** Called for messages that are not valid JSON-RPC 2.0. */
    readonly onProtocolError?: (error: Error, message: unknown) => void;
}

/**
 * One side of a JSON-RPC 2.0 connection. Requests and responses are validated against {@link methods}, so a
 * peer can neither call nor serve a method that is not part of the protocol.
 */
export class RpcPeer {
    readonly #transport: RpcTransport;
    readonly #options: RpcPeerOptions;
    readonly #handlers = new Map<string, Handler>();
    readonly #notificationListeners = new Map<string, Set<(params: unknown) => void>>();
    readonly #pending = new Map<string, Pending>();
    readonly #unsubscribe: () => void;
    #nextId = 1;
    #disposed = false;

    constructor(transport: RpcTransport, options: RpcPeerOptions = {}) {
        this.#transport = transport;
        this.#options = options;
        this.#unsubscribe = transport.subscribe((message) => this.#receive(message));
    }

    get disposed(): boolean {
        return this.#disposed;
    }

    handle<M extends MethodName>(
        method: M,
        handler: (params: MethodParams<M>) => MethodResult<M> | Promise<MethodResult<M>>,
    ): () => void {
        const spec = methods[method];
        this.#handlers.set(method, async (raw) => {
            const parsed = spec.params.safeParse(raw ?? {});
            if (!parsed.success) {
                throw new RpcError(RpcErrorCode.InvalidParams, `invalid params for ${method}: ${parsed.error.message}`);
            }
            const result = await handler(parsed.data as MethodParams<M>);
            return spec.result.parse(result);
        });
        return () => {
            this.#handlers.delete(method);
        };
    }

    request<M extends MethodName>(
        method: M,
        params: MethodParams<M>,
        options: { readonly timeoutMs?: number } = {},
    ): Promise<MethodResult<M>> {
        if (this.#disposed) {
            return Promise.reject(new RpcError(RpcErrorCode.Disposed, 'rpc peer is disposed'));
        }
        const spec = methods[method];
        const checked = spec.params.parse(params);
        const id = String(this.#nextId++);
        return new Promise<MethodResult<M>>((resolve, reject) => {
            const timeoutMs = options.timeoutMs ?? this.#options.timeoutMs ?? 15_000;
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new RpcError(RpcErrorCode.Timeout, `${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.#pending.set(id, {
                method,
                timer,
                resolve: (raw) => {
                    const parsed = spec.result.safeParse(raw);
                    if (parsed.success) {
                        resolve(parsed.data as MethodResult<M>);
                    } else {
                        reject(new RpcError(RpcErrorCode.InternalError, `invalid result for ${method}`, parsed.error));
                    }
                },
                reject,
            });
            this.#transport.send({ jsonrpc: '2.0', id, method, params: checked });
        });
    }

    notify(method: string, params?: unknown): void {
        if (!this.#disposed) {
            this.#transport.send({ jsonrpc: '2.0', method, params });
        }
    }

    onNotification(method: string, listener: (params: unknown) => void): () => void {
        let listeners = this.#notificationListeners.get(method);
        if (!listeners) {
            listeners = new Set();
            this.#notificationListeners.set(method, listeners);
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    dispose(): void {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#unsubscribe();
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new RpcError(RpcErrorCode.Disposed, `${pending.method} cancelled: rpc peer disposed`));
        }
        this.#pending.clear();
        this.#handlers.clear();
        this.#notificationListeners.clear();
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
                for (const listener of this.#notificationListeners.get(notification.data.method) ?? []) {
                    listener(notification.data.params);
                }
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
            this.#transport.send({ jsonrpc: '2.0', id, error: { code, message: text } });
        }
    }

    #protocolError(error: Error, message: unknown): void {
        this.#options.onProtocolError?.(error, message);
    }
}
