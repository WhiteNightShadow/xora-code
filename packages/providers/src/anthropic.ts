import { omitParams, planThinking, planToolChoice, type ThinkingPlan } from './effort.ts';
import { classifyError } from './errors.ts';
import { asNumber, asString, isRecord, type JsonObject, parseJson } from './json.ts';
import type { SseEvent } from './sse.ts';
import type {
    AssistantMessage,
    AssistantPart,
    ModelEvent,
    ModelInfo,
    Quirks,
    StopReason,
    ToolResultMessage,
    Usage,
    UserPart,
} from './types.ts';
import { type Clock, IMAGE_OMITTED, parseArguments, truncatedStream, type WireContext } from './wire.ts';

const EPHEMERAL = { type: 'ephemeral' } as const;
/** Thinking budgets for legacy models when `effortMap` gives no number. */
const DEFAULT_BUDGETS = { low: 2_048, medium: 8_192, high: 16_384, max: 32_768 } as const;
const MIN_BUDGET = 1_024;

// ---------------------------------------------------------------------------------------------------------------
// Request

function thinkingFields(model: ModelInfo, quirks: Quirks, plan: ThinkingPlan, maxTokens: number): JsonObject {
    const style = quirks.thinking;
    if (model.reasoning.mode === 'none' || style === undefined) {
        return {};
    }
    const effort = (value: string | undefined): JsonObject =>
        value === undefined ? {} : { output_config: { effort: value } };
    switch (style.kind) {
        case 'anthropic_adaptive': {
            if (plan.on) {
                // `display` defaults to omitted on current models, which would stream empty thinking.
                return { thinking: { type: 'adaptive', display: 'summarized' }, ...effort(plan.vendorEffort) };
            }
            if (style.offMode === 'between_tools') {
                // Takes no other thinking field; the default effort is within its `high` ceiling.
                return { thinking: { type: 'between_tools' } };
            }
            if (style.offMode === 'disabled') {
                return { thinking: { type: 'disabled' } };
            }
            // Thinking cannot be turned off: run at the weakest effort instead.
            const lowest = model.reasoning.efforts[0];
            const vendor = lowest === undefined ? undefined : (quirks.effortMap?.[lowest] ?? lowest);
            return { thinking: { type: 'adaptive', display: 'summarized' }, ...effort(vendor) };
        }
        case 'anthropic_budget': {
            if (!plan.on) {
                return {};
            }
            const fromMap = Number(plan.vendorEffort);
            const wanted = Number.isFinite(fromMap) && fromMap > 0 ? fromMap : DEFAULT_BUDGETS[plan.effort ?? 'medium'];
            // The budget must stay below max_tokens and at or above 1024; otherwise thinking stays off.
            const budget = Math.min(wanted, maxTokens - 1);
            return budget >= MIN_BUDGET ? { thinking: { type: 'enabled', budget_tokens: budget } } : {};
        }
        // Anthropic-compatible endpoints of openai-style vendors (deepseek documents enabled/disabled plus effort).
        case 'deepseek':
        case 'glm':
            return {
                thinking: { type: plan.on ? 'enabled' : 'disabled' },
                ...(plan.on ? effort(plan.vendorEffort) : {}),
            };
        case 'kimi':
        case 'openai':
            return plan.on ? effort(plan.vendorEffort) : {};
        default:
            return {};
    }
}

function contentBlocks(parts: readonly UserPart[], images: boolean): JsonObject[] {
    return parts.flatMap((part): JsonObject[] => {
        if (part.type === 'text') {
            // Empty text blocks are rejected.
            return part.text ? [{ type: 'text', text: part.text }] : [];
        }
        return images
            ? [{ type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } }]
            : [{ type: 'text', text: IMAGE_OMITTED }];
    });
}

function toolResultBlock(message: ToolResultMessage, images: boolean): JsonObject {
    const content = contentBlocks(message.content, images);
    return {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        ...(content.length > 0 ? { content } : {}),
        is_error: message.isError ?? false,
    };
}

