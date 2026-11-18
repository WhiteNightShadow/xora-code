import os from 'node:os';
import type * as acp from '@agentclientprotocol/sdk';
import {
    type AssistantMessage,
    type AssistantPart,
    type Message,
    type ModelEvent,
    type ModelRequest,
    resolveQuirks,
    type UserPart,
} from '@xora/providers';
import { z } from 'zod';
import type { HostTool } from './config.ts';
import {
    applyCompaction,
    compactionCut,
    compactionMessages,
    compactionShares,
    displayState,
} from './context/compaction.ts';
import { contextMessages } from './context/messages.ts';
import { maskToolResults, readOutput, spillToolOutput } from './context/outputs.ts';
import { estimateMessageTokens, estimateTokens } from './context/tokens.ts';
import {
    COMPACT_AT,
    contextBudget,
    currentContextTokens,
    estimatedContextTokens,
    fixedTokens,
    MASK_AT,
} from './context/window.ts';
import {
    type AnyTool,
    checkPathAccess,
    clipText,
    completeModel,
    isReadOnlyCommand,
    isSensitivePath,
    LSP_EDIT_NOTE,
    type LspManager,
    lenientInput,
    lenientToolInput,
    nonInteractiveEnv,
    ProviderError,
    parseToolArguments,
    renderTerminalText,
    renderTodos,
    resolveToolName,
    sanitizeEnv,
    streamModel,
    type ToolContext,
    type ToolResult,
    toolParameters,
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
const MAX_FINAL_ATTEMPTS = 5;
const FALLBACK_ERRORS: ReadonlySet<string> = new Set(['quota', 'auth', 'permission', 'not_found']);
const LIVE_OUTPUT_INTERVAL_MS = 250;
const LIVE_OUTPUT_TAIL = 4000;
/** Tool calls without a change to a todo list with open steps before the model is reminded of it. */
const TODO_REMINDER_CALLS = 10;
/** The same call with the same result this many times in a row before the model is told so, and every so many after. */
const REPEAT_REMINDER_CALLS = 3;

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
    /** The tool's own name, whatever the model called it: permissions, hooks and the record go by it. */
    readonly name: string;
    readonly tool: AnyTool | undefined;
    readonly input: unknown;
    readonly error: string | undefined;
    /** Said to the model after the result: what of its input the tool did not take. */
    readonly note?: string;
    readonly targets: readonly string[];
    readonly title: string;
    readonly kind: acp.ToolKind;
}

/** Tool names listed to a model that asked for one that does not exist. */
const LISTED_TOOLS = 40;

/** A tool's parameters by name, the required ones marked, for a model that got them wrong. */
function parameterList(schema: Record<string, unknown>): string {
    const properties = schema.properties;
    if (properties === null || typeof properties !== 'object') {
        return '';
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return Object.keys(properties)
        .map((name) => (required.has(name) ? `${name} (required)` : name))
        .join(', ');
}

/**
 * A model's tool call as the engine runs it (21 §4.1): the tool it means, and its input in the shape the tool asks
 * for where what the model meant is not in doubt. What still does not fit is an error the model can act on.
 */
function prepareCall(
    part: Extract<AssistantPart, { type: 'tool_call' }>,
    tools: Map<string, AnyTool>,
    cwd: string,
): PreparedCall {
    const tool = tools.get(part.name) ?? tools.get(resolveToolName(part.name, tools.keys()) ?? '');
    if (!tool) {
        const names = [...tools.keys()];
        const listed = `${names.slice(0, LISTED_TOOLS).join(', ')}${names.length > LISTED_TOOLS ? ', …' : ''}`;
        return {
            id: part.id,
            name: part.name,
            tool,
            input: undefined,
            error: `Unknown tool "${part.name}". The tools are: ${listed}.`,
            targets: [],
            title: part.name,
            kind: 'other',
        };
    }
    const base = { id: part.id, name: tool.name, tool };
    const failed = (error: string, input: unknown): PreparedCall => ({
        ...base,
        input,
        error,
        targets: [],
        title: tool.name,
        kind: tool.kind,
    });
    const sent = parseToolArguments(part.arguments);
    if (!sent.ok) {
        return failed(
            `The arguments for ${tool.name} are not valid JSON. Send a single JSON object, with every backslash and double quote inside a string escaped (\\\\ and \\").`,
            undefined,
        );
    }
    // Host and MCP tools bring their own JSON Schema, and judge what it does not describe themselves.
    const own = (tool as { jsonSchema?: Record<string, unknown> }).jsonSchema;
    const schema = own ?? toolParameters(tool);
    const fitted = own ? lenientInput(own, sent.value) : lenientToolInput(tool, sent.value);
    const parameters = parameterList(schema);
    if (fitted.refused !== undefined) {
        return failed(`Invalid arguments for ${tool.name}: ${fitted.refused}`, fitted.input);
    }
    let note: string | undefined;
    if (fitted.unknown.length > 0) {
        const unknown = fitted.unknown.map((name) => `"${name}"`).join(', ');
        const what = `${tool.name} has no parameter ${unknown}; its parameters are: ${parameters}.`;
        // A call that changes things does not run on a guess at what the parameter was for (`append` on write).
        // A fetch is asked about but changes nothing: it runs like a read.
        if (!tool.readOnly && tool.kind !== 'fetch') {
            return failed(`${what} Nothing was done: send the call again with these.`, fitted.input);
        }
        note = `(${what} The call ran without ${fitted.unknown.length === 1 ? 'it' : 'them'}.)`;
    }
    const parsed = tool.schema.safeParse(fitted.input);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ');
        const hint = parameters ? ` Parameters of ${tool.name}: ${parameters}.` : '';
        return failed(`Invalid arguments for ${tool.name}: ${issues}.${hint}`, fitted.input);
    }
    let targets: readonly string[] = [];
    try {
        targets = tool.targets(parsed.data, { cwd });
    } catch {
        targets = [];
    }
    return {
        ...base,
        input: parsed.data,
        error: undefined,
        ...(note ? { note } : {}),
        targets,
        title: tool.title(parsed.data),
        kind: tool.kind,
    };
}

