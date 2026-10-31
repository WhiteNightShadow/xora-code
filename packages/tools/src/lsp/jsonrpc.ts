/**
 * The base protocol of LSP: JSON-RPC 2.0 messages, each preceded by a `Content-Length` header, over a byte stream.
 * `MessageReader` cuts the stream into messages and `JsonRpcConnection` matches requests to responses; neither knows
 * about processes, so both can be tested on plain buffers.
 */

export type JsonRpcId = number | string;

export interface JsonRpcError {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
}

/** Largest message accepted from a server; anything bigger means a broken stream or a runaway server. */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Headers are a line or two; this much without the blank line that ends them means the stream is not LSP. */
const MAX_HEADER_BYTES = 8 * 1024;
const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');

/** JSON-RPC error codes used here (the LSP specification lists them). */
export const ErrorCodes = {
    MethodNotFound: -32601,
    InternalError: -32603,
    RequestCancelled: -32800,
    ContentModified: -32801,
} as const;

/** The stream cannot be read any further: a header is malformed or a message is too large. */
export class FramingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FramingError';
    }
}

/** The other side answered a request with an error. */
export class ResponseError extends Error {
    readonly code: number;
    readonly data: unknown;

    constructor(code: number, message: string, data?: unknown) {
        super(message);
        this.name = 'ResponseError';
        this.code = code;
        this.data = data;
    }
}

/** No answer arrived in time; the request was cancelled on the other side. */
export class RequestTimeoutError extends Error {
    readonly method: string;
    readonly timeoutMs: number;

    constructor(method: string, timeoutMs: number) {
        super(`${method} got no answer within ${timeoutMs} ms`);
        this.name = 'RequestTimeoutError';
        this.method = method;
        this.timeoutMs = timeoutMs;
    }
}

/** The caller aborted the request. */
export class RequestAbortedError extends Error {
    constructor(method: string) {
        super(`${method} was cancelled`);
        this.name = 'RequestAbortedError';
    }
}

/** The connection closed before an answer arrived. */
export class ConnectionClosedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConnectionClosedError';
    }
}

/** Frames one message: the `Content-Length` header counts bytes of the UTF-8 body, not characters. */
export function encodeMessage(message: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

function parseHeader(text: string): number {
    let length: number | undefined;
    for (const line of text.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon <= 0) {
            throw new FramingError(`malformed header line ${JSON.stringify(line.slice(0, 80))}`);
        }
        if (line.slice(0, colon).trim().toLowerCase() === 'content-length') {
            const value = line.slice(colon + 1).trim();
            if (!/^\d{1,12}$/.test(value)) {
                throw new FramingError(`invalid Content-Length ${JSON.stringify(value.slice(0, 40))}`);
            }
            length = Number(value);
        }
        // Content-Type is the only other header; LSP fixes it to UTF-8 JSON.
    }
    if (length === undefined) {
        throw new FramingError('message header without Content-Length');
    }
    return length;
}

export type ReadResult =
    | { readonly ok: true; readonly message: unknown }
    | { readonly ok: false; readonly error: string };

/**
 * Cuts a byte stream into messages. Chunks may end anywhere, inside a header or inside a multi-byte character, and
 * may hold several messages. A body that is not JSON is reported and skipped (the length keeps the stream in step);
 * a broken header or an oversized message throws `FramingError`, after which the stream cannot be trusted.
 */
export class MessageReader {
    readonly #maxBytes: number;
    #chunks: Buffer[] = [];
    #buffered = 0;
    /** Length of the body being read, once its header is parsed. */
    #bodyLength: number | undefined;

    constructor(maxBytes = MAX_MESSAGE_BYTES) {
        this.#maxBytes = maxBytes;
    }

    /** Adds bytes and returns every message they complete, in order. */
    push(chunk: Uint8Array): ReadResult[] {
        if (chunk.length > 0) {
            this.#chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            this.#buffered += chunk.length;
        }
        const results: ReadResult[] = [];
        for (;;) {
            if (this.#bodyLength === undefined) {
                const data = this.#joined();
                const end = data.indexOf(HEADER_END);
                if (end < 0) {
                    if (data.length > MAX_HEADER_BYTES) {
                        throw new FramingError(`no message header in the first ${MAX_HEADER_BYTES} bytes`);
                    }
                    return results;
                }
                const length = parseHeader(data.subarray(0, end).toString('ascii'));
                if (length > this.#maxBytes) {
                    throw new FramingError(`a message of ${length} bytes is over the limit of ${this.#maxBytes}`);
                }
                this.#bodyLength = length;
                this.#consume(end + HEADER_END.length);
            }
            // Large bodies arrive in many chunks; they are joined once, when complete.
            if (this.#buffered < this.#bodyLength) {
                return results;
            }
            const body = this.#joined().subarray(0, this.#bodyLength);
            this.#consume(this.#bodyLength);
            this.#bodyLength = undefined;
            try {
                results.push({ ok: true, message: JSON.parse(body.toString('utf8')) });
            } catch {
                results.push({ ok: false, error: `a message body of ${body.length} bytes is not valid JSON` });
            }
        }
    }

