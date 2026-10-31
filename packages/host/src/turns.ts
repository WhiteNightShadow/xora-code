import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { SessionConfig } from '@xora/engine';
import {
    type Attachment,
    type ErrorClass,
    type FileChange,
    type Item,
    type ItemOf,
    type Money,
    type Project,
    RpcError,
    RpcErrorCode,
    type ThreadMeta,
    type ToolCallStatus,
    type ToolDisplay,
    ToolDisplaySchema,
    type ToolKind,
} from '@xora/protocol';
import { checkPathAccess, isReadOnlyCommand, isSensitivePath } from '@xora/tools';
import type { ApprovalService } from './approvals.ts';
import type { Bus } from './bus.ts';
import type { ConnectionService } from './connections.ts';
import type { EngineManager, EngineProcess, HostToolResult, ToolHookRequest } from './engines/manager.ts';
import { type EngineDefinition, engineById } from './engines/registry.ts';
import type { ExtensionService, SessionExtras } from './extensions.ts';
import { readMention } from './files.ts';
import { newId } from './ids.ts';
import type { Logger } from './log.ts';
import { type CallFacts, HIGH_RISK_LABELS, highRiskOf } from './policy.ts';
import type { ProjectService } from './projects.ts';
import type { PromptService } from './prompts.ts';
import type { ReviewService } from './review.ts';
import type { SettingsService } from './settings.ts';
import type { ShellApi } from './shell.ts';
import type { ThreadStore } from './threads.ts';
import type { UsageService } from './usage.ts';

/** JSON-RPC codes the xora engine uses for classified failures. */
const MODEL_ERROR_CODE = -32050;
const BUSY_ERROR_CODE = -32051;

const READ_KINDS: ReadonlySet<string> = new Set(['read', 'search', 'think']);

export interface TurnDeps {
    readonly threads: ThreadStore;
    readonly projects: ProjectService;
    readonly connections: ConnectionService;
    readonly settings: SettingsService;
    readonly prompts: PromptService;
    readonly approvals: ApprovalService;
    readonly review: ReviewService;
    readonly usage: UsageService;
    readonly engines: EngineManager;
    readonly bus: Bus;
    readonly shell: ShellApi;
    readonly log: Logger;
    readonly userAgent: string;
    /** Port reserved for a worktree thread (`XORA_PORT`). */
    readonly portFor?: (threadId: string) => Promise<number>;
    /** Called after every turn ends, for goal mode and team runs. */
    readonly onTurnEnded?: (event: TurnEnded) => void;
    /** Skills, slash commands, hooks and MCP servers of the thread's project (09). */
    readonly extensions?: ExtensionService;
}

/** Tools a thread gets from the host (the supervisor's team tools), with their handler. */
export interface HostToolProvider {
    readonly tools: ReadonlyArray<{
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        kind?: 'read' | 'edit' | 'search' | 'execute' | 'think' | 'fetch' | 'other';
    }>;
    /** Built-in tools this thread must not have. */
    readonly disabledTools?: readonly string[];
    /** Extra prompt layers for the thread (organisation and agent, 06 §4). */
    readonly layers?: ReadonlyArray<{ id: string; title: string; text: string }>;
    /**
     * A person approves every high-risk action of the thread (06 §8: push, publish, delete, external messages,
     * payments), whatever its mode, rules or hooks say. Threads of a team run always get this.
     */
    readonly highRiskApproval?: boolean;
    handle(name: string, input: unknown, signal: AbortSignal): Promise<HostToolResult>;
}

export interface TurnEnded {
    readonly threadId: string;
    readonly turnId: string;
    readonly outcome: 'completed' | 'cancelled' | 'failed';
    readonly stopReason?: string;
    /** The last agent message of the turn. */
    readonly lastText: string;
    readonly changedFiles: readonly string[];
}

function money(total: Money | null, add: Money | null): Money | null {
    if (!add) return total;
    if (!total) return add;
    return { amount: Math.round((total.amount + add.amount) * 1e6) / 1e6, currency: total.currency };
}

function textOf(content: readonly acp.ToolCallContent[] | null | undefined): string | undefined {
    if (!content) return undefined;
    const parts = content
        .map((entry) => (entry.type === 'content' && entry.content.type === 'text' ? entry.content.text : ''))
        .filter((text) => text.length > 0);
    return parts.length > 0 ? parts.join('\n') : undefined;
}

function diffDisplay(content: readonly acp.ToolCallContent[] | null | undefined): ToolDisplay | undefined {
    const diffs = (content ?? []).filter(
        (entry): entry is Extract<acp.ToolCallContent, { type: 'diff' }> => entry.type === 'diff',
    );
    if (diffs.length === 0) return undefined;
    return {
        kind: 'diff',
        diffs: diffs.map((diff) => ({ path: diff.path, oldText: diff.oldText ?? null, newText: diff.newText })),
    };
}

