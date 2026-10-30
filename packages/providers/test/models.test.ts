import { anthropicText, errorTurn, openaiText } from '@xora/test-kit';
import { describe, expect, it } from 'vitest';
import { compareModels, listModels, ProviderError, testConnection } from '../src/index.ts';
import { connect, preset, useMockServer } from './helpers.ts';

const server = useMockServer({
    models: [
        { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', maxInputTokens: 1_000_000, maxTokens: 128_000 },
        { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
        { id: 'claude-haiku-5-5' },
        { id: 'claude-new-6' },
        { id: 'claude-new-7' },
    ],
    modelsPageSize: 2,
});

describe('listModels', () => {
    it('reads the openai-style model list', async () => {
        const models = await listModels(connect('deepseek', server()));
        expect(models.map((model) => model.id)).toEqual([
            'claude-opus-5-5',
            'claude-sonnet-5-5',
            'claude-haiku-5-5',
            'claude-new-6',
            'claude-new-7',
        ]);
        expect(server().requests[0]).toMatchObject({
            method: 'GET',
            path: '/models',
            headers: { authorization: 'Bearer test-key', 'user-agent': 'XoraCode' },
        });
    });

    it('follows anthropic pagination', async () => {
        const models = await listModels(connect('anthropic', server()), { userAgent: 'XoraCode/1.0.0' });
        expect(models).toEqual([
            { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutput: 128_000 },
            { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
            { id: 'claude-haiku-5-5', name: 'claude-haiku-5-5' },
            { id: 'claude-new-6', name: 'claude-new-6' },
            { id: 'claude-new-7', name: 'claude-new-7' },
        ]);
        const requests = server().requests;
        expect(requests.map((request) => request.query.after_id)).toEqual([
            undefined,
            'claude-sonnet-5-5',
            'claude-new-6',
        ]);
        expect(requests[0]?.headers).toMatchObject({
            'x-api-key': 'test-key',
            'anthropic-version': '2023-06-01',
            'user-agent': 'XoraCode/1.0.0',
        });
    });

    it('classifies listing failures', async () => {
        server().respondWith(() => errorTurn(401, { error: { message: 'Invalid Authentication' } }));
        const error = await listModels(connect('kimi-cn', server())).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({ errorClass: 'auth', status: 401 });
    });
});

describe('compareModels', () => {
    it('finds catalog ids the endpoint does not serve and listed models the catalog does not know', () => {
        const connection = { preset: preset('kimi-code-cn') };
        const result = compareModels(connection, [{ id: 'k3' }, { id: 'kimi-for-coding' }]);
        expect(result).toEqual({ missing: ['k3.1-pro'], unknown: [{ id: 'kimi-for-coding' }] });
    });
});

describe('testConnection', () => {
    it('sends one minimal request at the weakest effort', async () => {
        server().enqueue(openaiText('pong', { usage: { prompt_tokens: 5, completion_tokens: 1 } }));
        const result = await testConnection(connect('kimi-cn', server()), 'kimi-k3.1-pro');
        expect(result).toMatchObject({
            ok: true,
            model: 'kimi-k3.1-pro',
            usage: { inputTokens: 5, outputTokens: 1 },
        });
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        expect(result.ttftMs).toBeGreaterThanOrEqual(0);
        expect(server().requests[0]?.body).toMatchObject({
            model: 'kimi-k3.1-pro',
            messages: [{ role: 'user', content: 'ping' }],
            max_completion_tokens: 16,
            reasoning_effort: 'low',
        });
    });

    it('turns thinking off where the model allows it', async () => {
        server().enqueue(openaiText('pong'), anthropicText('pong'));
        await testConnection(connect('deepseek', server()), 'deepseek-flash');
        await testConnection(connect('anthropic', server()), 'claude-sonnet-5-5');
        const [deepseek, sonnet] = server().requests;
        expect(deepseek?.body).toMatchObject({ thinking: { type: 'disabled' }, max_tokens: 16 });
        expect(sonnet?.body).toMatchObject({ thinking: { type: 'between_tools' }, max_tokens: 16 });
    });

    it('reports failures instead of throwing', async () => {
        server().enqueue(
            errorTurn(401, { error: { message: 'Incorrect API key provided', type: 'incorrect_api_key_error' } }),
        );
        const result = await testConnection(connect('kimi-global', server()), 'kimi-k3');
        expect(result).toMatchObject({
            ok: false,
            model: 'kimi-k3',
            error: { errorClass: 'auth', message: 'Incorrect API key provided' },
        });
    });
});
