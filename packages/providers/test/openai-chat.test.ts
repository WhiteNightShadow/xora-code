import { openaiText, openaiToolCalls, sseFrame } from '@xora/test-kit';
import { describe, expect, it } from 'vitest';
import {
    type AssistantPart,
    buildOpenAiChatBody,
    completeModel,
    type Effort,
    findModel,
    type Message,
    type ModelInfo,
    type ModelRequest,
    mapChatUsage,
    type ProviderConnection,
    ProviderError,
    type ProviderPreset,
    resolveQuirks,
    streamModel,
} from '../src/index.ts';
import {
    assistant,
    collect,
    connect,
    preset,
    READ_TOOL,
    request,
    roundTrip,
    sentMessages,
    toolResult,
    useMockServer,
    user,
} from './helpers.ts';

const server = useMockServer();

/** Body the openai adapter would send, without a server round trip. */
function body(connection: ProviderConnection, model: string, overrides: Parameters<typeof request>[1] = {}) {
    const modelRequest = request(model, overrides);
    const info = findModel(connection, model);
    return buildOpenAiChatBody({
        preset: connection.preset,
        model: info,
        quirks: resolveQuirks(connection.preset, info),
        request: modelRequest,
    });
}

const offline = (presetId: string, extraModels?: readonly ModelInfo[]): ProviderConnection => ({
    preset: preset(presetId),
    ...(extraModels ? { extraModels } : {}),
});

const TOOL_CALL: AssistantPart = { type: 'tool_call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' };

/** A conversation whose assistant turn carries recorded reasoning, optionally with a tool round trip. */
function history(provider: string, model: string, withTools: boolean): Message[] {
    const parts: AssistantPart[] = [
        { type: 'reasoning', text: 'I should look.' },
        { type: 'text', text: 'Looking.' },
        ...(withTools ? [TOOL_CALL] : []),
    ];
    return [
        user('what is in a.txt?'),
        assistant(provider, model, parts),
        ...(withTools ? [toolResult('call_1', 'hello')] : []),
        user('and now?'),
    ];
}

function sentAssistant(): Record<string, unknown> {
    const message = sentMessages(server()).find((entry) => entry.role === 'assistant');
    if (message === undefined) {
        throw new Error('no assistant message sent');
    }
    return message;
}

