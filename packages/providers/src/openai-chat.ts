import { omitParams, planThinking, planToolChoice, type ThinkingPlan } from './effort.ts';
import { classifyError, ProviderError } from './errors.ts';
import { asNumber, asString, isRecord, type JsonObject, parseJson } from './json.ts';
import type { SseEvent } from './sse.ts';
import type {
    AssistantMessage,
    AssistantPart,
    ModelEvent,
    Quirks,
    StopReason,
    ThinkingStyle,
    Usage,
    UserPart,
} from './types.ts';
import { type Clock, generatedToolCallId, IMAGE_OMITTED, truncatedStream, type WireContext } from './wire.ts';

const TOOL_IMAGES = 'Images returned by the tool calls above:';

// ---------------------------------------------------------------------------------------------------------------
// Request

function thinkingFields(style: ThinkingStyle | undefined, plan: ThinkingPlan): JsonObject {
    const effort = plan.on && plan.vendorEffort !== undefined ? { reasoning_effort: plan.vendorEffort } : {};
    switch (style?.kind) {
        case 'deepseek':
            return { thinking: { type: plan.on ? 'enabled' : 'disabled' }, ...effort };
        case 'glm':
            return { thinking: { type: plan.on ? 'enabled' : 'disabled', clear_thinking: !style.preserve }, ...effort };
        case 'minimax':
            // On is the default (`adaptive`; `enabled` is a 400 there).
            if (!plan.on) return { thinking: { type: 'disabled' } };
            return style.effort ? effort : {};
        case 'kimi':
        case 'openai':
        case 'anthropic_adaptive':
        case 'anthropic_budget':
            return effort;
        default:
            return {};
    }
}

