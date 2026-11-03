import os from 'node:os';
import type * as acp from '@agentclientprotocol/sdk';
import type { AssistantMessage, AssistantPart, Message, ModelEvent, ModelRequest, UserPart } from '@xora/providers';
import { z } from 'zod';
import type { HostTool } from './config.ts';
import {
    contextBudget,
    contextMessages,
    currentContextTokens,
    estimatedContextTokens,
    estimateMessageTokens,
    estimateTokens,
    pruneToolResults,
    summarise,
    summaryCut,
} from './context.ts';
import {
    type AnyTool,
    checkPathAccess,
    isReadOnlyCommand,
    isSensitivePath,
    LSP_EDIT_NOTE,
    type LspManager,
    ProviderError,
    sanitizeEnv,
    streamModel,
    type ToolContext,
    type ToolResult,
    toolSpecs,
} from './deps.ts';
import { withEditDiagnostics } from './diagnostics.ts';
import { mcpTools } from './mcp.ts';
import { environmentBlock, modeNote, systemSegments } from './prompt.ts';
import { type EngineSession, type ResolvedTarget, resolveTarget } from './session.ts';

export type StopReason = acp.StopReason;

/** What the loop needs from the ACP connection; tests provide a fake. */
export interface TurnIO {
    /** Fire-and-forget `session/update`; ordering is preserved. */
    update(update: acp.SessionUpdate): void;
    requestPermission(request: Omit<acp.RequestPermissionRequest, 'sessionId'>): Promise<acp.RequestPermissionResponse>;
    /** Runs a host-implemented tool (`_xora/tool/call`). */
    callHostTool(name: string, input: unknown, signal: AbortSignal): Promise<ToolResult>;
    /** Runs the host's hooks for an event (`_xora/hook/run`); only called for events in `hookEvents`. */
    runHook?(event: HookEvent, payload: HookPayload, signal: AbortSignal): Promise<HookReply>;
}

export type ToolHookEvent = 'PreToolUse' | 'PostToolUse';
/** Events the engine raises itself: around tool calls, and before it compacts on its own (09 §4). */
export type HookEvent = ToolHookEvent | 'PreCompact';

export interface ToolHookPayload {
    readonly tool_name: string;
    readonly tool_input: unknown;
    readonly tool_use_id: string;
    readonly tool_response?: { readonly content: string; readonly isError: boolean };
}

/** PreCompact: `manual` for `/compact`, `auto` when the context runs full or the model changes vendor. */
export interface CompactHookPayload {
    readonly trigger: 'auto' | 'manual';
    readonly custom_instructions: string;
}

export type HookPayload = ToolHookPayload | CompactHookPayload;

/** What the host's hooks decided; every field is optional. */
export interface HookReply {
    readonly blocked?: boolean;
    readonly reason?: string;
    readonly decision?: 'allow' | 'ask' | 'deny';
    readonly additionalContext?: string;
    readonly updatedInput?: Record<string, unknown>;
}

/** PreToolUse outcome for one call. */
interface PreHook {
    readonly blocked?: string;
    readonly ask?: boolean;
    readonly allowed?: boolean;
}

export class ModelError extends Error {
    readonly errorClass: string;
    readonly retryable: boolean;
    readonly retryAfterMs: number | undefined;
    readonly status: number | undefined;

    constructor(error: ProviderError) {
        super(error.message);
        this.name = 'ModelError';
        this.errorClass = error.errorClass;
        this.retryable = error.retryable;
        this.retryAfterMs = error.retryAfterMs;
        this.status = error.status;
    }
}

const MAX_ATTEMPTS = 3;
const LIVE_OUTPUT_INTERVAL_MS = 250;
const LIVE_OUTPUT_TAIL = 4000;

/** What the user sees from the loop: notices and permission options, in the session's language. */
const ZH_TEXT = {
    fallback: (model: string) => `切换到备用模型${model}`,
    retry: (rateLimited: boolean, seconds: number) =>
        `${rateLimited ? '触发限速' : '模型服务暂时不可用'}，${seconds}秒后重试`,
    allowOnce: '允许一次',
    allowAlways: '总是允许',
    reject: '拒绝',
    hookBlocked: (tool: string) => `hook拦截了${tool}`,
};