function reasoningBlock(part: Extract<AssistantPart, { type: 'reasoning' }>): JsonObject {
    if (part.redacted !== undefined) {
        return { type: 'redacted_thinking', data: part.redacted };
    }
    return {
        type: 'thinking',
        thinking: part.text,
        ...(part.signature !== undefined ? { signature: part.signature } : {}),
    };
}

function assistantBlocks(message: AssistantMessage, replay: boolean): JsonObject[] {
    return message.content.flatMap((part): JsonObject[] => {
        switch (part.type) {
            case 'text':
                return part.text ? [{ type: 'text', text: part.text }] : [];
            case 'reasoning':
                // Thinking blocks go back unchanged and in order, but only to the model that wrote them.
                return replay ? [reasoningBlock(part)] : [];
            default:
                return [{ type: 'tool_use', id: part.id, name: part.name, input: parseArguments(part.arguments) }];
        }
    });
}

interface AnthropicMessage {
    readonly role: 'user' | 'assistant';
    readonly content: JsonObject[];
}

/** Maps xora messages to anthropic messages; tool results and user turns that follow each other share a message. */
export function toAnthropicMessages(context: WireContext): AnthropicMessage[] {
    const { preset, model, quirks, request } = context;
    const images = model.input.includes('image');
    const out: AnthropicMessage[] = [];
    const push = (role: AnthropicMessage['role'], blocks: JsonObject[]): void => {
        if (blocks.length === 0) {
            return;
        }
        const last = out[out.length - 1];
        if (role === 'user' && last?.role === 'user') {
            last.content.push(...blocks);
        } else {
            out.push({ role, content: blocks });
        }
    };
    for (const message of request.messages) {
        if (message.role === 'user') {
            push('user', contentBlocks(message.content, images));
        } else if (message.role === 'tool') {
            push('user', [toolResultBlock(message, images)]);
        } else {
            const replay =
                quirks.reasoningEcho !== 'never' && message.provider === preset.id && message.model === request.model;
            push('assistant', assistantBlocks(message, replay));
        }
    }
    return out;
}

/** Builds the `/v1/messages` request body for a streaming call. */
export function buildAnthropicBody(context: WireContext): JsonObject {
    const { model, quirks, request } = context;
    const plan = planThinking(model, quirks, request.effort);
    const maxTokens = request.maxOutputTokens ?? Math.min(model.maxOutput, 32_000);
    const cache = quirks.cacheControl === 'auto';
    const body: JsonObject = { model: request.model, max_tokens: maxTokens };

    const system: JsonObject[] = request.system
        .filter((segment) => segment.length > 0)
        .map((text) => ({ type: 'text', text }));
    const tools: JsonObject[] = (request.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        eager_input_streaming: true,
    }));
    const messages = toAnthropicMessages(context);
    if (cache) {
        // Breakpoints after the stable prefix (tools render before system) and on the newest user turn.
        const prefixEnd = system[system.length - 1] ?? tools[tools.length - 1];
        if (prefixEnd !== undefined) {
            prefixEnd.cache_control = EPHEMERAL;
        }
        const lastUser = messages.findLast((message) => message.role === 'user');
        const lastBlock = lastUser?.content[lastUser.content.length - 1];
        if (lastBlock !== undefined) {
            lastBlock.cache_control = EPHEMERAL;
        }
    }
    if (system.length > 0) {
        body.system = system;
    }
    body.messages = messages;
    if (tools.length > 0) {
        body.tools = tools;
        const choice = planToolChoice(request.toolChoice, quirks, plan.on);
        if (choice !== undefined) {
            body.tool_choice =
                choice.kind === 'function'
                    ? { type: 'tool', name: choice.name }
                    : { type: choice.kind === 'required' ? 'any' : choice.kind };
        }
    }
    if (request.temperature !== undefined) {
        body.temperature = request.temperature;
    }
    if (request.topP !== undefined) {
        body.top_p = request.topP;
    }
    Object.assign(body, thinkingFields(model, quirks, plan, maxTokens));
    body.stream = true;
    Object.assign(body, quirks.extraBody);
    omitParams(body, quirks.omitParams);
    if (plan.on) {
        omitParams(body, quirks.omitParamsWhenThinking);
    }
    return body;
}

