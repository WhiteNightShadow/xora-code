import { z } from 'zod';
import {
    ApprovalDecisionSchema,
    ApprovalSchema,
    AttachmentSchema,
    ConnectionSchema,
    DiffFileSchema,
    EffortSchema,
    ExtensionsSnapshotSchema,
    FileChangeSchema,
    HandoffResultSchema,
    IdSchema,
    ItemSchema,
    ModelOptionSchema,
    ModelRefSchema,
    MoneySchema,
    PermissionModeSchema,
    PresetSummarySchema,
    ProjectSchema,
    PromptLayerSchema,
    PromptScopeSchema,
    RuleSchema,
    SettingsSchema,
    TeamRunSchema,
    ThreadMetaSchema,
    UpdateStatusSchema,
    UsageRequestSchema,
    UsageRowSchema,
    UsageTotalsSchema,
    WorkflowInfoSchema,
    WorkflowRunSchema,
} from './domain.ts';
import { EventEnvelopeSchema } from './events.ts';

/** Bumped on every breaking change to the UI↔host protocol. UI and host ship in the same app bundle. */
export const PROTOCOL_VERSION = 2;

export const SystemInfoSchema = z.object({
    protocolVersion: z.number().int(),
    bundleVersion: z.string(),
    shellVersion: z.string(),
    hostPid: z.number().int(),
    platform: z.string(),
    arch: z.string(),
    versions: z.object({
        node: z.string(),
        electron: z.string(),
    }),
    dataDir: z.string(),
    uptimeMs: z.number().nonnegative(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

const empty = z.object({}).strict();
const ok = z.object({ ok: z.literal(true) });
const threadRef = z.object({ threadId: IdSchema }).strict();

export const ThreadSnapshotSchema = z.object({
    thread: ThreadMetaSchema,
    events: z.array(EventEnvelopeSchema),
    /** Items of the running turn that are still streaming, with their text so far. */
    live: z.array(ItemSchema),
    lastSeq: z.number().int().nonnegative(),
});
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>;

export const ConnectionTestSchema = z.object({
    ok: z.boolean(),
    latencyMs: z.number().optional(),
    ttftMs: z.number().optional(),
    message: z.string().optional(),
    errorClass: z.string().optional(),
});

export const RevertResultSchema = z.object({
    restored: z.array(z.string()),
    deleted: z.array(z.string()),
    conflicts: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type RevertResult = z.infer<typeof RevertResultSchema>;

/**
 * Every method the host serves to the UI. The renderer can only call what is listed here, and both sides
 * validate params and results against these schemas.
 */
export const methods = {
    'system.ping': {
        params: z.object({ sentAt: z.number() }).strict(),
        result: z.object({ sentAt: z.number(), receivedAt: z.number() }),
    },
    'system.info': { params: empty, result: SystemInfoSchema },
    'system.open': {
        params: z
            .object({
                kind: z.enum(['external', 'path', 'reveal']),
                target: z.string().min(1).max(4096),
            })
            .strict(),
        result: ok,
    },

    'project.list': { params: empty, result: z.array(ProjectSchema) },
    'project.add': { params: z.object({ path: z.string().min(1).max(4096) }).strict(), result: ProjectSchema },
    /** Opens the native folder picker and adds the chosen folder. */
    'project.pick': { params: empty, result: ProjectSchema.nullable() },
    'project.update': {
        params: z
            .object({
                projectId: IdSchema,
                name: z.string().min(1).max(200).optional(),
                trusted: z.boolean().optional(),
                defaults: z
                    .object({ mode: PermissionModeSchema.optional(), model: ModelRefSchema.optional() })
                    .optional(),
            })
            .strict(),
        result: ProjectSchema,
    },
    'project.remove': { params: z.object({ projectId: IdSchema }).strict(), result: ok },

    'thread.list': {
        params: z.object({ projectId: IdSchema.optional(), includeArchived: z.boolean().optional() }).strict(),
        result: z.array(ThreadMetaSchema),
    },
    /** Starts a thread that turns this one into a reusable workflow or skill (06 §11); the user reviews the file. */
    'thread.distill': {
        params: z
            .object({
                threadId: IdSchema,
                kind: z.enum(['workflow', 'skill']),
                scope: z.enum(['project', 'user']).optional(),
            })
            .strict(),
        result: ThreadMetaSchema,
    },
    'thread.create': {
        params: z
            .object({
                projectId: IdSchema,
                title: z.string().max(200).optional(),
                model: ModelRefSchema.optional(),
                mode: PermissionModeSchema.optional(),
                effort: EffortSchema.optional(),
                sessionPrompt: z.string().max(100_000).optional(),
                /** Run in a separate git worktree instead of the project folder (04 §1). */
                location: z.enum(['local', 'worktree']).optional(),
                engine: z.string().max(40).optional(),
            })
            .strict(),
        result: ThreadMetaSchema,
    },
    /** Moves the thread and its uncommitted work between the project folder and a worktree. */
    'thread.handoff': {
        params: z.object({ threadId: IdSchema, to: z.enum(['local', 'worktree']) }).strict(),
        result: z.object({ thread: ThreadMetaSchema, result: HandoffResultSchema }),
    },
    /** Same task on 2–4 models, each in its own worktree (cursor /best-of-n). */
    'thread.bestOfN': {
        params: z
            .object({
                projectId: IdSchema,
                text: z.string().min(1).max(1_000_000),
                models: z.array(ModelRefSchema).min(2).max(4),
                mode: PermissionModeSchema.optional(),
            })
            .strict(),
        result: z.object({ group: z.string(), threads: z.array(ThreadMetaSchema) }),
    },
    /** Applies a worktree thread's uncommitted changes to the project folder (cursor /apply-worktree). */
    'worktree.apply': { params: threadRef, result: HandoffResultSchema },
    /** Deletes the thread's worktree after snapshotting it; the thread stays readable. */
    'worktree.remove': { params: z.object({ threadId: IdSchema, force: z.boolean().optional() }).strict(), result: ok },
    'git.diff': {
        params: z.object({ threadId: IdSchema, staged: z.boolean().optional() }).strict(),
        result: z.object({ files: z.array(DiffFileSchema), isRepo: z.boolean(), branch: z.string().optional() }),
    },
    'git.hunks': {
        params: z
            .object({
                threadId: IdSchema,
                path: z.string(),
                hunkIds: z.array(z.string()).min(1),
                action: z.enum(['stage', 'unstage', 'revert']),
                staged: z.boolean().optional(),
            })
            .strict(),
        result: ok,
    },
    'git.commit': {
        params: z
            .object({ threadId: IdSchema, message: z.string().min(1).max(10_000), all: z.boolean().optional() })
            .strict(),
        result: z.object({ commit: z.string() }),
    },
    'thread.read': {
        params: z.object({ threadId: IdSchema, afterSeq: z.number().int().nonnegative().optional() }).strict(),
        result: ThreadSnapshotSchema,
    },
    'thread.subscribe': { params: threadRef, result: ok },
    'thread.unsubscribe': { params: threadRef, result: ok },
    'thread.update': {
        params: z
            .object({
                threadId: IdSchema,
                title: z.string().min(1).max(200).optional(),
                model: ModelRefSchema.optional(),
                mode: PermissionModeSchema.optional(),
                effort: EffortSchema.optional(),
                pinned: z.boolean().optional(),
                archived: z.boolean().optional(),
            })
            .strict(),
        result: ThreadMetaSchema,
    },
    'thread.markRead': { params: threadRef, result: ok },
    'thread.markReviewed': { params: threadRef, result: ok },
    'thread.delete': { params: threadRef, result: ok },
    'thread.search': {
        params: z.object({ query: z.string().min(1).max(500) }).strict(),
        result: z.array(z.object({ threadId: z.string(), title: z.string(), snippet: z.string() })),
    },

    'turn.start': {
        params: z
            .object({
                threadId: IdSchema,
                text: z.string().max(1_000_000),
                attachments: z.array(AttachmentSchema).max(20).optional(),
            })
            .strict(),
        result: z.object({ turnId: z.string() }),
    },
    'turn.cancel': { params: threadRef, result: ok },
    /** Everything that extends agents in a project: skills, commands, agents, hooks, MCP servers, plugins (09). */
    'extension.list': {
        params: z.object({ projectId: IdSchema.optional() }).strict(),
        result: ExtensionsSnapshotSchema,
    },
    'extension.toggle': {
        params: z
            .object({
                kind: z.enum(['skill', 'mcp', 'plugin']),
                name: z.string().min(1),
                enabled: z.boolean(),
                projectId: IdSchema.optional(),
            })
            .strict(),
        result: ok,
    },
    /** Trusting a project enables its hooks and MCP servers and lets its skills run scripts (09 §5). */
    'project.trust': { params: z.object({ projectId: IdSchema, trusted: z.boolean() }).strict(), result: ok },
    'plugin.install': {
        params: z
            .object({
                source: z.discriminatedUnion('kind', [
                    z.object({ kind: z.literal('dir'), path: z.string() }),
                    z.object({ kind: z.literal('git'), url: z.string(), ref: z.string().optional() }),
                    z.object({ kind: z.literal('market'), market: z.string(), plugin: z.string() }),
                ]),
            })
            .strict(),
        result: z.object({
            name: z.string(),
            version: z.string(),
            permissions: z.array(z.string()),
            permissionsGrew: z.boolean(),
        }),
    },
    'plugin.uninstall': { params: z.object({ name: z.string() }).strict(), result: ok },
    /** Plugin marketplaces in the Claude format (`.claude-plugin/marketplace.json`), from git or a folder (09 §3). */
    'market.list': {
        params: empty,
        result: z.array(
            z.object({
                name: z.string(),
                source: z.string(),
                description: z.string().optional(),
                plugins: z.array(
                    z.object({
                        name: z.string(),
                        description: z.string().optional(),
                        version: z.string().optional(),
                        installable: z.boolean(),
                        installed: z.boolean(),
                    }),
                ),
                diagnostics: z.array(z.string()),
            }),
        ),
    },
    'market.add': {
        params: z
            .object({
                source: z.discriminatedUnion('kind', [
                    z.object({ kind: z.literal('dir'), path: z.string().min(1) }),
                    z.object({ kind: z.literal('git'), url: z.string().min(1), ref: z.string().optional() }),
                ]),
            })
            .strict(),
        result: z.object({ name: z.string(), plugins: z.number() }),
    },
    'market.refresh': { params: z.object({ name: z.string() }).strict(), result: ok },
    'market.remove': { params: z.object({ name: z.string() }).strict(), result: ok },
    'mcp.save': {
        params: z
            .object({
                name: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
                scope: z.enum(['global', 'project']),
                projectId: IdSchema.optional(),
                transport: z.enum(['stdio', 'http']),
                command: z.string().optional(),
                args: z.array(z.string()).optional(),
                env: z.record(z.string(), z.string()).optional(),
                url: z.string().optional(),
                headers: z.record(z.string(), z.string()).optional(),
            })
            .strict(),
        result: ok,
    },
    'mcp.remove': {
        params: z
            .object({ name: z.string(), scope: z.enum(['global', 'project']), projectId: IdSchema.optional() })
            .strict(),
        result: ok,
    },
    /** Finds MCP servers configured in Claude Code, Cursor, VS Code and Codex; secrets are not copied (09 §6). */
    'mcp.discover': {
        params: z.object({ projectId: IdSchema.optional() }).strict(),
        result: z.array(
            z.object({
                name: z.string(),
                tool: z.string(),
                file: z.string(),
                transport: z.string(),
                target: z.string(),
                secretKeys: z.array(z.string()),
            }),
        ),
    },
    'mcp.import': {
        params: z.object({ names: z.array(z.string()).min(1), projectId: IdSchema.optional() }).strict(),
        result: z.object({ imported: z.array(z.string()) }),
    },
    'mcp.test': {
        params: z.object({ name: z.string(), projectId: IdSchema.optional() }).strict(),
        result: z.object({ ok: z.boolean(), tools: z.array(z.string()), error: z.string().optional() }),
    },
    'mcp.authorize': { params: z.object({ name: z.string(), projectId: IdSchema.optional() }).strict(), result: ok },
    /** Starts an agent-team run: a supervisor plans and dispatches, executors deliver (06 §5). */
    'team.start': {
        params: z
            .object({
                projectId: IdSchema,
                goal: z.string().min(1).max(50_000),
                autonomy: z.enum(['L0', 'L1', 'L2', 'L3']).optional(),
                budget: z.number().positive().optional(),
                /** `hypotheses`: rival explanations investigated in parallel and challenged (06 §7). */
                mode: z.enum(['standard', 'hypotheses']).optional(),
                /** A finished run of the project this one continues: its supervisor gets that run's goal and report. */
                continues: z.string().optional(),
            })
            .strict(),
        result: TeamRunSchema,
    },
    /** The user writes to the supervisor (`supervisor`) or to a member (a task id) of a running team. */
    'team.message': {
        params: z.object({ runId: z.string(), to: z.string().min(1), text: z.string().min(1).max(20_000) }).strict(),
        result: TeamRunSchema,
    },
    'team.list': { params: z.object({ projectId: IdSchema.optional() }).strict(), result: z.array(TeamRunSchema) },
    'team.get': { params: z.object({ runId: z.string() }).strict(), result: TeamRunSchema },
    'team.stop': { params: z.object({ runId: z.string() }).strict(), result: TeamRunSchema },
    /** Continues a paused run (after a restart, a spent budget or a declined delivery), optionally with more budget. */
    'team.resume': {
        params: z.object({ runId: z.string(), budget: z.number().positive().optional() }).strict(),
        result: TeamRunSchema,
    },
    /** Workflows of a project (`.xora/workflows/`) and the user's (`<data>/workflows/`), with their problems. */
    'workflow.list': { params: z.object({ projectId: IdSchema }).strict(), result: z.array(WorkflowInfoSchema) },
    'workflow.start': {
        params: z
            .object({
                projectId: IdSchema,
                key: z.string(),
                inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
                budget: z.number().positive().optional(),
                /** Wait for the off-peak window of the models it uses. */
                offPeak: z.boolean().optional(),
            })
            .strict(),
        result: WorkflowRunSchema,
    },
    'workflow.runs': {
        params: z.object({ projectId: IdSchema.optional() }).strict(),
        result: z.array(WorkflowRunSchema),
    },
    'workflow.get': { params: z.object({ runId: z.string() }).strict(), result: WorkflowRunSchema },
    'workflow.stop': { params: z.object({ runId: z.string() }).strict(), result: WorkflowRunSchema },
    /** Continues a paused run (after a restart or a spent budget), optionally with more budget. */
    'workflow.resume': {
        params: z.object({ runId: z.string(), budget: z.number().positive().optional() }).strict(),
        result: WorkflowRunSchema,
    },
    /** Switches a project workflow's schedule, file, git and webhook triggers on or off. */
    'workflow.triggers': {
        params: z.object({ projectId: IdSchema, key: z.string(), enabled: z.boolean() }).strict(),
        result: WorkflowInfoSchema,
    },
    /** The local webhook address and token of a workflow whose triggers are on. */
    'workflow.webhook': {
        params: z.object({ projectId: IdSchema, key: z.string() }).strict(),
        result: z.object({ url: z.string(), token: z.string() }),
    },
    'team.roster': {
        params: z.object({ projectId: IdSchema }).strict(),
        result: z.object({
            org: z.string(),
            agents: z.array(
                z.object({
                    id: z.string(),
                    name: z.string(),
                    role: z.string(),
                    tier: z.string(),
                    category: z.string().optional(),
                }),
            ),
            tiers: z.record(z.string(), z.array(z.string())),
        }),
    },
    /** Reads a file inside the thread's workspace for the file preview (04 §5). */
    'fs.read': {
        params: z.object({ threadId: IdSchema, path: z.string().min(1).max(4096) }).strict(),
        result: z.object({
            path: z.string(),
            kind: z.enum(['text', 'image', 'binary', 'too_large']),
            text: z.string().optional(),
            data: z.string().optional(),
            mimeType: z.string().optional(),
            size: z.number(),
        }),
    },
    /** Fuzzy file search for @ mentions; respects .gitignore. */
    'fs.find': {
        params: z.object({ threadId: IdSchema, query: z.string().max(200) }).strict(),
        result: z.array(z.string()),
    },
    'fs.list': {
        params: z.object({ threadId: IdSchema, path: z.string().max(4096).optional() }).strict(),
        result: z.array(z.object({ name: z.string(), path: z.string(), dir: z.boolean(), size: z.number() })),
    },
    /** Inline edit (M4): rewrite a selection with the thread's model, returning the proposal without writing. */
    'edit.inline': {
        params: z
            .object({
                threadId: IdSchema,
                path: z.string().min(1).max(4096),
                start: z.number().int().nonnegative(),
                end: z.number().int().nonnegative(),
                instruction: z.string().min(1).max(20_000),
            })
            .strict(),
        result: z.object({ replacement: z.string(), oldText: z.string(), newText: z.string() }),
    },
    'edit.apply': {
        params: z
            .object({
                threadId: IdSchema,
                path: z.string().min(1).max(4096),
                expectedOld: z.string(),
                newText: z.string().max(5_000_000),
            })
            .strict(),
        result: ok,
    },
    /** Goal mode: set a goal and start working on it (04 §6). */
    'goal.start': {
        params: z
            .object({
                threadId: IdSchema,
                objective: z.string().min(1).max(20_000),
                acceptCommand: z.string().max(2000).optional(),
                maxRounds: z.number().int().min(1).max(50).optional(),
                budget: z.number().positive().optional(),
            })
            .strict(),
        result: ThreadMetaSchema,
    },
    'goal.stop': { params: threadRef, result: ThreadMetaSchema },
    /** Manual compaction (`/compact`), optionally with what to keep (08 §3). */
    'turn.compact': {
        params: z.object({ threadId: IdSchema, focus: z.string().max(2000).optional() }).strict(),
        result: z.object({ compacted: z.boolean() }),
    },

    'approval.list': { params: empty, result: z.array(ApprovalSchema) },
    'approval.respond': {
        params: z
            .object({
                approvalId: z.string().min(1),
                decision: ApprovalDecisionSchema,
                scope: z.enum(['project', 'global']).optional(),
                message: z.string().max(4000).optional(),
            })
            .strict(),
        result: ok,
    },
    'rules.list': { params: empty, result: z.array(RuleSchema) },
    'rules.remove': { params: z.object({ ruleId: z.string() }).strict(), result: ok },

    'review.turn': {
        params: z.object({ threadId: IdSchema, turnId: z.string() }).strict(),
        result: z.object({ files: z.array(FileChangeSchema), available: z.boolean() }),
    },
    'review.file': {
        params: z.object({ threadId: IdSchema, turnId: z.string(), path: z.string() }).strict(),
        result: z.object({ oldText: z.string().nullable(), newText: z.string().nullable(), binary: z.boolean() }),
    },
    /** Goes back to before a turn: the xora engine forgets it and the later turns; optionally the files too (M3-3). */
    'thread.rewind': {
        params: z
            .object({ threadId: IdSchema, turnId: z.string(), files: z.boolean(), force: z.boolean().optional() })
            .strict(),
        result: RevertResultSchema,
    },
    /** A new thread with the conversation up to and including `afterTurnId` (all of it when omitted). */
    'thread.fork': {
        params: z.object({ threadId: IdSchema, afterTurnId: z.string().optional() }).strict(),
        result: ThreadMetaSchema,
    },
    'review.revert': {
        params: z
            .object({
                threadId: IdSchema,
                turnId: z.string(),
                paths: z.array(z.string()).optional(),
                force: z.boolean().optional(),
            })
            .strict(),
        result: RevertResultSchema,
    },

    'provider.presets': { params: empty, result: z.array(PresetSummarySchema) },
    'provider.connections': { params: empty, result: z.array(ConnectionSchema) },
    'provider.save': {
        params: z
            .object({
                connectionId: IdSchema.optional(),
                presetId: z.string().min(1),
                name: z.string().max(100).optional(),
                apiKey: z.string().max(4000).optional(),
                baseUrl: z.string().max(2000).optional(),
                enabled: z.boolean().optional(),
            })
            .strict(),
        result: ConnectionSchema,
    },
    'provider.remove': { params: z.object({ connectionId: IdSchema }).strict(), result: ok },
    'provider.test': {
        params: z.object({ connectionId: IdSchema, model: z.string().optional() }).strict(),
        result: ConnectionTestSchema,
    },
    'provider.refreshModels': { params: z.object({ connectionId: IdSchema }).strict(), result: ConnectionSchema },
    /** Picks which of the connection's models are offered; the user refreshes the list by hand, nothing on a timer. */
    'provider.selectModels': {
        params: z.object({ connectionId: IdSchema, models: z.array(z.string().min(1).max(200)).max(500) }).strict(),
        result: ConnectionSchema,
    },
    'model.list': { params: empty, result: z.array(ModelOptionSchema) },
    /** Probes local model servers (ollama, lm studio, llama.cpp, vllm) on their default ports. */
    'provider.detectLocal': {
        params: empty,
        result: z.array(
            z.object({ presetId: z.string(), name: z.string(), baseUrl: z.string(), models: z.array(z.string()) }),
        ),
    },
    /** Engines a thread can run on: the built-in xora engine and external ACP agents (05 §4). */
    'engine.list': {
        params: empty,
        result: z.array(
            z.object({
                id: z.string(),
                name: z.string(),
                kind: z.enum(['builtin', 'external']),
                available: z.boolean(),
                command: z.string().optional(),
                note: z.string().optional(),
                homepage: z.string().optional(),
            }),
        ),
    },

    'settings.get': { params: empty, result: SettingsSchema },
    'settings.update': { params: z.object({ patch: SettingsSchema.partial() }).strict(), result: SettingsSchema },

    'prompt.get': {
        params: z
            .object({ scope: PromptScopeSchema, projectId: IdSchema.optional(), threadId: IdSchema.optional() })
            .strict(),
        result: z.object({ text: z.string(), path: z.string().optional() }),
    },
    'prompt.set': {
        params: z
            .object({
                scope: PromptScopeSchema,
                projectId: IdSchema.optional(),
                threadId: IdSchema.optional(),
                text: z.string().max(200_000),
            })
            .strict(),
        result: ok,
    },
    'prompt.effective': { params: threadRef, result: z.array(PromptLayerSchema) },

    'usage.summary': {
        params: z
            .object({
                range: z.enum(['today', 'week', 'month', 'all']),
                groupBy: z.enum(['model', 'provider', 'project', 'thread', 'day']),
            })
            .strict(),
        result: z.object({ totals: UsageTotalsSchema, rows: z.array(UsageRowSchema) }),
    },
    'usage.thread': {
        params: threadRef,
        result: z.object({ totals: UsageTotalsSchema, requests: z.array(UsageRequestSchema) }),
    },

    'terminal.open': {
        params: z
            .object({
                threadId: IdSchema.optional(),
                projectId: IdSchema.optional(),
                cols: z.number().int().min(10).max(1000),
                rows: z.number().int().min(4).max(500),
            })
            .strict(),
        result: z.object({ terminalId: z.string(), cwd: z.string(), shell: z.string(), scrollback: z.string() }),
    },
    'terminal.write': {
        params: z.object({ terminalId: z.string(), data: z.string().max(1_000_000) }).strict(),
        result: ok,
    },
    'terminal.resize': {
        params: z
            .object({
                terminalId: z.string(),
                cols: z.number().int().min(10).max(1000),
                rows: z.number().int().min(4).max(500),
            })
            .strict(),
        result: ok,
    },
    'terminal.close': { params: z.object({ terminalId: z.string() }).strict(), result: ok },

    'update.status': { params: empty, result: UpdateStatusSchema },
    'update.check': { params: empty, result: UpdateStatusSchema },
    'update.apply': { params: empty, result: ok },
} as const;

export type HostMethods = typeof methods;
export type MethodName = keyof HostMethods;
export type MethodParams<M extends MethodName> = z.input<HostMethods[M]['params']>;
export type MethodResult<M extends MethodName> = z.output<HostMethods[M]['result']>;

/** Notifications the host pushes to every connected UI. */
export const notifications = {
    /** A persisted event of a thread the UI subscribed to. */
    'thread.event': z.object({ event: EventEnvelopeSchema }),
    /** Streaming text for an in-flight item; not persisted. */
    'thread.delta': z.object({
        threadId: z.string(),
        turnId: z.string(),
        itemId: z.string(),
        stream: z.enum(['agent_message', 'reasoning', 'tool_output']),
        text: z.string(),
    }),
    /** New state of an in-flight item (tool call progress); not persisted. */
    'thread.item': z.object({ threadId: z.string(), item: ItemSchema }),
    /** Thread metadata changed: status, title, cost. Sent for all threads. */
    'thread.meta': z.object({ thread: ThreadMetaSchema }),
    'thread.removed': z.object({ threadId: z.string() }),
    'project.changed': z.object({ project: ProjectSchema }),
    'project.removed': z.object({ projectId: z.string() }),
    'approval.requested': z.object({ approval: ApprovalSchema }),
    'approval.resolved': z.object({ approvalId: z.string(), status: z.string() }),
    'update.changed': z.object({ status: UpdateStatusSchema }),
    'usage.changed': z.object({ threadId: z.string().optional(), cost: MoneySchema.optional() }),
    'connection.changed': z.object({}),
    'settings.changed': z.object({ settings: SettingsSchema }),
    'terminal.output': z.object({ terminalId: z.string(), data: z.string() }),
    'terminal.exit': z.object({ terminalId: z.string(), exitCode: z.number().nullable() }),
    'team.changed': z.object({ run: TeamRunSchema }),
    'workflow.changed': z.object({ run: WorkflowRunSchema }),
    'extension.changed': z.object({}),
    /** The user clicked a system notification or tray entry for this thread. */
    'ui.focusThread': z.object({ threadId: z.string() }),
} as const;

export type HostNotifications = typeof notifications;
export type NotificationName = keyof HostNotifications;
export type NotificationParams<N extends NotificationName> = z.output<HostNotifications[N]>;