const TEXT: Readonly<Record<'zh-CN' | 'en', typeof ZH_TEXT>> = {
    'zh-CN': ZH_TEXT,
    en: {
        fallback: (model) => `Switched to the fallback model ${model}`,
        retry: (rateLimited, seconds) =>
            `${rateLimited ? 'Rate limited' : 'The model service is unavailable'}; retrying in ${seconds}s`,
        allowOnce: 'Allow once',
        allowAlways: 'Always allow',
        reject: 'Reject',
        hookBlocked: (tool) => `A hook blocked ${tool}`,
    },
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}

function text(value: string): acp.ContentBlock {
    return { type: 'text', text: value };
}

/** A finished model request as the host records it for usage and cost. */
function requestRecord(target: ResolvedTarget, done: Extract<ModelEvent, { type: 'done' }>) {
    return {
        provider: target.connection.preset.id,
        channel: target.connection.preset.channel,
        model: target.model.id,
        family: target.model.family,
        pricing: target.model.pricing,
        usage: done.usage ?? null,
        latencyMs: done.latencyMs,
        ttftMs: done.ttftMs,
        requestId: done.requestId,
        stopReason: done.stopReason,
        status: 'ok',
    };
}

/** Converts ACP prompt blocks into the user message the model sees. */
export function toUserMessage(prompt: readonly acp.ContentBlock[], session: EngineSession): Message {
    const parts: UserPart[] = [];
    if (session.isFirstPrompt) {
        parts.push({ type: 'text', text: environmentBlock(session.cwd, session.roots) });
    }
    for (const block of prompt) {
        switch (block.type) {
            case 'text':
                parts.push({ type: 'text', text: block.text });
                break;
            case 'image':
                parts.push({ type: 'image', mimeType: block.mimeType, data: block.data });
                break;
            case 'resource_link':
                parts.push({ type: 'text', text: `Referenced: ${block.name} (${block.uri})` });
                break;
            case 'resource': {
                const resource = block.resource;
                if ('text' in resource) {
                    parts.push({ type: 'text', text: `<file uri="${resource.uri}">\n${resource.text}\n</file>` });
                } else {
                    parts.push({ type: 'text', text: `Attached binary resource: ${resource.uri}` });
                }
                break;
            }
            default:
                parts.push({ type: 'text', text: '[unsupported attachment omitted]' });
        }
    }
    const note = modeNote(session.config.mode);
    if (note) {
        parts.push({ type: 'text', text: `<system-reminder>${note}</system-reminder>` });
    }
    return { role: 'user', content: parts };
}

/** Wraps a host-declared tool; its schema is the host's JSON Schema and it never asks for permission here. */
export function hostTool(spec: HostTool, io: TurnIO): AnyTool {
    return {
        name: spec.name,
        description: spec.description,
        kind: spec.kind,
        schema: z.record(z.string(), z.unknown()),
        jsonSchema: spec.parameters,
        readOnly: true,
        targets: () => [],
        title: () => spec.name,
        run: (input: unknown, ctx: ToolContext) => io.callHostTool(spec.name, input, ctx.signal),
    } as AnyTool;
}

interface PreparedCall {
    readonly id: string;
    readonly name: string;
    readonly tool: AnyTool | undefined;
    readonly input: unknown;
    readonly error: string | undefined;
    readonly targets: readonly string[];
    readonly title: string;
    readonly kind: acp.ToolKind;
}

function prepareCall(
    part: Extract<AssistantPart, { type: 'tool_call' }>,
    tools: Map<string, AnyTool>,
    cwd: string,
): PreparedCall {
    const tool = tools.get(part.name);
    const base = { id: part.id, name: part.name, tool };
    if (!tool) {
        return {
            ...base,
            input: undefined,
            error: `Unknown tool "${part.name}".`,
            targets: [],
            title: part.name,
            kind: 'other',
        };
    }
    let raw: unknown;
    try {
        raw = part.arguments.trim().length === 0 ? {} : JSON.parse(part.arguments);
    } catch {
        return {
            ...base,
            input: undefined,
            error: `The arguments for ${part.name} are not valid JSON. Send a single JSON object.`,
            targets: [],
            title: tool.name,
            kind: tool.kind,
        };
    }
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
        return {
            ...base,
            input: raw,
            error: `Invalid arguments for ${part.name}: ${issues}`,
            targets: [],
            title: tool.name,
            kind: tool.kind,
        };
    }
    let targets: readonly string[] = [];
    try {
        targets = tool.targets(parsed.data, { cwd });
    } catch {
        targets = [];
    }
    return { ...base, input: parsed.data, error: undefined, targets, title: tool.title(parsed.data), kind: tool.kind };
}