describe('openai chat request mapping', () => {
    it('maps system segments, user parts, assistant tool calls and tool results', async () => {
        server().enqueue(openaiText('ok'));
        const { body: sent } = await roundTrip(
            server(),
            connect('deepseek', server()),
            request('deepseek-flash', {
                system: ['Stable prefix.', '', 'Project rules.'],
                messages: [
                    user('read a.txt'),
                    assistant('deepseek', 'deepseek-flash', [{ type: 'text', text: 'Sure.' }, TOOL_CALL]),
                    toolResult('call_1', 'contents'),
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'and this' },
                            { type: 'image', mimeType: 'image/png', data: 'AAAA' },
                        ],
                    },
                ],
                tools: [READ_TOOL],
                effort: 'off',
            }),
        );
        expect(sent.messages).toEqual([
            { role: 'system', content: 'Stable prefix.\n\nProject rules.' },
            { role: 'user', content: 'read a.txt' },
            {
                role: 'assistant',
                content: 'Sure.',
                tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } },
                ],
            },
            { role: 'tool', tool_call_id: 'call_1', content: 'contents' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'and this' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                ],
            },
        ]);
        expect(sent).toMatchObject({
            model: 'deepseek-flash',
            stream: true,
            stream_options: { include_usage: true },
            tools: [{ type: 'function', function: { name: 'read', parameters: READ_TOOL.parameters } }],
        });
        const recorded = server().requests[0];
        expect(recorded?.path).toBe('/chat/completions');
        expect(recorded?.headers.authorization).toBe('Bearer test-key');
    });

    it('replaces images for text-only models and moves tool-result images into a user message', () => {
        const image = { type: 'image', mimeType: 'image/png', data: 'AAAA' } as const;
        const messages: Message[] = [
            user('look'),
            assistant('deepseek', 'x', [TOOL_CALL]),
            { role: 'tool', toolCallId: 'call_1', toolName: 'read', content: [{ type: 'text', text: 'shot' }, image] },
            { role: 'user', content: [{ type: 'text', text: 'see' }, image] },
        ];
        const textOnly = body(offline('deepseek'), 'deepseek-v4-pro', { messages }).messages;
        expect(textOnly).toEqual([
            { role: 'system', content: 'You are a test.' },
            { role: 'user', content: 'look' },
            expect.objectContaining({ role: 'assistant', content: null }),
            {
                role: 'tool',
                tool_call_id: 'call_1',
                content: 'shot\n\n[image omitted: this model does not accept images]',
            },
            { role: 'user', content: 'see\n\n[image omitted: this model does not accept images]' },
        ]);
        const vision = body(offline('deepseek'), 'deepseek-flash', { messages }).messages as unknown[];
        expect(vision[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'shot' });
        expect(vision[4]).toEqual({
            role: 'user',
            content: [
                { type: 'text', text: 'Images returned by the tool calls above:' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
        });
    });

    it('uses the vendor max tokens field only when a limit is set', () => {
        expect(body(offline('kimi-cn'), 'kimi-k3', { maxOutputTokens: 500 })).toMatchObject({
            max_completion_tokens: 500,
        });
        expect(body(offline('deepseek'), 'deepseek-flash', { maxOutputTokens: 500 })).toMatchObject({
            max_tokens: 500,
        });
        const unset = body(offline('deepseek'), 'deepseek-flash');
        expect(unset).not.toHaveProperty('max_tokens');
        expect(unset).not.toHaveProperty('max_completion_tokens');
    });
});

describe('reasoning echo', () => {
    it('deepseek sends earlier reasoning back once tools are in play', async () => {
        server().enqueue(openaiText('ok'));
        await completeModel(
            connect('deepseek', server()),
            request('deepseek-flash', { messages: history('deepseek', 'deepseek-flash', true), tools: [READ_TOOL] }),
        );
        expect(sentAssistant()).toEqual({
            role: 'assistant',
            content: 'Looking.',
            reasoning_content: 'I should look.',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
        });
    });

    it('deepseek keeps echoing when the history has tool calls but this request has no tools', () => {
        const sent = body(offline('deepseek'), 'deepseek-flash', {
            messages: history('deepseek', 'deepseek-flash', true),
        });
        expect((sent.messages as Array<Record<string, unknown>>)[2]).toHaveProperty(
            'reasoning_content',
            'I should look.',
        );
    });

    it('deepseek strips reasoning when no tools are in play', async () => {
        server().enqueue(openaiText('ok'));
        await completeModel(
            connect('deepseek', server()),
            request('deepseek-flash', { messages: history('deepseek', 'deepseek-flash', false) }),
        );
        expect(sentAssistant()).toEqual({ role: 'assistant', content: 'Looking.' });
    });

    it('kimi always sends the whole assistant message back', async () => {
        server().enqueue(openaiText('ok'));
        await completeModel(
            connect('kimi-cn', server()),
            request('kimi-k3.1-pro', { messages: history('kimi-cn', 'kimi-k3.1-pro', false) }),
        );
        expect(sentAssistant()).toEqual({
            role: 'assistant',
            content: 'Looking.',
            reasoning_content: 'I should look.',
        });
    });

    it('never echoes reasoning to another provider or another model', () => {
        for (const [provider, model] of [
            ['kimi-cn', 'deepseek-flash'],
            ['deepseek', 'deepseek-v4-pro'],
        ] as const) {
            const sent = body(offline('deepseek'), 'deepseek-flash', {
                messages: history(provider, model, true),
                tools: [READ_TOOL],
            });
            expect((sent.messages as Array<Record<string, unknown>>)[2]).not.toHaveProperty('reasoning_content');
        }
    });

    it('never fabricates reasoning that was not recorded', () => {
        const messages: Message[] = [user('q'), assistant('kimi-cn', 'kimi-k3', [{ type: 'text', text: 'a' }])];
        const sent = body(offline('kimi-cn'), 'kimi-k3', { messages });
        expect((sent.messages as unknown[])[2]).toEqual({ role: 'assistant', content: 'a' });
    });

    it('glm preserved thinking echoes reasoning and turns off clear_thinking', () => {
        const sent = body(offline('glm-cn'), 'glm-5.3', { messages: history('glm-cn', 'glm-5.3', false) });
        expect((sent.messages as unknown[])[2]).toMatchObject({ reasoning_content: 'I should look.' });
        expect(sent).toMatchObject({
            thinking: { type: 'enabled', clear_thinking: false },
            reasoning_effort: 'max',
            tool_stream: true,
        });
        // glm returns usage without being asked and does not document stream_options.
        expect(sent).not.toHaveProperty('stream_options');
    });

    it('uses the configured reasoning field in both directions', async () => {
        const relay: ProviderPreset = {
            ...preset('custom-openai'),
            id: 'relay',
            quirks: { reasoningField: 'reasoning', reasoningEcho: 'always' },
        };
        const connection: ProviderConnection = { preset: relay, baseUrl: server().url };
        server().enqueue(openaiText('answer', { reasoning: 'because', reasoningField: 'reasoning' }));
        const done = await completeModel(connection, request('relay-model'));
        expect(done.message.content).toEqual([
            { type: 'reasoning', text: 'because' },
            { type: 'text', text: 'answer' },
        ]);
        server().enqueue(openaiText('ok'));
        await completeModel(connection, request('relay-model', { messages: [user('q'), done.message, user('again')] }));
        expect(sentAssistant()).toEqual({ role: 'assistant', content: 'answer', reasoning: 'because' });
    });
});