/** Whether two JSON values are the same, whatever order their properties come in. */
function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        return false;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        return (
            Array.isArray(a) &&
            Array.isArray(b) &&
            a.length === b.length &&
            a.every((item, index) => sameJson(item, b[index]))
        );
    }
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return (
        keys.length === Object.keys(right).length &&
        keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
    );
}

/**
 * The model's reply with its tool calls as they are run: under the tool's own name, with the input the tool is
 * given. A call that only runs because it was read leniently (`Read {"file_path": …}`, arguments that were almost
 * JSON) would otherwise stand in the history in a form nothing else reads: the task ledger and the placeholders of
 * masked results go by the tool's own parameters (20 §4.3), providers by valid JSON, and the model by its own
 * earlier calls. Calls that are refused stay as they were sent, next to the error that says why.
 */
function asRun(message: AssistantMessage, calls: readonly PreparedCall[]): AssistantMessage {
    let next = 0;
    let changed = false;
    const content = message.content.map((part) => {
        if (part.type !== 'tool_call') {
            return part;
        }
        const call = calls[next++];
        if (!call || call.error !== undefined || !call.tool || call.id !== part.id) {
            return part;
        }
        let sent: unknown;
        try {
            sent = JSON.parse(part.arguments);
        } catch {
            sent = undefined;
        }
        if (part.name === call.name && sameJson(sent, call.input)) {
            return part;
        }
        changed = true;
        return { ...part, name: call.name, arguments: JSON.stringify(call.input) };
    });
    return changed ? { ...message, content } : message;
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
    /** What the batch of calls running adds at the end of its last result (`#executeCalls`). */
    #tail: { left: number; readonly text: () => string | undefined } | undefined;
    /** The call made last in this turn and its result, and how many times in a row the two came the same. */
    #repeat: { readonly key: string; readonly result: string; count: number } | undefined;

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
        // Tool calls since this turn last wrote the todo list; none counted until it writes one: a list left from an
        // earlier turn is not this turn's progress.
        let sinceTodo: number | undefined;
        for (;;) {
            if (this.#stopped) {
                this.#closeCancelledTurn();
                return 'cancelled';
            }
            if (requests >= session.config.maxTurnRequests) {
                return 'max_turn_requests';
            }
            await this.#manageContext();
            const outcome = await this.#request();
            requests++;
            if (outcome.kind === 'cancelled') {
                this.#closeCancelledTurn(outcome.partial);
                return 'cancelled';
            }
            const message = outcome.message;
            const calls = message.content.filter(
                (part): part is Extract<AssistantPart, { type: 'tool_call' }> => part.type === 'tool_call',
            );
            // A reply cut off at the output limit runs none of its calls: they stay as they came.
            const truncated = outcome.stopReason === 'max_tokens';
            const prepared = calls.map((part) => prepareCall(part, this.#tools, session.cwd));
            session.append(truncated ? message : asRun(message, prepared));
            if (calls.length > 0) {
                const todos = session.todos;
                // Once every call of the batch has run: whether the list changed, and if not, whether it is time to
                // remind the model of it, at the end of the last result.
                await this.#executeCalls(prepared, calls, truncated, () => {
                    if (this.#stopped) return undefined;
                    if (session.todos !== todos) {
                        sinceTodo = 0;
                        return undefined;
                    }
                    if (sinceTodo === undefined) return undefined;
                    sinceTodo += calls.length;
                    const reminder = this.#todoReminder(sinceTodo);
                    if (reminder) sinceTodo = 0;
                    return reminder;
                });
                if (this.#stopped) {
                    this.#closeCancelledTurn();
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

    /**
     * Ensures a cancelled turn never leaves `session.history` ending on a bare `user` or `tool` message (or with an
     * unsigned partial thinking block), which strict vendors (DeepSeek thinking, MiniMax, Anthropic, Kimi, GLM) reject
     * with HTTP 400 on the very next user message.
     */
    #closeCancelledTurn(partial?: AssistantMessage): void {
        const session = this.#session;
        const textParts = partial?.content.filter(
            (part): part is Extract<AssistantPart, { type: 'text' }> =>
                part.type === 'text' && part.text.trim().length > 0,
        );
        const last = session.history.at(-1);
        if ((!textParts || textParts.length === 0) && last?.role === 'assistant') {
            return;
        }
        let provider = partial?.provider ?? 'unknown';
        let model = partial?.model ?? session.config.model.model;
        if (!partial) {
            try {
                const target = resolveTarget(session.config.model);
                provider = target.connection.preset.id;
                model = target.model.id;
            } catch {
                // Keep configured model id if preset lookup fails.
            }
        }
        const fallbackReasoning: AssistantPart[] = [];
        if (!textParts || textParts.length === 0) {
            // Kimi & GLM (`reasoningEcho: 'always'`) require `reasoning_content` on every assistant message of that model.
            try {
                const target = resolveTarget(session.config.model);
                const quirks = resolveQuirks(target.connection.preset, target.model);
                if (quirks.reasoningEcho === 'always' && target.connection.preset.defaultWire === 'openai_chat') {
                    fallbackReasoning.push({ type: 'reasoning', text: 'Stopped by user.' });
                }
            } catch {
                // Ignore.
            }
        }
        session.append({
            role: 'assistant',
            content:
                textParts && textParts.length > 0
                    ? textParts
                    : [...fallbackReasoning, { type: 'text', text: '[Stopped by user.]' }],
            provider,
            model,
        });
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

    /**
     * The user follows the work by the todo list (the plan above the composer). When this turn wrote it, it still has
     * open steps and TODO_REMINDER_CALLS tool calls went by without it changing, the model is reminded to bring it up
     * to date: left alone, models write the list at the start and seldom touch it again. The reminder goes at the end
     * of the last tool result, not in a user message of its own: that would read as the start of a turn when the
     * context is compacted, and some providers refuse a user message straight after tool results.
     */
    #todoReminder(since: number): string | undefined {
        const todos = this.#session.todos;
        if (since < TODO_REMINDER_CALLS || !this.#tools.has('todo')) return undefined;
        if (!todos.some((item) => item.status !== 'completed')) return undefined;
        return `<system-reminder>Your todo list has not changed in the last ${since} tool calls, and the user follows your progress by it:
${renderTodos(todos)}
If steps are done, started or no longer needed, update it with the todo tool now, then carry on; if it is right as it is, just carry on. Do not mention this reminder.</system-reminder>`;
    }

    /**
     * The context starts over from `summary`, the host's account of the work: everything before is represented by it,
     * and the ledger of what came before no longer holds (20 §4.4).
     */
    #restart(summary: string): void {
        const session = this.#session;
        const keepFrom = session.history.length;
        const before = contextMessages(session).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        session.startFrom({
            contextStart: keepFrom,
            summary,
            base: summary,
            ledgerFrom: keepFrom,
            judgments: [],
            narratives: [],
            compactions: 0,
        });
        session.file.append({
            t: 'compaction',
            ts: Date.now(),
            level: 3,
            summary,
            keepFrom,
            tokensBefore: before,
            tokensAfter: estimateTokens(summary),
            fresh: true,
        });
    }

    /** What every request to `target` carries besides the conversation: the system prompt and the tool definitions. */
    #fixed(target: ResolvedTarget): number {
        return fixedTokens(
            systemSegments(this.#session.config.layers),
            target.model.tools ? toolSpecs([...this.#tools.values()]) : [],
        );
    }

    /**
     * Keeps the context within the budget of `target` (20 §4.4): at MASK_AT older tool output is masked to
     * references, all at once; at COMPACT_AT older turns give way to the state of the work, unless masking alone
     * brings it back. Before a request to a fallback model it runs for that model's budget (level 4).
     */
    async #manageContext(target = resolveTarget(this.#session.config.model), level: 3 | 4 = 3): Promise<void> {
        const session = this.#session;
        const fixed = this.#fixed(target);
        const budget = contextBudget(session, target, fixed);
        const used = currentContextTokens(session, fixed);
        if (used < budget * MASK_AT) {
            return;
        }
        const masked = maskToolResults(session, budget);
        if (masked && currentContextTokens(session, fixed) < budget * COMPACT_AT) {
            return;
        }
        if (used >= budget * COMPACT_AT) {
            await this.compact(level, undefined, 'auto', target);
        }
    }

    /**
     * Replaces older turns with the state of the work, asking `target` (the thread's model, or the fallback about to
     * be used: level 4) for its part in the request it would have made next; when it cannot answer, the state is the
     * engine's part alone. Before a compaction of its own (`auto`) the engine runs the host's PreCompact hooks; for
     * `/compact` the host has run them already.
     */
    async compact(
        level: 3 | 4,
        focus?: string,
        trigger: 'auto' | 'manual' = 'auto',
        target = resolveTarget(this.#session.config.model),
    ): Promise<boolean> {
        const session = this.#session;
        const fixed = this.#fixed(target);
        const budget = contextBudget(session, target, fixed);
        const shares = compactionShares({
            budget,
            fixed,
            used: currentContextTokens(session, fixed),
            estimated: estimatedContextTokens(session, fixed),
        });
        // `/compact` is the user asking for it: the state alone continues, however little there is to compact.
        const cut = compactionCut(session, trigger === 'manual' ? 0 : shares.tail);
        if (cut === undefined) {
            // Nothing older than the latest steps: masking what tool output there is is all that can be done.
            return maskToolResults(session, budget, { keep: 2, force: true });
        }
        if (trigger === 'auto' && this.#hookEnabled('PreCompact')) {
            await this.#runHook('PreCompact', { trigger: 'auto', custom_instructions: '' });
        }
        const id = `compaction-${Date.now()}`;
        this.#io.update({
            sessionUpdate: 'compaction_update',
            compactionId: id,
            status: 'started',
        } as acp.SessionUpdate);
        let asked: { text: string; done: Extract<ModelEvent, { type: 'done' }> } | undefined;
        try {
            asked = await this.#askState(target, focus);
        } catch {
            // The model could not answer: the state is the engine's records alone, which never fail.
        }
        if (this.#signal.aborted) {
            this.#io.update({
                sessionUpdate: 'compaction_update',
                compactionId: id,
                status: 'failed',
                error: 'cancelled',
            } as acp.SessionUpdate);
            return false;
        }
        const environment = environmentBlock(session.cwd, session.roots)
            .replace(/^<environment>\n/, '')
            .replace(/\n<\/environment>$/, '');
        const result = applyCompaction(session, cut, {
            level,
            ...(asked?.text ? { answer: asked.text } : {}),
            jobs: this.#runningJobs(),
            requestTokens: shares.requests,
            environment,
        });
        const candidates = result.added.flatMap((entry) =>
            entry.kind === 'fact' || entry.kind === 'deadend' || entry.kind === 'constraint'
                ? [
                      {
                          id: entry.id,
                          kind: entry.kind,
                          scope: entry.kind === 'constraint' ? 'user' : 'project',
                          note: entry.text,
                      },
                  ]
                : [],
        );
        this.#io.update({
            sessionUpdate: 'compaction_update',
            compactionId: id,
            status: 'completed',
            summary: [text(displayState(result.state))],
            _meta: {
                xora: {
                    level,
                    before: result.before,
                    after: result.after,
                    judged: result.judged,
                    ...(candidates.length > 0 ? { candidates } : {}),
                },
            },
        } as acp.SessionUpdate);
        this.#reportContext(asked ? { target, done: asked.done } : undefined);
        return true;
    }

    /**
     * The model's part of the state: the request it would have made next — same model, system prompt, tools and
     * messages, so the provider's cache covers all of it — with the compaction instruction at the end.
     */
    async #askState(
        target: ResolvedTarget,
        focus: string | undefined,
    ): Promise<{ text: string; done: Extract<ModelEvent, { type: 'done' }> }> {
        const session = this.#session;
        const request: ModelRequest = { ...this.#buildRequest(target), messages: compactionMessages(session, focus) };
        const run = () =>
            completeModel(target.connection, request, {
                signal: this.#signal,
                userAgent: session.config.userAgent,
                ...this.#streamTimeouts(target),
            });
        let done: Extract<ModelEvent, { type: 'done' }>;
        try {
            done = await run();
        } catch (error) {
            if (!(error instanceof ProviderError) || !error.retryable || this.#signal.aborted) {
                throw error;
            }
            await sleep(Math.min(10_000, error.retryAfterMs ?? 2000), this.#signal);
            done = await run();
        }
        const answer = done.message.content
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join('\n')
            .trim();
        return { text: answer, done };
    }

    /** Background jobs still running, one line each, for the state of the work. */
    #runningJobs(): string[] {
        return this.#session.jobs
            .list()
            .filter((job) => job.running)
            .map((job) => `${job.id}: \`${clipText(job.command, 120)}\``);
    }

    /**
     * The context as it is after a compaction, so the meter drops at once instead of at the next request (a manual
     * `/compact` has none); carries the summary request, counted like any other.
     */
    #reportContext(summary?: { target: ResolvedTarget; done: Extract<ModelEvent, { type: 'done' }> }): void {
        const session = this.#session;
        let target: ResolvedTarget;
        try {
            target = resolveTarget(session.config.model);
        } catch {
            return;
        }
        const fixed = this.#fixed(target);
        this.#io.update({
            sessionUpdate: 'usage_update',
            used: currentContextTokens(session, fixed),
            size: contextBudget(session, target, fixed),
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
        let emergencyCompacted = false;
        for (let index = 0; index < chain.length; index++) {
            const spec = chain[index];
            if (!spec) {
                continue;
            }
            const target = resolveTarget(spec);
            const hasFallback = index < chain.length - 1;
            const maxAttempts = hasFallback ? MAX_ATTEMPTS : MAX_FINAL_ATTEMPTS;
            if (index > 0) {
                this.#notice(
                    'warning',
                    this.#text.fallback(target.model.name),
                    lastError instanceof Error ? lastError.message : undefined,
                );
                // The fallback's window may be smaller: the context is kept within its budget, not the main model's.
                // Reasoning the main model wrote is not replayed to another vendor (07 §5 rule 2, done by the
                // providers), so nothing else needs to change.
                await this.#manageContext(target, 4);
            }
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const result = await this.#streamOnce(target);
                if (result.kind !== 'error') {
                    return result;
                }
                lastError = result.error;
                const error = result.error;
                if (this.#signal.aborted) {
                    return { kind: 'cancelled', partial: undefined };
                }
                if (error instanceof ProviderError && error.errorClass === 'context_length' && !emergencyCompacted) {
                    emergencyCompacted = true;
                    if (await this.compact(index > 0 ? 4 : 3, undefined, 'auto', target)) {
                        attempt--;
                        continue;
                    }
                }
                if (!(error instanceof ProviderError) || !error.retryable) {
                    if (error instanceof ProviderError && hasFallback && FALLBACK_ERRORS.has(error.errorClass)) {
                        break;
                    }
                    throw error instanceof ProviderError ? new ModelError(error) : error;
                }
                if (attempt === maxAttempts) {
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

    #streamTimeouts(target: ResolvedTarget): { firstByteTimeoutMs: number; idleTimeoutMs: number } {
        const effort = this.#session.config.effort;
        const heavyReasoning = effort === 'high' || effort === 'max' || target.model.reasoning.mode === 'always';
        return {
            firstByteTimeoutMs: heavyReasoning ? 240_000 : 180_000,
            idleTimeoutMs: 45_000,
        };
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
                ...this.#streamTimeouts(target),
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
        const fixed = fixedTokens(request.system, request.tools ?? []);
        const promptTokens = done.usage?.inputTokens ?? currentContextTokens(session, fixed);
        session.lastPromptTokens = promptTokens;
        // Estimated as the next request will be, tool definitions included, so the two compare like for like.
        session.lastPromptEstimate = estimatedContextTokens(session, fixed);
        this.#io.update({
            sessionUpdate: 'usage_update',
            used: promptTokens,
            size: contextBudget(session, target, fixed),
            _meta: { xora: { request: requestRecord(target, done) } },
        });
    }

    #reportFailure(target: ResolvedTarget, error: unknown): void {
        this.#io.update({
            sessionUpdate: 'usage_update',
            used: this.#session.lastPromptTokens,
            size: contextBudget(this.#session, target, this.#fixed(target)),
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
                // As a terminal would show it: a progress bar is its last frame, not every one of them.
                _meta: { xora: { liveOutput: renderTerminalText(tail) } },
            });
        };
        return {
            cwd: session.cwd,
            roots: [...session.roots, session.artifactsDir],
            signal: this.#signal,
            env: { ...sanitizeEnv(process.env), ...nonInteractiveEnv(), ...session.config.env },
            artifacts: { save: async (name, content) => session.saveArtifact(name, content) },
            jobs: session.jobs,
            files: {
                seen: (file) => session.files.get(file),
                note: (file, stamp) => {
                    session.files.set(file, stamp);
                },
            },
            outputs: { read: (ref) => readOutput(session, ref) },
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
            const ran = await call.tool.run(call.input, this.#toolContext(call));
            const result = await withEditDiagnostics(this.#lsp, this.#session, call.tool, ran, this.#signal);
            return call.note ? { ...result, content: `${result.content}\n\n${call.note}` } : result;
        } catch (error) {
            return {
                content: `Tool ${call.name} failed: ${error instanceof Error ? error.message : String(error)}`,
                isError: true,
            };
        }
    }

    /**
     * A model that makes the very same call again and again, with the very same result, is going round in a circle:
     * weaker models do when an edit keeps missing or a command keeps failing (21 §4.5). It is told so after the
     * result, the third time and every third after; a call whose result changes (a job being polled) never counts.
     * Like the todo reminder it goes to the model only, not into what the user sees of the call.
     */
    #repeatReminder(call: PreparedCall, result: ToolResult): string | undefined {
        const key = `${call.name}\n${JSON.stringify(call.input ?? null)}`;
        if (this.#repeat?.key === key && this.#repeat.result === result.content) {
            this.#repeat.count++;
        } else {
            this.#repeat = { key, result: result.content, count: 1 };
        }
        const count = this.#repeat.count;
        if (count % REPEAT_REMINDER_CALLS !== 0) {
            return undefined;
        }
        return `<system-reminder>You have now made exactly this ${call.name} call ${count} times in a row, and its result was the same every time. Making it again will not change anything: work with the result you have, change the arguments, or take another approach; if something blocks you, say what it is. Do not mention this reminder.</system-reminder>`;
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
        const repeated = this.#repeatReminder(call, result);
        const tail = this.#tail;
        const appended = tail && --tail.left === 0 ? tail.text() : undefined;
        const contextText = spillToolOutput(
            this.#session,
            this.#session.history.length,
            call.name,
            result.content,
            result.fullContent,
        );
        this.#session.append({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: [
                { type: 'text', text: contextText },
                ...(repeated ? [{ type: 'text' as const, text: repeated }] : []),
                ...(appended ? [{ type: 'text' as const, text: appended }] : []),
            ],
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
        const suffix = `\n\n<hook event="PostToolUse">\n${notes.join('\n')}\n</hook>`;
        return {
            ...result,
            content: `${result.content}${suffix}`,
            ...(result.fullContent !== undefined ? { fullContent: `${result.fullContent}${suffix}` } : {}),
        };
    }

    /**
     * `tail`: asked once every call of the batch has run, for text to add at the end of the last result.
     */
    async #executeCalls(
        calls: PreparedCall[],
        parts: readonly Extract<AssistantPart, { type: 'tool_call' }>[],
        truncated: boolean,
        tail?: () => string | undefined,
    ): Promise<void> {
        this.#tail = tail ? { left: parts.length, text: tail } : undefined;
        try {
            await this.#runBatch(calls, parts, truncated);
        } finally {
            this.#tail = undefined;
        }
    }

    /** `calls`: the calls of `parts`, prepared, in the same order; a hook may put another in a call's place. */
    async #runBatch(
        calls: PreparedCall[],
        parts: readonly Extract<AssistantPart, { type: 'tool_call' }>[],
        truncated: boolean,
    ): Promise<void> {
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
            // What the session was already allowed (stopping a job it started) is not asked about again, unless a
            // hook wants it confirmed.
            const decision =
                call.tool.unasked && !hooks[index]?.ask ? { allow: true } : await this.#authorize(call, hooks[index]);
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
