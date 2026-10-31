import path from 'node:path';
import { SYSTEM_PROMPT } from '@xora/engine';
import {
    type HostMethods,
    type HostNotifications,
    methods,
    notifications,
    PROTOCOL_VERSION,
    type PromptLayer,
    RpcError,
    RpcErrorCode,
    RpcPeer,
    type RpcTransport,
    type ThreadMeta,
} from '@xora/protocol';
import { completeModel } from '@xora/providers';
import { XoraDatabase } from '@xora/storage';
import { ApprovalService } from './approvals.ts';
import { Bus } from './bus.ts';
import { ConnectionService } from './connections.ts';
import { DistillService } from './distill.ts';
import { EngineManager } from './engines/manager.ts';
import { EXTERNAL_ENGINES, engineById, XORA_ENGINE } from './engines/registry.ts';
import { ExtensionService } from './extensions.ts';
import {
    applyInlineEdit,
    findFiles,
    INLINE_EDIT_SYSTEM,
    inlineEditPrompt,
    listForPreview,
    readForPreview,
    unfence,
} from './files.ts';
import { GoalService } from './goals.ts';
import { HistoryService } from './history.ts';
import { detectLocalServers } from './local-models.ts';
import { HostLog, type Logger } from './log.ts';
import { offPeakStartFor } from './off-peak.ts';
import { type HostPaths, hostPaths } from './paths.ts';
import { ProjectService } from './projects.ts';
import { PromptService } from './prompts.ts';
import { ReviewService } from './review.ts';
import { SettingsService } from './settings.ts';
import type { ShellApi } from './shell.ts';
import { mergePath, resolveLoginPath } from './shell-env.ts';
import { registerTeamHandlers, TeamService } from './team.ts';
import { TerminalService } from './terminals.ts';
import { ThreadStore } from './threads.ts';
import { type TriggerFire, TriggerService } from './triggers.ts';
import { TurnService } from './turns.ts';
import { UpdateService } from './updates.ts';
import { UsageService } from './usage.ts';
import { which } from './which.ts';
import { registerWorkflowHandlers, triggerKey, WorkflowService } from './workflows.ts';
import { WorktreeService } from './worktrees.ts';

export interface HostOptions {
    readonly dataDir: string;
    readonly shell: ShellApi;
    readonly bundleVersion: string;
    readonly shellVersion: string;
    readonly log?: Logger;
    /** Path of the xora engine entry when it runs over stdio (tests); defaults to `<bundle>/engine/index.cjs`. */
    readonly engineEntry?: string;
    /** Skip resolving the login shell PATH (tests). */
    readonly skipShellEnv?: boolean;
    readonly fetch?: typeof fetch;
    /** Home directory for user skills and MCP config imports; tests point it at a temporary folder. */
    readonly home?: string;
}

export type UiPeer = RpcPeer<HostMethods, HostNotifications>;

/**
 * The host: the single owner of state and the only place decisions are made (02 §1). It serves any number of
 * UI windows over the protocol and drives engines over ACP.
 */
export class HostCore {
    readonly paths: HostPaths;
    readonly log: Logger;
    readonly db: XoraDatabase;
    readonly bus = new Bus();
    readonly settings: SettingsService;
    readonly projects: ProjectService;
    readonly threads: ThreadStore;
    readonly connections: ConnectionService;
    readonly prompts: PromptService;
    readonly approvals: ApprovalService;
    readonly review: ReviewService;
    readonly usage: UsageService;
    readonly engines: EngineManager;
    readonly turns: TurnService;
    readonly updates: UpdateService;
    readonly terminals: TerminalService;
    readonly worktrees: WorktreeService;
    readonly goals: GoalService;
    readonly extensions: ExtensionService;
    readonly team: TeamService;
    readonly workflows: WorkflowService;
    readonly distill: DistillService;
    readonly triggers: TriggerService;
    #triggerSync: ReturnType<typeof setInterval> | undefined;
    readonly #options: HostOptions;
    readonly #startedAt = Date.now();

