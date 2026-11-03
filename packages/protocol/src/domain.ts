import { z } from 'zod';
import { LanguageSettingSchema } from './language.ts';

/**
 * Product domain shared by the UI and the host: projects, threads, turns and items, approvals, providers,
 * settings, usage and updates. The host is the only writer; the UI renders what these schemas describe.
 */

export const IdSchema = z.string().min(1).max(200);

export const EffortSchema = z.enum(['off', 'low', 'medium', 'high', 'max']);
export type Effort = z.infer<typeof EffortSchema>;

/** 询问 / 自动编辑 / 计划 / 全权 (10 §2). */
export const PermissionModeSchema = z.enum(['ask', 'auto_edit', 'plan', 'full']);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ModelRefSchema = z.object({
    connectionId: IdSchema,
    model: z.string().min(1).max(200),
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const MoneySchema = z.object({
    amount: z.number(),
    currency: z.string().min(3).max(3),
});
export type Money = z.infer<typeof MoneySchema>;

// ---------------------------------------------------------------------------------------------------------
// Projects

export const ProjectSchema = z.object({
    id: IdSchema,
    name: z.string(),
    path: z.string(),
    addedAt: z.number(),
    lastOpenedAt: z.number().optional(),
    trusted: z.boolean(),
    git: z.object({ isRepo: z.boolean(), branch: z.string().optional() }),
    missing: z.boolean().optional(),
    defaults: z
        .object({
            mode: PermissionModeSchema.optional(),
            model: ModelRefSchema.optional(),
        })
        .optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------------------------------------------------
// Threads

export const ThreadStatusSchema = z.enum(['idle', 'running', 'awaiting_approval', 'failed', 'cancelled']);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const ThreadLocationSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local') }),
    z.object({ kind: z.literal('worktree'), path: z.string(), worktreeId: z.string(), branch: z.string().optional() }),
]);
export type ThreadLocation = z.infer<typeof ThreadLocationSchema>;

/** Goal mode (04 §6): work until the acceptance check passes or the rounds or budget run out. */
export const GoalSchema = z.object({
    objective: z.string(),
    acceptCommand: z.string().optional(),
    maxRounds: z.number().int().positive(),
    budget: z.number().nonnegative().optional(),
    state: z.enum(['active', 'achieved', 'exhausted', 'stopped', 'failed']),
    rounds: z.number().int().nonnegative(),
    lastCheck: z.object({ passed: z.boolean(), exitCode: z.number().nullable(), output: z.string() }).optional(),
});
export type Goal = z.infer<typeof GoalSchema>;

export const ThreadMetaSchema = z.object({
    id: IdSchema,
    projectId: IdSchema,
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    status: ThreadStatusSchema,
    /** A finished turn changed files and the user has not looked at them yet. */
    needsReview: z.boolean(),
    unread: z.boolean(),
    engine: z.string(),
    model: ModelRefSchema.nullable(),
    mode: PermissionModeSchema,
    effort: EffortSchema,
    location: ThreadLocationSchema,
    pinned: z.boolean(),
    archived: z.boolean(),
    lastSeq: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    cost: MoneySchema.nullable(),
    /** Tokens of every model request so far: what the thread used, also where no price is known. */
    tokens: z.object({ input: z.number(), output: z.number() }).optional(),
    /** Prompt tokens of the latest model request and the model's window, for the context meter. */
    context: z.object({ used: z.number(), size: z.number() }).nullable(),
    parent: z.object({ threadId: IdSchema, turnId: z.string() }).optional(),
    agentId: z.string().optional(),
    taskId: z.string().optional(),
    /** Team run this thread belongs to, and its role and model tier in it (06). */
    teamRunId: z.string().optional(),
    /** Workflow run this thread belongs to (its own thread or a step's); `taskId` is then the step id. */
    workflowRunId: z.string().optional(),
    role: z.string().optional(),
    tier: z.string().optional(),
    group: z.string().optional(),
    goal: GoalSchema.optional(),
});
export type ThreadMeta = z.infer<typeof ThreadMetaSchema>;

// ---------------------------------------------------------------------------------------------------------
// Items

export const ToolKindSchema = z.enum([
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
]);
export type ToolKind = z.infer<typeof ToolKindSchema>;

export const FileDiffSchema = z.object({
    path: z.string(),
    oldText: z.string().nullable(),
    newText: z.string(),
});

export const TodoEntrySchema = z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['high', 'medium', 'low']).optional(),
});
export type TodoEntry = z.infer<typeof TodoEntrySchema>;