function xoraMeta(meta: unknown): Record<string, unknown> | undefined {
    const value = (meta as { xora?: unknown } | null | undefined)?.xora;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function toolKind(kind: string | null | undefined): ToolKind {
    const known: ToolKind[] = [
        'read',
        'edit',
        'delete',
        'move',
        'search',
        'execute',
        'think',
        'fetch',
        'switch_mode',
        'other',
    ];
    return known.includes(kind as ToolKind) ? (kind as ToolKind) : 'other';
}

async function promptBlocks(
    text: string,
    attachments: readonly Attachment[],
    cwd: string,
): Promise<acp.ContentBlock[]> {
    const blocks: acp.ContentBlock[] = [];
    if (text.trim().length > 0) {
        blocks.push({ type: 'text', text });
    }
    for (const attachment of attachments) {
        if (attachment.kind === 'image' && attachment.data) {
            blocks.push({ type: 'image', data: attachment.data, mimeType: attachment.mimeType });
        } else if (attachment.kind === 'text' && attachment.data !== undefined) {
            blocks.push({
                type: 'resource',
                resource: {
                    uri: `file:///${encodeURIComponent(attachment.path ?? attachment.name)}`,
                    text: attachment.data,
                    mimeType: attachment.mimeType,
                },
            });
        } else if (attachment.path) {
            // @ mentions: embed small text files so the model does not need a read call.
            const mention = await readMention(cwd, attachment.path);
            if (mention) {
                blocks.push({
                    type: 'resource',
                    resource: { uri: `file:///${mention.path}`, text: mention.text, mimeType: 'text/plain' },
                });
            } else {
                blocks.push({ type: 'resource_link', name: attachment.name, uri: `file://${attachment.path}` });
            }
        }
    }
    return blocks;
}

/** State of one running turn: in-flight items and accumulated usage. */
class RunningTurn {
    readonly threadId: string;
    readonly turnId: string;
    readonly projectId: string;
    readonly cwd: string;
    readonly engine: EngineDefinition;
    readonly startedAt = Date.now();
    readonly abort = new AbortController();
    readonly live = new Map<string, Item>();
    readonly toolItems = new Map<string, string>();
    sessionId: string | undefined;
    process: EngineProcess | undefined;
    text: ItemOf<'agent_message'> | undefined;
    reasoning: ItemOf<'reasoning'> | undefined;
    requests = 0;
    inputTokens = 0;
    cachedTokens = 0;
    outputTokens = 0;
    cost: Money | null = null;
    before: string | undefined;
    exited: string | undefined;
    newSession = false;
    lastText = '';
    /** `session/load` replays the history as updates; those belong to earlier turns and are ignored. */
    replaying = false;
    /** What the project's extensions give this turn; read once when the turn starts. */
    extras: SessionExtras | undefined;

    constructor(thread: ThreadMeta, cwd: string, engine: EngineDefinition, turnId: string) {
        this.threadId = thread.id;
        this.turnId = turnId;
        this.projectId = thread.projectId;
        this.cwd = cwd;
        this.engine = engine;
    }
}

/**
 * Runs turns: snapshot the work tree, drive the engine session over ACP, turn its updates into thread items,
 * route its permission requests through policy and approval cards, then diff the result.
 */
export class TurnService {
    readonly #deps: TurnDeps;
    readonly #running = new Map<string, RunningTurn>();
    readonly #hostTools = new Map<string, HostToolProvider>();
    readonly #mcpWarned = new Map<string, Set<string>>();
    #sleepBlocked = false;

    constructor(deps: TurnDeps) {
        this.#deps = deps;
    }

    /** Extra prompt layers a thread gets from its host tools (organisation, roster and agent of a team run). */
    hostLayers(threadId: string): ReadonlyArray<{ id: string; title: string; text: string }> {
        return this.#hostTools.get(threadId)?.layers ?? [];
    }

    /** Gives a thread host-implemented tools and extra prompt layers (used by team runs). */
    setHostTools(threadId: string, provider: HostToolProvider | undefined): void {
        if (provider) this.#hostTools.set(threadId, provider);
        else this.#hostTools.delete(threadId);
    }

    get runningCount(): number {
        return this.#running.size;
    }

    isRunning(threadId: string): boolean {
        return this.#running.has(threadId);
    }

    live(threadId: string): Item[] {
        return [...(this.#running.get(threadId)?.live.values() ?? [])];
    }

    /** Working directory of a thread: the project folder, or its worktree. */
    cwdOf(thread: ThreadMeta, project: Project): string {
        return thread.location.kind === 'worktree' ? thread.location.path : project.path;
    }

    async start(threadId: string, text: string, attachments: readonly Attachment[] = []): Promise<string> {
        const { threads, projects, connections, settings } = this.#deps;
        const thread = threads.get(threadId);
        if (this.#running.has(threadId)) {
            throw new RpcError(RpcErrorCode.Rejected, '这个线程正在运行，等它完成或先停止');
        }
        if (text.trim().length === 0 && attachments.length === 0) {
            throw new RpcError(RpcErrorCode.InvalidParams, '消息不能为空');
        }
        const project = await projects.get(thread.projectId);
        if (project.missing) {
            throw new RpcError(RpcErrorCode.Rejected, `项目文件夹不存在：${project.path}`);
        }
        if (thread.location.kind === 'worktree' && !existsSync(thread.location.path)) {
            throw new RpcError(RpcErrorCode.Rejected, '这个线程的worktree已经删除，不能继续运行');
        }
        const engine = engineById(thread.engine);
        if (!engine) {
            throw new RpcError(RpcErrorCode.Rejected, `未知的引擎：${thread.engine}`);
        }
        const modelRef = thread.model ?? project.defaults?.model ?? settings.get().defaultModel;
        if (engine.kind === 'builtin') {
            if (!modelRef) {
                throw new RpcError(RpcErrorCode.Rejected, '还没有选择模型：先在设置里连接一个模型');
            }
            await connections.engineConfig(modelRef.connectionId);
        }
        this.#checkBudget();

        const turnId = newId('turn');
        const userItem: ItemOf<'user_message'> = {
            id: newId('i'),
            turnId,
            ts: Date.now(),
            type: 'user_message',
            text,
            attachments: attachments.map((attachment) =>
                attachment.kind === 'image'
                    ? { ...attachment, data: undefined, size: attachment.data?.length }
                    : attachment,
            ) as Attachment[],
        };
        const cwd = this.cwdOf(thread, project);
        const running = new RunningTurn(thread, cwd, engine, turnId);
        this.#running.set(threadId, running);
        threads.append(
            threadId,
            'turn.started',
            { turnId, input: userItem, model: modelRef ?? null, mode: thread.mode, effort: thread.effort },
            { turnId, itemId: userItem.id },
        );
        threads.update(threadId, {
            status: 'running',
            needsReview: false,
            unread: false,
            turns: thread.turns + 1,
            ...(thread.model || !modelRef ? {} : { model: modelRef }),
        });
        projects.touch(thread.projectId);
        this.#updateSleep();
        void this.#run(running, thread, project, (extras) =>
            promptBlocks((extras && this.#deps.extensions?.expandSlash(extras, text)) ?? text, attachments, cwd),
        );
        return turnId;
    }

    cancel(threadId: string): void {
        const running = this.#running.get(threadId);
        if (!running) {
            return;
        }
        // Tell the engine first, so a pending approval that resolves as cancelled is read as a cancelled turn.
        if (running.process && running.sessionId) {
            running.process.agent.notify('session/cancel', { sessionId: running.sessionId }).catch(() => undefined);
        }
        running.abort.abort();
        this.#deps.approvals.cancelThread(threadId);
    }

    #checkBudget(): void {
        const { budgets } = this.#deps.settings.get();
        const now = new Date();
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        if (budgets.dailyLimit !== null && this.#deps.usage.spentSince(dayStart) >= budgets.dailyLimit) {
            throw new RpcError(RpcErrorCode.Rejected, '今日花费已到预算上限，可以在设置→用量与预算里调整');
        }
        if (budgets.monthlyLimit !== null && this.#deps.usage.spentSince(monthStart) >= budgets.monthlyLimit) {
            throw new RpcError(RpcErrorCode.Rejected, '本月花费已到预算上限，可以在设置→用量与预算里调整');
        }
    }

    #updateSleep(): void {
        const want = this.#running.size > 0 && this.#deps.settings.get().preventSleep;
        if (want !== this.#sleepBlocked) {
            this.#sleepBlocked = want;
            this.#deps.shell.preventSleep(want).catch(() => undefined);
        }
        const running = [...this.#running.keys()].flatMap((threadId) => {
            const thread = this.#deps.threads.find(threadId);
            return thread ? [{ threadId, title: thread.title, status: thread.status }] : [];
        });
        this.#deps.shell.updateTray(running).catch(() => undefined);
    }

    async #sessionConfig(
        thread: ThreadMeta,
        project: Project,
        cwd: string,
        extras: SessionExtras | undefined,
    ): Promise<SessionConfig> {
        const { connections, settings, prompts, threads } = this.#deps;
        const current = settings.get();
        const modelRef = thread.model ?? project.defaults?.model ?? current.defaultModel;
        if (!modelRef) {
            throw new RpcError(RpcErrorCode.Rejected, '还没有选择模型');
        }
        const provider = this.#hostTools.get(thread.id);
        const baseLayers = prompts.engineLayers({
            projectId: project.id,
            projectRoot: project.path,
            cwd,
            sessionPrompt: threads.sessionPrompt(thread.id),
        });
        // Organisation and agent layers go after the user's global layer and before the project layers (08 §1.2).
        const extra = provider?.layers ?? [];
        const globalIndex = baseLayers.findIndex((layer) => layer.id === 'user_global_instructions');
        const layers = [
            ...baseLayers.slice(0, globalIndex + 1),
            ...extra,
            ...baseLayers.slice(globalIndex + 1),
            ...(extras?.layers ?? []),
        ];
        const ownTools = provider?.tools ?? [];
        const tools = [
            ...ownTools,
            ...(extras?.tools ?? []).filter((tool) => !ownTools.some((own) => own.name === tool.name)),
        ];
        const fast = current.fastModel;
        return {
            model: { connection: await connections.engineConfig(modelRef.connectionId), model: modelRef.model },
            fallbacks: [],
            ...(fast
                ? { fastModel: { connection: await connections.engineConfig(fast.connectionId), model: fast.model } }
                : {}),
            effort: thread.effort,
            mode: thread.mode,
            layers,
            softContextWindow: current.softContextWindow,
            maxTurnRequests: 200,
            userAgent: this.#deps.userAgent,
            env:
                thread.location.kind === 'worktree' && this.#deps.portFor
                    ? { XORA_PORT: String(await this.#deps.portFor(thread.id)) }
                    : {},
            hostTools: tools.map((tool) => ({ ...tool, kind: tool.kind ?? 'other' })),
            disabledTools: [...(provider?.disabledTools ?? [])],
            hookEvents: [...(extras?.hookEvents ?? [])],
        };
    }

    /**
     * External agents get Xora's prompt layers as a labelled block in front of the first prompt (08 §1.3); Xora
     * never writes their instruction files into the user's repository.
     */
    #externalInstructions(thread: ThreadMeta, project: Project, cwd: string): acp.ContentBlock[] {
        const layers = this.#deps.prompts
            .layers({
                projectId: project.id,
                projectRoot: project.path,
                cwd,
                sessionPrompt: this.#deps.threads.sessionPrompt(thread.id),
            })
            // External agents read AGENTS.md themselves.
            .filter((layer) => layer.id !== 'project_instructions');
        if (layers.length === 0) {
            return [];
        }
        const text = layers
            .map((layer) => `<${layer.id} source="${layer.source}">\n${layer.text}\n</${layer.id}>`)
            .join('\n\n');
        return [{ type: 'text', text: `<instructions>\n${text}\n</instructions>` }];
    }

    async #openSession(running: RunningTurn, thread: ThreadMeta, project: Project): Promise<void> {
        const { engines, threads } = this.#deps;
        const process = await engines.connect(running.engine, project.id);
        running.process = process;
        const meta = process.isXora
            ? { xora: await this.#sessionConfig(thread, project, running.cwd, running.extras) }
            : undefined;
        const mcpServers = (this.#deps.extensions?.mcpServersFor(
            running.extras,
            process.isXora ? { http: true, sse: true } : (process.capabilities.mcpCapabilities ?? {}),
        ) ?? []) as acp.McpServer[];
        const existing = threads.sessionId(thread.id);
        let sessionId: string | undefined;
        let opened: unknown;
        if (existing && (process.supportsResume || process.supportsLoad)) {
            try {
                engines.register(existing, process.key, this.#handlers(running));
                if (process.supportsResume) {
                    opened = await process.agent.request('session/resume', {
                        sessionId: existing,
                        cwd: running.cwd,
                        mcpServers,
                        ...(meta ? { _meta: meta } : {}),
                    });
                } else {
                    running.replaying = true;
                    opened = await process.agent.request('session/load', {
                        sessionId: existing,
                        cwd: running.cwd,
                        mcpServers,
                        ...(meta ? { _meta: meta } : {}),
                    });
                }
                running.replaying = false;
                sessionId = existing;
            } catch (error) {
                running.replaying = false;
                engines.unregister(existing);
                this.#deps.log.warn(
                    `could not resume session ${existing}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        } else if (existing && process.isXora) {
            sessionId = existing;
        }
        if (!sessionId) {
            const created = await process.agent.request('session/new', {
                cwd: running.cwd,
                mcpServers,
                ...(meta ? { _meta: meta } : {}),
            });
            sessionId = created.sessionId;
            opened = created;
            running.newSession = true;
            threads.update(thread.id, { sessionId }, { touch: false });
            engines.register(sessionId, process.key, this.#handlers(running));
        } else if (meta && process.isXora && !process.supportsResume) {
            await process.agent.request('_xora/session/configure', { sessionId, _meta: meta });
        }
        running.sessionId = sessionId;
        this.#mcpReport(running, (opened as { _meta?: { xora?: { mcp?: unknown } } } | undefined)?._meta?.xora?.mcp);
    }

    /** MCP servers the engine could not start get one notice per thread and error (09 §2). */
    #mcpReport(running: RunningTurn, value: unknown): void {
        if (!Array.isArray(value)) {
            return;
        }
        const statuses = value.flatMap((entry) => {
            const item = entry as { name?: unknown; status?: unknown; tools?: unknown; error?: unknown };
            return typeof item.name === 'string' && typeof item.status === 'string'
                ? [
                      {
                          name: item.name,
                          status: item.status,
                          tools: typeof item.tools === 'number' ? item.tools : 0,
                          ...(typeof item.error === 'string' ? { error: item.error } : {}),
                      },
                  ]
                : [];
        });
        this.#deps.extensions?.reportMcp(running.projectId, statuses);
        let warned = this.#mcpWarned.get(running.threadId);
        for (const status of statuses) {
            if (status.status !== 'failed') continue;
            const key = `${status.name}:${status.error ?? ''}`;
            warned ??= new Set();
            if (warned.has(key)) continue;
            warned.add(key);
            this.#notice(running, 'warning', `mcp服务器${status.name}没有启动`, status.error);
        }
        if (warned) this.#mcpWarned.set(running.threadId, warned);
    }

    /** Reads the project's extensions for a turn; a broken extension never stops the turn. */
    async #loadExtras(project: Project): Promise<SessionExtras | undefined> {
        const extensions = this.#deps.extensions;
        if (!extensions) {
            return undefined;
        }
        try {
            return await extensions.forSession(project);
        } catch (error) {
            this.#deps.log.warn(`extensions: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    /**
     * SessionStart (new sessions) and UserPromptSubmit hooks (09 §4). Returns context blocks to put in front of the
     * prompt, or `undefined` when a hook blocked the prompt.
     */
    async #promptHooks(
        running: RunningTurn,
        blocks: readonly acp.ContentBlock[],
    ): Promise<acp.ContentBlock[] | undefined> {
        const extensions = this.#deps.extensions;
        const extras = running.extras;
        if (!extensions || !extras) {
            return [];
        }
        const base = { sessionId: running.threadId, cwd: running.cwd, signal: running.abort.signal };
        const context: acp.ContentBlock[] = [];
        const note = (event: string, text: string) =>
            context.push({ type: 'text', text: `<hook_context event="${event}">\n${text}\n</hook_context>` });
        try {
            if (running.newSession) {
                const started = await extensions.runHook(extras, 'SessionStart', {
                    ...base,
                    targets: ['startup'],
                    payload: { source: 'startup' },
                });
                if (started?.additionalContext) note('SessionStart', started.additionalContext);
            }
            const prompt = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
            const submitted = await extensions.runHook(extras, 'UserPromptSubmit', { ...base, payload: { prompt } });
            if (submitted?.blocked) {
                this.#notice(
                    running,
                    'warning',
                    'hook拦截了这条消息',
                    submitted.reason ?? submitted.messages.join('\n'),
                );
                return undefined;
            }
            if (submitted?.additionalContext) note('UserPromptSubmit', submitted.additionalContext);
        } catch (error) {
            this.#notice(running, 'warning', 'hook运行失败', error instanceof Error ? error.message : String(error));
        }
        return context;
    }

    /** Fire-and-forget hooks (Stop, Notification); failures are only logged. */
    #sideHook(
        running: RunningTurn,
        event: 'Stop' | 'Notification',
        targets: string[],
        payload: Record<string, unknown>,
    ): void {
        const extensions = this.#deps.extensions;
        const extras = running.extras;
        if (!extensions || !extras) {
            return;
        }
        void extensions
            .runHook(extras, event, { sessionId: running.threadId, cwd: running.cwd, targets, payload })
            .catch((error: unknown) => this.#deps.log.warn(`${event} hook: ${String(error)}`));
    }

    #notice(running: RunningTurn, severity: 'info' | 'warning' | 'error', title: string, description?: string): void {
        this.#apply(running, {
            sessionUpdate: 'notice',
            severity,
            title,
            ...(description ? { description } : {}),
        } as unknown as acp.SessionUpdate);
    }

    async #run(
        running: RunningTurn,
        thread: ThreadMeta,
        project: Project,
        prepare: (extras: SessionExtras | undefined) => Promise<acp.ContentBlock[]>,
    ): Promise<void> {
        const { threads, review, engines } = this.#deps;
        try {
            running.extras = await this.#loadExtras(project);
            const blocks = await prepare(running.extras);
            running.before = await review.snapshot(running.cwd, `thread-${running.threadId}`);
            threads.startTurn(running.threadId, running.turnId, running.before);
            if (running.abort.signal.aborted) {
                await this.#finish(running, 'cancelled');
                return;
            }
            await this.#openSession(running, thread, project);
            const sessionId = running.sessionId;
            if (!sessionId || !running.process) {
                throw new Error('no engine session');
            }
            if (running.abort.signal.aborted) {
                await this.#finish(running, 'cancelled');
                return;
            }
            const command =
                blocks.length === 1 && blocks[0]?.type === 'text'
                    ? /^\/compact(?:\s+([\s\S]*))?$/.exec(blocks[0].text.trim())
                    : null;
            if (command && running.process.isXora) {
                // `/compact [focus]`: summarise older turns now instead of prompting (08 §3).
                const focus = command[1]?.trim();
                if (running.extras && this.#deps.extensions) {
                    await this.#deps.extensions
                        .runHook(running.extras, 'PreCompact', {
                            sessionId: running.threadId,
                            cwd: running.cwd,
                            targets: ['manual'],
                            payload: { trigger: 'manual', custom_instructions: focus ?? '' },
                        })
                        .catch((error: unknown) => this.#deps.log.warn(`PreCompact hook: ${String(error)}`));
                }
                await running.process.agent.request('_xora/session/compact', {
                    sessionId,
                    ...(focus ? { focus } : {}),
                });
                await this.#finish(running, 'end_turn');
                return;
            }
            const context = await this.#promptHooks(running, blocks);
            if (!context) {
                await this.#finish(running, 'refusal');
                return;
            }
            const prompt = [
                ...(!running.process.isXora && running.newSession
                    ? this.#externalInstructions(thread, project, running.cwd)
                    : []),
                ...context,
                ...blocks,
            ];
            const response = await running.process.agent.request('session/prompt', {
                sessionId,
                prompt,
                // The xora engine marks where each host turn starts, for rewind and fork (M3-3).
                ...(running.process.isXora ? { _meta: { xora: { turnId: running.turnId } } } : {}),
            });
            await this.#finish(running, response.stopReason);
        } catch (error) {
            if (running.abort.signal.aborted && !running.exited) {
                await this.#finish(running, 'cancelled');
            } else {
                await this.#fail(running, error);
            }
        } finally {
            if (running.sessionId) {
                engines.unregister(running.sessionId);
            }
            this.#running.delete(running.threadId);
            this.#updateSleep();
        }
    }

    // Updates → items ---------------------------------------------------------------------------------------

    #handlers(running: RunningTurn) {
        return {
            onUpdate: (notification: acp.SessionNotification) => {
                if (running.replaying) {
                    return;
                }
                try {
                    this.#apply(running, notification.update);
                } catch (error) {
                    this.#deps.log.warn(
                        `bad session update: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            },
            onPermission: (request: acp.RequestPermissionRequest, signal: AbortSignal) =>
                this.#permission(running, request, signal),
            onExit: (reason: string) => {
                running.exited = reason;
            },
            onHook: (request: ToolHookRequest, signal: AbortSignal) => {
                const extensions = this.#deps.extensions;
                if (!extensions || !running.extras) {
                    return Promise.resolve({});
                }
                return extensions.runToolHook(running.extras, request.event, request.payload, {
                    sessionId: running.threadId,
                    cwd: running.cwd,
                    signal,
                });
            },
            onHostTool: async (name: string, input: unknown, signal: AbortSignal): Promise<HostToolResult> => {
                const provider = this.#hostTools.get(running.threadId);
                const extensions = this.#deps.extensions;
                if (
                    !provider?.tools.some((tool) => tool.name === name) &&
                    extensions &&
                    running.extras?.tools.some((tool) => tool.name === name)
                ) {
                    try {
                        return await extensions.handleTool(running.extras, name, input);
                    } catch (error) {
                        return {
                            content: `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
                            isError: true,
                        };
                    }
                }
                if (!provider) {
                    return { content: `Tool ${name} is not available in this thread.`, isError: true };
                }
                try {
                    return await provider.handle(name, input, signal);
                } catch (error) {
                    return {
                        content: `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
                        isError: true,
                    };
                }
            },
        };
    }

    #persist(running: RunningTurn, item: Item, kind: 'item.started' | 'item.completed' = 'item.completed'): void {
        this.#deps.threads.append(running.threadId, kind, { item }, { turnId: running.turnId, itemId: item.id });
        if (kind === 'item.completed') {
            running.live.delete(item.id);
        } else {
            running.live.set(item.id, item);
        }
    }

    #closeText(running: RunningTurn): void {
        if (running.text) {
            const item = running.text;
            running.text = undefined;
            running.lastText = item.text || running.lastText;
            if (item.text.length > 0) this.#persist(running, item);
            else running.live.delete(item.id);
        }
        if (running.reasoning) {
            const item = running.reasoning;
            running.reasoning = undefined;
            if (item.text.length > 0) this.#persist(running, item);
            else running.live.delete(item.id);
        }
    }

    #delta(running: RunningTurn, stream: 'agent_message' | 'reasoning', text: string): void {
        if (stream === 'agent_message') {
            if (running.reasoning) {
                const item = running.reasoning;
                running.reasoning = undefined;
                if (item.text.length > 0) this.#persist(running, item);
            }
            running.text ??= {
                id: newId('i'),
                turnId: running.turnId,
                ts: Date.now(),
                type: 'agent_message',
                text: '',
            };
            running.text = { ...running.text, text: running.text.text + text };
            running.live.set(running.text.id, running.text);
            this.#deps.bus.toThread(running.threadId, 'thread.delta', {
                threadId: running.threadId,
                turnId: running.turnId,
                itemId: running.text.id,
                stream,
                text,
            });
        } else {
            if (running.text) {
                const item = running.text;
                running.text = undefined;
                running.lastText = item.text || running.lastText;
                if (item.text.length > 0) this.#persist(running, item);
            }
            running.reasoning ??= {
                id: newId('i'),
                turnId: running.turnId,
                ts: Date.now(),
                type: 'reasoning',
                text: '',
            };
            running.reasoning = { ...running.reasoning, text: running.reasoning.text + text };
            running.live.set(running.reasoning.id, running.reasoning);
            this.#deps.bus.toThread(running.threadId, 'thread.delta', {
                threadId: running.threadId,
                turnId: running.turnId,
                itemId: running.reasoning.id,
                stream,
                text,
            });
        }
    }

    #apply(running: RunningTurn, update: acp.SessionUpdate): void {
        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                if (update.content.type === 'text') this.#delta(running, 'agent_message', update.content.text);
                return;
            case 'agent_thought_chunk':
                if (update.content.type === 'text') this.#delta(running, 'reasoning', update.content.text);
                return;
            case 'tool_call':
                this.#toolCall(running, update);
                return;
            case 'tool_call_update':
                this.#toolCallUpdate(running, update);
                return;
            case 'plan': {
                const item: ItemOf<'plan'> = {
                    id: `plan-${running.turnId}`,
                    turnId: running.turnId,
                    ts: Date.now(),
                    type: 'plan',
                    entries: update.entries.map((entry) => ({
                        content: entry.content,
                        status: entry.status,
                        priority: entry.priority,
                    })),
                };
                this.#persist(running, item);
                return;
            }
            case 'usage_update':
                this.#usage(running, update);
                return;
            case 'notice': {
                this.#closeText(running);
                const severity =
                    update.severity === 'error' || update.severity === 'warning' ? update.severity : 'info';
                this.#persist(running, {
                    id: newId('i'),
                    turnId: running.turnId,
                    ts: Date.now(),
                    type: 'notice',
                    severity,
                    title: update.title,
                    ...(update.description ? { description: update.description } : {}),
                });
                return;
            }
            case 'compaction_update': {
                this.#closeText(running);
                const meta = xoraMeta(update._meta);
                const id = `compaction-${update.compactionId}`;
                const summary = update.summary?.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
                const item: ItemOf<'compaction'> = {
                    id,
                    turnId: running.turnId,
                    ts: Date.now(),
                    type: 'compaction',
                    status:
                        update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : 'started',
                    level: typeof meta?.level === 'number' ? Math.min(4, Math.max(1, meta.level)) : 3,
                    ...(summary ? { summary } : {}),
                    ...(typeof meta?.before === 'number' ? { before: meta.before } : {}),
                    ...(typeof meta?.after === 'number' ? { after: meta.after } : {}),
                };
                this.#persist(running, item, item.status === 'started' ? 'item.started' : 'item.completed');
                return;
            }
            default:
                return;
        }
    }

    #toolCall(running: RunningTurn, update: acp.ToolCall): void {
        this.#closeText(running);
        const meta = xoraMeta(update._meta);
        const item: ItemOf<'tool_call'> = {
            id: newId('i'),
            turnId: running.turnId,
            ts: Date.now(),
            type: 'tool_call',
            toolCallId: update.toolCallId,
            ...(typeof meta?.name === 'string' ? { name: meta.name } : update.name ? { name: update.name } : {}),
            title: update.title,
            kind: toolKind(update.kind),
            status: (update.status as ToolCallStatus | undefined) ?? 'pending',
            ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
            ...(update.locations
                ? {
                      locations: update.locations.map((location) => ({
                          path: location.path,
                          ...(location.line ? { line: location.line } : {}),
                      })),
                  }
                : {}),
        };
        running.toolItems.set(update.toolCallId, item.id);
        if (item.status === 'completed' || item.status === 'failed') {
            this.#persist(running, { ...item, ...(textOf(update.content) ? { output: textOf(update.content) } : {}) });
        } else {
            this.#persist(running, item, 'item.started');
        }
    }

    #toolCallUpdate(running: RunningTurn, update: acp.ToolCallUpdate): void {
        const itemId = running.toolItems.get(update.toolCallId);
        const current = itemId ? running.live.get(itemId) : undefined;
        if (current?.type !== 'tool_call') {
            return;
        }
        const meta = xoraMeta(update._meta);
        const displayParse = meta?.display ? ToolDisplaySchema.safeParse(meta.display) : undefined;
        const display = displayParse?.success ? displayParse.data : diffDisplay(update.content);
        let status: ToolCallStatus = (update.status as ToolCallStatus | null | undefined) ?? current.status;
        if (meta?.denied === true) status = 'denied';
        if (meta?.cancelled === true) status = 'cancelled';
        const output = typeof meta?.liveOutput === 'string' ? meta.liveOutput : textOf(update.content);
        const next: ItemOf<'tool_call'> = {
            ...current,
            status,
            ...(update.title ? { title: update.title } : {}),
            ...(update.kind ? { kind: toolKind(update.kind) } : {}),
            ...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(display ? { display } : {}),
            ...(update.locations
                ? {
                      locations: update.locations.map((location) => ({
                          path: location.path,
                          ...(location.line ? { line: location.line } : {}),
                      })),
                  }
                : {}),
            ...(typeof meta?.durationMs === 'number' ? { durationMs: meta.durationMs } : {}),
        };
        if (status === 'completed' || status === 'failed' || status === 'denied' || status === 'cancelled') {
            running.toolItems.delete(update.toolCallId);
            this.#persist(running, next);
        } else {
            running.live.set(next.id, next);
            this.#deps.bus.toThread(running.threadId, 'thread.item', { threadId: running.threadId, item: next });
        }
    }

    #usage(running: RunningTurn, update: Extract<acp.SessionUpdate, { sessionUpdate: 'usage_update' }>): void {
        const { threads, usage, bus } = this.#deps;
        const request = xoraMeta(update._meta)?.request as
            | {
                  provider: string;
                  channel?: string;
                  model: string;
                  pricing?: string;
                  usage: {
                      inputTokens: number;
                      cachedTokens: number;
                      cacheWriteTokens: number;
                      outputTokens: number;
                      reasoningTokens: number;
                  } | null;
                  latencyMs: number;
                  ttftMs?: number;
                  stopReason?: string;
                  status: 'ok' | 'error';
                  errorClass?: string;
              }
            | undefined;
        let cost: Money | null = null;
        if (request) {
            const owner = threads.find(running.threadId);
            const recorded = usage.record({
                projectId: running.projectId,
                threadId: running.threadId,
                turnId: running.turnId,
                ...(owner?.agentId ? { agentId: owner.agentId, agentPath: owner.agentId } : {}),
                ...(owner?.taskId ? { taskId: owner.taskId } : {}),
                ...(owner?.teamRunId ? { workflowRunId: owner.teamRunId } : {}),
                ...(owner?.role ? { role: owner.role } : {}),
                ...(owner?.tier ? { tier: owner.tier } : {}),
                engine: running.engine.id,
                provider: request.provider,
                ...(request.channel ? { channel: request.channel } : {}),
                model: request.model,
                ...(request.pricing ? { pricing: request.pricing } : {}),
                usage: request.usage,
                latencyMs: request.latencyMs,
                ...(request.ttftMs !== undefined ? { ttftMs: request.ttftMs } : {}),
                status: request.status,
                ...(request.errorClass ? { errorClass: request.errorClass } : {}),
                ...(request.stopReason ? { stopReason: request.stopReason } : {}),
                source: request.usage ? 'vendor' : 'estimate',
            });
            cost = recorded.cost;
            if (request.usage) {
                running.requests++;
                running.inputTokens += request.usage.inputTokens;
                running.cachedTokens += request.usage.cachedTokens;
                running.outputTokens += request.usage.outputTokens;
            }
        } else if (update.cost) {
            cost = usage.toDisplay({ amount: update.cost.amount, currency: update.cost.currency });
        }
        running.cost = money(running.cost, cost);
        const thread = threads.get(running.threadId);
        threads.update(
            running.threadId,
            {
                context: { used: update.used, size: update.size },
                ...(cost ? { cost: money(thread.cost, cost) } : {}),
            },
            { touch: false },
        );
        bus.broadcast('usage.changed', { threadId: running.threadId, ...(cost ? { cost } : {}) });
    }

    // Permissions -----------------------------------------------------------------------------------------

    /** Whether a person approves every high-risk action of the thread (06 §8): team runs and opted-in threads. */
    #guardsHighRisk(threadId: string): boolean {
        return (
            this.#deps.threads.find(threadId)?.teamRunId !== undefined ||
            this.#hostTools.get(threadId)?.highRiskApproval === true
        );
    }

    async #facts(running: RunningTurn, request: acp.RequestPermissionRequest): Promise<CallFacts> {
        const meta = xoraMeta(request._meta);
        const kind = toolKind(request.toolCall.kind);
        const rawInput = request.toolCall.rawInput as Record<string, unknown> | undefined;
        const command =
            typeof meta?.command === 'string'
                ? meta.command
                : typeof rawInput?.command === 'string'
                  ? rawInput.command
                  : undefined;
        const paths = Array.isArray(meta?.targets)
            ? (meta.targets as string[])
            : (request.toolCall.locations ?? []).map((location) => location.path);
        const roots = [running.cwd];
        let outside: string[];
        let sensitive: string[];
        if (Array.isArray(meta?.outside) && Array.isArray(meta?.sensitive)) {
            outside = meta.outside as string[];
            sensitive = meta.sensitive as string[];
        } else {
            // External agents report locations only; check them the same way the xora engine does.
            outside = [];
            sensitive = [];
            for (const file of paths) {
                const access = await checkPathAccess(roots, file);
                if (!access.ok) outside.push(file);
                if (
                    isSensitivePath(file, os.homedir()) ||
                    (access.ok && isSensitivePath(access.realPath, os.homedir()))
                ) {
                    sensitive.push(file);
                }
            }
        }
        const toolName = typeof meta?.toolName === 'string' ? meta.toolName : (request.toolCall.title ?? 'tool');
        const highRisk = this.#guardsHighRisk(running.threadId)
            ? highRiskOf({ toolName, command }, { cwd: running.cwd })
            : undefined;
        return {
            toolName,
            kind,
            readOnly: typeof meta?.readOnly === 'boolean' ? meta.readOnly : READ_KINDS.has(kind),
            ...(command !== undefined ? { command } : {}),
            ...(command !== undefined
                ? {
                      readOnlyCommand:
                          typeof meta?.readOnlyCommand === 'boolean'
                              ? meta.readOnlyCommand
                              : isReadOnlyCommand(command),
                  }
                : {}),
            paths,
            outside,
            sensitive,
            external: running.engine.kind === 'external',
            ...(highRisk ? { highRisk } : {}),
        };
    }

    async #permission(
        running: RunningTurn,
        request: acp.RequestPermissionRequest,
        signal: AbortSignal,
    ): Promise<acp.RequestPermissionResponse> {
        const { approvals, threads, settings, bus, shell } = this.#deps;
        const allowOption =
            request.options.find((option) => option.kind === 'allow_once') ??
            request.options.find((option) => option.kind.startsWith('allow'));
        const rejectOption =
            request.options.find((option) => option.kind === 'reject_once') ??
            request.options.find((option) => option.kind.startsWith('reject'));
        const select = (allow: boolean, message?: string): acp.RequestPermissionResponse => {
            const option = allow ? allowOption : rejectOption;
            if (!option) return { outcome: { outcome: 'cancelled' } };
            return {
                outcome: { outcome: 'selected', optionId: option.optionId },
                ...(message ? { _meta: { xora: { message } } } : {}),
            };
        };
        const thread = threads.get(running.threadId);
        const facts = await this.#facts(running, request);
        const policy = approvals.evaluate(running.threadId, facts, {
            mode: thread.mode,
            projectId: running.projectId,
            projectRoot: running.cwd,
        });
        // A trusted PreToolUse hook may ask for a confirmation the policy would skip, or waive one it would ask
        // for; it never overrides a deny, a path outside the workspace, a secret file or a high-risk action (09 §4).
        const hookDecision = (request._meta as { xora?: { hookDecision?: unknown } } | null | undefined)?.xora
            ?.hookDecision;
        let decision = policy.decision;
        if (hookDecision === 'ask' && decision === 'allow') {
            decision = 'ask';
        } else if (
            hookDecision === 'allow' &&
            decision === 'ask' &&
            facts.outside.length === 0 &&
            facts.sensitive.length === 0 &&
            !facts.highRisk
        ) {
            decision = 'allow';
        }
        if (decision === 'allow') {
            return select(true);
        }
        if (decision === 'deny') {
            this.#deps.log.info(`denied ${facts.toolName} in ${running.threadId}: ${policy.reason}`);
            return select(false, policy.reason);
        }
        const shown = facts.paths.map((file) => {
            const relative = path.relative(running.cwd, file);
            return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
        });
        const summary =
            facts.command ?? (shown.length > 0 ? shown.join('\n') : (request.toolCall.title ?? facts.toolName));
        const title = request.toolCall.title ?? facts.toolName;
        let approvalItem: ItemOf<'approval'> | undefined;
        const outcome = await new Promise<Awaited<ReturnType<ApprovalService['request']>>>((resolve) => {
            const onAbort = () => approvals.cancelThread(running.threadId);
            signal.addEventListener('abort', onAbort, { once: true });
            running.abort.signal.addEventListener('abort', onAbort, { once: true });
            approvals
                .request(
                    {
                        threadId: running.threadId,
                        turnId: running.turnId,
                        projectId: running.projectId,
                        toolCallId: request.toolCall.toolCallId,
                        toolName: facts.toolName,
                        title: facts.highRisk
                            ? `高风险动作（${HIGH_RISK_LABELS[facts.highRisk.action]}）：${title}`
                            : title,
                        toolKind: facts.kind,
                        summary,
                        ...(facts.command ? { command: facts.command } : {}),
                        paths: [...facts.paths],
                        risks: [...policy.risks],
                        engine: running.engine.id,
                    },
                    facts,
                    (approval) => {
                        approvalItem = {
                            id: newId('i'),
                            turnId: running.turnId,
                            ts: Date.now(),
                            type: 'approval',
                            approvalId: approval.id,
                            ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
                            title: approval.title,
                            toolKind: approval.toolKind,
                            summary: approval.summary,
                            risks: approval.risks,
                            status: 'pending',
                        };
                        this.#persist(running, approvalItem, 'item.started');
                        threads.update(running.threadId, { status: 'awaiting_approval' });
                        this.#sideHook(running, 'Notification', ['permission_prompt'], {
                            message: `Xora Code needs your permission to use ${approval.title}`,
                            notification_type: 'permission_prompt',
                        });
                        const prefs = settings.get().notifications;
                        if (prefs.onApproval && !bus.focused) {
                            shell
                                .notify('需要你确认', `${thread.title}：${approval.title}`, running.threadId)
                                .catch(() => undefined);
                        }
                    },
                )
                .then(resolve);
        });
        if (approvalItem) {
            this.#persist(running, {
                ...approvalItem,
                status: outcome.status,
                ...(outcome.decision ? { decision: outcome.decision } : {}),
                decidedBy: 'user',
                ...(outcome.message ? { message: outcome.message } : {}),
            });
        }
        if (this.#running.has(running.threadId) && !running.abort.signal.aborted) {
            threads.update(running.threadId, { status: 'running' }, { touch: false });
        }
        if (outcome.status === 'allowed') {
            return select(true);
        }
        if (outcome.status === 'denied') {
            return select(false, outcome.message);
        }
        return { outcome: { outcome: 'cancelled' } };
    }

    // Completion --------------------------------------------------------------------------------------------

    #closeLive(running: RunningTurn, status: ToolCallStatus): void {
        this.#closeText(running);
        for (const item of [...running.live.values()]) {
            if (item.type === 'tool_call') {
                this.#persist(running, { ...item, status });
            } else if (item.type === 'compaction') {
                this.#persist(running, { ...item, status: 'failed' });
            } else {
                running.live.delete(item.id);
            }
        }
    }

    async #changes(
        running: RunningTurn,
    ): Promise<{ files: FileChange[]; additions: number; deletions: number } | undefined> {
        const { review, threads } = this.#deps;
        const after = await review.snapshot(running.cwd, `thread-${running.threadId}`);
        threads.endTurn(running.threadId, running.turnId, 'ended', after);
        if (!running.before || !after || running.before === after) {
            return undefined;
        }
        try {
            const files = await review.changes(running.cwd, running.before, after);
            if (files.length === 0) {
                return undefined;
            }
            const changes = {
                files,
                additions: files.reduce((sum, file) => sum + file.additions, 0),
                deletions: files.reduce((sum, file) => sum + file.deletions, 0),
            };
            this.#persist(running, {
                id: `changes-${running.turnId}`,
                turnId: running.turnId,
                ts: Date.now(),
                type: 'file_changes',
                ...changes,
            });
            return changes;
        } catch (error) {
            this.#deps.log.warn(`diff failed: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    async #finish(running: RunningTurn, stopReason: acp.StopReason): Promise<void> {
        const { threads, bus, settings, shell } = this.#deps;
        if (stopReason !== 'cancelled' && stopReason !== 'refusal') {
            this.#sideHook(running, 'Stop', [], { stop_hook_active: false });
        }
        this.#closeLive(running, stopReason === 'cancelled' ? 'cancelled' : 'completed');
        const changes = await this.#changes(running);
        threads.append(
            running.threadId,
            'turn.completed',
            {
                turnId: running.turnId,
                stopReason,
                durationMs: Date.now() - running.startedAt,
                usage: {
                    requests: running.requests,
                    inputTokens: running.inputTokens,
                    cachedTokens: running.cachedTokens,
                    outputTokens: running.outputTokens,
                    cost: running.cost,
                },
                ...(changes ? { changes } : {}),
            },
            { turnId: running.turnId },
        );
        const thread = threads.get(running.threadId);
        threads.update(running.threadId, {
            status: stopReason === 'cancelled' ? 'cancelled' : 'idle',
            needsReview: Boolean(changes),
            unread: !bus.focused,
            ...(thread.turns <= 1 && thread.title === '新线程' ? { title: this.#title(running) } : {}),
        });
        if (stopReason !== 'cancelled' && settings.get().notifications.onComplete && !bus.focused) {
            shell.notify('任务完成', thread.title, running.threadId).catch(() => undefined);
        }
        this.#ended(
            running,
            stopReason === 'cancelled' ? 'cancelled' : 'completed',
            stopReason,
            changes?.files.map((file) => file.path) ?? [],
        );
    }

    #ended(
        running: RunningTurn,
        outcome: TurnEnded['outcome'],
        stopReason: string | undefined,
        changedFiles: string[],
    ): void {
        const hook = this.#deps.onTurnEnded;
        if (!hook) return;
        // After the bookkeeping of this turn, and outside its call stack, so the hook may start the next turn.
        setTimeout(() => {
            try {
                hook({
                    threadId: running.threadId,
                    turnId: running.turnId,
                    outcome,
                    ...(stopReason ? { stopReason } : {}),
                    lastText: running.lastText,
                    changedFiles,
                });
            } catch (error) {
                this.#deps.log.warn(`turn hook failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }, 0);
    }

    #title(running: RunningTurn): string {
        const started = this.#deps.threads
            .events(running.threadId)
            .find((event) => event.kind === 'turn.started' && event.turnId === running.turnId);
        const text = (started?.payload as { input?: { text?: string } } | undefined)?.input?.text ?? '';
        const line =
            text
                .split('\n')
                .find((candidate) => candidate.trim().length > 0)
                ?.trim() ?? '新线程';
        return line.length > 40 ? `${line.slice(0, 40)}…` : line;
    }

    #classify(error: unknown): { errorClass: ErrorClass; message: string; retryable: boolean; retryAfterMs?: number } {
        const rpc = error as { code?: unknown; message?: unknown; data?: unknown };
        if (rpc && typeof rpc.code === 'number') {
            const data = xoraMeta(rpc.data);
            if (rpc.code === MODEL_ERROR_CODE && data) {
                const known = [
                    'auth',
                    'quota',
                    'rate_limit',
                    'overloaded',
                    'context_length',
                    'invalid_request',
                    'permission',
                    'not_found',
                    'network',
                    'timeout',
                    'server',
                    'content_filter',
                    'cancelled',
                ];
                const errorClass = (
                    known.includes(String(data.errorClass)) ? data.errorClass : 'unknown'
                ) as ErrorClass;
                return {
                    errorClass,
                    message: String(rpc.message ?? 'model error'),
                    retryable: data.retryable === true,
                    ...(typeof data.retryAfterMs === 'number' ? { retryAfterMs: data.retryAfterMs } : {}),
                };
            }
            if (rpc.code === BUSY_ERROR_CODE) {
                return { errorClass: 'engine', message: '引擎里这个会话还在运行', retryable: true };
            }
            if (rpc.code === RpcErrorCode.Rejected) {
                return { errorClass: 'invalid_request', message: String(rpc.message), retryable: false };
            }
        }
        return {
            errorClass: 'engine',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
        };
    }

    async #fail(running: RunningTurn, error: unknown): Promise<void> {
        const { threads, bus, settings, shell, approvals, log } = this.#deps;
        approvals.cancelThread(running.threadId);
        const classified = running.exited
            ? { errorClass: 'engine' as const, message: `引擎进程退出：${running.exited}`, retryable: true }
            : this.#classify(error);
        log.warn(`turn ${running.turnId} failed: ${classified.errorClass}: ${classified.message}`);
        this.#closeLive(running, 'failed');
        await this.#changes(running).catch(() => undefined);
        const item: ItemOf<'error'> = {
            id: newId('i'),
            turnId: running.turnId,
            ts: Date.now(),
            type: 'error',
            ...classified,
        };
        this.#persist(running, item);
        threads.append(
            running.threadId,
            'turn.failed',
            { turnId: running.turnId, error: item, durationMs: Date.now() - running.startedAt },
            { turnId: running.turnId },
        );
        const thread = threads.update(running.threadId, { status: 'failed', unread: !bus.focused });
        if (settings.get().notifications.onFailure && !bus.focused) {
            shell.notify('任务失败', `${thread.title}：${classified.message}`, running.threadId).catch(() => undefined);
        }
        this.#ended(running, 'failed', undefined, []);
    }

    async dispose(): Promise<void> {
        for (const threadId of [...this.#running.keys()]) {
            this.cancel(threadId);
        }
    }
}