function acpContent(result: ToolResult): acp.ToolCallContent[] {
    if (result.display?.kind === 'diff') {
        const diffs: acp.ToolCallContent[] = result.display.diffs.map((diff) => ({
            type: 'diff' as const,
            path: diff.path,
            oldText: diff.oldText,
            newText: diff.newText,
        }));
        // The diagnostics the model got with the edit, so the user sees them under the diff too.
        const note = result.content.indexOf(LSP_EDIT_NOTE);
        return note < 0 ? diffs : [...diffs, { type: 'content', content: text(result.content.slice(note)) }];
    }
    const body = result.content.length > 8000 ? `${result.content.slice(0, 8000)}\n…` : result.content;
    return [{ type: 'content', content: text(body) }];
}

/**
 * Runs one prompt turn: stream the model, execute tool calls (asking the host when a call is not plainly
 * read-only inside the workspace), feed results back, and repeat until the model stops.
 */
export class TurnRunner {
    readonly #session: EngineSession;
    readonly #io: TurnIO;
    readonly #signal: AbortSignal;
    readonly #tools: Map<string, AnyTool>;
    readonly #home = os.homedir();
    /** Language servers for the `lsp` tool and for diagnostics after edits. */
    readonly #lsp: LspManager | undefined;
    #cancelled = false;

