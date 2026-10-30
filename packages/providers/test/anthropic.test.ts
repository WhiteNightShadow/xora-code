import { anthropicText, anthropicToolUse, sseFrame } from '@xora/test-kit';
import { describe, expect, it } from 'vitest';
import {
    buildAnthropicBody,
    completeModel,
    type Effort,
    findModel,
    type Message,
    type ModelInfo,
    type ModelRequest,
    mapAnthropicUsage,
    type ProviderConnection,
    ProviderError,
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
    toolResult,
    useMockServer,
    user,
} from './helpers.ts';

const server = useMockServer();
const EPHEMERAL = { type: 'ephemeral' };

function body(connection: ProviderConnection, modelRequest: ModelRequest) {
    const info = findModel(connection, modelRequest.model);
    return buildAnthropicBody({
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

function countBreakpoints(value: unknown): number {
    return JSON.stringify(value).split('"cache_control"').length - 1;
}

describe('anthropic request mapping', () => {
    it('sends protocol headers, system blocks, tools and a default max_tokens', async () => {
        server().enqueue(anthropicText('ok'));
        const { body: sent } = await roundTrip(
            server(),
            connect('anthropic', server()),
            request('claude-opus-5-5', { system: ['Stable.', 'Project.'], tools: [READ_TOOL] }),
        );
        const recorded = server().requests[0];
        expect(recorded?.path).toBe('/v1/messages');
        expect(recorded?.headers).toMatchObject({
            'x-api-key': 'test-key',
            'anthropic-version': '2023-06-01',
            'user-agent': 'XoraCode',
        });
        expect(recorded?.headers).not.toHaveProperty('authorization');
        expect(sent).toEqual({
            model: 'claude-opus-5-5',
            max_tokens: 32_000,
            system: [
                { type: 'text', text: 'Stable.' },
                { type: 'text', text: 'Project.', cache_control: EPHEMERAL },
            ],
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: EPHEMERAL }] }],
            tools: [
                {
                    name: 'read',
                    description: 'Read a file',
                    input_schema: READ_TOOL.parameters,
                    eager_input_streaming: true,
                },
            ],
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: 'medium' },
            stream: true,
        });
    });

    it('merges consecutive tool results and the next user turn into one user message', () => {
        const messages: Message[] = [
            user('read both'),
            assistant('anthropic', 'claude-opus-5-5', [
                { type: 'text', text: 'Reading.' },
                { type: 'tool_call', id: 'toolu_a', name: 'read', arguments: '{"path":"a.txt"}' },
                { type: 'tool_call', id: 'toolu_b', name: 'read', arguments: 'not json' },
            ]),
            toolResult('toolu_a', 'one'),
            toolResult('toolu_b', 'missing', true),
            user('continue'),
        ];
        const sent = body(offline('anthropic'), request('claude-opus-5-5', { messages }));
        expect(sent.messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'read both' }] },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Reading.' },
                    { type: 'tool_use', id: 'toolu_a', name: 'read', input: { path: 'a.txt' } },
                    { type: 'tool_use', id: 'toolu_b', name: 'read', input: {} },
                ],
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_a',
                        content: [{ type: 'text', text: 'one' }],
                        is_error: false,
                    },
                    {
                        type: 'tool_result',
                        tool_use_id: 'toolu_b',
                        content: [{ type: 'text', text: 'missing' }],
                        is_error: true,
                    },
                    { type: 'text', text: 'continue', cache_control: EPHEMERAL },
                ],
            },
        ]);
    });

    it('places at most two cache breakpoints: after the stable prefix and on the newest user turn', () => {
        const messages: Message[] = [
            user('one'),
            assistant('anthropic', 'claude-opus-5-5', [{ type: 'text', text: 'a' }]),
            user('two'),
        ];
        const withSystem = body(offline('anthropic'), request('claude-opus-5-5', { messages, tools: [READ_TOOL] }));
        expect(countBreakpoints(withSystem)).toBe(2);
        expect((withSystem.tools as unknown[])[0]).not.toHaveProperty('cache_control');
        expect((withSystem.messages as Array<{ content: unknown[] }>)[0]?.content[0]).not.toHaveProperty(
            'cache_control',
        );

        const noSystem = body(offline('anthropic'), request('claude-opus-5-5', { system: [], tools: [READ_TOOL] }));
        expect((noSystem.tools as unknown[])[0]).toMatchObject({ cache_control: EPHEMERAL });
        expect(countBreakpoints(noSystem)).toBe(2);

        // deepseek's anthropic endpoint ignores cache_control, so its preset does not ask for breakpoints.
        const deepseek = body(
            { ...offline('deepseek'), wire: 'anthropic_messages' },
            request('deepseek-flash', { messages, tools: [READ_TOOL] }),
        );
        expect(countBreakpoints(deepseek)).toBe(0);
    });

    it('maps tool_choice and drops forced choices the model rejects', () => {
        const choice = (model: string, toolChoice: ModelRequest['toolChoice']) =>
            body(offline('anthropic'), request(model, { tools: [READ_TOOL], toolChoice })).tool_choice;
        expect(choice('claude-opus-5-5', 'required')).toEqual({ type: 'auto' });
        expect(choice('claude-opus-5-5', { name: 'read' })).toEqual({ type: 'auto' });
        expect(choice('claude-opus-5-5', 'none')).toEqual({ type: 'none' });
        expect(choice('claude-haiku-5-5', 'required')).toEqual({ type: 'any' });
        expect(choice('claude-haiku-5-5', { name: 'read' })).toEqual({ type: 'tool', name: 'read' });
    });

    it('never sends sampling parameters to current Claude models', () => {
        const sent = body(offline('anthropic'), request('claude-sonnet-5-5', { temperature: 0.3, topP: 0.9 }));
        expect(sent).not.toHaveProperty('temperature');
        expect(sent).not.toHaveProperty('top_p');
    });
});