// ---------------------------------------------------------------------------------------------------------------
// Response

interface RawUsage {
    input?: number;
    cacheRead?: number;
    cacheWrite?: number;
    output?: number;
}

function mergeUsage(target: RawUsage, raw: unknown): void {
    if (!isRecord(raw)) {
        return;
    }
    target.input = asNumber(raw.input_tokens) ?? target.input;
    target.cacheRead = asNumber(raw.cache_read_input_tokens) ?? target.cacheRead;
    target.cacheWrite = asNumber(raw.cache_creation_input_tokens) ?? target.cacheWrite;
    target.output = asNumber(raw.output_tokens) ?? target.output;
}

/** Anthropic reports uncached input separately; xora's input total includes cache reads and writes. */
export function mapAnthropicUsage(raw: JsonObject): Usage {
    const usage: RawUsage = {};
    mergeUsage(usage, raw);
    return toUsage(usage);
}

function toUsage(raw: RawUsage): Usage {
    const cachedTokens = raw.cacheRead ?? 0;
    const cacheWriteTokens = raw.cacheWrite ?? 0;
    return {
        inputTokens: (raw.input ?? 0) + cachedTokens + cacheWriteTokens,
        cachedTokens,
        cacheWriteTokens,
        outputTokens: raw.output ?? 0,
        reasoningTokens: 0,
    };
}

function stopReason(raw: string | undefined): StopReason {
    switch (raw) {
        case 'end_turn':
        case 'stop_sequence':
            return 'end_turn';
        case 'tool_use':
            return 'tool_use';
        case 'max_tokens':
        case 'model_context_window_exceeded':
            return 'max_tokens';
        case 'refusal':
            return 'refusal';
        case 'pause_turn':
            return 'pause';
        default:
            return 'other';
    }
}

type Block =
    | { readonly kind: 'text'; text: string }
    | { readonly kind: 'thinking'; text: string; signature?: string }
    | { readonly kind: 'redacted'; readonly data: string }
    | { readonly kind: 'tool'; readonly index: number; readonly id: string; readonly name: string; args: string };

