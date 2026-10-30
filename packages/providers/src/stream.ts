import { buildAnthropicBody, parseAnthropicStream } from './anthropic.ts';
import { endpointFor, findModel, operationUrl, resolveQuirks } from './catalog.ts';
import { classifyError, ProviderError, requestIdFrom } from './errors.ts';
import { buildHeaders, Exchange } from './http.ts';
import { isRecord, parseJson } from './json.ts';
import { buildOpenAiChatBody, parseOpenAiChatStream } from './openai-chat.ts';
import { parseSse } from './sse.ts';
import type { ModelEvent, ModelRequest, ProviderConnection, StreamOptions } from './types.ts';
import { Clock, type WireContext } from './wire.ts';

/** Largest error body kept for classification and messages. */
const MAX_ERROR_BODY = 64 * 1024;

/**
 * Streams one model call. Yields `start` once the vendor accepted the request, then deltas, then `done`; every
 * failure is thrown as a {@link ProviderError}. The caller's `signal` cancels the call (`cancelled`) and the idle
 * timeout (default 300 s, restarted by any received byte including keep-alive comments) ends it (`timeout`).
 */
export async function* streamModel(
    connection: ProviderConnection,
    request: ModelRequest,
    options: StreamOptions = {},
): AsyncGenerator<ModelEvent> {
    const endpoint = endpointFor(connection);
    const model = findModel(connection, request.model);
    const quirks = resolveQuirks(connection.preset, model);
    const context: WireContext = { preset: connection.preset, model, quirks, request };
    const anthropic = endpoint.wire === 'anthropic_messages';
    const body = anthropic ? buildAnthropicBody(context) : buildOpenAiChatBody(context);
    const headers = buildHeaders(connection, quirks, endpoint.wire, {
        accept: 'text/event-stream',
        json: true,
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });
    const provider = connection.preset.id;
    const clock = new Clock();
    const exchange = new Exchange(provider, options);
    try {
        const response = await exchange.fetch(operationUrl(endpoint, 'generate'), {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        const requestId = requestIdFrom(response.headers);
        if (!response.ok) {
            const text = (await exchange.text(response)).slice(0, MAX_ERROR_BODY);
            throw classifyError({
                provider,
                status: response.status,
                body: text,
                headers: response.headers,
                quirks,
                ...(requestId ? { requestId } : {}),
            });
        }
        if (response.body === null) {
            throw new ProviderError('the response has no body', { errorClass: 'server', provider });
        }
        let stream: ReadableStream<Uint8Array>;
        if ((response.headers.get('content-type') ?? '').includes('application/json')) {
            // An error delivered with a success status, an endpoint that ignored `stream: true`, or a proxy that
            // mislabels the event stream.
            const text = await exchange.text(response);
            const payload = parseJson(text);
            if (isRecord(payload) && (payload.error !== undefined || payload.type === 'error')) {
                throw classifyError({ provider, body: payload, quirks, ...(requestId ? { requestId } : {}) });
            }
            if (payload !== undefined) {
                throw new ProviderError('the endpoint answered without streaming', {
                    errorClass: 'invalid_request',
                    provider,
                    ...(requestId ? { requestId } : {}),
                });
            }
            stream = new Blob([text]).stream();
        } else {
            stream = exchange.watch(response.body);
        }
        yield { type: 'start', model: request.model, ...(requestId ? { requestId } : {}) };
        const events = parseSse(stream);
        yield* anthropic
            ? parseAnthropicStream(events, context, clock, requestId)
            : parseOpenAiChatStream(events, context, clock, requestId);
    } finally {
        exchange.dispose();
    }
}

/** Runs {@link streamModel} to completion and returns its `done` event. */
export async function completeModel(
    connection: ProviderConnection,
    request: ModelRequest,
    options: StreamOptions = {},
): Promise<Extract<ModelEvent, { type: 'done' }>> {
    for await (const event of streamModel(connection, request, options)) {
        if (event.type === 'done') {
            return event;
        }
    }
    throw new ProviderError('the stream ended without a result', {
        errorClass: 'network',
        provider: connection.preset.id,
    });
}
