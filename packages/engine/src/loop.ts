import os from 'node:os';
import type * as acp from '@agentclientprotocol/sdk';
import type { AssistantMessage, AssistantPart, Message, ModelEvent, ModelRequest, UserPart } from '@xora/providers';
import { z } from 'zod';
import type { HostTool } from './config.ts';
import { contextBudget, contextMessages, currentContextTokens, pruneToolResults, summarise } from './context.ts';
import {
    type AnyTool,
    checkPathAccess,
    isReadOnlyCommand,
    isSensitivePath,
    ProviderError,
    sanitizeEnv,
    streamModel,
    type ToolContext,
    type ToolResult,
    toolSpecs,
} from './deps.ts';
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
        return result.display.diffs.map((diff) => ({
            type: 'diff' as const,
            path: diff.path,
            oldText: diff.oldText,
            newText: diff.newText,
        }));
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
    #cancelled = false;

    get #stopped(): boolean {
        return this.#signal.aborted || this.#cancelled;
    }

    constructor(session: EngineSession, io: TurnIO, signal: AbortSignal, tools: readonly AnyTool[]) {
        this.#session = session;
        this.#io = io;
        this.#signal = signal;
        const disabled = new Set(session.config.disabledTools);
        const all = [
            ...tools.filter((tool) => !disabled.has(tool.name)),
            ...session.config.hostTools.map((spec) => hostTool(spec, io)),
            ...(session.mcp ? mcpTools(session.mcp) : []),
        ];
        this.#tools = new Map(all.map((tool) => [tool.name, tool]));
    }

    async run(prompt: readonly acp.ContentBlock[]): Promise<StopReason> {
        const session = this.#session;
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
                    return 'end_turn';
            }
        }
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

    async compact(level: 3 | 4, focus?: string): Promise<boolean> {
        const session = this.#session;
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
                _meta: { xora: { level, before: result?.before, after: result?.after } },
            } as acp.SessionUpdate);
            return result !== undefined;
        } catch (error) {
            this.#io.update({
                sessionUpdate: 'compaction_update',
                compactionId: id,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
            } as acp.SessionUpdate);
            pruneToolResults(session, 2);
            return false;
        }
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
                    `切换到备用模型${target.model.name}`,
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
                    `${error.errorClass === 'rate_limit' ? '触发限速' : '模型服务暂时不可用'}，${Math.round(wait / 1000)}秒后重试`,
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
        this.#io.update({
            sessionUpdate: 'usage_update',
            used: promptTokens,
            size: contextBudget(session, target),
            _meta: {
                xora: {
                    request: {
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
                    },
                },
            },
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
        };
    }

    async #authorize(call: PreparedCall): Promise<{ allow: boolean; message?: string; cancelled?: boolean }> {
        const { outside, sensitive } = await this.#pathFacts(call);
        const command =
            call.name === 'bash' && typeof (call.input as { command?: unknown }).command === 'string'
                ? (call.input as { command: string }).command
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
                { optionId: 'allow_once', name: '允许一次', kind: 'allow_once' },
                { optionId: 'allow_always', name: '总是允许', kind: 'allow_always' },
                { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
            ],
            _meta: {
                xora: {
                    toolName: call.name,
                    readOnly: call.tool?.readOnly ?? false,
                    targets: call.targets,
                    outside,
                    sensitive,
                    ...(command !== undefined ? { command, readOnlyCommand: isReadOnlyCommand(command) } : {}),
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
            return await call.tool.run(call.input, this.#toolContext(call));
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
        const free = await Promise.all(calls.map((call) => this.#isFree(call)));
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
                        const result = await this.#runCall(item);
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
            const decision = await this.#authorize(call);
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
            this.#finish(call, await this.#runCall(call), startedAt);
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