/** Structured tool result for rendering; mirrors `ToolDisplay` in `@xora/tools`. */
export const ToolDisplaySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('diff'), diffs: z.array(FileDiffSchema) }),
    z.object({
        kind: z.literal('command'),
        command: z.string(),
        exitCode: z.number().nullable(),
        output: z.string(),
        truncated: z.boolean(),
        artifactPath: z.string().optional(),
        durationMs: z.number(),
        background: z.object({ jobId: z.string() }).optional(),
    }),
    z.object({ kind: z.literal('files'), paths: z.array(z.string()), truncated: z.boolean() }),
    z.object({ kind: z.literal('matches'), count: z.number(), files: z.number(), truncated: z.boolean() }),
    z.object({
        kind: z.literal('read'),
        path: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        totalLines: z.number(),
    }),
    z.object({ kind: z.literal('todo'), items: z.array(TodoEntrySchema) }),
    z.object({ kind: z.literal('text'), text: z.string() }),
]);
export type ToolDisplay = z.infer<typeof ToolDisplaySchema>;

export const ToolCallStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed', 'denied', 'cancelled']);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const LocationSchema = z.object({ path: z.string(), line: z.number().optional() });

export const AttachmentSchema = z.object({
    kind: z.enum(['image', 'text', 'file']),
    name: z.string(),
    mimeType: z.string(),
    /** base64 for images, utf-8 text for text files. */
    data: z.string().optional(),
    path: z.string().optional(),
    size: z.number().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const RiskSchema = z.enum([
    'write',
    'delete',
    'execute',
    'network',
    'outside_workspace',
    'sensitive_file',
    'unknown_command',
    'external_agent',
]);
export type Risk = z.infer<typeof RiskSchema>;

export const ApprovalDecisionSchema = z.enum(['allow_once', 'allow_session', 'allow_always', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const FileChangeSchema = z.object({
    path: z.string(),
    oldPath: z.string().optional(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
    additions: z.number(),
    deletions: z.number(),
    binary: z.boolean(),
});
export type FileChange = z.infer<typeof FileChangeSchema>;

export const ErrorClassSchema = z.enum([
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
    'engine',
    'budget',
    'unknown',
]);
export type ErrorClass = z.infer<typeof ErrorClassSchema>;

const itemBase = {
    id: z.string().min(1),
    turnId: z.string().min(1),
    ts: z.number(),
};

export const UserMessageItemSchema = z.object({
    ...itemBase,
    type: z.literal('user_message'),
    text: z.string(),
    attachments: z.array(AttachmentSchema),
});

export const AgentMessageItemSchema = z.object({ ...itemBase, type: z.literal('agent_message'), text: z.string() });
export const ReasoningItemSchema = z.object({ ...itemBase, type: z.literal('reasoning'), text: z.string() });

export const ToolCallItemSchema = z.object({
    ...itemBase,
    type: z.literal('tool_call'),
    toolCallId: z.string(),
    name: z.string().optional(),
    title: z.string(),
    kind: ToolKindSchema,
    status: ToolCallStatusSchema,
    input: z.unknown().optional(),
    /** Plain-text output for engines without structured display. */
    output: z.string().optional(),
    display: ToolDisplaySchema.optional(),
    locations: z.array(LocationSchema).optional(),
    durationMs: z.number().optional(),
});

export const PlanItemSchema = z.object({
    ...itemBase,
    type: z.literal('plan'),
    entries: z.array(TodoEntrySchema),
});

export const ApprovalItemSchema = z.object({
    ...itemBase,
    type: z.literal('approval'),
    approvalId: z.string(),
    toolCallId: z.string().optional(),
    title: z.string(),
    toolKind: ToolKindSchema,
    summary: z.string(),
    risks: z.array(RiskSchema),
    status: z.enum(['pending', 'allowed', 'denied', 'expired', 'cancelled']),
    decision: ApprovalDecisionSchema.optional(),
    /** `supervisor`: a team's supervisor approved an ordinary command of its member (06 §21). */
    decidedBy: z.enum(['user', 'rule', 'policy', 'supervisor']).optional(),
    message: z.string().optional(),
});

export const FileChangesItemSchema = z.object({
    ...itemBase,
    type: z.literal('file_changes'),
    files: z.array(FileChangeSchema),
    additions: z.number(),
    deletions: z.number(),
    /** Set when the turn's changes were reverted afterwards. */
    reverted: z.array(z.string()).optional(),
});

export const NoticeItemSchema = z.object({
    ...itemBase,
    type: z.literal('notice'),
    severity: z.enum(['info', 'warning', 'error']),
    title: z.string(),
    description: z.string().optional(),
});

export const ErrorItemSchema = z.object({
    ...itemBase,
    type: z.literal('error'),
    errorClass: ErrorClassSchema,
    message: z.string(),
    retryable: z.boolean(),
    retryAfterMs: z.number().optional(),
});

export const CompactionItemSchema = z.object({
    ...itemBase,
    type: z.literal('compaction'),
    status: z.enum(['started', 'completed', 'failed']),
    level: z.number().int().min(1).max(4),
    summary: z.string().optional(),
    before: z.number().optional(),
    after: z.number().optional(),
});

/**
 * Work the thread's agent handed to a subagent (a child thread, `parent` set): its card in the parent's turn.
 * `agent` is the defined agent's name, empty for a general-purpose subagent.
 */
export const SubagentItemSchema = z.object({
    ...itemBase,
    type: z.literal('subagent'),
    taskId: z.string(),
    title: z.string(),
    agent: z.string(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    summary: z.string().optional(),
    threadId: z.string().optional(),
    cost: MoneySchema.optional(),
    /** The tool call that started it, whose own card the UI then leaves out. */
    toolCallId: z.string().optional(),
});

/**
 * Work the chief assistant handed on (06 §23): a team run, a workflow run or a member's conversation. Its card in
 * the assistant's turn follows the work: `waiting` while it waits for the user, the outcome's first lines once over.
 * A card that reports news after the turn it started in (`report`) goes into the latest turn instead.
 */
export const DelegationItemSchema = z.object({
    ...itemBase,
    type: z.literal('delegation'),
    kind: z.enum(['team', 'workflow', 'member']),
    /** The team or workflow run, or the member's thread. */
    refId: z.string(),
    projectId: IdSchema,
    title: z.string(),
    /** The member's name, or the workflow's title. */
    who: z.string().optional(),
    status: z.enum(['running', 'waiting', 'done', 'failed', 'cancelled']),
    /** What it waits for from the user, its progress, or the outcome once over. */
    summary: z.string().optional(),
    cost: MoneySchema.optional(),
    /** The tool call that handed it on, whose own card the UI then leaves out. */
    toolCallId: z.string().optional(),
    /** A later report on work handed on in an earlier turn. */
    report: z.boolean().optional(),
});

export const ItemSchema = z.discriminatedUnion('type', [
    UserMessageItemSchema,
    AgentMessageItemSchema,
    ReasoningItemSchema,
    ToolCallItemSchema,
    PlanItemSchema,
    ApprovalItemSchema,
    FileChangesItemSchema,
    NoticeItemSchema,
    ErrorItemSchema,
    CompactionItemSchema,
    SubagentItemSchema,
    DelegationItemSchema,
]);
export type Item = z.infer<typeof ItemSchema>;
export type ItemOf<T extends Item['type']> = Extract<Item, { type: T }>;

// ---------------------------------------------------------------------------------------------------------
// Approvals

export const ApprovalSchema = z.object({
    id: z.string().min(1),
    threadId: IdSchema,
    turnId: z.string(),
    projectId: IdSchema,
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    title: z.string(),
    toolKind: ToolKindSchema,
    summary: z.string(),
    /** Command line for shell tools. */
    command: z.string().optional(),
    paths: z.array(z.string()),
    risks: z.array(RiskSchema),
    createdAt: z.number(),
    expiresAt: z.number(),
    /** Which "always" scopes make sense for this call. */
    alwaysScopes: z.array(z.enum(['project', 'global'])),
    engine: z.string(),
    /** A supervisor decides it on the user's behalf (06 §24): it is not the user's to answer unless handed back. */
    reviewer: z.literal('supervisor').optional(),
    /** Mass deletion or dropping a database: the user decides it themselves (06 §24). */
    grave: z.enum(['mass_delete', 'drop_database']).optional(),
    /** Why the supervisor handed it back to the user. */
    note: z.string().optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const RuleSchema = z.object({
    id: z.string(),
    scope: z.enum(['global', 'project']),
    projectId: z.string().optional(),
    /** Tool name, or `*` for any tool. */
    tool: z.string(),
    /**
     * Command prefix for shell tools, path glob for file tools, a domain for fetches (its subdomains too), `*` for
     * any input.
     */
    pattern: z.string(),
    decision: z.enum(['allow', 'ask', 'deny']),
    createdAt: z.number(),
    note: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

// ---------------------------------------------------------------------------------------------------------
// Providers and models

export const ReasoningInfoSchema = z.object({
    mode: z.enum(['none', 'always', 'toggle']),
    efforts: z.array(EffortSchema),
    defaultEffort: EffortSchema,
});

export const ModelSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    family: z.string(),
    contextWindow: z.number(),
    maxOutput: z.number(),
    input: z.array(z.enum(['text', 'image'])),
    reasoning: ReasoningInfoSchema,
    tools: z.boolean(),
    pricing: z.string().optional(),
    verified: z.string().optional(),
    deprecated: z.string().optional(),
});
export type ModelSummary = z.infer<typeof ModelSummarySchema>;

export const PresetSummarySchema = z.object({
    id: z.string(),
    name: z.string(),
    vendor: z.string(),
    channel: z.enum(['api', 'subscription_key', 'local', 'custom']),
    region: z.enum(['cn', 'global']).optional(),
    wire: z.enum(['openai_chat', 'anthropic_messages']),
    baseUrl: z.string().optional(),
    needsKey: z.boolean(),
    models: z.array(ModelSummarySchema),
    compliance: z
        .object({
            interactiveOnly: z.boolean().optional(),
            allowed: z.boolean().optional(),
            note: z.string().optional(),
        })
        .optional(),
    links: z
        .object({ docs: z.string().optional(), keys: z.string().optional(), pricing: z.string().optional() })
        .optional(),
    verified: z.string().optional(),
});
export type PresetSummary = z.infer<typeof PresetSummarySchema>;

export const ConnectionSchema = z.object({
    id: IdSchema,
    presetId: z.string(),
    name: z.string(),
    baseUrl: z.string().optional(),
    hasKey: z.boolean(),
    enabled: z.boolean(),
    /** The models the user picked: what model pickers, defaults and team tiers offer. */
    models: z.array(ModelSummarySchema),
    /** Everything the connection is known to serve: the preset's models and those its server listed last time. */
    available: z.array(ModelSummarySchema).optional(),
    createdAt: z.number(),
    status: z
        .object({
            ok: z.boolean(),
            checkedAt: z.number(),
            message: z.string().optional(),
            errorClass: ErrorClassSchema.optional(),
        })
        .optional(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

export const ModelOptionSchema = z.object({
    connectionId: z.string(),
    connectionName: z.string(),
    presetId: z.string(),
    model: ModelSummarySchema,
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

// ---------------------------------------------------------------------------------------------------------
// Settings

/**
 * The permissions a workflow run's steps get: `default` keeps each step's own (its agent's mode, the project's for
 * commands); `auto_edit` lets every step edit files; `full` allows everything inside the workspace. Read-only agents
 * stay read-only.
 */
export const WorkflowRunModeSchema = z.enum(['default', 'auto_edit', 'full']);
export type WorkflowRunMode = z.infer<typeof WorkflowRunModeSchema>;

export const SettingsSchema = z.object({
    language: LanguageSettingSchema,
    theme: z.enum(['system', 'light', 'dark']),
    density: z.enum(['comfortable', 'compact']),
    defaultModel: ModelRefSchema.nullable(),
    /** Titles, summaries and compaction. */
    fastModel: ModelRefSchema.nullable(),
    /**
     * Tried in order when a thread's model is rate limited, overloaded or failing (07 §7); switching to another
     * vendor summarises the context first. Team runs pick theirs by tier.
     */
    fallbackModels: z.array(ModelRefSchema).max(3),
    defaultMode: PermissionModeSchema,
    defaultEffort: EffortSchema,
    /** Cap on the context the engine keeps, regardless of the model window (08 §2). */
    softContextWindow: z.number().int().positive(),
    /** Xora engine: add language server errors to the results of edits when a server is installed (04 §3). */
    lspDiagnostics: z.boolean(),
    notifications: z.object({ onComplete: z.boolean(), onApproval: z.boolean(), onFailure: z.boolean() }),
    preventSleep: z.boolean(),
    currency: z.enum(['CNY', 'USD']),
    usdToCny: z.number().positive(),
    update: z.object({
        channel: z.enum(['stable', 'beta', 'nightly', 'dev']),
        feedUrl: z.string(),
        autoCheck: z.boolean(),
    }),
    budgets: z.object({
        dailyLimit: z.number().nonnegative().nullable(),
        monthlyLimit: z.number().nonnegative().nullable(),
        turnLimit: z.number().nonnegative().nullable(),
    }),
    /**
     * Agent teams (06): members of one run that work at the same time, and the model members run on (06 §25):
     * `default` (absent) the default model unless a member or a card has its own; `tiers` each tier's model chain.
     */
    team: z.object({
        maxParallel: z.number().int().min(1).max(8),
        models: z.enum(['default', 'tiers']).optional(),
    }),
    /**
     * Who answers approval cards (06 §24): `supervisor` has a supervisor agent decide them on the user's behalf, and
     * only mass deletion and dropping a database reach the user; `user` asks the user.
     */
    approvals: z.object({ reviewer: z.enum(['supervisor', 'user']) }),
    /** What the user chose when they last started a team run or a workflow: the next one starts from it. */
    lastChoices: z.object({
        teamAutonomy: z.enum(['L0', 'L1', 'L2', 'L3']),
        teamMode: z.enum(['standard', 'hypotheses']),
        teamBudget: z.number().positive().nullable(),
        workflowMode: WorkflowRunModeSchema,
        /** Absent until the first team run that sets it: `full`. */
        teamPermission: WorkflowRunModeSchema.optional(),
    }),
});
export type Settings = z.infer<typeof SettingsSchema>;

// ---------------------------------------------------------------------------------------------------------
// Prompts

export const PromptScopeSchema = z.enum(['global', 'project', 'thread']);
export type PromptScope = z.infer<typeof PromptScopeSchema>;

export const PromptLayerSchema = z.object({
    id: z.string(),
    title: z.string(),
    source: z.string(),
    text: z.string(),
    chars: z.number(),
    tokens: z.number(),
    truncated: z.boolean(),
    editable: z.boolean(),
});
export type PromptLayer = z.infer<typeof PromptLayerSchema>;

// ---------------------------------------------------------------------------------------------------------
// Usage

export const UsageTotalsSchema = z.object({
    requests: z.number(),
    inputTokens: z.number(),
    cachedTokens: z.number(),
    outputTokens: z.number(),
    reasoningTokens: z.number(),
    cost: MoneySchema,
    /** False when some request had an unknown price. */
    complete: z.boolean(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageRequestSchema = z.object({
    id: z.string(),
    ts: z.number(),
    turnId: z.string(),
    provider: z.string(),
    model: z.string(),
    agentPath: z.string(),
    inputTokens: z.number(),
    cachedTokens: z.number(),
    cacheWriteTokens: z.number(),
    outputTokens: z.number(),
    reasoningTokens: z.number(),
    latencyMs: z.number(),
    ttftMs: z.number().optional(),
    cost: MoneySchema.nullable(),
    period: z.string().optional(),
    complete: z.boolean(),
    status: z.enum(['ok', 'error']),
    errorClass: z.string().optional(),
    stopReason: z.string().optional(),
});
export type UsageRequest = z.infer<typeof UsageRequestSchema>;

export const UsageRowSchema = z.object({
    key: z.string(),
    label: z.string(),
    totals: UsageTotalsSchema,
    cacheHitRate: z.number(),
});
export type UsageRow = z.infer<typeof UsageRowSchema>;

// ---------------------------------------------------------------------------------------------------------
// Updates

export const UpdateStatusSchema = z.object({
    bundleVersion: z.string(),
    shellVersion: z.string(),
    channel: z.string(),
    state: z.enum(['idle', 'checking', 'downloading', 'ready', 'up_to_date', 'error', 'disabled']),
    available: z.object({ version: z.string(), notes: z.string().optional(), size: z.number().optional() }).optional(),
    staged: z.string().optional(),
    error: z.string().optional(),
    checkedAt: z.number().optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

// ---------------------------------------------------------------------------------------------------------
// Working-tree review (hunks)

export const DiffLineSchema = z.object({
    kind: z.enum([' ', '+', '-']),
    text: z.string(),
    oldLine: z.number().optional(),
    newLine: z.number().optional(),
    noNewline: z.boolean().optional(),
});

export const DiffHunkSchema = z.object({
    id: z.string(),
    header: z.string(),
    oldStart: z.number(),
    oldLines: z.number(),
    newStart: z.number(),
    newLines: z.number(),
    lines: z.array(DiffLineSchema),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffFileSchema = z.object({
    oldPath: z.string(),
    newPath: z.string(),
    status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied']),
    binary: z.boolean(),
    hunks: z.array(DiffHunkSchema),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const HandoffResultSchema = z.object({
    status: z.enum(['moved', 'conflicts', 'failed', 'nothing']),
    tracked: z.array(z.string()),
    untracked: z.array(z.string()),
    conflicts: z.array(z.object({ path: z.string(), reason: z.string() })),
    message: z.string().optional(),
});
export type HandoffResult = z.infer<typeof HandoffResultSchema>;

// ---------------------------------------------------------------------------------------------------------
// Agent teams (06)

/**
 * What a member works with in a team run, set before it starts (06 §22): a connected model's id, a thinking level
 * and permissions. Absent fields fall back to the member's own settings and the run's permissions.
 */
export const StaffPresetSchema = z.object({
    model: z.string().max(200).optional(),
    effort: EffortSchema.optional(),
    mode: PermissionModeSchema.optional(),
});
export type StaffPreset = z.infer<typeof StaffPresetSchema>;

/**
 * The report on a run that is over, for whoever ordered it (06 §22): markdown under `## 目标达成`, `## 已完成`,
 * `## 下一步` (`## Outcome`, `## Done`, `## Next steps`). Briefs written before have `## 结论`, `## 问题`, `## 下一步`.
 */
export const RunBriefSchema = z.object({
    status: z.enum(['writing', 'ready', 'failed']),
    text: z.string().optional(),
    /** Why it could not be written. */
    note: z.string().optional(),
    at: z.number(),
});
export type RunBrief = z.infer<typeof RunBriefSchema>;

export const TeamTaskSchema = z.object({
    id: z.string(),
    title: z.string(),
    goal: z.string(),
    category: z.string(),
    tier: z.string(),
    status: z.string(),
    assignee: z.string().optional(),
    threadId: z.string().optional(),
    dependsOn: z.array(z.string()),
    ownership: z.array(z.string()),
    acceptance: z.array(z.unknown()),
    attempts: z.number(),
    /** The stage the member is on or ended with, once it handed in a partial deliverable (06 §20). */
    stage: z.number().optional(),
    /** What is left, from the latest partial deliverable, while the task runs. */
    remaining: z.array(z.string()).optional(),
    /** The supervisor's latest guidance on the task. */
    guidance: z.string().optional(),
    /** The host's latest watch report on the running member: `repeat`, `spin` or `silent`. */
    watch: z.object({ rule: z.string(), at: z.number() }).optional(),
    /**
     * Who works it and with what (06 §22): before it starts, the member and settings it will get (`preset` when the
     * user set them); once dispatched, what it runs with.
     */
    memberId: z.string().optional(),
    model: z.string().optional(),
    effort: EffortSchema.optional(),
    mode: PermissionModeSchema.optional(),
    preset: z.boolean().optional(),
    deliverable: z.unknown().optional(),
    verdict: z
        .object({ verdict: z.string(), reasons: z.array(z.string()), outOfOwnership: z.array(z.string()) })
        .optional(),
    cost: MoneySchema.nullable(),
});
export type TeamTask = z.infer<typeof TeamTaskSchema>;

export const TeamRunSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    goal: z.string(),
    status: z.enum([
        'planning',
        'awaiting_plan_approval',
        'running',
        'integrating',
        'done',
        'failed',
        'paused',
        'cancelled',
    ]),
    autonomy: z.enum(['L0', 'L1', 'L2', 'L3']),
    budget: MoneySchema.nullable(),
    /** Why the run is paused, stuck or failed. */
    note: z.string().optional(),
    /** Things the user should know, e.g. a tier that fell back to the default model. */
    warnings: z.array(z.string()).optional(),
    supervisorThreadId: z.string().optional(),
    mode: z.enum(['standard', 'hypotheses']).optional(),
    /** The earlier run of the project this one continues. */
    continues: z.string().optional(),
    /** Moved to the archive by the user: listed apart. */
    archived: z.boolean().optional(),
    /** What members may do without asking (06 §21). */
    permission: z.enum(['default', 'auto_edit', 'full']).optional(),
    /** Members working at the same time. */
    parallel: z.number().optional(),
    /** The members the user chose for the run, with their settings (06 §22); absent: the supervisor picks. */
    members: z.array(StaffPresetSchema.extend({ memberId: z.string(), name: z.string() })).optional(),
    /** The group the run was handed to (06 §24): its leader supervises, its members work. */
    group: z.object({ id: z.string(), name: z.string() }).optional(),
    /** The gist of the goal, for lists (06 §28); absent until written, and on older runs. */
    title: z.string().optional(),
    /** The supervisor's report to the user once the run is over (06 §22); `report` keeps the details. */
    brief: RunBriefSchema.optional(),
    /** The supervisor's last message of each turn, newest last: what it reports to the user. */
    feedback: z.array(z.object({ ts: z.number(), text: z.string() })).optional(),
    /** Messages between the user, the supervisor and the members (06 §7), oldest first. */
    conversation: z
        .array(
            z.object({
                ts: z.number(),
                from: z.string(),
                to: z.string(),
                text: z.string(),
                /** `stage`: a member handed in part of its card; `guide`: the supervisor's task_guide; `watch`: the host's watch (06 §20). */
                kind: z.enum([
                    'message',
                    'question',
                    'answer',
                    'user',
                    'challenge',
                    'stage',
                    'guide',
                    'watch',
                    'approval',
                ]),
            }),
        )
        .optional(),
    tasks: z.array(TeamTaskSchema),
    ledger: z.unknown().optional(),
    progress: z.array(z.unknown()),
    report: z.string().optional(),
    cost: MoneySchema,
    /** Share of the cost spent by the supervisor (06 §5); alert above the organisation's threshold. */
    supervisionShare: z.number(),
    costByTier: z.record(z.string(), z.number()),
    createdAt: z.number(),
    updatedAt: z.number(),
});
export type TeamRun = z.infer<typeof TeamRunSchema>;

// ---------------------------------------------------------------------------------------------------------
// Workflows (06 §11–§12)

const WorkflowScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const WorkflowInfoSchema = z.object({
    /** `project:<name>` or `user:<name>`. */
    key: z.string(),
    name: z.string(),
    title: z.string(),
    description: z.string().optional(),
    source: z.enum(['project', 'user']),
    path: z.string(),
    /** Problems in the file; a workflow with any cannot run. */
    issues: z.array(z.object({ path: z.string(), message: z.string(), line: z.number().optional() })),
    /** A project workflow in a project not trusted yet: it cannot run until the user trusts the project. */
    untrusted: z.boolean(),
    inputs: z.array(
        z.object({
            name: z.string(),
            type: z.enum(['string', 'number', 'boolean']),
            description: z.string().optional(),
            default: WorkflowScalarSchema.optional(),
        }),
    ),
    steps: z.array(z.object({ id: z.string(), type: z.string(), title: z.string(), needs: z.array(z.string()) })),
    trigger: z.object({
        manual: z.boolean(),
        schedule: z.array(z.string()),
        timezone: z.string().optional(),
        files: z.array(z.string()),
        git: z.array(z.string()),
        webhook: z.boolean(),
        offPeakOnly: z.boolean(),
    }),
    /** Triggers act only once the user switched them on, and stop when the file changed since (`stale`). */
    triggers: z.object({
        enabled: z.boolean(),
        stale: z.boolean(),
        /** The next scheduled run, while the triggers are on. */
        nextRunAt: z.number().optional(),
    }),
    budget: MoneySchema.nullable(),
});
export type WorkflowInfo = z.infer<typeof WorkflowInfoSchema>;

export const WorkflowStepRunSchema = z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    needs: z.array(z.string()),
    status: z.enum(['pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled']),
    attempts: z.number(),
    agent: z.string().optional(),
    tier: z.string().optional(),
    outputs: z.record(z.string(), z.string()),
    summary: z.string().optional(),
    note: z.string().optional(),
    threadIds: z.array(z.string()),
    teamRunId: z.string().optional(),
    childRunId: z.string().optional(),
    cost: MoneySchema.nullable(),
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
});
export type WorkflowStepRun = z.infer<typeof WorkflowStepRunSchema>;

/** A job a member does on a schedule (06 §19), in one project, unattended. */
export const MemberRoutineSchema = z.object({
    id: z.string(),
    title: z.string(),
    /** Five-field cron such as `0 9 * * 1-5`, or `@daily` and the like, in `timezone` (the system's when absent). */
    schedule: z.string(),
    timezone: z.string().optional(),
    projectId: IdSchema,
    /** What the member does each time. */
    instruction: z.string(),
    enabled: z.boolean(),
    lastRunAt: z.number().optional(),
    /** The thread of the last run. */
    lastThreadId: z.string().optional(),
    nextRunAt: z.number().optional(),
    /** Why it does not run: a schedule that does not parse, a project that is gone. */
    problem: z.string().optional(),
});
export type MemberRoutine = z.infer<typeof MemberRoutineSchema>;

/**
 * A member of the team (06 §19): one of the organization's agents, built in or made by the user, with a name, a
 * job, a model tier and permissions, a long-term memory it keeps itself, and routines. Its conversations, workflow
 * steps and team tasks are threads with its id as `agentId`.
 */
export const MemberSchema = z.object({
    id: z.string(),
    /** Built-in members carry their name in the UI language until the user renames them. */
    name: z.string(),
    /** supervisor, planner, plan_reviewer, scout, executor, reviewer or specialist. */
    role: z.string(),
    /** An executor's kind of work, such as `coding` or `testing`. */
    category: z.string().optional(),
    tier: z.string(),
    /** The model it runs on before its tier's chain (06 §21), as a model id; absent: the tier picks. */
    model: z.string().optional(),
    mode: PermissionModeSchema,
    description: z.string().optional(),
    /** Its own layer of the system prompt. */
    prompt: z.string(),
    /** Its tool whitelist; absent means its role's. */
    tools: z.array(z.string()).optional(),
    /** Skills of the skill library it brings to its work (06 §21). */
    skills: z.array(z.string()).optional(),
    /** MCP servers it works with, by configured name (06 §27). */
    mcp: z.array(z.string()).optional(),
    /** Built in, the user's (every project, `<data>/orgs/default/agents/`) or the project's (`.xora/agents/`). */
    source: z.enum(['builtin', 'user', 'project']),
    /** A built-in member the user changed: a file of the user's overrides it. */
    customized: z.boolean(),
    /** The file that defines it, when there is one. */
    file: z.string().optional(),
    /** All its own notes (general and per project); `projects`: the projects it has notes in. */
    memory: z.object({ chars: z.number(), updatedAt: z.number().optional(), projects: z.number().optional() }),
    routines: z.array(MemberRoutineSchema),
});
export type Member = z.infer<typeof MemberSchema>;

/**
 * A group of the organization (06 §24), the way a company has teams: a leader (a supervisor, who plans and hands
 * out the group's work) and its members. A member is in one group at most; one not in any reports to the user.
 */
export const OrgGroupSchema = z.object({
    id: z.string(),
    name: z.string(),
    /** One line: what the group does. */
    description: z.string().optional(),
    leaderId: z.string(),
    memberIds: z.array(z.string()),
});
export type OrgGroup = z.infer<typeof OrgGroupSchema>;

/** The organization chart (06 §24): its groups, and the built-in members the user deleted, who can come back. */
export const OrgChartSchema = z.object({
    groups: z.array(OrgGroupSchema),
    removed: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type OrgChart = z.infer<typeof OrgChartSchema>;

/**
 * The report for whoever ordered a run (06 §11): what came of it, what is wrong, what to do next, without the
 * steps. Written once the run is over.
 */
export const WorkflowBriefSchema = RunBriefSchema;
export type WorkflowBrief = z.infer<typeof WorkflowBriefSchema>;

export const WorkflowRunSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    key: z.string(),
    name: z.string(),
    title: z.string(),
    status: z.enum(['queued', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled']),
    reason: z.enum(['manual', 'schedule', 'files', 'git', 'webhook', 'parent']),
    /** Started by a trigger: API channels only, with a budget (06 §12). */
    unattended: z.boolean(),
    /** Moved to the archive by the user: listed apart. */
    archived: z.boolean().optional(),
    inputs: z.record(z.string(), WorkflowScalarSchema),
    /** Why the run is queued, paused, failed or cancelled. */
    note: z.string().optional(),
    warnings: z.array(z.string()),
    /** When a run queued for the off-peak window starts. */
    startsAt: z.number().optional(),
    /** The run's own thread: progress notices and the approval cards of gates and commands. */
    threadId: z.string(),
    parentRunId: z.string().optional(),
    steps: z.array(WorkflowStepRunSchema),
    budget: MoneySchema.nullable(),
    cost: MoneySchema,
    /** Absent on runs from before it existed: `default`. */
    mode: WorkflowRunModeSchema.optional(),
    /** Absent until the run is over, and on runs from before briefs existed. */
    brief: WorkflowBriefSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    endedAt: z.number().optional(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

// ---------------------------------------------------------------------------------------------------------
// Extensions (09)

export const ExtensionOriginSchema = z.enum(['builtin', 'user', 'project', 'plugin', 'imported', 'global']);

export const SkillInfoSchema = z.object({
    name: z.string(),
    description: z.string(),
    origin: ExtensionOriginSchema,
    path: z.string(),
    trusted: z.boolean(),
    enabled: z.boolean(),
    plugin: z.string().optional(),
});
export type SkillInfo = z.infer<typeof SkillInfoSchema>;

export const CommandInfoSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    argumentHint: z.string().optional(),
    origin: ExtensionOriginSchema,
    path: z.string(),
});
export type CommandInfo = z.infer<typeof CommandInfoSchema>;

export const AgentInfoSchema = z.object({
    name: z.string(),
    description: z.string(),
    origin: ExtensionOriginSchema,
    path: z.string(),
    tier: z.string().optional(),
    role: z.string().optional(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const HookInfoSchema = z.object({
    event: z.string(),
    matcher: z.string().optional(),
    command: z.string(),
    origin: ExtensionOriginSchema,
    source: z.string(),
    trusted: z.boolean(),
});
export type HookInfo = z.infer<typeof HookInfoSchema>;

export const McpServerInfoSchema = z.object({
    name: z.string(),
    transport: z.enum(['stdio', 'http', 'sse']),
    target: z.string(),
    origin: ExtensionOriginSchema,
    enabled: z.boolean(),
    trusted: z.boolean(),
    status: z.enum(['stopped', 'starting', 'running', 'failed', 'unknown']),
    error: z.string().optional(),
    tools: z.number().optional(),
    needsAuth: z.boolean().optional(),
    /** Where it is configured: `global` and `project` are edited in settings, `repo` is the repository's `.mcp.json`. */
    scope: z.enum(['global', 'project', 'repo', 'plugin']).optional(),
    /** Secrets an import could not copy. */
    missingSecrets: z.array(z.string()).optional(),
});
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

export const PluginInfoSchema = z.object({
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    enabled: z.boolean(),
    source: z.string(),
    installedAt: z.number(),
    components: z.object({
        skills: z.number(),
        commands: z.number(),
        agents: z.number(),
        hooks: z.number(),
        mcpServers: z.number(),
    }),
    permissions: z.array(z.string()),
});
export type PluginInfo = z.infer<typeof PluginInfoSchema>;

export const ExtensionsSnapshotSchema = z.object({
    projectTrusted: z.boolean(),
    skills: z.array(SkillInfoSchema),
    commands: z.array(CommandInfoSchema),
    agents: z.array(AgentInfoSchema),
    hooks: z.array(HookInfoSchema),
    mcpServers: z.array(McpServerInfoSchema),
    plugins: z.array(PluginInfoSchema),
    diagnostics: z.array(z.string()),
});
export type ExtensionsSnapshot = z.infer<typeof ExtensionsSnapshotSchema>;