    /** Bytes received but not yet part of a complete message. */
    get buffered(): number {
        return this.#buffered;
    }

    #joined(): Buffer {
        if (this.#chunks.length > 1) {
            this.#chunks = [Buffer.concat(this.#chunks, this.#buffered)];
        }
        return this.#chunks[0] ?? Buffer.alloc(0);
    }

    #consume(bytes: number): void {
        const rest = this.#joined().subarray(bytes);
        this.#chunks = rest.length > 0 ? [rest] : [];
        this.#buffered = rest.length;
    }
}

export interface RequestOptions {
    /** Rejects with `RequestTimeoutError` and cancels the request on the other side after this long. */
    readonly timeoutMs?: number;
    /** Rejects with `RequestAbortedError` and cancels the request on the other side. */
    readonly signal?: AbortSignal | undefined;
}

export interface ConnectionHandlers {
    /** Answers a request from the other side; throw a `ResponseError` to answer with an error. */
    onRequest(method: string, params: unknown): unknown;
    onNotification(method: string, params: unknown): void;
}

interface Pending {
    readonly method: string;
    resolve(value: unknown): void;
    reject(error: Error): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON-RPC 2.0 over a framed stream: numbers outgoing requests, matches responses, answers incoming requests through
 * `handlers`, and fails pending requests on timeout, abort or close. `write` gets complete frames.
 */
export class JsonRpcConnection {
    readonly #write: (frame: Buffer) => void;
    readonly #handlers: ConnectionHandlers;
    readonly #pending = new Map<JsonRpcId, Pending>();
    #nextId = 1;
    #closed: Error | undefined;

    constructor(write: (frame: Buffer) => void, handlers: ConnectionHandlers) {
        this.#write = write;
        this.#handlers = handlers;
    }

    /** Requests waiting for an answer. */
    get pending(): number {
        return this.#pending.size;
    }

    get closed(): boolean {
        return this.#closed !== undefined;
    }

    request<T>(method: string, params: unknown, options: RequestOptions = {}): Promise<T> {
        if (this.#closed) {
            return Promise.reject(this.#closed);
        }
        if (options.signal?.aborted) {
            return Promise.reject(new RequestAbortedError(method));
        }
        const id = this.#nextId++;
        return new Promise<T>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const cleanup = (): void => {
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', onAbort);
                this.#pending.delete(id);
            };
            const giveUp = (error: Error): void => {
                cleanup();
                this.#send({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } });
                reject(error);
            };
            const onAbort = (): void => giveUp(new RequestAbortedError(method));
            this.#pending.set(id, {
                method,
                resolve: (value) => {
                    cleanup();
                    resolve(value as T);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
            });
            if (options.timeoutMs !== undefined) {
                timer = setTimeout(
                    () => giveUp(new RequestTimeoutError(method, options.timeoutMs ?? 0)),
                    options.timeoutMs,
                );
            }
            options.signal?.addEventListener('abort', onAbort, { once: true });
            this.#send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
        });
    }

    notify(method: string, params?: unknown): void {
        if (!this.#closed) {
            this.#send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
        }
    }

    /** Handles one parsed message from the other side. */
    receive(message: unknown): void {
        if (this.#closed || !isObject(message)) {
            return;
        }
        const { id, method } = message;
        if (typeof method === 'string') {
            if (id === undefined || id === null) {
                try {
                    this.#handlers.onNotification(method, message.params);
                } catch {
                    // A failing handler must not break the connection.
                }
            } else if (typeof id === 'number' || typeof id === 'string') {
                void this.#answer(id, method, message.params);
            }
            return;
        }
        if (typeof id !== 'number' && typeof id !== 'string') {
            return;
        }
        // A late answer to a request that timed out or was aborted finds nothing here and is dropped.
        const pending = this.#pending.get(id);
        if (!pending) {
            return;
        }
        if (isObject(message.error)) {
            const code = typeof message.error.code === 'number' ? message.error.code : ErrorCodes.InternalError;
            const text = typeof message.error.message === 'string' ? message.error.message : 'unknown error';
            pending.reject(new ResponseError(code, text, message.error.data));
        } else {
            pending.resolve(message.result ?? null);
        }
    }

    /** Fails every pending request with `error` and stops sending. */
    close(error: Error): void {
        if (this.#closed) {
            return;
        }
        this.#closed = error;
        for (const pending of [...this.#pending.values()]) {
            pending.reject(error);
        }
        this.#pending.clear();
    }

    async #answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
        try {
            const result = await this.#handlers.onRequest(method, params);
            this.#send({ jsonrpc: '2.0', id, result: result ?? null });
        } catch (error) {
            const code = error instanceof ResponseError ? error.code : ErrorCodes.InternalError;
            const text = error instanceof Error ? error.message : String(error);
            this.#send({ jsonrpc: '2.0', id, error: { code, message: text } });
        }
    }

    #send(message: Record<string, unknown>): void {
        if (this.#closed) {
            return;
        }
        try {
            this.#write(encodeMessage(message));
        } catch {
            // The process side reports a broken pipe through its own close.
        }
    }
}