function userContent(parts: readonly UserPart[], images: boolean): string | JsonObject[] {
    const blocks = parts.map((part): JsonObject => {
        if (part.type === 'text') {
            return { type: 'text', text: part.text };
        }
        return images
            ? { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
            : { type: 'text', text: IMAGE_OMITTED };
    });
    if (blocks.every((block) => block.type === 'text')) {
        return blocks.map((block) => block.text as string).join('\n\n');
    }
    return blocks;
}

function joinText(parts: readonly AssistantPart[], type: 'text' | 'reasoning'): string {
    return parts.flatMap((part) => (part.type !== 'tool_call' && part.type === type ? [part.text] : [])).join('\n\n');
}

/**
 * Reasoning goes back only to the provider and model that produced it, and only when the vendor wants it:
 * `always`, or `with_tools` once the request has tools or the history has tool calls.
 */
function echoesReasoning(context: WireContext): (message: AssistantMessage) => boolean {
    const { preset, quirks, request } = context;
    const mode = quirks.reasoningEcho ?? 'never';
    if (mode === 'never' || quirks.reasoningField === 'none') {
        return () => false;
    }
    if (mode === 'with_tools') {
        const toolsInPlay =
            (request.tools?.length ?? 0) > 0 ||
            request.messages.some(
                (message) => message.role === 'tool' || (message.role === 'assistant' && hasToolCalls(message)),
            );
        if (!toolsInPlay) {
            return () => false;
        }
    }
    return (message) => message.provider === preset.id && message.model === request.model;
}

function hasToolCalls(message: AssistantMessage): boolean {
    return message.content.some((part) => part.type === 'tool_call');
}

function assistantMessage(message: AssistantMessage, echo: boolean, field: string): JsonObject {
    const text = joinText(message.content, 'text');
    const calls = message.content.flatMap((part) =>
        part.type === 'tool_call'
            ? [{ id: part.id, type: 'function', function: { name: part.name, arguments: part.arguments } }]
            : [],
    );
    const out: JsonObject = { role: 'assistant', content: text || (calls.length > 0 ? null : '') };
    // Never fabricate reasoning: a message without recorded reasoning goes back without the field.
    if (echo && message.content.some((part) => part.type === 'reasoning')) {
        out[field] = joinText(message.content, 'reasoning');
    }
    if (calls.length > 0) {
        out.tool_calls = calls;
    }
    return out;
}

/** Maps xora messages to chat messages. Images from tool results follow the tool messages in a user message. */
export function toChatMessages(context: WireContext): JsonObject[] {
    const { model, quirks, request } = context;
    const images = model.input.includes('image');
    const echo = echoesReasoning(context);
    const field = quirks.reasoningField === 'reasoning' ? 'reasoning' : 'reasoning_content';
    const out: JsonObject[] = [];
    const system = request.system.filter((segment) => segment.length > 0).join('\n\n');
    if (system) {
        out.push({ role: 'system', content: system });
    }
    let toolImages: UserPart[] = [];
    const flushToolImages = (): void => {
        if (toolImages.length > 0) {
            out.push({
                role: 'user',
                content: userContent([{ type: 'text', text: TOOL_IMAGES }, ...toolImages], true),
            });
            toolImages = [];
        }
    };
    for (const message of request.messages) {
        if (message.role !== 'tool') {
            flushToolImages();
        }
        if (message.role === 'user') {
            out.push({ role: 'user', content: userContent(message.content, images) });
        } else if (message.role === 'assistant') {
            out.push(assistantMessage(message, echo(message), field));
        } else {
            const pictures = message.content.filter((part) => part.type === 'image');
            const texts = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
            if (pictures.length > 0 && images) {
                toolImages.push(...pictures);
            } else if (pictures.length > 0) {
                texts.push(IMAGE_OMITTED);
            }
            out.push({ role: 'tool', tool_call_id: message.toolCallId, content: texts.join('\n\n') });
        }
    }
    flushToolImages();
    return out;
}

/** Builds the `/chat/completions` request body for a streaming call. */
export function buildOpenAiChatBody(context: WireContext): JsonObject {
    const { model, quirks, request } = context;
    const plan = planThinking(model, quirks, request.effort);
    const body: JsonObject = { model: request.model, messages: toChatMessages(context), stream: true };
    if (quirks.streamUsage !== false) {
        body.stream_options = { include_usage: true };
    }
    const tools = request.tools ?? [];
    if (tools.length > 0) {
        body.tools = tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
        const choice = planToolChoice(request.toolChoice, quirks, plan.on);
        if (choice !== undefined) {
            body.tool_choice =
                choice.kind === 'function' ? { type: 'function', function: { name: choice.name } } : choice.kind;
        }
    }
    if (request.maxOutputTokens !== undefined) {
        body[quirks.maxTokensField ?? 'max_tokens'] = request.maxOutputTokens;
    }
    if (request.temperature !== undefined) {
        body.temperature = request.temperature;
    }
    if (request.topP !== undefined) {
        body.top_p = request.topP;
    }
    if (model.reasoning.mode !== 'none') {
        Object.assign(body, thinkingFields(quirks.thinking, plan));
    }
    Object.assign(body, quirks.extraBody);
    omitParams(body, quirks.omitParams);
    if (plan.on) {
        omitParams(body, quirks.omitParamsWhenThinking);
    }
    return body;
}

// ---------------------------------------------------------------------------------------------------------------
// Response

/**
 * Maps the usage layouts of openai-compatible vendors: openai and glm (`prompt_tokens_details.cached_tokens`),
 * deepseek (`prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`) and kimi (`cached_tokens` at the top level or
 * in the details, `cache_write_tokens`). Input always includes cached tokens.
 */
export function mapChatUsage(raw: JsonObject): Usage {
    const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
    const completion = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : {};
    const hit = asNumber(raw.prompt_cache_hit_tokens);
    const miss = asNumber(raw.prompt_cache_miss_tokens);
    const cachedTokens = asNumber(details.cached_tokens) ?? asNumber(raw.cached_tokens) ?? hit ?? 0;
    const cacheWriteTokens = asNumber(details.cache_write_tokens) ?? asNumber(raw.cache_write_tokens) ?? 0;
    const prompt =
        asNumber(raw.prompt_tokens) ?? (hit !== undefined || miss !== undefined ? (hit ?? 0) + (miss ?? 0) : 0);
    return {
        inputTokens: Math.max(prompt, cachedTokens + cacheWriteTokens),
        cachedTokens,
        cacheWriteTokens,
        outputTokens: asNumber(raw.completion_tokens) ?? 0,
        reasoningTokens: asNumber(completion.reasoning_tokens) ?? asNumber(raw.reasoning_tokens) ?? 0,
    };
}

function stopReason(raw: string | undefined, toolCalls: boolean): StopReason {
    switch (raw) {
        case undefined:
        case 'stop':
            // Some servers report `stop` even when the message ends in tool calls.
            return toolCalls ? 'tool_use' : 'end_turn';
        case 'tool_calls':
        case 'function_call':
            return 'tool_use';
        case 'length':
        case 'model_context_window_exceeded':
            return 'max_tokens';
        case 'content_filter':
        case 'sensitive':
            return 'content_filter';
        default:
            return 'other';
    }
}

/** Finish reasons that mean the response broke off on the vendor side. */
const FAILED_FINISH: Readonly<Record<string, 'server' | 'overloaded'>> = {
    network_error: 'server', // glm: model inference failed
    error: 'server', // openrouter
    insufficient_system_resource: 'overloaded', // deepseek
};

function reasoningDelta(delta: JsonObject, field: Quirks['reasoningField']): string {
    if (field === 'none') {
        return '';
    }
    const primary = asString(delta[field ?? 'reasoning_content']);
    if (primary !== undefined) {
        return primary;
    }
    // Without a configured field accept either spelling; servers that send both send the same text.
    return field === undefined ? (asString(delta.reasoning) ?? '') : '';
}

interface ToolCallState {
    readonly index: number;
    readonly id: string;
    name: string;
    args: string;
}

/** Turns `/chat/completions` stream events into model events, ending with `done`. */
export async function* parseOpenAiChatStream(
    events: AsyncIterable<SseEvent>,
    context: WireContext,
    clock: Clock,
    requestId: string | undefined,
): AsyncGenerator<ModelEvent> {
    const { preset, quirks, request } = context;
    const provider = preset.id;
    let reasoning = '';
    let text = '';
    const calls: ToolCallState[] = [];
    const byIndex = new Map<number, ToolCallState>();
    const byId = new Map<string, ToolCallState>();
    let finish: string | undefined;
    let usage: Usage | undefined;
    let sawDone = false;

    for await (const event of events) {
        const data = event.data.trim();
        if (data === '[DONE]') {
            sawDone = true;
            break;
        }
        const chunk = data === '' ? undefined : parseJson(data);
        if (!isRecord(chunk)) {
            continue;
        }
        if (chunk.error !== undefined && chunk.error !== null) {
            const status = asNumber(isRecord(chunk.error) ? chunk.error.code : undefined);
            throw classifyError({
                provider,
                body: chunk,
                quirks,
                ...(status !== undefined && status >= 400 && status < 600 ? { status } : {}),
                ...(requestId ? { requestId } : {}),
            });
        }
        if (isRecord(chunk.usage)) {
            usage = mapChatUsage(chunk.usage);
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices.filter(isRecord) : [];
        const choice = choices.find((candidate) => (asNumber(candidate.index) ?? 0) === 0);
        if (choice === undefined) {
            continue;
        }
        const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : {};
        const thought = reasoningDelta(delta, quirks.reasoningField);
        if (thought) {
            clock.mark();
            reasoning += thought;
            yield { type: 'reasoning_delta', text: thought };
        }
        const content = asString(delta.content);
        if (content) {
            clock.mark();
            text += content;
            yield { type: 'text_delta', text: content };
        }
        for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : []) {
            const vendorIndex = asNumber(fragment.index);
            const id = asString(fragment.id) || undefined;
            const fn = isRecord(fragment.function) ? fragment.function : {};
            let state =
                vendorIndex !== undefined
                    ? byIndex.get(vendorIndex)
                    : id !== undefined
                      ? byId.get(id)
                      : calls[calls.length - 1];
            if (state === undefined) {
                state = {
                    index: calls.length,
                    id: id ?? generatedToolCallId(),
                    name: asString(fn.name) ?? '',
                    args: '',
                };
                calls.push(state);
                if (vendorIndex !== undefined) {
                    byIndex.set(vendorIndex, state);
                }
                byId.set(state.id, state);
                clock.mark();
                yield { type: 'tool_call_start', index: state.index, id: state.id, name: state.name };
            } else if (!state.name && asString(fn.name)) {
                state.name = asString(fn.name) ?? '';
            }
            const args = asString(fn.arguments);
            if (args) {
                state.args += args;
                yield { type: 'tool_call_delta', index: state.index, delta: args };
            }
        }
        const reason = asString(choice.finish_reason);
        if (reason) {
            finish = reason;
        }
    }

    if (!sawDone && finish === undefined) {
        throw truncatedStream(provider, requestId);
    }
    const failed = finish !== undefined && Object.hasOwn(FAILED_FINISH, finish) ? FAILED_FINISH[finish] : undefined;
    if (failed !== undefined) {
        throw new ProviderError(`the response broke off (finish_reason ${finish})`, {
            errorClass: failed,
            provider,
            ...(finish ? { code: finish } : {}),
            ...(requestId ? { requestId } : {}),
        });
    }
    const parts: AssistantPart[] = [];
    if (reasoning) {
        parts.push({ type: 'reasoning', text: reasoning });
    }
    if (text) {
        parts.push({ type: 'text', text });
    }
    for (const call of calls) {
        parts.push({ type: 'tool_call', id: call.id, name: call.name, arguments: call.args || '{}' });
    }
    yield {
        type: 'done',
        stopReason: stopReason(finish, calls.length > 0),
        ...(finish !== undefined ? { rawStopReason: finish } : {}),
        message: { role: 'assistant', content: parts, provider, model: request.model },
        ...(usage !== undefined ? { usage } : {}),
        ...(requestId ? { requestId } : {}),
        ...(clock.ttftMs !== undefined ? { ttftMs: clock.ttftMs } : {}),
        latencyMs: clock.latencyMs,
    };
}
