import { buildAnthropicBody, parseAnthropicStream } from './anthropic.ts';
import { alternateOperationUrl, endpointFor, findModel, operationUrl, resolveQuirks } from './catalog.ts';
import { classifyError, ProviderError, requestIdFrom } from './errors.ts';
import { buildHeaders, Exchange } from './http.ts';
import { isRecord, parseJson } from './json.ts';
import { buildOpenAiChatBody, parseOpenAiChatStream } from './openai-chat.ts';
import { parseSse } from './sse.ts';
import type { ModelEvent, ModelRequest, ProviderConnection, StreamOptions } from './types.ts';
import { Clock, type WireContext } from './wire.ts';

/** Largest error body kept for classification and messages. */
const MAX_ERROR_BODY = 64 * 1024;
/** Endpoints that rejected `stream_options` once; remembered so later turns skip it immediately. */
const streamUsageRejected = new Set<string>();
/** Endpoints where `/v1` vs bare path was resolved after a 404; remembered for subsequent calls. */
const alternatePathResolved = new Map<string, string>();

/**
 * Streams one model call. Yields `start` once the vendor accepted the request, then deltas, then `done`; every
 * failure is thrown as a {@link ProviderError}. The caller's `signal` cancels the call (`cancelled`) and the first-byte
 * / mid-stream idle timeouts (default 180 s until first body chunk, then 45 s between chunks) end stalls (`timeout`).
 */
export async function* streamModel(
    connection: ProviderConnection,
    request: ModelRequest,
    options: StreamOptions = {},
): AsyncGenerator<ModelEvent> {
    const endpoint = endpointFor(connection);
    const model = findModel(connection, request.model);
    const baseQuirks = resolveQuirks(connection.preset, model);
    const anthropic = endpoint.wire === 'anthropic_messages';
    const quirks =
        !anthropic && streamUsageRejected.has(endpoint.baseUrl) ? { ...baseQuirks, streamUsage: false } : baseQuirks;
    const context: WireContext = { preset: connection.preset, model, quirks, request };
    let body = anthropic ? buildAnthropicBody(context) : buildOpenAiChatBody(context);
    const headers = buildHeaders(connection, quirks, endpoint.wire, {
        accept: 'text/event-stream',
        json: true,
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });
    const provider = connection.preset.id;
    const clock = new Clock();
    const exchange = new Exchange(provider, options);
    try {
        const primaryUrl = alternatePathResolved.get(endpoint.baseUrl) ?? operationUrl(endpoint, 'generate');
        let response = await exchange.fetch(primaryUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        if (response.status === 404 && (connection.preset.channel === 'custom' || Boolean(connection.baseUrl))) {
            const altUrl = alternateOperationUrl(endpoint, 'generate');
            if (altUrl && altUrl !== primaryUrl) {
                await exchange.text(response).catch(() => '');
                const retried = await exchange.fetch(altUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                });
                if (retried.status !== 404) {
                    alternatePathResolved.set(endpoint.baseUrl, altUrl);
                    response = retried;
                }
            }
        }
        let errorText: string | undefined;
        if (!anthropic && response.status === 400 && body.stream_options !== undefined) {
            errorText = (await exchange.text(response)).slice(0, MAX_ERROR_BODY);
            if (/stream_options|include_usage/i.test(errorText)) {
                streamUsageRejected.add(endpoint.baseUrl);
                const { stream_options: _dropped, ...withoutStreamUsage } = body;
                body = withoutStreamUsage;
                errorText = undefined;
                response = await exchange.fetch(alternatePathResolved.get(endpoint.baseUrl) ?? primaryUrl, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                });
            }
        }
        const requestId = requestIdFrom(response.headers);
        if (!response.ok) {
            const text = errorText ?? (await exchange.text(response)).slice(0, MAX_ERROR_BODY);
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