    get #stopped(): boolean {
        return this.#signal.aborted || this.#cancelled;
    }

    get #text(): typeof ZH_TEXT {
        return TEXT[this.#session.config.language];
    }

    constructor(session: EngineSession, io: TurnIO, signal: AbortSignal, tools: readonly AnyTool[], lsp?: LspManager) {
        this.#session = session;
        this.#io = io;
        this.#signal = signal;
        this.#lsp = lsp;
        const disabled = new Set(session.config.disabledTools);
        const all = [
            ...tools.filter((tool) => !disabled.has(tool.name)),
            ...session.config.hostTools.map((spec) => hostTool(spec, io)),
            ...(session.mcp ? mcpTools(session.mcp, session.config.mcpTools) : []),
        ];
        this.#tools = new Map(all.map((tool) => [tool.name, tool]));
    }

    /**
     * `fresh`: the context starts over from this summary, which the host wrote, before the prompt (a team's supervisor
     * woken with the state of its run, 06 §29). The earlier messages stay in the session file, out of the context.
     */
    async run(prompt: readonly acp.ContentBlock[], options: { readonly fresh?: string } = {}): Promise<StopReason> {
        const session = this.#session;
        if (options.fresh) {
            this.#restart(options.fresh);
        }
        // Steering the previous turn accepted but ended before taking (cancelled, out of requests) comes first.
        this.#steer();
        session.append(toUserMessage(prompt, session));
        let requests = 0;
        for (;;) {
            if (this.#stopped) {
                return 'cancelled';
            }
            if (requests >= session.config.maxTurnRequests) {
                return 'max_turn_requests';
            }
            await this.#manageContext();
            const outcome = await this.#request();
            requests++;
            if (outcome.kind === 'cancelled') {
                if (outcome.partial) {
                    session.append(outcome.partial);
                }
                return 'cancelled';
            }
            const message = outcome.message;
            session.append(message);
            const calls = message.content.filter(
                (part): part is Extract<AssistantPart, { type: 'tool_call' }> => part.type === 'tool_call',
            );
            if (calls.length > 0) {
                await this.#executeCalls(calls, outcome.stopReason === 'max_tokens');
                if (this.#stopped) {
                    return 'cancelled';
                }
                this.#steer();
                continue;
            }
            switch (outcome.stopReason) {
                case 'max_tokens':
                    return 'max_tokens';
                case 'refusal':
                case 'content_filter':
                    return 'refusal';
                case 'pause':
                    continue;
                default:
                    // A message that arrived while the model wrote its answer is answered in the same turn.
                    if (this.#steer()) {
                        continue;
                    }
                    return 'end_turn';
            }
        }
    }

    /** Appends the messages the host sent into this turn (06 §20) as one user message; true when there were any. */
    #steer(): boolean {
        const notes = this.#session.takeSteering();
        if (notes.length === 0) {
            return false;
        }
        this.#session.append({ role: 'user', content: notes.map((note) => ({ type: 'text' as const, text: note })) });
        return true;
    }

    /** The context starts from `summary`: everything before this point is represented by it, as after a compaction. */
    #restart(summary: string): void {
        const session = this.#session;
        const keepFrom = session.history.length;
        const before = contextMessages(session).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        session.contextStart = keepFrom;
        session.summary = summary;
        session.prunedUpTo = Math.max(session.prunedUpTo, keepFrom);
        session.lastPromptTokens = 0;
        session.lastPromptEstimate = 0;
        session.file.append({
            t: 'compaction',
            ts: Date.now(),
            level: 3,
            summary,
            keepFrom,
            tokensBefore: before,
            tokensAfter: estimateTokens(summary),
        });
    }

    /** Compaction levels 2 and 3 when the context crosses 60% and 80% of the budget. */
    async #manageContext(): Promise<void> {
        const session = this.#session;
        const target = resolveTarget(session.config.model);
        const budget = contextBudget(session, target);
        const used = currentContextTokens(session, systemSegments(session.config.layers));
        if (used < budget * 0.6) {
            return;
        }
        if (used < budget * 0.8) {
            pruneToolResults(session);
            return;
        }
        await this.compact(3);
    }

    /**
     * Summarises older turns. Before a compaction of its own (`auto`) the engine runs the host's PreCompact hooks;
     * for `/compact` the host has run them already.
     */
    async compact(level: 3 | 4, focus?: string, trigger: 'auto' | 'manual' = 'auto'): Promise<boolean> {
        const session = this.#session;
        if (
            trigger === 'auto' &&
            this.#hookEnabled('PreCompact') &&
            summaryCut(session, level === 4 ? 1 : 2) !== undefined
        ) {
            await this.#runHook('PreCompact', { trigger: 'auto', custom_instructions: '' });
        }
        const id = `compaction-${Date.now()}`;
        this.#io.update({
            sessionUpdate: 'compaction_update',
            compactionId: id,
            status: 'started',
        } as acp.SessionUpdate);
        try {
            const target = resolveTarget(session.config.fastModel ?? session.config.model);
            const result = await summarise(session, target, {
                keepTurns: level === 4 ? 1 : 2,
                ...(focus ? { focus } : {}),
                signal: this.#signal,
                userAgent: session.config.userAgent,
            });
            if (!result) {
                pruneToolResults(session, 2);
            }
            this.#io.update({
                sessionUpdate: 'compaction_update',
                compactionId: id,
                status: 'completed',
                ...(result?.summary ? { summary: [text(result.summary)] } : {}),
                // Nothing to summarise yet: only older tool output was replaced, which is level 2.
                _meta: { xora: { level: result ? level : 2, before: result?.before, after: result?.after } },
            } as acp.SessionUpdate);
            this.#reportContext(result?.done ? { target, done: result.done } : undefined);
            return result !== undefined;
        } catch (error) {
            this.#io.update({
                sessionUpdate: 'compaction_update',
                compactionId: id,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
            } as acp.SessionUpdate);
            pruneToolResults(session, 2);
            this.#reportContext();
            return false;
        }
    }

    /**
     * The context as it is after a compaction, so the meter drops at once instead of at the next request (a manual
     * `/compact` has none); carries the summary request, counted like any other.
     */
    #reportContext(summary?: { target: ResolvedTarget; done: Extract<ModelEvent, { type: 'done' }> }): void {
        const session = this.#session;
        let size: number;
        try {
            size = contextBudget(session, resolveTarget(session.config.model));
        } catch {
            return;
        }
        this.#io.update({
            sessionUpdate: 'usage_update',
            used: currentContextTokens(session, systemSegments(session.config.layers)),
            size,
            ...(summary ? { _meta: { xora: { request: requestRecord(summary.target, summary.done) } } } : {}),
        });
    }

    #buildRequest(target: ResolvedTarget): ModelRequest {
        const session = this.#session;
        const maxOutput = Math.min(target.model.maxOutput, session.config.maxOutputTokens ?? 32_000);
        return {
            model: target.model.id,
            system: systemSegments(session.config.layers),
            messages: contextMessages(session),
            ...(target.model.tools ? { tools: toolSpecs([...this.#tools.values()]) } : {}),
            ...(session.config.effort ? { effort: session.config.effort } : {}),
            maxOutputTokens: maxOutput,
        };
    }

    async #request(): Promise<
        | { kind: 'done'; message: AssistantMessage; stopReason: string }
        | { kind: 'cancelled'; partial: AssistantMessage | undefined }
    > {
        const session = this.#session;
        const chain = [session.config.model, ...session.config.fallbacks];
        let lastError: unknown;
        for (let index = 0; index < chain.length; index++) {
            const spec = chain[index];
            if (!spec) {
                continue;
            }
            const target = resolveTarget(spec);
            if (index > 0) {
                this.#notice(
                    'warning',
                    this.#text.fallback(target.model.name),
                    lastError instanceof Error ? lastError.message : undefined,
                );
                if (this.#crossesProvider(target)) {
                    // Reasoning from another vendor cannot be replayed (07 §5 rule 2): summarise first.
                    await this.compact(4);
                }
            }
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                const result = await this.#streamOnce(target);
                if (result.kind !== 'error') {
                    return result;
                }
                lastError = result.error;
                const error = result.error;
                if (this.#signal.aborted) {
                    return { kind: 'cancelled', partial: undefined };
                }
                if (!(error instanceof ProviderError) || !error.retryable) {
                    throw error instanceof ProviderError ? new ModelError(error) : error;
                }
                if (attempt === MAX_ATTEMPTS) {
                    break;
                }
                const wait = Math.min(60_000, error.retryAfterMs ?? 2000 * 2 ** (attempt - 1));
                this.#notice(
                    'warning',
                    this.#text.retry(error.errorClass === 'rate_limit', Math.round(wait / 1000)),
                    error.message,
                );
                await sleep(wait, this.#signal);
            }
        }
        throw lastError instanceof ProviderError
            ? new ModelError(lastError)
            : (lastError ?? new Error('model request failed'));
    }

    #crossesProvider(target: ResolvedTarget): boolean {
        return this.#session.history.some(
            (message) => message.role === 'assistant' && `${message.provider}/${message.model}` !== target.key,
        );
    }

    async #streamOnce(
        target: ResolvedTarget,
    ): Promise<
        | { kind: 'done'; message: AssistantMessage; stopReason: string }
        | { kind: 'cancelled'; partial: AssistantMessage | undefined }
        | { kind: 'error'; error: unknown }
    > {
        const session = this.#session;
        const request = this.#buildRequest(target);
        let textSoFar = '';
        let reasoningSoFar = '';
        try {
            let done: Extract<ModelEvent, { type: 'done' }> | undefined;
            for await (const event of streamModel(target.connection, request, {
                signal: this.#signal,
                userAgent: session.config.userAgent,
            })) {
                if (event.type === 'text_delta') {
                    textSoFar += event.text;
                    this.#io.update({ sessionUpdate: 'agent_message_chunk', content: text(event.text) });
                } else if (event.type === 'reasoning_delta') {
                    reasoningSoFar += event.text;
                    this.#io.update({ sessionUpdate: 'agent_thought_chunk', content: text(event.text) });
                } else if (event.type === 'done') {
                    done = event;
                }
            }
            if (!done) {
                throw new Error('model stream ended without a final event');
            }
            this.#reportUsage(target, request, done);
            return { kind: 'done', message: done.message, stopReason: done.stopReason };
        } catch (error) {
            if (this.#signal.aborted) {
                const parts: AssistantPart[] = [];
                if (reasoningSoFar) {
                    parts.push({ type: 'reasoning', text: reasoningSoFar });
                }
                if (textSoFar) {
                    parts.push({ type: 'text', text: textSoFar });
                }
                return {
                    kind: 'cancelled',
                    partial:
                        parts.length > 0
                            ? {
                                  role: 'assistant',
                                  content: parts,
                                  provider: target.connection.preset.id,
                                  model: target.model.id,
                              }
                            : undefined,
                };
            }
            this.#reportFailure(target, error);
            return { kind: 'error', error };
        }
    }

    #reportUsage(target: ResolvedTarget, request: ModelRequest, done: Extract<ModelEvent, { type: 'done' }>): void {
        const session = this.#session;
        const promptTokens = done.usage?.inputTokens ?? currentContextTokens(session, request.system);
        session.lastPromptTokens = promptTokens;
        session.lastPromptEstimate = estimatedContextTokens(session, request.system);
        this.#io.update({
            sessionUpdate: 'usage_update',
            used: promptTokens,
            size: contextBudget(session, target),
            _meta: { xora: { request: requestRecord(target, done) } },
        });
    }

    #reportFailure(target: ResolvedTarget, error: unknown): void {
        this.#io.update({
            sessionUpdate: 'usage_update',
            used: this.#session.lastPromptTokens,
            size: contextBudget(this.#session, target),
            _meta: {
                xora: {
                    request: {
                        provider: target.connection.preset.id,
                        channel: target.connection.preset.channel,
                        model: target.model.id,
                        family: target.model.family,
                        pricing: target.model.pricing,
                        usage: null,
                        latencyMs: 0,
                        status: 'error',
                        errorClass: error instanceof ProviderError ? error.errorClass : 'unknown',
                    },
                },
            },
        });
    }

    #notice(severity: 'info' | 'warning' | 'error', title: string, description?: string): void {
        this.#io.update({
            sessionUpdate: 'notice',
            severity,
            title,
            ...(description ? { description } : {}),
        } as acp.SessionUpdate);
    }

    /** Whether every target is inside the roots and not a secret, checking the resolved path as well. */
    async #pathFacts(call: PreparedCall): Promise<{ outside: string[]; sensitive: string[] }> {
        const roots = [...this.#session.roots, this.#session.artifactsDir];
        const outside: string[] = [];
        const sensitive: string[] = [];
        for (const target of call.targets) {
            const access = await checkPathAccess(roots, target);
            if (!access.ok) {
                outside.push(target);
            }
            if (isSensitivePath(target, this.#home) || (access.ok && isSensitivePath(access.realPath, this.#home))) {
                sensitive.push(target);
            }
        }
        return { outside, sensitive };
    }

    async #isFree(call: PreparedCall): Promise<boolean> {
        if (!call.tool || call.error || !call.tool.readOnly) {
            return false;
        }
        const facts = await this.#pathFacts(call);
        return facts.outside.length === 0 && facts.sensitive.length === 0;
    }

    #toolContext(call: PreparedCall): ToolContext {
        const session = this.#session;
        let pending = '';
        let scheduled = false;
        let tail = '';
        const flush = () => {
            scheduled = false;
            tail = (tail + pending).slice(-LIVE_OUTPUT_TAIL);
            pending = '';
            this.#io.update({
                sessionUpdate: 'tool_call_update',
                toolCallId: call.id,
                _meta: { xora: { liveOutput: tail } },
            });
        };
        return {
            cwd: session.cwd,
            roots: [...session.roots, session.artifactsDir],
            signal: this.#signal,
            env: { ...sanitizeEnv(process.env), ...session.config.env },
            artifacts: { save: async (name, content) => session.saveArtifact(name, content) },
            jobs: session.jobs,
            todos: {
                get: () => session.todos,
                set: (items) => {
                    session.setTodos(items);
                    this.#io.update({
                        sessionUpdate: 'plan',
                        entries: items.map((item) => ({
                            content: item.content,
                            status: item.status,
                            priority: item.priority ?? 'medium',
                        })),
                    });
                },
            },
            onOutput: (chunk) => {
                pending += chunk;
                if (!scheduled) {
                    scheduled = true;
                    setTimeout(flush, LIVE_OUTPUT_INTERVAL_MS);
                }
            },
            ...(this.#lsp ? { lsp: { manager: this.#lsp, trusted: session.config.lsp.trusted } } : {}),
        };
    }

    async #authorize(
        call: PreparedCall,
        hook: PreHook | undefined,
    ): Promise<{ allow: boolean; message?: string; cancelled?: boolean }> {
        const { outside, sensitive } = await this.#pathFacts(call);
        const command =
            call.name === 'bash' && typeof (call.input as { command?: unknown }).command === 'string'
                ? (call.input as { command: string }).command
                : undefined;
        // The address a fetch goes to: the host asks, and remembers answers, per domain (10 §3).
        const url =
            call.kind === 'fetch' && typeof (call.input as { url?: unknown } | undefined)?.url === 'string'
                ? (call.input as { url: string }).url
                : undefined;
        const response = await this.#io.requestPermission({
            toolCall: {
                toolCallId: call.id,
                title: call.title,
                kind: call.kind,
                status: 'pending',
                rawInput: call.input,
                locations: call.targets.map((target) => ({ path: target })),
            },
            options: [
                { optionId: 'allow_once', name: this.#text.allowOnce, kind: 'allow_once' },
                { optionId: 'allow_always', name: this.#text.allowAlways, kind: 'allow_always' },
                { optionId: 'reject_once', name: this.#text.reject, kind: 'reject_once' },
            ],
            _meta: {
                xora: {
                    toolName: call.name,
                    readOnly: call.tool?.readOnly ?? false,
                    targets: call.targets,
                    outside,
                    sensitive,
                    ...(command !== undefined ? { command, readOnlyCommand: isReadOnlyCommand(command) } : {}),
                    ...(url !== undefined ? { url } : {}),
                    ...(hook?.ask ? { hookDecision: 'ask' } : hook?.allowed ? { hookDecision: 'allow' } : {}),
                },
            },
        });
        if (response.outcome.outcome === 'cancelled') {
            // ACP: a cancelled permission request means the prompt turn is being cancelled.
            this.#cancelled = true;
            return { allow: false, cancelled: true };
        }
        if (response.outcome.outcome === 'selected' && response.outcome.optionId.startsWith('allow')) {
            return { allow: true };
        }
        const message = (response._meta as { xora?: { message?: string } } | null | undefined)?.xora?.message;
        return { allow: false, ...(message ? { message } : {}) };
    }

    async #runCall(call: PreparedCall): Promise<ToolResult> {
        if (call.error || !call.tool) {
            return { content: call.error ?? `Unknown tool "${call.name}".`, isError: true };
        }
        this.#io.update({ sessionUpdate: 'tool_call_update', toolCallId: call.id, status: 'in_progress' });
        try {
            const result = await call.tool.run(call.input, this.#toolContext(call));
            return await withEditDiagnostics(this.#lsp, this.#session, call.tool, result, this.#signal);
        } catch (error) {
            return {
                content: `Tool ${call.name} failed: ${error instanceof Error ? error.message : String(error)}`,
                isError: true,
            };
        }
    }

    #finish(call: PreparedCall, result: ToolResult, startedAt: number, extra: Record<string, unknown> = {}): void {
        this.#io.update({
            sessionUpdate: 'tool_call_update',
            toolCallId: call.id,
            status: result.isError ? 'failed' : 'completed',
            content: acpContent(result),
            ...(result.locations ? { locations: result.locations.map((location) => ({ ...location })) } : {}),
            _meta: {
                xora: {
                    name: call.name,
                    ...(result.display ? { display: result.display } : {}),
                    durationMs: Date.now() - startedAt,
                    ...extra,
                },
            },
        });
        this.#session.append({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: 'text', text: result.content }],
            ...(result.isError ? { isError: true } : {}),
        });
    }

    #hookEnabled(event: HookEvent): boolean {
        return this.#io.runHook !== undefined && this.#session.config.hookEvents.includes(event);
    }

    async #runHook(event: HookEvent, payload: HookPayload): Promise<HookReply> {
        try {
            return (await this.#io.runHook?.(event, payload, this.#signal)) ?? {};
        } catch (error) {
            // A failing hook bridge must not take the turn down; the host applies each hook's own failure policy.
            this.#notice('warning', `${event} hook failed`, error instanceof Error ? error.message : String(error));
            return {};
        }
    }

    /**
     * Runs PreToolUse hooks for every valid call, in order, before any of them runs, so that the calls a hook
     * blocks or wants confirmed are known when the read-only batch is formed. A hook may replace the input.
     */
    async #preToolHooks(
        calls: PreparedCall[],
        parts: readonly Extract<AssistantPart, { type: 'tool_call' }>[],
    ): Promise<Array<PreHook | undefined>> {
        const results: Array<PreHook | undefined> = [];
        for (let index = 0; index < calls.length; index++) {
            const call = calls[index] as PreparedCall;
            const part = parts[index];
            if (call.error || !call.tool || !part || this.#stopped) {
                results.push(undefined);
                continue;
            }
            const reply = await this.#runHook('PreToolUse', {
                tool_name: call.name,
                tool_input: call.input,
                tool_use_id: call.id,
            });
            if (reply.blocked || reply.decision === 'deny') {
                results.push({ blocked: reply.reason?.trim() || 'blocked by a PreToolUse hook' });
                continue;
            }
            if (reply.updatedInput) {
                const updated = prepareCall(
                    { ...part, arguments: JSON.stringify(reply.updatedInput) },
                    this.#tools,
                    this.#session.cwd,
                );
                calls[index] = updated;
                this.#io.update({
                    sessionUpdate: 'tool_call_update',
                    toolCallId: call.id,
                    title: updated.title,
                    rawInput: updated.input,
                    locations: updated.targets.map((target) => ({ path: target })),
                });
            }
            results.push({ ask: reply.decision === 'ask', allowed: reply.decision === 'allow' });
        }
        return results;
    }

    /** Runs PostToolUse hooks for a call that ran; their feedback is appended to the result the model sees. */
    async #postToolHook(call: PreparedCall, result: ToolResult): Promise<ToolResult> {
        if (!this.#hookEnabled('PostToolUse') || call.error || !call.tool) {
            return result;
        }
        const reply = await this.#runHook('PostToolUse', {
            tool_name: call.name,
            tool_input: call.input,
            tool_use_id: call.id,
            tool_response: { content: result.content, isError: result.isError === true },
        });
        const notes = [
            reply.blocked || reply.decision === 'deny' ? reply.reason?.trim() : undefined,
            reply.additionalContext?.trim(),
        ].filter((note): note is string => Boolean(note));
        if (notes.length === 0) {
            return result;
        }
        return {
            ...result,
            content: `${result.content}\n\n<hook event="PostToolUse">\n${notes.join('\n')}\n</hook>`,
        };
    }

    async #executeCalls(
        parts: readonly Extract<AssistantPart, { type: 'tool_call' }>[],
        truncated: boolean,
    ): Promise<void> {
        const calls = parts.map((part) => prepareCall(part, this.#tools, this.#session.cwd));
        for (const call of calls) {
            this.#io.update({
                sessionUpdate: 'tool_call',
                toolCallId: call.id,
                title: call.title,
                kind: call.kind,
                status: 'pending',
                rawInput: call.input,
                locations: call.targets.map((target) => ({ path: target })),
                _meta: { xora: { name: call.name } },
            });
        }
        const finished = new Set<string>();
        const hooks =
            this.#hookEnabled('PreToolUse') && !truncated
                ? await this.#preToolHooks(calls, parts)
                : calls.map(() => undefined);
        // A call a hook blocks or wants confirmed never joins a read-only batch.
        const free = await Promise.all(
            calls.map((call, index) => (hooks[index]?.blocked || hooks[index]?.ask ? false : this.#isFree(call))),
        );
        let index = 0;
        while (index < calls.length && !this.#stopped) {
            const call = calls[index];
            if (!call) {
                break;
            }
            if (truncated) {
                const startedAt = Date.now();
                this.#finish(
                    call,
                    {
                        content:
                            'The response hit the output limit, so this call may be incomplete and was not run. Retry with smaller steps.',
                        isError: true,
                    },
                    startedAt,
                );
                finished.add(call.id);
                index++;
                continue;
            }
            if (free[index]) {
                const batch: PreparedCall[] = [];
                while (index < calls.length && free[index]) {
                    batch.push(calls[index] as PreparedCall);
                    index++;
                }
                await Promise.all(
                    batch.map(async (item) => {
                        const startedAt = Date.now();
                        const result = await this.#postToolHook(item, await this.#runCall(item));
                        this.#finish(item, result, startedAt);
                        finished.add(item.id);
                    }),
                );
                continue;
            }
            const startedAt = Date.now();
            if (call.error || !call.tool) {
                this.#finish(call, await this.#runCall(call), startedAt);
                finished.add(call.id);
                index++;
                continue;
            }
            const blocked = hooks[index]?.blocked;
            if (blocked) {
                this.#notice('warning', this.#text.hookBlocked(call.name), blocked);
                this.#finish(
                    call,
                    { content: `A PreToolUse hook blocked this call: ${blocked}`, isError: true },
                    startedAt,
                    {
                        denied: true,
                    },
                );
                finished.add(call.id);
                index++;
                continue;
            }
            const decision = await this.#authorize(call, hooks[index]);
            if (this.#stopped) {
                break;
            }
            if (!decision.allow) {
                const reason = decision.message ? ` The user said: ${decision.message}` : '';
                this.#finish(
                    call,
                    { content: `The user denied this ${call.name} call.${reason}`, isError: true },
                    startedAt,
                    { denied: true },
                );
                finished.add(call.id);
                index++;
                continue;
            }
            this.#finish(call, await this.#postToolHook(call, await this.#runCall(call)), startedAt);
            finished.add(call.id);
            index++;
        }
        for (const call of calls) {
            if (!finished.has(call.id)) {
                this.#finish(call, { content: 'Cancelled by the user before it ran.', isError: true }, Date.now(), {
                    cancelled: true,
                });
            }
        }
    }
}
