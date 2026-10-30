import { classifyError, type ProviderError } from './errors.ts';
import type { ProviderConnection, Quirks, StreamOptions, Wire } from './types.ts';

export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_USER_AGENT = 'XoraCode';
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/**
 * Request headers: protocol headers and auth, then preset `extraHeaders`, then the connection's own headers. The
 * user agent is set last so nothing can replace the truthful client identity.
 */
export function buildHeaders(
    connection: ProviderConnection,
    quirks: Quirks,
    wire: Wire,
    options: { readonly userAgent?: string; readonly accept: string; readonly json: boolean },
): Record<string, string> {
    const headers: Record<string, string> = { accept: options.accept };
    if (options.json) {
        headers['content-type'] = 'application/json';
    }
    if (wire === 'anthropic_messages') {
        headers['anthropic-version'] = ANTHROPIC_VERSION;
    }
    const key = connection.apiKey?.trim();
    if (key && connection.preset.auth === 'bearer') {
        headers.authorization = `Bearer ${key}`;
    } else if (key && connection.preset.auth === 'x-api-key') {
        headers['x-api-key'] = key;
    }
    for (const extra of [quirks.extraHeaders, connection.headers]) {
        for (const [name, value] of Object.entries(extra ?? {})) {
            headers[name.toLowerCase()] = value;
        }
    }
    headers['user-agent'] = options.userAgent ?? DEFAULT_USER_AGENT;
    return headers;
}

/**
 * Owns one HTTP exchange: forwards the caller's abort signal, enforces the idle timeout (any received byte,
 * including SSE keep-alive comments, restarts it) and turns transport failures into {@link ProviderError}s.
 */
export class Exchange {
    readonly #provider: string;
    readonly #fetch: typeof fetch;
    readonly #idleMs: number;
    readonly #external: AbortSignal | undefined;
    readonly #controller = new AbortController();
    readonly #onAbort = (): void => this.#controller.abort();
    #timer: ReturnType<typeof setTimeout> | undefined;
    #idleFired = false;

    constructor(provider: string, options: StreamOptions, defaultIdleMs = DEFAULT_IDLE_TIMEOUT_MS) {
        this.#provider = provider;
        this.#fetch = options.fetch ?? globalThis.fetch;
        this.#idleMs = options.idleTimeoutMs ?? defaultIdleMs;
        this.#external = options.signal;
        this.#external?.addEventListener('abort', this.#onAbort, { once: true });
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    /** Sends the request; resolves once headers arrive. */
    async fetch(url: string, init: RequestInit): Promise<Response> {
        if (this.#external?.aborted) {
            throw this.failure(this.#external.reason);
        }
        this.#touch();
        let response: Response;
        try {
            response = await this.#fetch(url, { ...init, signal: this.#controller.signal });
        } catch (error) {
            throw this.failure(error);
        }
        // Headers are data too: the body gets a full idle period of its own.
        this.#touch();
        return response;
    }

    /** Wraps a response body so every chunk restarts the idle timer and read failures become ProviderErrors. */
    watch(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
        const reader = body.getReader();
        return new ReadableStream<Uint8Array>({
            pull: async (controller) => {
                let result: Awaited<ReturnType<typeof reader.read>>;
                try {
                    result = await reader.read();
                } catch (error) {
                    controller.error(this.failure(error));
                    return;
                }
                if (result.done) {
                    this.#clearTimer();
                    controller.close();
                    return;
                }
                this.#touch();
                controller.enqueue(result.value);
            },
            cancel: async (reason) => {
                await reader.cancel(reason).catch(() => undefined);
            },
        });
    }

    /** Reads a whole body as text under the same idle and abort rules. */
    async text(response: Response): Promise<string> {
        if (response.body === null) {
            return '';
        }
        return new Response(this.watch(response.body)).text();
    }

    /** Classifies a transport failure, telling a caller abort and an idle timeout apart from network errors. */
    failure(error: unknown): ProviderError {
        if (this.#external?.aborted) {
            return classifyError({ provider: this.#provider, aborted: true, cause: error });
        }
        if (this.#idleFired) {
            return classifyError({ provider: this.#provider, idleTimeoutMs: this.#idleMs, cause: error });
        }
        return classifyError({ provider: this.#provider, cause: error });
    }

    /** Stops the timer, detaches from the caller's signal and aborts anything still in flight. */
    dispose(): void {
        this.#clearTimer();
        this.#external?.removeEventListener('abort', this.#onAbort);
        this.#controller.abort();
    }

    #touch(): void {
        this.#clearTimer();
        if (this.#idleMs > 0 && Number.isFinite(this.#idleMs)) {
            this.#timer = setTimeout(() => {
                this.#idleFired = true;
                this.#controller.abort();
            }, this.#idleMs);
            // An abandoned stream must not keep the process alive until the timer fires.
            this.#timer.unref?.();
        }
    }

    #clearTimer(): void {
        if (this.#timer !== undefined) {
            clearTimeout(this.#timer);
            this.#timer = undefined;
        }
    }
}
