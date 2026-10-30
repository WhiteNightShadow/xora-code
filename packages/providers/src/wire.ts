import { ProviderError } from './errors.ts';
import type { ModelInfo, ModelRequest, ProviderPreset, Quirks } from './types.ts';

/** Everything a wire adapter needs to map one request. */
export interface WireContext {
    readonly preset: ProviderPreset;
    readonly model: ModelInfo;
    /** Preset quirks with the model's overrides applied. */
    readonly quirks: Quirks;
    readonly request: ModelRequest;
}

/** Latency bookkeeping for one model call. */
export class Clock {
    readonly #startedAt = performance.now();
    #firstToken: number | undefined;

    /** Records the first streamed token of any kind. */
    mark(): void {
        this.#firstToken ??= performance.now();
    }

    get ttftMs(): number | undefined {
        return this.#firstToken === undefined ? undefined : Math.round(this.#firstToken - this.#startedAt);
    }

    get latencyMs(): number {
        return Math.round(performance.now() - this.#startedAt);
    }
}

export const IMAGE_OMITTED = '[image omitted: this model does not accept images]';

/** Raised when a stream closes before the vendor said it was complete. */
export function truncatedStream(provider: string, requestId: string | undefined): ProviderError {
    return new ProviderError('the stream ended before the response was complete', {
        errorClass: 'network',
        provider,
        ...(requestId ? { requestId } : {}),
    });
}

/** `tool_call` arguments must be a JSON object for the anthropic wire; anything else becomes `{}`. */
export function parseArguments(text: string): Record<string, unknown> {
    try {
        const value: unknown = JSON.parse(text);
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

/** Fallback id for a tool call a vendor streamed without one. */
export function generatedToolCallId(): string {
    return `call_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}