describe('anthropic thinking', () => {
    const thinking = (model: string, effort?: Effort, connection = offline('anthropic')) => {
        const sent = body(connection, request(model, effort === undefined ? {} : { effort }));
        return { thinking: sent.thinking, output_config: sent.output_config };
    };

    it('uses adaptive thinking with summarized display and the model default effort', () => {
        expect(thinking('claude-sonnet-5-5')).toEqual({
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: 'high' },
        });
        expect(thinking('claude-opus-5-5', 'max')).toMatchObject({ output_config: { effort: 'max' } });
    });

    it('expresses "off" the way each model allows', () => {
        // opus 5.5 and fable 5.1 cannot disable thinking: lowest effort instead.
        expect(thinking('claude-opus-5-5', 'off')).toEqual({
            thinking: { type: 'adaptive', display: 'summarized' },
            output_config: { effort: 'low' },
        });
        expect(thinking('claude-fable-5-1', 'off')).toMatchObject({ output_config: { effort: 'low' } });
        // sonnet 5.5: between_tools with no other field and no effort above its ceiling.
        expect(thinking('claude-sonnet-5-5', 'off')).toEqual({
            thinking: { type: 'between_tools' },
            output_config: undefined,
        });
        expect(thinking('claude-haiku-5-5', 'off')).toEqual({
            thinking: { type: 'disabled' },
            output_config: undefined,
        });
    });

    it('gives legacy models a thinking budget below max_tokens', () => {
        const legacy: ModelInfo = {
            id: 'claude-legacy',
            name: 'Legacy',
            family: 'claude',
            contextWindow: 200_000,
            maxOutput: 64_000,
            input: ['text'],
            reasoning: { mode: 'toggle', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'off' },
            tools: true,
            quirks: { thinking: { kind: 'anthropic_budget' }, effortMap: { max: '40000' } },
        };
        const connection = offline('anthropic', [legacy]);
        const sent = (overrides: Partial<ModelRequest>) => body(connection, request('claude-legacy', overrides));
        expect(sent({ effort: 'high' }).thinking).toEqual({ type: 'enabled', budget_tokens: 16_384 });
        expect(sent({ effort: 'max', maxOutputTokens: 50_000 }).thinking).toEqual({
            type: 'enabled',
            budget_tokens: 40_000,
        });
        expect(sent({ effort: 'high', maxOutputTokens: 1_500 }).thinking).toEqual({
            type: 'enabled',
            budget_tokens: 1_499,
        });
        expect(sent({ effort: 'high', maxOutputTokens: 1_000 })).not.toHaveProperty('thinking');
        expect(sent({})).not.toHaveProperty('thinking');
        expect(sent({ effort: 'high' })).not.toHaveProperty('output_config');
    });

    it('translates openai-style vendors on their anthropic endpoints', () => {
        const deepseek = { ...offline('deepseek'), wire: 'anthropic_messages' as const };
        expect(thinking('deepseek-flash', 'max', deepseek)).toEqual({
            thinking: { type: 'enabled' },
            output_config: { effort: 'max' },
        });
        expect(thinking('deepseek-flash', 'off', deepseek)).toEqual({
            thinking: { type: 'disabled' },
            output_config: undefined,
        });
    });
});

