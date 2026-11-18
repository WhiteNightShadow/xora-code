import { classifyError, type ProviderError } from './errors.ts';
import type { ProviderConnection, Quirks, StreamOptions, Wire } from './types.ts';

export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_USER_AGENT = 'XoraCode';
export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 180_000;
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;
export const DEFAULT_IDLE_TIMEOUT_MS = DEFAULT_FIRST_BYTE_TIMEOUT_MS;

/** Strips invisible clipboard characters, CR/LF, surrounding quotes and accidental `Bearer ` prefixes from API keys. */
export function sanitizeApiKey(raw: string | undefined): string {
    if (!raw) return '';
    return raw
        .replace(/[\r\n\uFEFF\u200B-\u200D]/g, '')
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .replace(/^bearer\s+/i, '')
        .trim();
}

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
    const key = sanitizeApiKey(connection.apiKey);
    if (key && connection.preset.auth === 'bearer') {
        headers.authorization = `Bearer ${key}`;
        if (wire === 'anthropic_messages' && (connection.preset.channel === 'custom' || Boolean(connection.baseUrl))) {
            headers['x-api-key'] = key;
        }
    } else if (key && connection.preset.auth === 'x-api-key') {
        headers['x-api-key'] = key;
        // Custom Anthropic-compatible gateways (MiniMax `/anthropic`, OneAPI/NewAPI relays) often check `Bearer` instead
        // of `x-api-key`; sending both on custom channels matches `firefox-reverse` while keeping official Anthropic clean.
        if (connection.preset.channel === 'custom') {
            headers.authorization = `Bearer ${key}`;
        }
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
 * Owns one HTTP exchange: forwards the caller's abort signal, enforces separate pre-first-byte (`firstByteTimeoutMs`)
 * and mid-stream (`idleTimeoutMs`) stall timeouts (any received byte, including SSE keep-alive comments, restarts the
 * active timer) and turns transport failures into {@link ProviderError}s.
 */
export class Exchange {
    readonly #provider: string;
    readonly #fetch: typeof fetch;
    readonly #firstByteMs: number;
    readonly #streamIdleMs: number;
    readonly #external: AbortSignal | undefined;
    readonly #controller = new AbortController();
    readonly #onAbort = (): void => this.#controller.abort();
    #timer: ReturnType<typeof setTimeout> | undefined;
    #sawBodyByte = false;
    #activeTimeoutMs = 0;
    #idleFired = false;

    constructor(provider: string, options: StreamOptions, defaultIdleMs?: number) {
        this.#provider = provider;
        this.#fetch = options.fetch ?? globalThis.fetch;
        this.#firstByteMs =
            options.firstByteTimeoutMs ?? options.idleTimeoutMs ?? defaultIdleMs ?? DEFAULT_FIRST_BYTE_TIMEOUT_MS;
        this.#streamIdleMs = options.idleTimeoutMs ?? defaultIdleMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
        this.#activeTimeoutMs = this.#firstByteMs;
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
        // Headers are data too: waiting for the first body chunk gets a full pre-first-byte window of its own.
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
                if (result.value.byteLength > 0) {
                    this.#sawBodyByte = true;
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
            return classifyError({ provider: this.#provider, idleTimeoutMs: this.#activeTimeoutMs, cause: error });
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
        const ms = this.#sawBodyByte ? this.#streamIdleMs : this.#firstByteMs;
        this.#activeTimeoutMs = ms;
        if (ms > 0 && Number.isFinite(ms)) {
            this.#timer = setTimeout(() => {
                this.#idleFired = true;
                this.#controller.abort();
            }, ms);
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
