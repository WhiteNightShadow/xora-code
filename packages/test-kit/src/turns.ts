import type { MockTurn } from './mock-model-server.ts';

/** One SSE frame: optional `event:` line, a `data:` line and the blank line that ends the event. */
export function sseFrame(data: unknown, event?: string): string {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    return `${event ? `event: ${event}\n` : ''}data: ${payload}\n\n`;
}

/** Splits text into pieces of at most `size` characters (at least one piece). */
function pieces(text: string, size: number | undefined): string[] {
    if (!size || size <= 0 || text.length <= size) {
        return [text];
    }
    const out: string[] = [];
    for (let start = 0; start < text.length; start += size) {
        out.push(text.slice(start, start + size));
    }
    return out;
}

interface TurnOptions {
    readonly model?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly delayMs?: number;
    /** Splits text, reasoning and tool arguments into deltas of this many characters. */
    readonly chunkSize?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// openai chat completions

export interface OpenAiTurnOptions extends TurnOptions {
    readonly reasoning?: string;
    /** Delta field carrying reasoning; defaults to `reasoning_content`. */
    readonly reasoningField?: string;
    /** Raw vendor usage object sent in a final chunk with empty `choices`. */
    readonly usage?: Readonly<Record<string, unknown>>;
    readonly finishReason?: string;
}

export interface OpenAiToolCall {
    readonly name: string;
    /** JSON text, or a value that is serialised. */
    readonly arguments: string | object;
    readonly id?: string;
}

function chatChunk(model: string, delta: Record<string, unknown>, finishReason: string | null = null) {
    return {
        id: 'chatcmpl-mock',
        object: 'chat.completion.chunk',
        created: 0,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
}

function openAiTurn(
    options: OpenAiTurnOptions,
    text: string | undefined,
    calls: readonly OpenAiToolCall[],
    finishReason: string,
): MockTurn {
    const model = options.model ?? 'mock-model';
    const field = options.reasoningField ?? 'reasoning_content';
    const events: string[] = [sseFrame(chatChunk(model, { role: 'assistant', content: '' }))];
    if (options.reasoning) {
        for (const piece of pieces(options.reasoning, options.chunkSize)) {
            events.push(sseFrame(chatChunk(model, { [field]: piece })));
        }
    }
    if (text) {
        for (const piece of pieces(text, options.chunkSize)) {
            events.push(sseFrame(chatChunk(model, { content: piece })));
        }
    }
    calls.forEach((call, index) => {
        const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
        const id = call.id ?? `call_mock_${index}`;
        events.push(
            sseFrame(
                chatChunk(model, {
                    tool_calls: [{ index, id, type: 'function', function: { name: call.name, arguments: '' } }],
                }),
            ),
        );
        for (const piece of pieces(args, options.chunkSize)) {
            events.push(sseFrame(chatChunk(model, { tool_calls: [{ index, function: { arguments: piece } }] })));
        }
    });
    events.push(sseFrame(chatChunk(model, {}, options.finishReason ?? finishReason)));
    if (options.usage) {
        events.push(
            sseFrame({
                id: 'chatcmpl-mock',
                object: 'chat.completion.chunk',
                model,
                choices: [],
                usage: options.usage,
            }),
        );
    }
    events.push(sseFrame('[DONE]'));
    return {
        events,
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.delayMs ? { delayMs: options.delayMs } : {}),
    };
}

/** A streamed chat completion that answers with text, optionally after reasoning. */
export function openaiText(text: string, options: OpenAiTurnOptions = {}): MockTurn {
    return openAiTurn(options, text, [], 'stop');
}

/** A streamed chat completion that ends in tool calls; arguments are streamed in pieces. */
export function openaiToolCalls(
    calls: readonly OpenAiToolCall[],
    options: OpenAiTurnOptions & { readonly text?: string } = {},
): MockTurn {
    return openAiTurn(options, options.text, calls, 'tool_calls');
}

// ---------------------------------------------------------------------------------------------------------------
// anthropic messages

export interface AnthropicTurnOptions extends TurnOptions {
    readonly thinking?: string;
    readonly signature?: string;
    /** Adds a `redacted_thinking` block with this data before any other block. */
    readonly redactedThinking?: string;
    /** Raw anthropic usage; `output_tokens` goes into `message_delta`, the rest into `message_start`. */
    readonly usage?: Readonly<Record<string, number>>;
    readonly stopReason?: string;
}

export interface AnthropicToolUse {
    readonly name: string;
    /** Input object, or raw JSON text streamed as is. */
    readonly input: string | object;
    readonly id?: string;
}

function anthropicTurn(
    options: AnthropicTurnOptions,
    text: string | undefined,
    tools: readonly AnthropicToolUse[],
    stopReason: string,
): MockTurn {
    const model = options.model ?? 'mock-model';
    const { output_tokens: outputTokens = 1, ...inputUsage } = options.usage ?? { input_tokens: 1 };
    const events: string[] = [
        sseFrame(
            {
                type: 'message_start',
                message: {
                    id: 'msg_mock',
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { ...inputUsage, output_tokens: 1 },
                },
            },
            'message_start',
        ),
        sseFrame({ type: 'ping' }, 'ping'),
    ];
    let index = 0;
    const block = (start: object, deltas: readonly object[]): void => {
        events.push(sseFrame({ type: 'content_block_start', index, content_block: start }, 'content_block_start'));
        for (const delta of deltas) {
            events.push(sseFrame({ type: 'content_block_delta', index, delta }, 'content_block_delta'));
        }
        events.push(sseFrame({ type: 'content_block_stop', index }, 'content_block_stop'));
        index++;
    };
    if (options.redactedThinking !== undefined) {
        block({ type: 'redacted_thinking', data: options.redactedThinking }, []);
    }
    if (options.thinking !== undefined) {
        block({ type: 'thinking', thinking: '', signature: '' }, [
            ...pieces(options.thinking, options.chunkSize).map((piece) => ({
                type: 'thinking_delta',
                thinking: piece,
            })),
            ...(options.signature !== undefined ? [{ type: 'signature_delta', signature: options.signature }] : []),
        ]);
    }
    if (text) {
        block(
            { type: 'text', text: '' },
            pieces(text, options.chunkSize).map((piece) => ({ type: 'text_delta', text: piece })),
        );
    }
    tools.forEach((tool, position) => {
        const json = typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input);
        block(
            { type: 'tool_use', id: tool.id ?? `toolu_mock_${position}`, name: tool.name, input: {} },
            pieces(json, options.chunkSize).map((piece) => ({ type: 'input_json_delta', partial_json: piece })),
        );
    });
    events.push(
        sseFrame(
            {
                type: 'message_delta',
                delta: { stop_reason: options.stopReason ?? stopReason, stop_sequence: null },
                usage: { output_tokens: outputTokens },
            },
            'message_delta',
        ),
        sseFrame({ type: 'message_stop' }, 'message_stop'),
    );
    return {
        events,
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.delayMs ? { delayMs: options.delayMs } : {}),
    };
}

/** A streamed anthropic message that answers with text, optionally after a thinking block. */
export function anthropicText(text: string, options: AnthropicTurnOptions = {}): MockTurn {
    return anthropicTurn(options, text, [], 'end_turn');
}

/** A streamed anthropic message that ends in `tool_use` blocks; input JSON is streamed in pieces. */
export function anthropicToolUse(
    tools: readonly AnthropicToolUse[],
    options: AnthropicTurnOptions & { readonly text?: string } = {},
): MockTurn {
    return anthropicTurn(options, options.text, tools, 'tool_use');
}

// ---------------------------------------------------------------------------------------------------------------
// errors

/** A non-streamed error response; objects are JSON-encoded, strings sent verbatim. */
export function errorTurn(status: number, body: unknown, headers?: Readonly<Record<string, string>>): MockTurn {
    return { status, body, ...(headers ? { headers } : {}) };
}
