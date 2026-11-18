import { anthropicText, errorTurn, openaiText, sseFrame, startMockModelServer } from '@xora/test-kit';
import { describe, expect, it } from 'vitest';
import {
    buildAnthropicBody,
    completeModel,
    endpointFor,
    inferModelInfo,
    type ModelEvent,
    type ProviderConnection,
    ProviderError,
    type ProviderPreset,
    resolveQuirks,
    sanitizeApiKey,
    streamModel,
} from '../src/index.ts';
import { collect, connect, preset, request, useMockServer } from './helpers.ts';

const server = useMockServer();

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
    const error = await promise.then(
        () => undefined,
        (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
}

describe('request headers', () => {
    it('sends a truthful user agent that configured headers cannot replace', async () => {
        const custom: ProviderPreset = {
            ...preset('custom-openai'),
            id: 'relay',
            quirks: { extraHeaders: { 'X-Relay-Route': 'cn', 'User-Agent': 'claude-cli/1.0' } },
        };
        const connection: ProviderConnection = {
            preset: custom,
            apiKey: 'relay-key',
            baseUrl: `${server().url}/v1/`,
            headers: { 'User-Agent': 'KimiCLI/9.9', 'X-Session': 'abc' },
        };
        server().enqueue(openaiText('ok'), openaiText('ok'));
        await completeModel(connection, request('m'), { userAgent: 'XoraCode/1.0.0' });
        await completeModel(connection, request('m'));
        const [first, second] = server().requests;
        expect(first?.path).toBe('/v1/chat/completions');
        expect(first?.headers).toMatchObject({
            'user-agent': 'XoraCode/1.0.0',
            authorization: 'Bearer relay-key',
            'x-relay-route': 'cn',
            'x-session': 'abc',
            accept: 'text/event-stream',
            'content-type': 'application/json',
        });
        expect(second?.headers['user-agent']).toBe('XoraCode');
    });

    it('sends no credentials to keyless local servers', async () => {
        server().enqueue(openaiText('ok'));
        await completeModel(connect('ollama', server(), { apiKey: 'unused' }), request('qwen3'));
        expect(server().requests[0]?.headers).not.toHaveProperty('authorization');
    });

    it('requires a base URL when the preset has no endpoint for the wire', async () => {
        const error = await failure(completeModel({ preset: preset('custom-openai'), apiKey: 'k' }, request('m')));
        expect(error.errorClass).toBe('invalid_request');
        const anthropicOnly = await failure(
            completeModel({ preset: preset('anthropic'), wire: 'openai_chat' }, request('claude-opus-5-5')),
        );
        expect(anthropicOnly.errorClass).toBe('invalid_request');
    });
});

describe('HTTP errors', () => {
    it('carries status, code, retry-after and request id', async () => {
        server().enqueue(
            errorTurn(
                429,
                { error: { message: 'Rate limit reached', type: 'rate_limit_error' } },
                { 'retry-after': '3', 'x-request-id': 'req_42' },
            ),
        );
        const error = await failure(completeModel(connect('deepseek', server()), request('deepseek-flash')));
        expect(error).toMatchObject({
            errorClass: 'rate_limit',
            status: 429,
            code: 'rate_limit_error',
            retryAfterMs: 3000,
            requestId: 'req_42',
            provider: 'deepseek',
            retryable: true,
            message: 'Rate limit reached',
        });
    });

    it('classifies glm business codes from the response body', async () => {
        server().enqueue(errorTurn(429, { error: { code: '1308', message: '已达到 5 小时的使用上限' } }));
        const error = await failure(completeModel(connect('glm-coding-cn', server()), request('glm-5.3')));
        expect(error).toMatchObject({ errorClass: 'quota', code: '1308', retryable: false });
    });

    it('classifies an anthropic 529 as overloaded', async () => {
        server().enqueue(errorTurn(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
        const error = await failure(completeModel(connect('anthropic', server()), request('claude-opus-5-5')));
        expect(error).toMatchObject({ errorClass: 'overloaded', status: 529, retryable: true });
    });

    it('classifies kimi code plan errors', async () => {
        server().enqueue(
            errorTurn(403, { error: { message: 'Your current subscription does not have access to k3.1-pro.' } }),
            errorTurn(429, { error: { message: "You've reached your 5-hour usage limit." } }),
            errorTurn(429, { error: { message: "We're receiving too many requests at the moment." } }),
        );
        const connection = connect('kimi-code-cn', server());
        const classes: string[] = [];
        for (let attempt = 0; attempt < 3; attempt++) {
            classes.push((await failure(completeModel(connection, request('k3.1-pro')))).errorClass);
        }
        expect(classes).toEqual(['permission', 'quota', 'rate_limit']);
    });

    it('recognises an error delivered with a success status', async () => {
        server().enqueue({ status: 200, body: { error: { code: '1214', message: 'messages 参数非法' } } });
        const error = await failure(completeModel(connect('glm-cn', server()), request('glm-5.3')));
        expect(error).toMatchObject({ errorClass: 'invalid_request', code: '1214' });
    });

    it('rejects a non-streamed answer but reads an event stream mislabelled as JSON', async () => {
        server().enqueue({ status: 200, body: { choices: [{ message: { content: 'whole' } }] } });
        expect(
            (await failure(completeModel(connect('deepseek', server()), request('deepseek-flash')))).errorClass,
        ).toBe('invalid_request');
        server().enqueue({ status: 200, body: (openaiText('mislabelled').events ?? []).join('') });
        const done = await completeModel(connect('deepseek', server()), request('deepseek-flash'));
        expect(done.message.content).toEqual([{ type: 'text', text: 'mislabelled' }]);
    });

    it('raises error chunks sent in the middle of an openai stream', async () => {
        server().enqueue({
            events: [
                sseFrame({ choices: [{ index: 0, delta: { content: 'par' } }] }),
                sseFrame({ error: { message: 'Upstream overloaded', code: 503 } }),
            ],
        });
        const error = await failure(completeModel(connect('openrouter', server()), request('some/model')));
        expect(error).toMatchObject({ errorClass: 'overloaded', status: 503 });
    });

    it('reports an unreachable endpoint as a network error', async () => {
        const closed = await startMockModelServer();
        await closed.close();
        const error = await failure(completeModel(connect('deepseek', closed), request('deepseek-flash')));
        expect(error).toMatchObject({ errorClass: 'network', retryable: true });
    });
});

describe('cancellation and idle timeout', () => {
    it('ends with cancelled when the caller aborts mid-stream', async () => {
        server().enqueue({ ...openaiText('a fairly long answer', { chunkSize: 1 }), delayMs: 20 });
        const controller = new AbortController();
        const seen: ModelEvent['type'][] = [];
        const run = (async () => {
            for await (const event of streamModel(connect('deepseek', server()), request('deepseek-flash'), {
                signal: controller.signal,
            })) {
                seen.push(event.type);
                if (event.type === 'text_delta') {
                    controller.abort();
                }
            }
        })();
        const error = await failure(run);
        expect(error).toMatchObject({ errorClass: 'cancelled', retryable: false });
        expect(seen).toContain('text_delta');
        expect(seen).not.toContain('done');
    });

    it('does not send anything when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const error = await failure(
            completeModel(connect('deepseek', server()), request('deepseek-flash'), { signal: controller.signal }),
        );
        expect(error.errorClass).toBe('cancelled');
        expect(server().requests).toHaveLength(0);
    });

    it('times out when no byte arrives for the idle timeout', async () => {
        server().enqueue({ events: openaiText('late').events ?? [], delayMs: 1_000 });
        const error = await failure(
            completeModel(connect('deepseek', server()), request('deepseek-flash'), { idleTimeoutMs: 150 }),
        );
        expect(error).toMatchObject({ errorClass: 'timeout', retryable: true });
    });

    it('times out on a stream that stalls after partial output', async () => {
        const events = openaiText('stalled').events ?? [];
        server().enqueue({ events: events.slice(0, 2), hang: true });
        const error = await failure(
            completeModel(connect('deepseek', server()), request('deepseek-flash'), { idleTimeoutMs: 150 }),
        );
        expect(error.errorClass).toBe('timeout');
    });

    it('keeps waiting while keep-alive comments arrive', async () => {
        // Every gap is well under the idle timeout although the whole response takes longer than it.
        const keepAlive = Array.from({ length: 6 }, () => ': keep-alive\n\n');
        server().enqueue({ events: [...keepAlive, ...(openaiText('queued answer').events ?? [])], delayMs: 60 });
        const started = Date.now();
        const done = await completeModel(connect('deepseek', server()), request('deepseek-flash'), {
            idleTimeoutMs: 300,
        });
        expect(Date.now() - started).toBeGreaterThan(300);
        expect(done.message.content).toEqual([{ type: 'text', text: 'queued answer' }]);
    });

    it('separates firstByteTimeoutMs (headers flushed, slow thinking) from mid-stream idleTimeoutMs', async () => {
        const frames = openaiText('deep thought answer').events ?? [];
        const encoder = new TextEncoder();
        // Simulate a reverse proxy that flushes 200 OK headers immediately, waits 180ms (> 70ms idleTimeoutMs,
        // < 500ms firstByteTimeoutMs) while the reasoning model thinks, then streams fast.
        const slowFirstByteFetch: typeof fetch = async (_input, init) => {
            const signal = init?.signal;
            const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                    await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(resolve, 180);
                        signal?.addEventListener(
                            'abort',
                            () => {
                                clearTimeout(timer);
                                reject(signal.reason ?? new Error('aborted'));
                            },
                            { once: true },
                        );
                    });
                    for (const frame of frames) {
                        controller.enqueue(typeof frame === 'string' ? encoder.encode(frame) : frame);
                    }
                    controller.close();
                },
            });
            return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        };
        const done = await completeModel(connect('deepseek', server()), request('deepseek-flash'), {
            fetch: slowFirstByteFetch,
            firstByteTimeoutMs: 500,
            idleTimeoutMs: 70,
        });
        expect(done.message.content).toEqual([{ type: 'text', text: 'deep thought answer' }]);

        // Once the first body chunk arrives, mid-stream silence aborts at idleTimeoutMs (~70ms), not firstByteTimeoutMs (800ms).
        const stallMidStreamFetch: typeof fetch = async (_input, init) => {
            const signal = init?.signal;
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    const first = frames[0] ?? 'data: {}\n\n';
                    controller.enqueue(typeof first === 'string' ? encoder.encode(first) : first);
                    signal?.addEventListener('abort', () => controller.error(signal.reason ?? new Error('aborted')), {
                        once: true,
                    });
                },
            });
            return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        };
        const started = Date.now();
        const error = await failure(
            completeModel(connect('deepseek', server()), request('deepseek-flash'), {
                fetch: stallMidStreamFetch,
                firstByteTimeoutMs: 800,
                idleTimeoutMs: 70,
            }),
        );
        expect(error).toMatchObject({ errorClass: 'timeout', retryable: true });
        expect(Date.now() - started).toBeLessThan(400);
    });
});