describe('anthropic thinking round trip', () => {
    it('streams thinking with its signature and replays it unchanged to the same model only', async () => {
        server().enqueue(
            anthropicToolUse([{ name: 'read', input: { path: 'a.txt' }, id: 'toolu_1' }], {
                thinking: 'Let me check the file.',
                signature: 'sig-abc',
                text: 'Checking.',
                chunkSize: 5,
                usage: {
                    input_tokens: 10,
                    cache_read_input_tokens: 80,
                    cache_creation_input_tokens: 5,
                    output_tokens: 20,
                },
            }),
        );
        const connection = connect('anthropic', server());
        const first = request('claude-opus-5-5', { tools: [READ_TOOL] });
        const events = await collect(streamModel(connection, first));
        expect(events.filter((event) => event.type === 'tool_call_start')).toEqual([
            { type: 'tool_call_start', index: 0, id: 'toolu_1', name: 'read' },
        ]);
        expect(events.flatMap((event) => (event.type === 'reasoning_delta' ? [event.text] : [])).join('')).toBe(
            'Let me check the file.',
        );
        const done = events[events.length - 1];
        if (done?.type !== 'done') {
            throw new Error('missing done event');
        }
        expect(done).toMatchObject({
            stopReason: 'tool_use',
            rawStopReason: 'tool_use',
            usage: { inputTokens: 95, cachedTokens: 80, cacheWriteTokens: 5, outputTokens: 20, reasoningTokens: 0 },
        });
        expect(done.message).toEqual({
            role: 'assistant',
            provider: 'anthropic',
            model: 'claude-opus-5-5',
            content: [
                { type: 'reasoning', text: 'Let me check the file.', signature: 'sig-abc' },
                { type: 'text', text: 'Checking.' },
                { type: 'tool_call', id: 'toolu_1', name: 'read', arguments: '{"path":"a.txt"}' },
            ],
        });

        const followUp = [user('hi'), done.message, toolResult('toolu_1', 'hello')];
        server().enqueue(anthropicText('It says hello.'));
        const { body: sent } = await roundTrip(
            server(),
            connection,
            request('claude-opus-5-5', { messages: followUp, tools: [READ_TOOL] }),
        );
        expect((sent.messages as Array<{ content: unknown[] }>)[1]?.content).toEqual([
            { type: 'thinking', thinking: 'Let me check the file.', signature: 'sig-abc' },
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'a.txt' } },
        ]);

        const otherModel = body(offline('anthropic'), request('claude-sonnet-5-5', { messages: followUp }));
        expect(
            (otherModel.messages as Array<{ content: Array<{ type: string }> }>)[1]?.content.map((block) => block.type),
        ).toEqual(['text', 'tool_use']);
    });

    it('keeps redacted thinking and sends it back as is', async () => {
        server().enqueue(anthropicText('Done.', { redactedThinking: 'opaque-data', thinking: '', signature: 'sig-x' }));
        const connection = connect('anthropic', server());
        const done = await completeModel(connection, request('claude-sonnet-5-5'));
        expect(done.message.content).toEqual([
            { type: 'reasoning', text: '', redacted: 'opaque-data' },
            { type: 'reasoning', text: '', signature: 'sig-x' },
            { type: 'text', text: 'Done.' },
        ]);
        const sent = body(
            offline('anthropic'),
            request('claude-sonnet-5-5', { messages: [user('a'), done.message, user('b')] }),
        );
        expect((sent.messages as Array<{ content: unknown[] }>)[1]?.content).toEqual([
            { type: 'redacted_thinking', data: 'opaque-data' },
            { type: 'thinking', thinking: '', signature: 'sig-x' },
            { type: 'text', text: 'Done.' },
        ]);
    });
});

describe('anthropic stream', () => {
    it('maps stop reasons', async () => {
        const cases: Array<[string, string]> = [
            ['end_turn', 'end_turn'],
            ['stop_sequence', 'end_turn'],
            ['max_tokens', 'max_tokens'],
            ['refusal', 'refusal'],
            ['pause_turn', 'pause'],
            ['model_context_window_exceeded', 'max_tokens'],
        ];
        for (const [raw, expected] of cases) {
            server().enqueue(anthropicText('x', { stopReason: raw }));
            const done = await completeModel(connect('anthropic', server()), request('claude-haiku-5-5'));
            expect(done).toMatchObject({ stopReason: expected, rawStopReason: raw });
        }
    });

    it('raises a mid-stream error event as a ProviderError', async () => {
        const start = anthropicText('partial').events?.slice(0, 2) ?? [];
        server().enqueue({
            events: [
                ...start,
                sseFrame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'),
            ],
        });
        const error = await completeModel(connect('anthropic', server()), request('claude-opus-5-5')).catch(
            (caught) => caught,
        );
        expect(error).toBeInstanceOf(ProviderError);
        expect(error).toMatchObject({
            errorClass: 'overloaded',
            code: 'overloaded_error',
            retryable: true,
            message: 'Overloaded',
        });
    });

    it('reports a stream that ends before message_stop as a network error', async () => {
        const events = anthropicText('cut short').events ?? [];
        server().enqueue({ events: events.slice(0, 5) });
        const error = await completeModel(connect('anthropic', server()), request('claude-opus-5-5')).catch(
            (caught) => caught,
        );
        expect(error).toMatchObject({ errorClass: 'network' });
    });

    it('maps usage with cache reads and writes included in the input', () => {
        expect(
            mapAnthropicUsage({
                input_tokens: 3,
                cache_read_input_tokens: 1000,
                cache_creation_input_tokens: 200,
                output_tokens: 50,
            }),
        ).toEqual({
            inputTokens: 1203,
            cachedTokens: 1000,
            cacheWriteTokens: 200,
            outputTokens: 50,
            reasoningTokens: 0,
        });
    });
});
