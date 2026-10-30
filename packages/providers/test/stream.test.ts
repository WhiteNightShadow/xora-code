import { errorTurn, openaiText, sseFrame, startMockModelServer } from '@xora/test-kit';
import { describe, expect, it } from 'vitest';
import {
    completeModel,
    type ModelEvent,
    type ProviderConnection,
    ProviderError,
    type ProviderPreset,
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