    private constructor(options: HostOptions, bundleDir: string) {
        this.#options = options;
        this.paths = hostPaths(options.dataDir);
        this.log = options.log ?? new HostLog(this.paths.logsDir);
        this.db = new XoraDatabase(this.paths.database);
        this.db.migrate();
        const userAgent = `XoraCode/${options.bundleVersion}`;
        this.settings = new SettingsService(this.db);
        this.projects = new ProjectService(this.db, this.bus);
        this.threads = new ThreadStore(this.db, this.bus, this.paths.threadsDir);
        this.connections = new ConnectionService(this.db, options.shell, this.bus, this.log, userAgent);
        this.prompts = new PromptService(this.paths.promptsDir, this.paths.projectsDir);
        this.approvals = new ApprovalService(this.db, this.bus);
        this.review = new ReviewService(this.paths.checkpointsDir, this.log);
        this.usage = new UsageService(this.db, () => this.settings.get());
        this.worktrees = new WorktreeService({ rootDir: this.paths.worktreesDir, log: this.log, review: this.review });
        this.extensions = new ExtensionService({
            dir: this.paths.extensionsDir,
            projects: this.projects,
            shell: options.shell,
            bus: this.bus,
            log: this.log,
            ...(options.home ? { home: options.home } : {}),
        });
        const engineData = path.join(this.paths.enginesDir, 'xora');
        this.engines = new EngineManager({
            log: this.log,
            version: options.bundleVersion,
            shell: options.shell,
            launch: async (definition) => {
                if (definition.kind === 'builtin') {
                    const env = {
                        ...process.env,
                        NODE_NO_WARNINGS: '1',
                        XORA_ENGINE_DATA: engineData,
                        XORA_ENGINE_VERSION: options.bundleVersion,
                    };
                    // In the app the bootstrap forks it from the bundle as a utility process, so the Electron binary
                    // never runs as plain Node (10 §6); tests and runs outside Electron use this process's Node.
                    if (options.shell.startEngine) {
                        return { kind: 'utility', entry: 'engine/index.cjs', env };
                    }
                    const entry = options.engineEntry ?? path.join(bundleDir, 'engine', 'index.cjs');
                    return { kind: 'stdio', command: process.execPath, args: [entry], env };
                }
                if (!definition.command) {
                    throw new Error(`engine ${definition.id} has no launch command`);
                }
                return {
                    kind: 'stdio',
                    command: definition.command,
                    args: definition.args ?? [],
                    env: { ...process.env, ...definition.env, GROK_TELEMETRY_ENABLED: '0' },
                };
            },
        });
        this.turns = new TurnService({
            threads: this.threads,
            projects: this.projects,
            connections: this.connections,
            settings: this.settings,
            prompts: this.prompts,
            approvals: this.approvals,
            review: this.review,
            usage: this.usage,
            engines: this.engines,
            bus: this.bus,
            shell: options.shell,
            log: this.log,
            userAgent,
            portFor: (threadId) => this.worktrees.port(threadId),
            extensions: this.extensions,
            onTurnEnded: (event) => {
                void this.goals.onTurnEnded(event).catch((error) => this.log.warn(`goal: ${String(error)}`));
                this.team.onTurnEnded(event);
                this.workflows.onTurnEnded(event);
            },
        });
        this.goals = new GoalService({
            threads: this.threads,
            projects: this.projects,
            turns: () => this.turns,
            log: this.log,
        });
        this.team = new TeamService({
            db: this.db,
            bus: this.bus,
            log: this.log,
            threads: this.threads,
            projects: this.projects,
            connections: this.connections,
            settings: this.settings,
            approvals: this.approvals,
            usage: this.usage,
            worktrees: this.worktrees,
            turns: this.turns,
            orgsDir: this.paths.orgsDir,
        });
        // The webhook keeps its port across restarts, so the URL given out stays valid (06 §12).
        const webhookPort = Number(this.#value('webhookPort') ?? 0);
        this.triggers = new TriggerService({
            log: this.log,
            ...(Number.isInteger(webhookPort) && webhookPort > 0 ? { webhookPort } : {}),
        });
        this.workflows = new WorkflowService({
            db: this.db,
            bus: this.bus,
            log: this.log,
            threads: this.threads,
            projects: this.projects,
            connections: this.connections,
            settings: this.settings,
            approvals: this.approvals,
            usage: this.usage,
            turns: this.turns,
            team: this.team,
            orgsDir: this.paths.orgsDir,
            workflowsDir: this.paths.workflowsDir,
            offPeakAt: (models, now) => offPeakStartFor(this.connections, models, new Date(now))?.getTime(),
            onTriggersChanged: () => this.#syncTriggers(),
            webhookUrl: (key) => this.triggers.webhookUrl(key),
            nextScheduledAt: (key) => this.triggers.nextScheduledAt(key),
            muteFiles: (projectDir) => {
                const files = this.triggers.muteFiles(projectDir);
                const git = this.triggers.muteGit(projectDir);
                return () => {
                    files();
                    git();
                };
            },
        });
        this.triggers.onFire((fire) => this.#onTrigger(fire));
        this.distill = new DistillService({
            threads: this.threads,
            turns: this.turns,
            projects: this.projects,
            log: this.log,
            workflowsDir: this.paths.workflowsDir,
            extensionsDir: this.paths.extensionsDir,
        });
        this.updates = new UpdateService({
            settings: this.settings,
            shell: options.shell,
            bus: this.bus,
            log: this.log,
            downloadsDir: this.paths.downloadsDir,
            bundleDir,
            bundleVersion: options.bundleVersion,
            shellVersion: options.shellVersion,
            ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        this.terminals = new TerminalService({
            bus: this.bus,
            log: this.log,
            modulesDir: async () => (await options.shell.info()).shellModulesDir,
        });
    }

    static async create(options: HostOptions): Promise<HostCore> {
        const info = await options.shell.info();
        const core = new HostCore(options, info.bundleDir);
        core.#recover();
        if (!options.skipShellEnv) {
            const login = await resolveLoginPath();
            const merged = mergePath(process.env.PATH, login);
            if (merged) {
                process.env.PATH = merged;
            }
        }
        await core.distill.restore().catch((error) => core.log.warn(`distill: ${String(error)}`));
        core.#syncTriggers();
        // Also catches what no event reports: a project that lost its trust, a workflow file edited by hand.
        core.#triggerSync = setInterval(() => core.#syncTriggers(), 60_000);
        core.#triggerSync.unref?.();
        core.log.info(`host ${options.bundleVersion} ready, data in ${options.dataDir}`);
        return core;
    }

    #value(key: string): string | undefined {
        return this.db.get<{ value: string }>('select value from host_values where key = ?', [key])?.value;
    }

    #setValue(key: string, value: string): void {
        this.db.run(
            'insert into host_values (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
            [key, value],
        );
    }

    #syncing: Promise<void> = Promise.resolve();

    /** Hands the switched-on workflow triggers to the trigger service (06 §12). */
    #syncTriggers(): void {
        this.#syncing = this.#syncing
            .then(async () => {
                const enabled = await this.workflows.enabledTriggers();
                await this.triggers.update(
                    enabled.map((entry) => ({
                        key: triggerKey(entry.projectId, entry.key),
                        projectDir: entry.projectDir,
                        spec: entry.definition.trigger,
                        ...(entry.lastScheduledAt !== undefined ? { lastScheduledAt: entry.lastScheduledAt } : {}),
                        ...(entry.webhookToken ? { webhookToken: entry.webhookToken } : {}),
                    })),
                );
                const port = this.triggers.webhookPort();
                if (port !== undefined && String(port) !== this.#value('webhookPort')) {
                    this.#setValue('webhookPort', String(port));
                }
            })
            .catch((error) =>
                this.log.warn(`workflow triggers: ${error instanceof Error ? error.message : String(error)}`),
            );
    }

    #onTrigger(fire: TriggerFire): void {
        const split = fire.key.indexOf('|');
        if (split < 0) return;
        const projectId = fire.key.slice(0, split);
        const key = fire.key.slice(split + 1);
        void this.workflows
            .fire({
                projectId,
                key,
                trigger: {
                    reason: fire.reason,
                    ...(fire.files ? { files: fire.files } : {}),
                    ...(fire.git ? { branch: fire.git.branch, commit: fire.git.commit, event: fire.git.event } : {}),
                    ...(fire.payload !== undefined ? { payload: fire.payload } : {}),
                },
                ...(fire.scheduledFor !== undefined ? { scheduledFor: fire.scheduledFor } : {}),
            })
            .catch((error) =>
                this.log.warn(
                    `workflow ${key}: trigger failed: ${error instanceof Error ? error.message : String(error)}`,
                ),
            );
    }

