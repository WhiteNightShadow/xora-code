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
    MemberSchema,
    MemberStatsSchema,
    ModelOptionSchema,
    ModelRefSchema,
    MoneySchema,
    OrgChartSchema,
    OrgGroupSchema,
    PermissionModeSchema,
    PersonaSchema,
    PresetSummarySchema,
    ProjectSchema,
    PromptFileSchema,
    PromptLayerSchema,
    PromptLibrarySchema,
    PromptScopeSchema,
    RuleSchema,
    SettingsSchema,
    StaffPresetSchema,
    TeamRunSchema,
    ThreadMetaSchema,
    UpdateStatusSchema,
    UsageRequestSchema,
    UsageRowSchema,
    UsageTotalsSchema,
    WorkflowInfoSchema,
    WorkflowRunModeSchema,
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
    /**
     * A message for a thread that may be busy (03): a turn starts at once when the thread is free and nothing waits;
     * otherwise the message waits its turn and starts one when the running turn has ended by itself.
     */
    'turn.queue': {
        params: z
            .object({
                threadId: IdSchema,
                text: z.string().max(1_000_000),
                attachments: z.array(AttachmentSchema).max(20).optional(),
            })
            .strict(),
        result: z.object({ turnId: z.string().optional(), queuedId: z.string().optional() }),
    },
    'turn.unqueue': { params: z.object({ threadId: IdSchema, id: z.string() }).strict(), result: ok },
    'turn.editQueued': {
        params: z.object({ threadId: IdSchema, id: z.string(), text: z.string().max(1_000_000) }).strict(),
        result: ok,
    },
    /**
     * A waiting message now: into the running turn, which takes it before its next model request (06 §20), or as a
     * turn of its own when nothing runs. `steered: false`: the running turn did not take it, and it still waits.
     */
    'turn.sendQueued': {
        params: z.object({ threadId: IdSchema, id: z.string() }).strict(),
        result: z.object({ turnId: z.string().optional(), steered: z.boolean().optional() }),
    },
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
                /**
                 * What members may do without asking (06 §21): `full` by default; `default` keeps each member's own
                 * mode. High-risk actions always ask the user; at L3 nobody watches, so `full` becomes `auto_edit`.
                 */
                permission: WorkflowRunModeSchema.optional(),
                /** Members working at the same time in this run; the team setting by default. */
                parallel: z.number().int().min(1).max(8).optional(),
                /**
                 * The members who work in the run, each with its model, thinking level and permissions (06 §22);
                 * the supervisor assigns cards only to them. Absent: the supervisor picks from all members.
                 */
                members: z
                    .array(StaffPresetSchema.extend({ memberId: z.string() }).strict())
                    .max(20)
                    .optional(),
                /** The group it is handed to (06 §24): its leader supervises and its members work. */
                groupId: z.string().optional(),
            })
            .strict(),
        result: TeamRunSchema,
    },
    /**
     * Sets who works a card that has not started, and with what model, thinking level and permissions (06 §22); an
     * empty string clears a field back to the member's own.
     */
    'team.presetTask': {
        params: z
            .object({
                runId: z.string(),
                taskId: z.string(),
                memberId: z.string().optional(),
                model: z.string().max(200).optional(),
                effort: z.union([EffortSchema, z.literal('')]).optional(),
                mode: z.union([PermissionModeSchema, z.literal('')]).optional(),
            })
            .strict(),
        result: TeamRunSchema,
    },
    /** Writes the report of a run that is over again; it arrives with `team.changed`. */
    'team.brief': { params: z.object({ runId: z.string() }).strict(), result: TeamRunSchema },
    /** Changes what the members of a running team may do without asking; waiting approvals are decided again. */
    'team.setPermission': {
        params: z.object({ runId: z.string(), permission: WorkflowRunModeSchema }).strict(),
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
    /** Moves a run to the archive, or back; the sidebar and the team board list archived runs apart. */
    'team.archive': { params: z.object({ runId: z.string(), archived: z.boolean() }).strict(), result: TeamRunSchema },
    /** Deletes a run that is over, with its threads and any worktree left; `team.removed` follows. */
    'team.delete': { params: z.object({ runId: z.string() }).strict(), result: ok },
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
                mode: WorkflowRunModeSchema.optional(),
            })
            .strict(),
        result: WorkflowRunSchema,
    },
    /** Changes a live run's permissions: its running steps' threads at once, and the steps still to come. */
    'workflow.setMode': {
        params: z.object({ runId: z.string(), mode: WorkflowRunModeSchema }).strict(),
        result: WorkflowRunSchema,
    },
    /**
     * Starts a thread whose agent writes a new workflow file from what the user describes (like `thread.distill`
     * without a source thread); the file is then listed by `workflow.list`.
     */
    'workflow.draft': {
        params: z
            .object({
                projectId: IdSchema,
                description: z.string().min(1).max(20_000),
                scope: z.enum(['project', 'user']).optional(),
            })
            .strict(),
        result: ThreadMetaSchema,
    },
    'workflow.runs': {
        params: z.object({ projectId: IdSchema.optional() }).strict(),
        result: z.array(WorkflowRunSchema),
    },
    'workflow.get': { params: z.object({ runId: z.string() }).strict(), result: WorkflowRunSchema },
    'workflow.stop': { params: z.object({ runId: z.string() }).strict(), result: WorkflowRunSchema },
    /** Moves a run to the archive, or back. */
    'workflow.archiveRun': {
        params: z.object({ runId: z.string(), archived: z.boolean() }).strict(),
        result: WorkflowRunSchema,
    },
    /** Deletes a run that is over, with its sub-runs and threads; `workflow.removed` follows. */
    'workflow.deleteRun': { params: z.object({ runId: z.string() }).strict(), result: ok },
    /** Writes the brief of a run that is over again, or for the first time; it arrives with `workflow.changed`. */
    'workflow.brief': { params: z.object({ runId: z.string() }).strict(), result: WorkflowRunSchema },
    /** Opens a thread that answers a question about a run, with its brief, steps and outputs as context. */
    'workflow.ask': {
        params: z.object({ runId: z.string(), question: z.string().min(1).max(4000) }).strict(),
        result: ThreadMetaSchema,
    },
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
    /** Deletes the workflow's file (runs and their history stay); refused while a run of it is under way. */
    'workflow.delete': { params: z.object({ projectId: IdSchema, key: z.string() }).strict(), result: ok },
    /** The local webhook address and token of a workflow whose triggers are on. */
    'workflow.webhook': {
        params: z.object({ projectId: IdSchema, key: z.string() }).strict(),
        result: z.object({ url: z.string(), token: z.string() }),
    },
    /** The members of a project's organization; without a project, the built-in and the user's ones. */
    'member.list': { params: z.object({ projectId: IdSchema.optional() }).strict(), result: z.array(MemberSchema) },
    /**
     * Creates or changes a member. A new one gets an id from its name; changing a built-in member writes a file of
     * the user's that overrides it. `scope: 'project'` writes `.xora/agents/<id>.md` into the project.
     */
    'member.save': {
        params: z
            .object({
                projectId: IdSchema.optional(),
                scope: z.enum(['user', 'project']),
                member: z
                    .object({
                        id: z.string().max(64).optional(),
                        name: z.string().min(1).max(60),
                        role: z.string(),
                        category: z.string().max(40).optional(),
                        tier: z.string(),
                        /** A connected model's id; it runs on that first, its tier's chain after (06 §21). */
                        model: z.string().max(200).optional(),
                        mode: PermissionModeSchema,
                        description: z.string().max(500).optional(),
                        prompt: z.string().max(20_000),
                        tools: z.array(z.string()).optional(),
                        /** Skills of the skill library, by name (06 §21). */
                        skills: z.array(z.string().max(64)).max(20).optional(),
                        /** MCP servers it works with, by configured name (06 §27). */
                        mcp: z.array(z.string().max(64)).max(20).optional(),
                    })
                    .strict(),
                /** The group it works in (06 §24); a new member goes to the first group when absent. */
                groupId: z.string().nullable().optional(),
                /** The talent market (19 §15): `member.id` names a new member when the id is free. */
                allowNewId: z.boolean().optional(),
            })
            .strict(),
        result: MemberSchema,
    },
    /**
     * Deletes a member (06 §24): one the user made goes (its file to the trash), a built-in one leaves the
     * organization until `member.reset` brings it back. Its memory stays. The last supervisor stays.
     */
    'member.delete': {
        params: z.object({ projectId: IdSchema.optional(), memberId: z.string() }).strict(),
        result: ok,
    },
    /** Puts a built-in member back as it comes: a changed one loses the changes, a deleted one returns. */
    'member.reset': { params: z.object({ memberId: z.string() }).strict(), result: ok },
    /** What its panel shows (19 §9, §10): recent projects, tokens, its supervisor's scores, and its folder. */
    'member.stats': { params: z.object({ memberId: z.string() }).strict(), result: MemberStatsSchema },
    /** The built-in members there are to hire (19 §15), and whether each is in the organization already. */
    'member.catalog': {
        params: z.object({ projectId: IdSchema.optional() }).strict(),
        result: z.object({ personas: z.array(PersonaSchema) }),
    },
    /** The organization chart (06 §24): groups with their leaders and members, and deleted built-in members. */
    'org.get': { params: z.object({ projectId: IdSchema.optional() }).strict(), result: OrgChartSchema },
    /**
     * Creates or changes a group (19 §4): the members listed leave any other group. Left out, `leaderId`,
     * `memberIds` and `parentId` stay as they are (a new group: none); `parentId: null` is the first level.
     */
    'org.saveGroup': {
        params: z
            .object({
                projectId: IdSchema.optional(),
                id: z.string().max(64).optional(),
                name: z.string().min(1).max(60),
                description: z.string().max(300).optional(),
                parentId: z.string().nullable().optional(),
                leaderId: z.string().optional(),
                memberIds: z.array(z.string()).max(60).optional(),
                prompt: z.string().max(3000).optional(),
            })
            .strict(),
        result: OrgGroupSchema,
    },
    /** A group's prompt and the folder of its memory (19 §5). */
    'org.readGroup': {
        params: z.object({ groupId: z.string() }).strict(),
        result: z.object({ prompt: z.string(), dir: z.string() }),
    },
    /** Deletes a group: what was in it moves up a level, and its folder goes to the trash (19 §4). */
    'org.deleteGroup': { params: z.object({ groupId: z.string() }).strict(), result: ok },
    /** The prompt of everyone in the organization, the body of `org.md` (19 §6). */
    'org.root': { params: empty, result: z.object({ prompt: z.string(), dir: z.string() }) },
    'org.saveRoot': { params: z.object({ prompt: z.string().max(12_000) }).strict(), result: ok },
    /** Moves a member to a group, or out of every group (`null`). */
    'org.moveMember': {
        params: z
            .object({ projectId: IdSchema.optional(), memberId: z.string(), groupId: z.string().nullable() })
            .strict(),
        result: OrgChartSchema,
    },
    /**
     * Builds a group from a template (06 §24), such as a regular software team: a tech lead, a product manager, an
     * architect, front- and back-end engineers, QA, DevOps, a reviewer, a researcher and a principal engineer.
     * `replace` deletes the members and groups that are not part of it.
     */
    'org.applyTemplate': {
        params: z
            .object({ projectId: IdSchema.optional(), template: z.enum(['dev-team']), replace: z.boolean() })
            .strict(),
        result: OrgChartSchema,
    },
    /**
     * One part of a member's memory (06 §21): `member` its general notes, `project` its notes in a project, `team`
     * the notes all members share in a project. `projects` lists the projects it has notes in.
     */
    /** 06 §21: opens a conversation with the organization assistant, which designs and changes members with skills. */
    'member.assistant': {
        params: z.object({ projectId: IdSchema, text: z.string().min(1).max(20_000) }).strict(),
        result: ThreadMetaSchema,
    },
    /**
     * A new conversation with the chief assistant (06 §23), the one place the user talks to: it answers, or hands
     * the work to a member, a team or a workflow in any project. It belongs to no project: `projectId` only says
     * where it runs (whose files it reads), the project the user worked in last when left out. `model` and `effort`:
     * what the user picked, else the default model and their thinking level for new conversations.
     */
    'chief.start': {
        params: z
            .object({
                projectId: IdSchema.optional(),
                text: z.string().min(1).max(50_000),
                model: ModelRefSchema.optional(),
                effort: EffortSchema.optional(),
            })
            .strict(),
        result: ThreadMetaSchema,
    },
    'member.memory': {
        params: z
            .object({
                memberId: z.string(),
                scope: z.enum(['member', 'project', 'team', 'user']).optional(),
                projectId: IdSchema.optional(),
            })
            .strict(),
        result: z.object({
            text: z.string(),
            updatedAt: z.number().optional(),
            projects: z.array(z.object({ projectId: z.string(), name: z.string(), chars: z.number() })).optional(),
        }),
    },
    'member.setMemory': {
        params: z
            .object({
                memberId: z.string(),
                text: z.string().max(50_000),
                scope: z.enum(['member', 'project', 'team', 'user']).optional(),
                projectId: IdSchema.optional(),
            })
            .strict(),
        result: ok,
    },
    'member.saveRoutine': {
        params: z
            .object({
                memberId: z.string(),
                routine: z
                    .object({
                        id: z.string().optional(),
                        title: z.string().min(1).max(80),
                        schedule: z.string().min(1).max(100),
                        timezone: z.string().max(64).optional(),
                        projectId: IdSchema,
                        instruction: z.string().min(1).max(10_000),
                        enabled: z.boolean(),
                    })
                    .strict(),
            })
            .strict(),
        result: MemberSchema,
    },
    'member.deleteRoutine': {
        params: z.object({ memberId: z.string(), routineId: z.string() }).strict(),
        result: MemberSchema,
    },
    /** Runs a routine now, whatever its schedule; returns the run's thread. */
    'member.runRoutine': {
        params: z.object({ memberId: z.string(), routineId: z.string() }).strict(),
        result: ThreadMetaSchema,
    },
    /** A conversation with a member in a project: a new thread where it works as itself, started with `text`. */
    /** Hands a member work in a thread of its own; `model`, `effort` and `mode` set what it works with (06 §22). */
    'member.chat': {
        params: z
            .object({
                projectId: IdSchema,
                memberId: z.string(),
                text: z.string().min(1).max(20_000),
            })
            .merge(StaffPresetSchema)
            .strict(),
        result: ThreadMetaSchema,
    },
    /** The threads a member works or worked in, in every project, newest first. */
    'member.threads': {
        params: z.object({ memberId: z.string(), limit: z.number().int().positive().max(200).optional() }).strict(),
        result: z.array(ThreadMetaSchema),
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
    /** The prompt directory (08 §1.4): every `.md` file in it is a global prompt, and one of them is in use. */
    'prompt.list': { params: empty, result: PromptLibrarySchema },
    'prompt.read': {
        params: z.object({ name: z.string().min(1).max(400) }).strict(),
        result: z.object({ text: z.string(), path: z.string() }),
    },
    /** A new prompt without `previous`; with it, that prompt saved under `name` (a rename when they differ). */
    'prompt.save': {
        params: z
            .object({
                name: z.string().min(1).max(400),
                text: z.string().max(200_000),
                previous: z.string().min(1).max(400).optional(),
            })
            .strict(),
        result: PromptFileSchema,
    },
    'prompt.remove': { params: z.object({ name: z.string().min(1).max(400) }).strict(), result: ok },
    /** Puts a prompt in use as the user global layer; `null` for none. */
    'prompt.select': { params: z.object({ name: z.string().min(1).max(400).nullable() }).strict(), result: ok },

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
    'team.removed': z.object({ runId: z.string() }),
    'workflow.changed': z.object({ run: WorkflowRunSchema }),
    'workflow.removed': z.object({ runId: z.string() }),
    /** A member, its memory or its routines changed. */
    'member.changed': z.object({ memberId: z.string() }),
    'extension.changed': z.object({}),
    /** The user clicked a system notification or tray entry for this thread. */
    'ui.focusThread': z.object({ threadId: z.string() }),
} as const;

export type HostNotifications = typeof notifications;
export type NotificationName = keyof HostNotifications;
export type NotificationParams<N extends NotificationName> = z.output<HostNotifications[N]>;