describe('thinking and effort', () => {
    const deepseek = (effort?: Effort) =>
        body(offline('deepseek'), 'deepseek-flash', effort === undefined ? {} : { effort });

    it('deepseek toggles thinking and maps effort to the nearest supported level', () => {
        expect(deepseek('high')).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
        expect(deepseek('medium')).toMatchObject({ reasoning_effort: 'high' });
        expect(deepseek('low')).toMatchObject({ reasoning_effort: 'low' });
        expect(deepseek('max')).toMatchObject({ reasoning_effort: 'max' });
        expect(deepseek()).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
        const off = deepseek('off');
        expect(off).toMatchObject({ thinking: { type: 'disabled' } });
        expect(off).not.toHaveProperty('reasoning_effort');
    });

    it('kimi sends only reasoning_effort and runs "off" at the weakest level', () => {
        const off = body(offline('kimi-cn'), 'kimi-k3.1-pro', { effort: 'off' });
        expect(off).toMatchObject({ reasoning_effort: 'low' });
        expect(off).not.toHaveProperty('thinking');
        expect(body(offline('kimi-cn'), 'kimi-k3.1-pro')).toMatchObject({ reasoning_effort: 'max' });
        expect(body(offline('kimi-code-cn'), 'k3.1-pro')).toMatchObject({ reasoning_effort: 'high' });
    });

    it('openai style sends reasoning_effort only, honouring effortMap', () => {
        const model: ModelInfo = {
            id: 'reasoner',
            name: 'Reasoner',
            family: 'openai',
            contextWindow: 200_000,
            maxOutput: 100_000,
            input: ['text'],
            reasoning: { mode: 'toggle', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
            tools: true,
            quirks: { effortMap: { max: 'xhigh' } },
        };
        const connection = offline('openai', [model]);
        expect(body(connection, 'reasoner')).toMatchObject({ reasoning_effort: 'medium' });
        expect(body(connection, 'reasoner', { effort: 'max' })).toMatchObject({ reasoning_effort: 'xhigh' });
        const off = body(connection, 'reasoner', { effort: 'off' });
        expect(off).not.toHaveProperty('reasoning_effort');
        expect(off).not.toHaveProperty('thinking');
    });

    it('sends no thinking fields for models that do not reason', () => {
        const sent = body(offline('deepseek'), 'deepseek-unlisted', { effort: 'high' });
        expect(sent).not.toHaveProperty('thinking');
        expect(sent).not.toHaveProperty('reasoning_effort');
    });
});

describe('sampling whitelist', () => {
    it('kimi never sends temperature or top_p', async () => {
        server().enqueue(openaiText('ok'));
        const { body: sent } = await roundTrip(
            server(),
            connect('kimi-global', server()),
            request('kimi-k3', { temperature: 0.2, topP: 0.5 }),
        );
        expect(sent).not.toHaveProperty('temperature');
        expect(sent).not.toHaveProperty('top_p');
    });

    it('deepseek drops sampling parameters while thinking and keeps them otherwise', () => {
        const thinking = body(offline('deepseek'), 'deepseek-flash', { temperature: 0.2, topP: 0.5 });
        expect(thinking).not.toHaveProperty('temperature');
        expect(thinking).not.toHaveProperty('top_p');
        expect(
            body(offline('deepseek'), 'deepseek-flash', { temperature: 0.2, topP: 0.5, effort: 'off' }),
        ).toMatchObject({ temperature: 0.2, top_p: 0.5 });
    });
});

describe('tool_choice downgrade', () => {
    const choice = (presetId: string, model: string, toolChoice: ModelRequest['toolChoice'], effort?: Effort) =>
        body(offline(presetId), model, { tools: [READ_TOOL], toolChoice, ...(effort ? { effort } : {}) }).tool_choice;

    it('glm only ever receives auto', () => {
        expect(choice('glm-cn', 'glm-5.3', 'required')).toBe('auto');
        expect(choice('glm-cn', 'glm-5.3', { name: 'read' })).toBe('auto');
        expect(choice('glm-global', 'glm-5.3', 'none')).toBe('auto');
    });

    it('deepseek allows only auto and none while thinking', () => {
        expect(choice('deepseek', 'deepseek-flash', 'required')).toBe('auto');
        expect(choice('deepseek', 'deepseek-flash', { name: 'read' })).toBe('auto');
        expect(choice('deepseek', 'deepseek-flash', 'none')).toBe('none');
    });

    it('deepseek keeps forced choices when thinking is off', () => {
        expect(choice('deepseek', 'deepseek-flash', 'required', 'off')).toBe('required');
        expect(choice('deepseek', 'deepseek-flash', { name: 'read' }, 'off')).toEqual({
            type: 'function',
            function: { name: 'read' },
        });
    });

    it('sends no tool_choice without tools', () => {
        expect(body(offline('deepseek'), 'deepseek-flash', { toolChoice: 'auto' })).not.toHaveProperty('tool_choice');
    });
});

describe('openai chat stream', () => {
    it('streams reasoning and text and ends with a done event carrying usage', async () => {
        server().enqueue(
            openaiText('Hello there', {
                reasoning: 'Think first.',
                chunkSize: 4,
                usage: {
                    prompt_tokens: 120,
                    completion_tokens: 30,
                    prompt_cache_hit_tokens: 100,
                    prompt_cache_miss_tokens: 20,
                    completion_tokens_details: { reasoning_tokens: 12 },
                },
            }),
        );
        const events = await collect(streamModel(connect('deepseek', server()), request('deepseek-flash')));
        expect(events[0]).toEqual({ type: 'start', model: 'deepseek-flash' });
        const reasoning = events.flatMap((event) => (event.type === 'reasoning_delta' ? [event.text] : []));
        const text = events.flatMap((event) => (event.type === 'text_delta' ? [event.text] : []));
        expect(reasoning.join('')).toBe('Think first.');
        expect(text.length).toBeGreaterThan(1);
        expect(text.join('')).toBe('Hello there');
        const done = events[events.length - 1];
        expect(done).toMatchObject({
            type: 'done',
            stopReason: 'end_turn',
            rawStopReason: 'stop',
            message: {
                role: 'assistant',
                provider: 'deepseek',
                model: 'deepseek-flash',
                content: [
                    { type: 'reasoning', text: 'Think first.' },
                    { type: 'text', text: 'Hello there' },
                ],
            },
            usage: { inputTokens: 120, cachedTokens: 100, cacheWriteTokens: 0, outputTokens: 30, reasoningTokens: 12 },
        });
        if (done?.type === 'done') {
            expect(done.ttftMs).toBeGreaterThanOrEqual(0);
            expect(done.latencyMs).toBeGreaterThanOrEqual(done.ttftMs ?? 0);
        }
    });

    it('accumulates parallel tool calls by index', async () => {
        const chunk = (delta: object, finish: string | null = null) =>
            sseFrame({
                id: 'c',
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta, finish_reason: finish }],
            });
        server().enqueue({
            events: [
                chunk({ role: 'assistant', content: null }),
                chunk({
                    tool_calls: [
                        { index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '' } },
                    ],
                }),
                chunk({
                    tool_calls: [
                        { index: 1, id: 'call_b', type: 'function', function: { name: 'grep', arguments: '{"pat' } },
                    ],
                }),
                chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
                chunk({ tool_calls: [{ index: 1, function: { arguments: 'tern":"x"}' } }] }),
                chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
                chunk({}, 'tool_calls'),
                sseFrame('[DONE]'),
            ],
        });
        const events = await collect(streamModel(connect('deepseek', server()), request('deepseek-flash')));
        expect(events.filter((event) => event.type === 'tool_call_start')).toEqual([
            { type: 'tool_call_start', index: 0, id: 'call_a', name: 'read' },
            { type: 'tool_call_start', index: 1, id: 'call_b', name: 'grep' },
        ]);
        const deltas = (index: number) =>
            events
                .flatMap((event) => (event.type === 'tool_call_delta' && event.index === index ? [event.delta] : []))
                .join('');
        expect(deltas(0)).toBe('{"path":"a.txt"}');
        expect(deltas(1)).toBe('{"pattern":"x"}');
        expect(events[events.length - 1]).toMatchObject({
            stopReason: 'tool_use',
            message: {
                content: [
                    { type: 'tool_call', id: 'call_a', name: 'read', arguments: '{"path":"a.txt"}' },
                    { type: 'tool_call', id: 'call_b', name: 'grep', arguments: '{"pattern":"x"}' },
                ],
            },
        });
    });

    it('streams tool calls built by the turn helper', async () => {
        server().enqueue(
            openaiToolCalls(
                [
                    { name: 'read', arguments: { path: 'a.txt' } },
                    { name: 'read', arguments: { path: 'b.txt' } },
                ],
                { text: 'Reading both.', chunkSize: 3 },
            ),
        );
        const done = await completeModel(connect('kimi-cn', server()), request('kimi-k3'));
        expect(done.stopReason).toBe('tool_use');
        expect(done.message.content).toEqual([
            { type: 'text', text: 'Reading both.' },
            { type: 'tool_call', id: 'call_mock_0', name: 'read', arguments: '{"path":"a.txt"}' },
            { type: 'tool_call', id: 'call_mock_1', name: 'read', arguments: '{"path":"b.txt"}' },
        ]);
    });

    it('maps finish reasons, including tool calls reported as stop', async () => {
        const cases: Array<[string, string]> = [
            ['length', 'max_tokens'],
            ['content_filter', 'content_filter'],
            ['sensitive', 'content_filter'],
            ['model_context_window_exceeded', 'max_tokens'],
            ['something_new', 'other'],
        ];
        for (const [raw, expected] of cases) {
            server().enqueue(openaiText('x', { finishReason: raw }));
            const done = await completeModel(connect('glm-cn', server()), request('glm-5.3'));
            expect(done).toMatchObject({ stopReason: expected, rawStopReason: raw });
        }
        server().enqueue(openaiToolCalls([{ name: 'read', arguments: '{}' }], { finishReason: 'stop' }));
        expect((await completeModel(connect('glm-cn', server()), request('glm-5.3'))).stopReason).toBe('tool_use');
    });

    it('treats vendor-side break-offs as retryable errors', async () => {
        const cases: Array<[string, string, string]> = [
            ['glm-cn', 'glm-5.3', 'network_error'],
            ['deepseek', 'deepseek-flash', 'insufficient_system_resource'],
        ];
        const classes: string[] = [];
        for (const [presetId, model, reason] of cases) {
            server().enqueue(openaiText('partial', { finishReason: reason }));
            const error = await completeModel(connect(presetId, server()), request(model)).catch((caught) => caught);
            expect(error).toBeInstanceOf(ProviderError);
            expect((error as ProviderError).retryable).toBe(true);
            classes.push((error as ProviderError).errorClass);
        }
        expect(classes).toEqual(['server', 'overloaded']);
    });

    it('reports a stream that closes before finishing as a network error', async () => {
        server().enqueue({ events: [sseFrame({ choices: [{ index: 0, delta: { content: 'cut' } }] })] });
        const error = await completeModel(connect('deepseek', server()), request('deepseek-flash')).catch(
            (caught) => caught,
        );
        expect(error).toMatchObject({ errorClass: 'network', retryable: true });
    });

    it('accepts a finished stream without [DONE]', async () => {
        server().enqueue({
            events: [
                sseFrame({ choices: [{ index: 0, delta: { content: 'fine' } }] }),
                sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
            ],
        });
        const done = await completeModel(connect('deepseek', server()), request('deepseek-flash'));
        expect(done.message.content).toEqual([{ type: 'text', text: 'fine' }]);
        expect(done).not.toHaveProperty('usage');
    });
});