/** Turns `/v1/messages` stream events into model events, ending with `done`. */
export async function* parseAnthropicStream(
    events: AsyncIterable<SseEvent>,
    context: WireContext,
    clock: Clock,
    requestId: string | undefined,
): AsyncGenerator<ModelEvent> {
    const { preset, quirks, request } = context;
    const provider = preset.id;
    const blocks = new Map<number, Block>();
    const usage: RawUsage = {};
    let sawUsage = false;
    let toolCount = 0;
    let rawStop: string | undefined;
    let stopped = false;

    for await (const event of events) {
        const payload = parseJson(event.data);
        if (!isRecord(payload)) {
            continue;
        }
        const type = asString(payload.type) ?? event.event;
        if (type === 'error') {
            throw classifyError({ provider, body: payload, quirks, ...(requestId ? { requestId } : {}) });
        }
        if (type === 'message_start') {
            const message = isRecord(payload.message) ? payload.message : {};
            if (isRecord(message.usage)) {
                mergeUsage(usage, message.usage);
                sawUsage = true;
            }
        } else if (type === 'content_block_start') {
            const index = asNumber(payload.index) ?? blocks.size;
            const block = isRecord(payload.content_block) ? payload.content_block : {};
            const blockType = asString(block.type);
            if (blockType === 'text') {
                const text = asString(block.text) ?? '';
                blocks.set(index, { kind: 'text', text });
                if (text) {
                    clock.mark();
                    yield { type: 'text_delta', text };
                }
            } else if (blockType === 'thinking') {
                const text = asString(block.thinking) ?? '';
                const signature = asString(block.signature) || undefined;
                blocks.set(index, { kind: 'thinking', text, ...(signature ? { signature } : {}) });
                if (text) {
                    clock.mark();
                    yield { type: 'reasoning_delta', text };
                }
            } else if (blockType === 'redacted_thinking') {
                blocks.set(index, { kind: 'redacted', data: asString(block.data) ?? '' });
            } else if (blockType === 'tool_use') {
                const input = isRecord(block.input) && Object.keys(block.input).length > 0 ? block.input : undefined;
                const tool: Block = {
                    kind: 'tool',
                    index: toolCount++,
                    id: asString(block.id) ?? '',
                    name: asString(block.name) ?? '',
                    args: input === undefined ? '' : JSON.stringify(input),
                };
                blocks.set(index, tool);
                clock.mark();
                yield { type: 'tool_call_start', index: tool.index, id: tool.id, name: tool.name };
            }
        } else if (type === 'content_block_delta') {
            const block = blocks.get(asNumber(payload.index) ?? -1);
            const delta = isRecord(payload.delta) ? payload.delta : {};
            const deltaType = asString(delta.type);
            if (deltaType === 'text_delta' && block?.kind === 'text') {
                const text = asString(delta.text) ?? '';
                if (text) {
                    block.text += text;
                    clock.mark();
                    yield { type: 'text_delta', text };
                }
            } else if (deltaType === 'thinking_delta' && block?.kind === 'thinking') {
                const text = asString(delta.thinking) ?? '';
                if (text) {
                    block.text += text;
                    clock.mark();
                    yield { type: 'reasoning_delta', text };
                }
            } else if (deltaType === 'signature_delta' && block?.kind === 'thinking') {
                block.signature = (block.signature ?? '') + (asString(delta.signature) ?? '');
            } else if (deltaType === 'input_json_delta' && block?.kind === 'tool') {
                const json = asString(delta.partial_json) ?? '';
                if (json) {
                    block.args += json;
                    yield { type: 'tool_call_delta', index: block.index, delta: json };
                }
            }
        } else if (type === 'message_delta') {
            const delta = isRecord(payload.delta) ? payload.delta : {};
            rawStop = asString(delta.stop_reason) ?? rawStop;
            if (isRecord(payload.usage)) {
                mergeUsage(usage, payload.usage);
                sawUsage = true;
            }
        } else if (type === 'message_stop') {
            stopped = true;
            break;
        }
    }

    if (!stopped && rawStop === undefined) {
        throw truncatedStream(provider, requestId);
    }
    const parts: AssistantPart[] = [...blocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, block]): AssistantPart => {
            switch (block.kind) {
                case 'text':
                    return { type: 'text', text: block.text };
                case 'thinking':
                    return {
                        type: 'reasoning',
                        text: block.text,
                        ...(block.signature ? { signature: block.signature } : {}),
                    };
                case 'redacted':
                    return { type: 'reasoning', text: '', redacted: block.data };
                default:
                    return { type: 'tool_call', id: block.id, name: block.name, arguments: block.args || '{}' };
            }
        })
        .filter((part) => part.type !== 'text' || part.text !== '');
    yield {
        type: 'done',
        stopReason: stopReason(rawStop),
        ...(rawStop !== undefined ? { rawStopReason: rawStop } : {}),
        message: { role: 'assistant', content: parts, provider, model: request.model },
        ...(sawUsage ? { usage: toUsage(usage) } : {}),
        ...(requestId ? { requestId } : {}),
        ...(clock.ttftMs !== undefined ? { ttftMs: clock.ttftMs } : {}),
        latencyMs: clock.latencyMs,
    };
}