describe('SSE over HTTP', () => {
    it('handles comments, blank lines and chunks split inside UTF-8 sequences and lines', async () => {
        const text = '你好，世界 😀 — done';
        const raw = new TextEncoder().encode((openaiText(text, { reasoning: '先想一想' }).events ?? []).join(''));
        const chunks: Array<string | Uint8Array> = [': keep-alive\n\n', '\n', '\r\n'];
        for (let start = 0; start < raw.length; start += 7) {
            chunks.push(raw.slice(start, start + 7));
        }
        server().enqueue({ events: chunks, delayMs: 1 });
        const done = await completeModel(connect('deepseek', server()), request('deepseek-flash'));
        expect(done.message.content).toEqual([
            { type: 'reasoning', text: '先想一想' },
            { type: 'text', text },
        ]);
    });

    it('stops reading when the consumer stops early', async () => {
        server().enqueue({ ...openaiText('one two three', { chunkSize: 1 }), delayMs: 10 });
        const events: ModelEvent[] = [];
        for await (const event of streamModel(connect('deepseek', server()), request('deepseek-flash'))) {
            events.push(event);
            if (event.type === 'text_delta') {
                break;
            }
        }
        expect(events.map((event) => event.type)).toEqual(['start', 'text_delta']);
        // The connection was released: the next call on the same server works at once.
        server().enqueue(openaiText('again'));
        const done = await collect(streamModel(connect('deepseek', server()), request('deepseek-flash')));
        expect(done[done.length - 1]).toMatchObject({ type: 'done' });
    });
});