describe('usage mapping', () => {
    it('maps every openai-compatible vendor layout, cached tokens included in the input', () => {
        // openai
        expect(
            mapChatUsage({
                prompt_tokens: 100,
                completion_tokens: 50,
                prompt_tokens_details: { cached_tokens: 40 },
                completion_tokens_details: { reasoning_tokens: 20 },
            }),
        ).toEqual({ inputTokens: 100, cachedTokens: 40, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 20 });
        // deepseek, also without prompt_tokens
        expect(
            mapChatUsage({ completion_tokens: 9, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }),
        ).toEqual({ inputTokens: 100, cachedTokens: 60, cacheWriteTokens: 0, outputTokens: 9, reasoningTokens: 0 });
        // kimi: cached tokens at the top level and in the details, cache writes in the details
        expect(
            mapChatUsage({
                prompt_tokens: 100,
                completion_tokens: 10,
                cached_tokens: 30,
                prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 50 },
            }),
        ).toEqual({ inputTokens: 100, cachedTokens: 30, cacheWriteTokens: 50, outputTokens: 10, reasoningTokens: 0 });
        expect(mapChatUsage({ prompt_tokens: 80, completion_tokens: 1, cached_tokens: 64 })).toMatchObject({
            cachedTokens: 64,
        });
        // glm
        expect(
            mapChatUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 70 } }),
        ).toEqual({ inputTokens: 100, cachedTokens: 70, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0 });
    });

    it('reads usage from the final chunk with empty choices', async () => {
        server().enqueue(
            openaiText('ok', {
                usage: {
                    prompt_tokens: 50,
                    completion_tokens: 5,
                    prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 40 },
                },
            }),
        );
        const done = await completeModel(connect('kimi-cn', server()), request('kimi-k3'));
        expect(done.usage).toEqual({
            inputTokens: 50,
            cachedTokens: 10,
            cacheWriteTokens: 40,
            outputTokens: 5,
            reasoningTokens: 0,
        });
    });
});