    /** Threads a crash left running are marked failed, with a closing event so the timeline is complete. */
    #recover(): void {
        const rows = this.db.all<{ thread_id: string; turn_id: string; started_at: number }>(
            `select thread_id, turn_id, started_at from turns where status = 'running'`,
        );
        for (const row of rows) {
            if (!this.threads.find(row.thread_id)) {
                continue;
            }
            const now = Date.now();
            this.threads.append(
                row.thread_id,
                'turn.failed',
                {
                    turnId: row.turn_id,
                    durationMs: now - row.started_at,
                    error: {
                        id: `recovered-${row.turn_id}`,
                        turnId: row.turn_id,
                        ts: now,
                        type: 'error',
                        errorClass: 'engine',
                        message: '应用在这一轮运行时退出了，这一轮没有完成',
                        retryable: true,
                    },
                },
                { turnId: row.turn_id },
            );
            this.threads.endTurn(row.thread_id, row.turn_id, 'interrupted', undefined);
        }
        const marked = this.threads.recoverInterrupted();
        if (marked.length > 0) {
            this.log.warn(`marked ${marked.length} interrupted thread(s) as failed`);
        }
    }

    startBackgroundWork(): void {
        this.updates.startAutoCheck();
    }

    async #effectiveLayers(thread: ThreadMeta): Promise<PromptLayer[]> {
        const project = this.db.get<{ path: string }>('select path from projects where id = ?', [thread.projectId]);
        const projectRoot = project?.path ?? '';
        const cwd = thread.location.kind === 'worktree' ? thread.location.path : projectRoot;
        const layers = this.prompts.layers({
            projectId: thread.projectId,
            projectRoot,
            cwd,
            sessionPrompt: this.threads.sessionPrompt(thread.id),
        });
        const system: PromptLayer = {
            id: 'system',
            title: '系统（xora统一）',
            source: '内置',
            text: SYSTEM_PROMPT,
            chars: SYSTEM_PROMPT.length,
            tokens: Math.ceil(SYSTEM_PROMPT.length / 4),
            truncated: false,
            editable: false,
        };
        const extra = (layer: { id: string; title: string; text: string }, source: string): PromptLayer => ({
            id: layer.id,
            title: layer.title,
            source,
            text: layer.text,
            chars: layer.text.length,
            tokens: Math.ceil(layer.text.length / 4),
            truncated: false,
            editable: false,
        });
        // The same order the engine gets (see TurnService): team layers after the user's global layer, skills last.
        const team = this.turns.hostLayers(thread.id).map((layer) => extra(layer, '团队'));
        const globalIndex = layers.findIndex((layer) => layer.id === 'user_global_instructions');
        let skills: PromptLayer[] = [];
        try {
            const project = await this.projects.get(thread.projectId);
            skills = (await this.extensions.promptLayers(project)).map((layer) => extra(layer, '扩展'));
        } catch (error) {
            this.log.warn(`effective prompt: ${error instanceof Error ? error.message : String(error)}`);
        }
        return [system, ...layers.slice(0, globalIndex + 1), ...team, ...layers.slice(globalIndex + 1), ...skills];
    }

    /** Serves one UI window. The returned peer is disposed when the window's port closes. */
    connectUi(transport: RpcTransport): UiPeer {
        const peer: UiPeer = new RpcPeer(transport, {
            methods,
            notifications,
            onProtocolError: (error) => this.log.warn(`ui protocol error: ${error.message}`),
        });
        const subscriber = {
            notify: (method: keyof HostNotifications & string, params: unknown) => peer.notify(method, params as never),
        };
        const remove = this.bus.add(subscriber);
        peer.onDispose(remove);
        const { settings, projects, threads, turns, approvals, connections, prompts, usage, review, updates, shell } = {
            settings: this.settings,
            projects: this.projects,
            threads: this.threads,
            turns: this.turns,
            approvals: this.approvals,
            connections: this.connections,
            prompts: this.prompts,
            usage: this.usage,
            review: this.review,
            updates: this.updates,
            shell: this.#options.shell,
        };
        const ok = { ok: true as const };

        peer.handle('system.ping', ({ sentAt }) => ({ sentAt, receivedAt: Date.now() }));
        peer.handle('system.info', async () => {
            const info = await shell.info();
            return {
                protocolVersion: PROTOCOL_VERSION,
                bundleVersion: this.#options.bundleVersion,
                shellVersion: this.#options.shellVersion,
                hostPid: process.pid,
                platform: process.platform,
                arch: process.arch,
                versions: { node: process.versions.node, electron: process.versions.electron ?? 'none' },
                dataDir: info.dataDir,
                uptimeMs: Date.now() - this.#startedAt,
            };
        });
        peer.handle('system.open', async ({ kind, target }) => {
            if (kind === 'external' && !/^https?:\/\//.test(target)) {
                throw new RpcError(RpcErrorCode.InvalidParams, 'only http(s) links can be opened externally');
            }
            await shell.open(kind, target);
            return ok;
        });

        peer.handle('project.list', () => projects.list());
        peer.handle('project.add', ({ path: dir }) => projects.add(dir));
        peer.handle('project.pick', async () => {
            const picked = await shell.pickDirectory('打开项目文件夹');
            return picked ? projects.add(picked) : null;
        });
        peer.handle('project.update', ({ projectId, ...patch }) => projects.update(projectId, patch));
        peer.handle('project.remove', ({ projectId }) => {
            if (threads.list({ projectId, includeArchived: true }).some((thread) => turns.isRunning(thread.id))) {
                throw new RpcError(RpcErrorCode.Rejected, '这个项目里还有线程在运行');
            }
            projects.remove(projectId);
            return ok;
        });

        peer.handle('thread.list', (params) => threads.list(params));
        const createThread = async (params: {
            projectId: string;
            title?: string;
            model?: { connectionId: string; model: string };
            mode?: 'ask' | 'auto_edit' | 'plan' | 'full';
            effort?: 'off' | 'low' | 'medium' | 'high' | 'max';
            sessionPrompt?: string;
            location?: 'local' | 'worktree';
            engine?: string;
            group?: string;
        }) => {
            const project = await projects.get(params.projectId);
            const current = settings.get();
            const engineId = params.engine ?? 'xora';
            if (!this.engine(engineId)) {
                throw new RpcError(RpcErrorCode.InvalidParams, `未知的引擎：${engineId}`);
            }
            let thread = threads.create({
                projectId: project.id,
                title: params.title?.trim() || '新线程',
                engine: engineId,
                model: params.model ?? project.defaults?.model ?? current.defaultModel,
                mode: params.mode ?? project.defaults?.mode ?? current.defaultMode,
                effort: params.effort ?? current.defaultEffort,
                ...(params.sessionPrompt ? { sessionPrompt: params.sessionPrompt } : {}),
                ...(params.group ? { extra: { group: params.group } } : {}),
            });
            if (params.location === 'worktree') {
                try {
                    const created = await this.worktrees.create(project, thread.id);
                    thread = threads.update(thread.id, {
                        location: { kind: 'worktree', path: created.path, worktreeId: thread.id },
                    });
                    void this.worktrees.runSetup(project, created.path, created.port).catch(() => undefined);
                } catch (error) {
                    threads.delete(thread.id);
                    throw error;
                }
            }
            projects.touch(project.id);
            return thread;
        };
        peer.handle('thread.create', (params) => createThread(params));
        peer.handle('thread.distill', ({ threadId, kind, scope }) =>
            this.distill.start({ threadId, kind, scope: scope ?? 'project' }),
        );
        const history = new HistoryService({
            threads,
            projects,
            review,
            engines: this.engines,
            turns,
            log: this.log,
            createThread: (params) => createThread(params),
        });
        peer.handle('thread.rewind', ({ threadId, turnId, files, force }) =>
            history.rewind(threadId, turnId, files, force ?? false),
        );
        peer.handle('thread.fork', ({ threadId, afterTurnId }) => history.fork(threadId, afterTurnId));
        peer.handle('thread.handoff', async ({ threadId, to }) => {
            if (turns.isRunning(threadId)) {
                throw new RpcError(RpcErrorCode.Rejected, '线程正在运行，先停止再迁移');
            }
            const thread = threads.get(threadId);
            const project = await projects.get(thread.projectId);
            if (to === 'worktree') {
                if (thread.location.kind === 'worktree') {
                    throw new RpcError(RpcErrorCode.Rejected, '线程已经在worktree里');
                }
                const created = await this.worktrees.create(project, thread.id);
                const result = await this.worktrees.handoff(project, project.path, created.path);
                const updated = threads.update(threadId, {
                    location: { kind: 'worktree', path: created.path, worktreeId: thread.id },
                });
                return { thread: updated, result };
            }
            if (thread.location.kind !== 'worktree') {
                throw new RpcError(RpcErrorCode.Rejected, '线程已经在主目录');
            }
            const result = await this.worktrees.handoff(project, thread.location.path, project.path);
            if (result.status === 'failed') {
                return { thread, result };
            }
            const updated = threads.update(threadId, { location: { kind: 'local' } });
            return { thread: updated, result };
        });
        peer.handle('thread.bestOfN', async ({ projectId, text, models, mode }) => {
            const group = `g_${Date.now().toString(36)}`;
            const created: ThreadMeta[] = [];
            for (const [index, model] of models.entries()) {
                const summary = connections.model(model);
                if (!summary) {
                    throw new RpcError(RpcErrorCode.InvalidParams, `模型不可用：${model.model}`);
                }
                const thread = await createThread({
                    projectId,
                    title: `候选${index + 1}·${summary.name}`,
                    model,
                    location: 'worktree',
                    group,
                    ...(mode ? { mode } : {}),
                });
                created.push(thread);
            }
            for (const thread of created) {
                await turns.start(thread.id, text, []);
            }
            return { group, threads: created.map((thread) => threads.get(thread.id)) };
        });
        peer.handle('worktree.apply', async ({ threadId }) => {
            if (turns.isRunning(threadId)) {
                throw new RpcError(RpcErrorCode.Rejected, '线程正在运行，先停止再应用');
            }
            const thread = threads.get(threadId);
            if (thread.location.kind !== 'worktree') {
                throw new RpcError(RpcErrorCode.Rejected, '这个线程不在worktree里');
            }
            const project = await projects.get(thread.projectId);
            return this.worktrees.handoff(project, thread.location.path, project.path);
        });
        peer.handle('worktree.remove', async ({ threadId, force }) => {
            if (turns.isRunning(threadId)) {
                throw new RpcError(RpcErrorCode.Rejected, '线程正在运行，先停止再删除worktree');
            }
            const thread = threads.get(threadId);
            if (thread.location.kind !== 'worktree') {
                throw new RpcError(RpcErrorCode.Rejected, '这个线程不在worktree里');
            }
            const project = await projects.get(thread.projectId);
            await this.worktrees.remove(project, threadId, thread.location.path, force ?? false);
            if (!thread.archived) {
                void turns.endSession(thread, 'archive');
            }
            threads.update(threadId, { archived: true });
            return ok;
        });
        const dirOf = async (threadId: string) => {
            const thread = threads.get(threadId);
            return turns.cwdOf(thread, await projects.get(thread.projectId));
        };
        peer.handle('git.diff', async ({ threadId, staged }) =>
            this.worktrees.diff(await dirOf(threadId), staged ?? false),
        );
        peer.handle('git.hunks', async ({ threadId, path: file, hunkIds, action, staged }) => {
            await this.worktrees.hunks(await dirOf(threadId), file, hunkIds, action, staged ?? false);
            return ok;
        });
        peer.handle('git.commit', async ({ threadId, message, all }) => ({
            commit: await this.worktrees.commit(await dirOf(threadId), message, all ?? false),
        }));
        peer.handle('thread.read', ({ threadId, afterSeq }) => {
            const thread = threads.get(threadId);
            return {
                thread,
                events: threads.events(threadId, afterSeq ?? 0),
                live: turns.live(threadId),
                lastSeq: thread.lastSeq,
            };
        });
        peer.handle('thread.subscribe', ({ threadId }) => {
            threads.get(threadId);
            this.bus.subscribe(subscriber, threadId);
            return ok;
        });
        peer.handle('thread.unsubscribe', ({ threadId }) => {
            this.bus.unsubscribe(subscriber, threadId);
            return ok;
        });
        peer.handle('thread.update', ({ threadId, title, model, mode, effort, pinned, archived }) => {
            const before = threads.get(threadId);
            if (model && !connections.model(model)) {
                throw new RpcError(RpcErrorCode.InvalidParams, '这个模型不在已连接的模型里');
            }
            const thread = threads.update(threadId, {
                ...(title !== undefined ? { title } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(mode !== undefined ? { mode } : {}),
                ...(effort !== undefined ? { effort } : {}),
                ...(pinned !== undefined ? { pinned } : {}),
                ...(archived !== undefined ? { archived } : {}),
            });
            if (title !== undefined && title !== before.title) {
                threads.append(threadId, 'thread.renamed', { title });
            }
            if (archived === true && !before.archived && !turns.isRunning(threadId)) {
                void turns.endSession(thread, 'archive');
            }
            const config = {
                ...(model !== undefined && JSON.stringify(model) !== JSON.stringify(before.model) ? { model } : {}),
                ...(mode !== undefined && mode !== before.mode ? { mode } : {}),
                ...(effort !== undefined && effort !== before.effort ? { effort } : {}),
            };
            if (Object.keys(config).length > 0) {
                threads.append(threadId, 'thread.config', config);
            }
            return thread;
        });
        peer.handle('thread.markRead', ({ threadId }) => {
            threads.update(threadId, { unread: false }, { touch: false });
            return ok;
        });
        peer.handle('thread.markReviewed', ({ threadId }) => {
            threads.update(threadId, { needsReview: false }, { touch: false });
            return ok;
        });
        peer.handle('thread.delete', ({ threadId }) => {
            if (turns.isRunning(threadId)) {
                throw new RpcError(RpcErrorCode.Rejected, '线程正在运行，先停止再删除');
            }
            approvals.clearSession(threadId);
            void turns.endSession(threads.get(threadId), 'delete');
            threads.delete(threadId);
            return ok;
        });
        peer.handle('thread.search', ({ query }) => threads.search(query));

        peer.handle('turn.start', async ({ threadId, text, attachments }) => ({
            turnId: await turns.start(threadId, text, attachments ?? []),
        }));
        peer.handle('fs.read', async ({ threadId, path: file }) => readForPreview(await dirOf(threadId), file));
        peer.handle('fs.find', async ({ threadId, query }) => findFiles(await dirOf(threadId), query));
        peer.handle('fs.list', async ({ threadId, path: dir }) => listForPreview(await dirOf(threadId), dir ?? '.'));
        peer.handle('edit.inline', async ({ threadId, path: file, start, end, instruction }) => {
            const thread = threads.get(threadId);
            const ref = thread.model ?? settings.get().defaultModel;
            if (!ref) {
                throw new RpcError(RpcErrorCode.Rejected, '还没有选择模型');
            }
            const root = await dirOf(threadId);
            const preview = await readForPreview(root, file);
            if (preview.kind !== 'text' || preview.text === undefined) {
                throw new RpcError(RpcErrorCode.Rejected, '只能编辑文本文件');
            }
            const content = preview.text;
            if (end > content.length || start > end) {
                throw new RpcError(RpcErrorCode.InvalidParams, 'selection is out of range');
            }
            const connection = await connections.providerConnection(ref.connectionId);
            const done = await completeModel(
                connection,
                {
                    model: ref.model,
                    system: [INLINE_EDIT_SYSTEM],
                    messages: [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: inlineEditPrompt(preview.path, content, start, end, instruction),
                                },
                            ],
                        },
                    ],
                    effort: 'low',
                    maxOutputTokens: 16_000,
                },
                { userAgent: `XoraCode/${this.#options.bundleVersion}` },
            );
            if (done.usage) {
                const recorded = this.usage.record({
                    projectId: thread.projectId,
                    threadId,
                    turnId: 'inline-edit',
                    agentPath: 'inline-edit',
                    engine: 'xora',
                    provider: connection.preset.id,
                    model: ref.model,
                    usage: done.usage,
                    latencyMs: done.latencyMs,
                    status: 'ok',
                    source: 'vendor',
                });
                if (recorded.cost) {
                    this.bus.broadcast('usage.changed', { threadId, cost: recorded.cost });
                }
            }
            const replacement = unfence(
                done.message.content
                    .filter((part) => part.type === 'text')
                    .map((part) => (part.type === 'text' ? part.text : ''))
                    .join(''),
            );
            return {
                replacement,
                oldText: content,
                newText: content.slice(0, start) + replacement + content.slice(end),
            };
        });
        peer.handle('edit.apply', async ({ threadId, path: file, expectedOld, newText }) => {
            await applyInlineEdit(await dirOf(threadId), file, expectedOld, newText);
            return ok;
        });
        peer.handle('goal.start', ({ threadId, objective, acceptCommand, maxRounds, budget }) =>
            this.goals.start(threadId, {
                objective,
                ...(acceptCommand ? { acceptCommand } : {}),
                ...(maxRounds ? { maxRounds } : {}),
                ...(budget !== undefined ? { budget } : {}),
            }),
        );
        peer.handle('goal.stop', ({ threadId }) => this.goals.stop(threadId));
        registerTeamHandlers(peer, this.team);
        registerWorkflowHandlers(peer, this.workflows);

        // Extensions (09) ---------------------------------------------------------------------------------------
        const extensions = this.extensions;
        peer.handle('extension.list', ({ projectId }) => extensions.snapshot(projectId));
        peer.handle('extension.toggle', async (params) => {
            await extensions.toggle(params);
            return ok;
        });
        peer.handle('project.trust', async ({ projectId, trusted }) => {
            await extensions.trust(projectId, trusted);
            return ok;
        });
        peer.handle('plugin.install', ({ source }) => extensions.installPlugin(source));
        peer.handle('plugin.uninstall', async ({ name }) => {
            await extensions.uninstallPlugin(name);
            return ok;
        });
        peer.handle('market.list', () => extensions.markets());
        peer.handle('market.add', ({ source }) => extensions.addMarket(source));
        peer.handle('market.refresh', async ({ name }) => {
            await extensions.refreshMarket(name);
            return ok;
        });
        peer.handle('market.remove', async ({ name }) => {
            await extensions.removeMarket(name);
            return ok;
        });
        peer.handle('mcp.save', async (params) => {
            await extensions.saveMcp(params);
            return ok;
        });
        peer.handle('mcp.remove', async (params) => {
            await extensions.removeMcp(params);
            return ok;
        });
        peer.handle('mcp.discover', ({ projectId }) => extensions.discoverMcp(projectId));
        peer.handle('mcp.import', ({ names, projectId }) => extensions.importMcp(names, projectId));
        peer.handle('mcp.test', ({ name, projectId }) => extensions.testMcp(name, projectId));
        peer.handle('mcp.authorize', async ({ name, projectId }) => {
            await extensions.authorizeMcp(name, projectId);
            return ok;
        });
        peer.handle('turn.compact', async ({ threadId, focus }) => {
            await turns.start(threadId, focus ? `/compact ${focus}` : '/compact', []);
            return { compacted: true };
        });
        peer.handle('turn.cancel', ({ threadId }) => {
            turns.cancel(threadId);
            return ok;
        });

        peer.handle('approval.list', () => approvals.list());
        peer.handle('approval.respond', ({ approvalId, decision, scope, message }) => {
            approvals.respond(approvalId, decision, scope, message);
            return ok;
        });
        peer.handle('rules.list', () => approvals.rules());
        peer.handle('rules.remove', ({ ruleId }) => {
            approvals.removeRule(ruleId);
            return ok;
        });

        const turnContext = async (threadId: string, turnId: string) => {
            const thread = threads.get(threadId);
            const project = await projects.get(thread.projectId);
            const turn = threads.turn(threadId, turnId);
            return { thread, cwd: turns.cwdOf(thread, project), turn };
        };
        peer.handle('review.turn', async ({ threadId, turnId }) => {
            const { cwd, turn } = await turnContext(threadId, turnId);
            if (!turn?.before || !turn.after) {
                return { files: [], available: false };
            }
            return { files: await review.changes(cwd, turn.before, turn.after), available: true };
        });
        peer.handle('review.file', async ({ threadId, turnId, path: file }) => {
            const { cwd, turn } = await turnContext(threadId, turnId);
            if (!turn?.before || !turn.after) {
                throw new RpcError(RpcErrorCode.NotFound, '这一轮没有检查点');
            }
            const versions = await review.file(cwd, turn.before, turn.after, file);
            return { oldText: versions.oldText, newText: versions.newText, binary: versions.binary };
        });
        peer.handle('review.revert', async ({ threadId, turnId, paths, force }) => {
            if (turns.isRunning(threadId)) {
                throw new RpcError(RpcErrorCode.Rejected, '线程正在运行，先停止再撤销');
            }
            const { cwd, turn } = await turnContext(threadId, turnId);
            if (!turn?.before || !turn.after) {
                throw new RpcError(RpcErrorCode.NotFound, '这一轮没有检查点，无法撤销');
            }
            const targets =
                paths ??
                (await review.changes(cwd, turn.before, turn.after)).flatMap((change) =>
                    change.oldPath ? [change.path, change.oldPath] : [change.path],
                );
            const result = await review.revert(cwd, turn.before, turn.after, targets, force ?? false);
            threads.append(
                threadId,
                'turn.reverted',
                { turnId, paths: [...result.restored, ...result.deleted], conflicts: result.conflicts },
                { turnId },
            );
            return result;
        });

        peer.handle('provider.presets', () => connections.presets());
        peer.handle('provider.connections', () => connections.list());
        peer.handle('provider.save', async (params) => {
            const connection = await connections.save(params);
            const current = settings.get();
            if (!current.defaultModel && connection.models[0] && connection.hasKey) {
                this.#applySettings({ defaultModel: { connectionId: connection.id, model: connection.models[0].id } });
            }
            return connection;
        });
        peer.handle('provider.remove', async ({ connectionId }) => {
            await connections.remove(connectionId);
            const current = settings.get();
            if (current.defaultModel?.connectionId === connectionId) {
                this.#applySettings({ defaultModel: null });
            }
            if (current.fastModel?.connectionId === connectionId) {
                this.#applySettings({ fastModel: null });
            }
            return ok;
        });
        peer.handle('provider.test', ({ connectionId, model }) => connections.test(connectionId, model));
        peer.handle('provider.refreshModels', ({ connectionId }) => connections.refreshModels(connectionId));
        peer.handle('model.list', () => connections.options());
        peer.handle('provider.detectLocal', () => detectLocalServers(this.#options.fetch ?? fetch));
        peer.handle('engine.list', () => [
            { id: XORA_ENGINE.id, name: XORA_ENGINE.name, kind: 'builtin' as const, available: true },
            ...EXTERNAL_ENGINES.map((engine) => ({
                id: engine.id,
                name: engine.name,
                kind: 'external' as const,
                available: Boolean(engine.command && which(engine.command)),
                ...(engine.command ? { command: [engine.command, ...(engine.args ?? [])].join(' ') } : {}),
                ...(engine.note ? { note: engine.note } : {}),
                ...(engine.homepage ? { homepage: engine.homepage } : {}),
            })),
        ]);

        peer.handle('settings.get', () => settings.get());
        peer.handle('settings.update', ({ patch }) => this.#applySettings(patch));

        peer.handle('prompt.get', ({ scope, projectId, threadId }) => {
            if (scope === 'global') return { text: prompts.readGlobal(), path: prompts.globalFile() };
            if (scope === 'project') {
                if (!projectId) throw new RpcError(RpcErrorCode.InvalidParams, 'projectId is required');
                return { text: prompts.readProject(projectId), path: prompts.projectFile(projectId) };
            }
            if (!threadId) throw new RpcError(RpcErrorCode.InvalidParams, 'threadId is required');
            return { text: threads.sessionPrompt(threadId) };
        });
        peer.handle('prompt.set', ({ scope, projectId, threadId, text }) => {
            if (scope === 'global') {
                prompts.writeGlobal(text);
            } else if (scope === 'project') {
                if (!projectId) throw new RpcError(RpcErrorCode.InvalidParams, 'projectId is required');
                prompts.writeProject(projectId, text);
            } else {
                if (!threadId) throw new RpcError(RpcErrorCode.InvalidParams, 'threadId is required');
                threads.update(threadId, { sessionPrompt: text }, { touch: false });
                threads.append(threadId, 'thread.config', { sessionPrompt: text });
            }
            return ok;
        });
        peer.handle('prompt.effective', ({ threadId }) => this.#effectiveLayers(threads.get(threadId)));

        peer.handle('usage.summary', ({ range, groupBy }) =>
            usage.summary(range, groupBy, {
                project: (id) =>
                    this.db.get<{ name: string }>('select name from projects where id = ?', [id])?.name ?? id,
                thread: (id) => threads.find(id)?.title ?? id,
            }),
        );
        peer.handle('usage.thread', ({ threadId }) => usage.thread(threadId));

        peer.handle('terminal.open', async ({ threadId, projectId, cols, rows }) => {
            let cwd: string;
            let key: string;
            if (threadId) {
                const thread = threads.get(threadId);
                cwd = turns.cwdOf(thread, await projects.get(thread.projectId));
                key = threadId;
            } else if (projectId) {
                cwd = projects.rootOf(projectId);
                key = projectId;
            } else {
                throw new RpcError(RpcErrorCode.InvalidParams, 'threadId or projectId is required');
            }
            return this.terminals.open(key, cwd, cols, rows);
        });
        peer.handle('terminal.write', ({ terminalId, data }) => {
            this.terminals.write(terminalId, data);
            return ok;
        });
        peer.handle('terminal.resize', ({ terminalId, cols, rows }) => {
            this.terminals.resize(terminalId, cols, rows);
            return ok;
        });
        peer.handle('terminal.close', ({ terminalId }) => {
            this.terminals.close(terminalId);
            return ok;
        });

        peer.handle('update.status', () => updates.status());
        peer.handle('update.check', () => updates.check());
        peer.handle('update.apply', async () => {
            try {
                await updates.apply(turns.runningCount);
            } catch (error) {
                throw new RpcError(RpcErrorCode.Rejected, error instanceof Error ? error.message : String(error));
            }
            return ok;
        });

        return peer;
    }

    #applySettings(patch: Parameters<SettingsService['update']>[0]) {
        const next = this.settings.update(patch);
        this.bus.broadcast('settings.changed', { settings: next });
        return next;
    }

    /** Engine lookup for threads; external engines arrive in M2. */
    engine(id: string) {
        return engineById(id);
    }

    activity(): { runningTurns: number; pendingApprovals: number; workflowRuns: number; workflowTriggers: number } {
        const workflows = this.workflows.background();
        return {
            runningTurns: this.turns.runningCount,
            pendingApprovals: this.approvals.list().length,
            workflowRuns: workflows.runs,
            workflowTriggers: workflows.triggers,
        };
    }

    async dispose(): Promise<void> {
        clearInterval(this.#triggerSync);
        await this.triggers.close().catch(() => undefined);
        await this.turns.endSessions('app_exit');
        this.terminals.dispose();
        this.updates.dispose();
        this.workflows.dispose();
        this.team.dispose();
        this.approvals.dispose();
        await this.turns.dispose();
        await this.engines.dispose();
        this.threads.close();
        this.db.close();
    }
}