describe('MiniMax custom endpoints & relay compatibility', () => {
    it('sanitizes Windows clipboard API keys and sends dual x-api-key + Bearer on custom Anthropic endpoints', async () => {
        expect(sanitizeApiKey('  "Bearer \uFEFFsk-win-key\u200B\r\n" ')).toBe('sk-win-key');

        // Auto-switches custom/MiniMax `/anthropic` base URLs to anthropic_messages wire with dual headers.
        expect(endpointFor({ preset: preset('minimax-cn'), baseUrl: 'https://api.minimaxi.com/anthropic/' })).toEqual({
            wire: 'anthropic_messages',
            baseUrl: 'https://api.minimaxi.com/anthropic',
        });

        server().enqueue(anthropicText('hello from minimax anthropic'));
        const customAnthropic: ProviderConnection = {
            preset: preset('custom-anthropic'),
            apiKey: 'Bearer \uFEFFsk-cp-minimax\r\n',
            baseUrl: server().url,
        };
        const done = await completeModel(customAnthropic, request('MiniMax-M2.7'));
        expect(done.message.content).toEqual([{ type: 'text', text: 'hello from minimax anthropic' }]);
        expect(server().requests[0]?.path).toBe('/v1/messages');
        expect(server().requests[0]?.headers).toMatchObject({
            'x-api-key': 'sk-cp-minimax',
            authorization: 'Bearer sk-cp-minimax',
        });
    });

    it('infers MiniMax quirks (omit temperature/top_p, reasoning_split) for custom MiniMax model IDs', () => {
        const m27 = inferModelInfo('MiniMax-M2.7');
        expect(m27.family).toBe('minimax');
        expect(m27.quirks?.omitParams).toEqual(['temperature', 'top_p']);
        expect(m27.quirks?.extraBody).toEqual({ reasoning_split: true });

        const m3 = inferModelInfo('MiniMax-M3');
        expect(m3.contextWindow).toBe(1_000_000);
        expect(m3.quirks?.omitParams).toEqual(['temperature', 'top_p']);
    });

    it('falls back to /v1/chat/completions on 404 and retries without stream_options on 400', async () => {
        const customOpenAi: ProviderConnection = {
            preset: preset('custom-openai'),
            apiKey: 'relay-key',
            // User omitted `/v1` on a relay / MiniMax host.
            baseUrl: server().url,
        };
        server().enqueue(
            errorTurn(404, { error: { message: 'Not Found' } }),
            errorTurn(400, { error: { message: 'Unsupported parameter: stream_options' } }),
            openaiText('relay ok'),
        );
        const done = await completeModel(customOpenAi, request('MiniMax-M2.7'));
        expect(done.message.content).toEqual([{ type: 'text', text: 'relay ok' }]);
        expect(server().requests[0]?.path).toBe('/chat/completions');
        expect(server().requests[1]?.path).toBe('/v1/chat/completions');
        expect(server().requests[1]?.body).toHaveProperty('stream_options');
        expect(server().requests[2]?.path).toBe('/v1/chat/completions');
        expect(server().requests[2]?.body).not.toHaveProperty('stream_options');
    });

    it('drops unsigned partial reasoning blocks when replaying interrupted Anthropic turns', () => {
        const customAnthropic: ProviderConnection = { preset: preset('custom-anthropic'), baseUrl: 'https://relay/v1' };
        const model = inferModelInfo('claude-sonnet-4-5');
        const body = buildAnthropicBody({
            preset: customAnthropic.preset,
            model,
            quirks: resolveQuirks(customAnthropic.preset, model),
            request: request('claude-sonnet-4-5', {
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'first' }] },
                    {
                        role: 'assistant',
                        provider: 'custom-anthropic',
                        model: 'claude-sonnet-4-5',
                        content: [
                            { type: 'reasoning', text: 'interrupted thinking without signature' },
                            { type: 'text', text: '[Stopped by user]' },
                        ],
                    },
                    { role: 'user', content: [{ type: 'text', text: 'second' }] },
                ],
            }),
        });
        const assistantMsg = (body.messages as Array<{ role: string; content: Array<{ type: string }> }>)[1];
        expect(assistantMsg?.content.map((block) => block.type)).toEqual(['text']);
    });
});
