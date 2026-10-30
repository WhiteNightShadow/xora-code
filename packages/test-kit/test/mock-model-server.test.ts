import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    anthropicText,
    errorTurn,
    type MockModelServer,
    openaiText,
    openaiToolCalls,
    sseFrame,
    startMockModelServer,
} from '../src/index.ts';

let server: MockModelServer;

beforeAll(async () => {
    server = await startMockModelServer({
        models: [{ id: 'a' }, { id: 'b' }, { id: 'c', displayName: 'Model C', maxInputTokens: 1000, maxTokens: 10 }],
        modelsPageSize: 2,
    });
});

afterEach(() => server.reset());

afterAll(async () => {
    await server.close();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

describe('startMockModelServer', () => {
    it('serves queued turns in order and records requests', async () => {
        server.enqueue(
            openaiText('first'),
            errorTurn(429, { error: { message: 'slow down' } }, { 'retry-after': '2' }),
        );
        const first = await post('/v1/chat/completions?x=1', { model: 'm' }, { Authorization: 'Bearer k' });
        expect(first.headers.get('content-type')).toContain('text/event-stream');
        const text = await first.text();
        expect(text).toContain('"content":"first"');
        expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
        const second = await post('/chat/completions', { model: 'm' });
        expect(second.status).toBe(429);
        expect(second.headers.get('retry-after')).toBe('2');
        expect(await second.json()).toEqual({ error: { message: 'slow down' } });
        expect(server.requests.map((request) => request.path)).toEqual(['/v1/chat/completions', '/chat/completions']);
        expect(server.requests[0]).toMatchObject({
            method: 'POST',
            query: { x: '1' },
            body: { model: 'm' },
            headers: { authorization: 'Bearer k' },
        });
        expect(server.pending).toBe(0);
    });

    it('fails loudly when nothing is queued', async () => {
        const response = await post('/v1/messages', {});
        expect(response.status).toBe(500);
    });

    it('lets a responder answer from the request content', async () => {
        server.respondWith((request) =>
            (request.body as { model?: string }).model === 'b' ? anthropicText('from b') : undefined,
        );
        server.enqueue(anthropicText('from queue'));
        expect(await (await post('/v1/messages', { model: 'b' })).text()).toContain('from b');
        expect(await (await post('/v1/messages', { model: 'a' })).text()).toContain('from queue');
    });

    it('writes raw chunks verbatim, including split bytes', async () => {
        const bytes = new TextEncoder().encode(sseFrame({ text: '你好' }));
        server.enqueue({ events: [': keep-alive\n\n', bytes.slice(0, 15), bytes.slice(15)], delayMs: 5 });
        const text = await (await post('/chat/completions', {})).text();
        expect(text).toBe(`: keep-alive\n\n${sseFrame({ text: '你好' })}`);
    });

    it('streams tool call arguments in pieces', async () => {
        server.enqueue(openaiToolCalls([{ name: 'read', arguments: { path: 'a.txt' } }], { chunkSize: 4 }));
        const text = await (await post('/chat/completions', {})).text();
        expect(text).toContain('"finish_reason":"tool_calls"');
        expect(text.match(/"arguments"/g)?.length).toBeGreaterThan(3);
    });

    it('lists models in openai shape and in paginated anthropic shape', async () => {
        const openai = (await (await fetch(`${server.url}/v1/models`)).json()) as { data: { id: string }[] };
        expect(openai.data.map((model) => model.id)).toEqual(['a', 'b', 'c']);
        const headers = { 'anthropic-version': '2023-06-01' };
        const page1 = await (await fetch(`${server.url}/v1/models?limit=100`, { headers })).json();
        expect(page1).toMatchObject({ has_more: true, last_id: 'b' });
        const page2 = await (await fetch(`${server.url}/v1/models?limit=100&after_id=b`, { headers })).json();
        expect(page2).toMatchObject({
            has_more: false,
            data: [{ id: 'c', display_name: 'Model C', max_input_tokens: 1000, max_tokens: 10 }],
        });
    });
});
