import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { findPriceTableForModel, getPriceTable } from '@xora/metering';
import {
    type HostMethods,
    type HostNotifications,
    type ItemOf,
    type ModelRef,
    type PermissionMode,
    type Project,
    type Risk,
    RpcError,
    RpcErrorCode,
    type RpcPeer,
    type TeamRun,
    type ToolKind,
    type WorkflowInfo,
    type WorkflowRun as WorkflowRunView,
    type WorkflowStepRun,
} from '@xora/protocol';
import { fromJson, type XoraDatabase } from '@xora/storage';
import { isReadOnlyCommand } from '@xora/tools';
import {
    type AgentSpec,
    type AgentStep,
    type AutonomyLevel,
    DEFAULT_FAILURE_POLICY,
    decideSteps,
    type FailurePolicy,
    findAgent,
    type GateStep,
    isFinished,
    issuePath,
    newStepState,
    nextTier,
    type Organization,
    parseWorkflow,
    type RunContext,
    type RunTrigger,
    renderTemplate,
    resolveInputs,
    runOutcome,
    type ScriptStep,
    type StepState,
    type StepVerify,
    type SubWorkflowStep,
    type SuperviseStep,
    stepTiers,
    TIER_LABELS,
    type Tier,
    validateAutonomy,
    type WorkflowDefinition,
    type WorkflowParse,
    type WorkflowScalar,
    type WorkflowStep,
} from '@xora/workflows';
import { pickTierModel, runChannels } from './agent-models.ts';
import type { ApprovalOutcome, ApprovalService } from './approvals.ts';
import type { Bus } from './bus.ts';
import type { ConnectionService } from './connections.ts';
import type { HostToolResult } from './engines/manager.ts';
import { runCheck } from './goals.ts';
import { newId } from './ids.ts';
import type { Logger } from './log.ts';
import type { CallFacts } from './policy.ts';
import type { ProjectService } from './projects.ts';
import type { SettingsService } from './settings.ts';
import type { TeamService } from './team.ts';
import { disabledBuiltins, loadTeamOrganization, shorten, systemLayers } from './team-agents.ts';
import type { ThreadStore } from './threads.ts';
import type { HostToolProvider, TurnEnded, TurnService } from './turns.ts';
import type { UsageService } from './usage.ts';

/**
 * Workflow runs (06 §11): fixed steps from a YAML file, started by hand or by a trigger (06 §12). Each run has a
 * thread of its own for progress notices and the approval cards of gates and commands; agent steps work in
 * threads of their own in the project directory, supervisor steps start a team run, script steps and
 * verification commands go through the permission policy. Runs are saved after every change and continue after
 * a restart from the steps that had not finished.
 */

/** Sub-workflows nested this deep at most. */
const MAX_DEPTH = 3;
const OUTPUT_TAIL = 4_000;
const SUMMARY_LIMIT = 4_000;
const TEAM_POLL_MS = 2_000;
const BROADCAST_MS = 200;
const RECENT_ENDS = 64;
const MAX_FILE_BYTES = 256_000;
const PROJECT_DIR = path.join('.xora', 'workflows');

type RunStatus = WorkflowRunView['status'];
const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);
const TEAM_TERMINAL: ReadonlySet<TeamRun['status']> = new Set(['done', 'failed', 'cancelled']);

/** Everything about a run that survives a restart, saved as `run_json`. */
interface RunRecord {
    readonly id: string;
    readonly projectId: string;
    readonly key: string;
    readonly definition: WorkflowDefinition;
    readonly org: Organization;
    readonly autonomy: AutonomyLevel;
    readonly trigger: RunTrigger;
    readonly unattended: boolean;
    readonly inputs: Record<string, WorkflowScalar>;
    /** The run's own thread and the turn its notices and approval cards are attached to. */
    readonly threadId: string;
    readonly turnId: string;
    readonly parentRunId?: string;
    readonly depth: number;
    status: RunStatus;
    note?: string;
    warnings: string[];
    budget?: { limit: number; currency: string };
    startsAt?: number;
    steps: Record<string, StepState>;
    readonly createdAt: number;
    updatedAt: number;
    endedAt?: number;
}

interface RunState {
    record: RunRecord;
    abort: AbortController;
    /** Steps whose host loop is running. */
    readonly working: Set<string>;
    /** `step_result` hand-ins of the current agent turn, by step id. */
    readonly results: Map<string, { summary: string; outputs: Record<string, string> }>;
    pumping: boolean;
    again: boolean;
    startTimer: ReturnType<typeof setTimeout> | undefined;
    broadcastTimer: ReturnType<typeof setTimeout> | undefined;
}

/** How a step's host loop ended; `pending` puts it back for later (the run was paused). */
interface StepResult {
    readonly status: 'succeeded' | 'failed' | 'skipped' | 'cancelled' | 'pending';
    readonly summary?: string;
    readonly outputs?: Record<string, string>;
    readonly note?: string;
}

interface DefinitionEntry {
    readonly key: string;
    readonly name: string;
    readonly source: 'project' | 'user';
    readonly path: string;
    readonly hash: string;
    readonly parsed: WorkflowParse;
    readonly problems: readonly string[];
}

interface TriggerRow {
    enabled: number;
    file_hash: string | null;
    last_scheduled_at: number | null;
    webhook_token: string | null;
}

interface ApproveRequest {
    readonly toolName: string;
    readonly title: string;
    readonly toolKind: ToolKind;
    readonly summary: string;
    readonly risks: readonly Risk[];
    readonly command?: string;
}

export interface WorkflowDeps {
    readonly db: XoraDatabase;
    readonly bus: Bus;
    readonly log: Logger;
    readonly threads: ThreadStore;
    readonly projects: ProjectService;
    readonly connections: ConnectionService;
    readonly settings: SettingsService;
    readonly approvals: ApprovalService;
    readonly usage: UsageService;
    readonly turns: TurnService;
    readonly team: TeamService;
    /** `<data>/orgs` (06 §2). */
    readonly orgsDir: string;
    /** `<data>/workflows`: the user's workflows, runnable in any project. */
    readonly workflowsDir: string;
    /** When a run that waits for off-peak prices may start; `undefined` means now (06 §12, 11 §7). */
    readonly offPeakAt?: (models: readonly ModelRef[], now: number) => number | undefined;
    /** Called when the switched-on triggers may have changed. */
    readonly onTriggersChanged?: () => void;
    /** The local webhook address of a workflow, once the trigger service runs one. */
    readonly webhookUrl?: (triggerKey: string) => string | undefined;
    /** Stops file triggers of a project while a run works in it, so its own edits start nothing; returns the undo. */
    readonly muteFiles?: (projectDir: string) => () => void;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function tail(output: string): string {
    const trimmed = output.trimEnd();
    return trimmed.length > OUTPUT_TAIL ? `…${trimmed.slice(-OUTPUT_TAIL)}` : trimmed;
}

function round(amount: number): number {
    return Math.round(amount * 1e6) / 1e6;
}

function stepTitle(step: WorkflowStep): string {
    return step.title ?? step.id;
}

function ok(content: string): HostToolResult {
    return { content };
}

function fail(content: string): HostToolResult {
    return { content, isError: true };
}

/** The key the trigger service knows a project workflow by. */
export function triggerKey(projectId: string, key: string): string {
    return `${projectId}|${key}`;
}

const STEP_RESULT_TOOL: HostToolProvider['tools'][number] = {
    name: 'step_result',
    description:
        'Hand in the result of this workflow step: `summary` says what you did and where the evidence is, `outputs` ' +
        'holds the values the step declares (strings). Call it once at the end, then end your turn; the host runs ' +
        'the verification, if any.',
    parameters: {
        type: 'object',
        properties: {
            summary: { type: 'string' },
            outputs: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['summary'],
        additionalProperties: false,
    },
    kind: 'other',
};

export class WorkflowService {
    readonly #deps: WorkflowDeps;
    readonly #runs = new Map<string, RunState>();
    /** Host-started turns waiting for their end, by turn id. */
    readonly #waiters = new Map<string, (event: TurnEnded) => void>();
    /** Ends nobody waited for yet, by turn id. */
    readonly #early = new Map<string, TurnEnded>();
    /** Waiting for any turn of a thread to end, by thread id. */
    readonly #idle = new Map<string, Array<() => void>>();
    /** Parents waiting for a sub-workflow, by child run id. */
    readonly #ends = new Map<string, Array<(record: RunRecord) => void>>();
    /** Undoes the file-trigger mute of each run that is not over. */
    readonly #unmute = new Map<string, () => void>();
    readonly #ready: Promise<void>;
    #disposed = false;

    constructor(deps: WorkflowDeps) {
        this.#deps = deps;
        this.#ready = this.#recover().catch((error) => deps.log.warn(`workflow: recovery failed: ${errorText(error)}`));
    }

    // Definitions ----------------------------------------------------------------------------------------------

    /** Project workflows (`.xora/workflows/*.yaml`) and the user's (`<data>/workflows/*.yaml`). */
    async list(projectId: string): Promise<WorkflowInfo[]> {
        const project = await this.#deps.projects.get(projectId);
        const entries = await this.#definitions(project);
        return entries.map((entry) => this.#info(project, entry));
    }

    async #definitions(project: Project): Promise<DefinitionEntry[]> {
        const entries: DefinitionEntry[] = [];
        const sources: Array<['project' | 'user', string]> = [
            ['project', path.join(project.path, PROJECT_DIR)],
            ['user', this.#deps.workflowsDir],
        ];
        for (const [source, dir] of sources) {
            let files: string[];
            try {
                files = (await readdir(dir)).filter((file) => /\.ya?ml$/i.test(file)).sort();
            } catch {
                continue;
            }
            const seen = new Set<string>();
            for (const file of files) {
                const full = path.join(dir, file);
                let text: string;
                try {
                    text = await readFile(full, 'utf8');
                } catch {
                    continue;
                }
                const parsed: WorkflowParse =
                    text.length > MAX_FILE_BYTES
                        ? { ok: false, issues: [{ path: [], message: '文件太大（上限256kb）' }] }
                        : parseWorkflow(text);
                const name = parsed.ok ? parsed.definition.name : file.replace(/\.ya?ml$/i, '');
                const problems: string[] = [];
                if (seen.has(name)) {
                    problems.push(`另一个文件已经用了名字${name}`);
                }
                seen.add(name);
                if (source === 'project' && !project.trusted) {
                    problems.push('项目还没有被信任：信任后才能运行项目里的工作流');
                }
                entries.push({
                    key: `${source}:${name}`,
                    name,
                    source,
                    path: full,
                    hash: createHash('sha256').update(text).digest('hex'),
                    parsed,
                    problems,
                });
            }
        }
        return entries;
    }

    async #entry(project: Project, key: string): Promise<DefinitionEntry> {
        const entry = (await this.#definitions(project)).find((candidate) => candidate.key === key);
        if (!entry) {
            throw new RpcError(RpcErrorCode.NotFound, `找不到工作流${key}`);
        }
        return entry;
    }

    #triggerRow(projectId: string, key: string): TriggerRow | undefined {
        return this.#deps.db.get<TriggerRow>(
            'select enabled, file_hash, last_scheduled_at, webhook_token from workflow_triggers where project_id = ? and workflow_key = ?',
            [projectId, key],
        );
    }

    #info(project: Project, entry: DefinitionEntry): WorkflowInfo {
        const definition = entry.parsed.ok ? entry.parsed.definition : undefined;
        const issues = [
            ...(entry.parsed.ok
                ? []
                : entry.parsed.issues.map((issue) => ({
                      path: issuePath(issue.path),
                      message: issue.message,
                      ...(issue.line !== undefined ? { line: issue.line } : {}),
                  }))),
            ...entry.problems.map((message) => ({ path: '', message })),
        ];
        const row = this.#triggerRow(project.id, entry.key);
        const trigger = definition?.trigger;
        const schedule = trigger?.schedule === undefined ? [] : [trigger.schedule].flat();
        const currency = this.#deps.settings.get().currency;
        return {
            key: entry.key,
            name: entry.name,
            title: definition?.title ?? entry.name,
            ...(definition?.description ? { description: definition.description } : {}),
            source: entry.source,
            path: entry.path,
            issues,
            inputs: Object.entries(definition?.inputs ?? {}).map(([name, input]) => ({
                name,
                type: input.type,
                ...(input.description ? { description: input.description } : {}),
                ...(input.default !== undefined ? { default: input.default } : {}),
            })),
            steps: (definition?.steps ?? []).map((step) => ({
                id: step.id,
                type: step.type,
                title: stepTitle(step),
                needs: step.needs,
            })),
            trigger: {
                manual: trigger?.manual ?? true,
                schedule,
                ...(trigger?.timezone ? { timezone: trigger.timezone } : {}),
                files: trigger?.files?.paths ?? [],
                git: trigger?.git?.on ?? [],
                webhook: trigger?.webhook ?? false,
                offPeakOnly: trigger?.offPeakOnly ?? false,
            },
            triggers: { enabled: row?.enabled === 1, stale: row?.enabled === 1 && row.file_hash !== entry.hash },
            budget: definition?.budget
                ? { amount: definition.budget.perRun, currency: definition.budget.currency ?? currency }
                : null,
        };
    }

    // Triggers -------------------------------------------------------------------------------------------------

    /**
     * Switches a project workflow's triggers on or off. On remembers the file's hash: when the file changes (a
     * pull, an edit) the triggers stop until they are switched on again, so a repository cannot start runs on
     * this machine by itself.
     */
    async setTriggers(projectId: string, key: string, enabled: boolean): Promise<WorkflowInfo> {
        const project = await this.#deps.projects.get(projectId);
        const entry = await this.#entry(project, key);
        if (enabled) {
            if (entry.source !== 'project') {
                throw new RpcError(RpcErrorCode.Rejected, '只有项目里的工作流能自动运行');
            }
            if (!entry.parsed.ok || entry.problems.length > 0) {
                throw new RpcError(RpcErrorCode.Rejected, '工作流有问题，先修好再启用自动运行');
            }
            const { trigger } = entry.parsed.definition;
            if (trigger.schedule === undefined && !trigger.files && !trigger.git && !trigger.webhook) {
                throw new RpcError(RpcErrorCode.Rejected, '这个工作流没有定时、文件、git或webhook触发');
            }
        }
        const existing = this.#triggerRow(projectId, key);
        const token =
            existing?.webhook_token ??
            (enabled && entry.parsed.ok && entry.parsed.definition.trigger.webhook
                ? randomBytes(24).toString('base64url')
                : null);
        this.#deps.db.run(
            `insert into workflow_triggers (project_id, workflow_key, enabled, file_hash, last_scheduled_at, webhook_token, updated_at)
             values (?, ?, ?, ?, ?, ?, ?)
             on conflict (project_id, workflow_key) do update set enabled = excluded.enabled,
                 file_hash = excluded.file_hash, webhook_token = excluded.webhook_token, updated_at = excluded.updated_at`,
            [
                projectId,
                key,
                enabled ? 1 : 0,
                enabled ? entry.hash : (existing?.file_hash ?? null),
                existing?.last_scheduled_at ?? Date.now(),
                token,
                Date.now(),
            ],
        );
        this.#deps.log.info(`workflow ${key} in ${projectId}: triggers ${enabled ? 'on' : 'off'}`);
        this.#deps.onTriggersChanged?.();
        return this.#info(project, entry);
    }

    async webhook(projectId: string, key: string): Promise<{ url: string; token: string }> {
        const row = this.#triggerRow(projectId, key);
        if (row?.enabled !== 1 || !row.webhook_token) {
            throw new RpcError(RpcErrorCode.Rejected, '这个工作流的webhook没有启用');
        }
        const url = this.#deps.webhookUrl?.(triggerKey(projectId, key));
        if (!url) {
            throw new RpcError(RpcErrorCode.Rejected, '本机webhook还没有启动');
        }
        return { url, token: row.webhook_token };
    }

    /**
     * Workflows whose triggers are on and whose file did not change since, for the trigger service. Returns the
     * definition, the time of the last scheduled run and the webhook token.
     */
    async enabledTriggers(): Promise<
        Array<{
            projectId: string;
            projectDir: string;
            key: string;
            definition: WorkflowDefinition;
            lastScheduledAt?: number;
            webhookToken?: string;
        }>
    > {
        const rows = this.#deps.db.all<{ project_id: string; workflow_key: string } & TriggerRow>(
            'select project_id, workflow_key, enabled, file_hash, last_scheduled_at, webhook_token from workflow_triggers where enabled = 1',
        );
        const out = [];
        for (const row of rows) {
            try {
                const project = await this.#deps.projects.get(row.project_id);
                if (project.missing || !project.trusted) continue;
                const entry = (await this.#definitions(project)).find((item) => item.key === row.workflow_key);
                if (!entry?.parsed.ok || entry.hash !== row.file_hash) continue;
                out.push({
                    projectId: project.id,
                    projectDir: project.path,
                    key: entry.key,
                    definition: entry.parsed.definition,
                    ...(row.last_scheduled_at !== null ? { lastScheduledAt: row.last_scheduled_at } : {}),
                    ...(row.webhook_token ? { webhookToken: row.webhook_token } : {}),
                });
            } catch {
                // The project is gone.
            }
        }
        return out;
    }

    /**
     * A trigger fired: start an unattended run unless the file changed, the triggers were switched off or a run
     * of the same workflow is still going.
     */
    async fire(input: {
        readonly projectId: string;
        readonly key: string;
        readonly trigger: RunTrigger;
        readonly scheduledFor?: number;
    }): Promise<WorkflowRunView | undefined> {
        await this.#ready;
        const { log } = this.#deps;
        const row = this.#triggerRow(input.projectId, input.key);
        if (input.scheduledFor !== undefined) {
            this.#deps.db.run(
                'update workflow_triggers set last_scheduled_at = ? where project_id = ? and workflow_key = ?',
                [input.scheduledFor, input.projectId, input.key],
            );
        }
        if (row?.enabled !== 1) return undefined;
        const project = await this.#deps.projects.get(input.projectId);
        const entry = await this.#entry(project, input.key).catch(() => undefined);
        if (!entry?.parsed.ok || entry.problems.length > 0 || entry.hash !== row.file_hash) {
            log.warn(
                `workflow ${input.key}: ${input.trigger.reason} trigger ignored, the file changed or has problems`,
            );
            return undefined;
        }
        const busy = [...this.#runs.values()].some(
            (state) =>
                state.record.projectId === input.projectId &&
                state.record.key === input.key &&
                !TERMINAL.has(state.record.status),
        );
        if (busy) {
            log.info(`workflow ${input.key}: ${input.trigger.reason} trigger skipped, a run is still going`);
            return undefined;
        }
        return this.#begin({
            project,
            entry,
            given: {},
            trigger: input.trigger,
            unattended: true,
            offPeak: entry.parsed.definition.trigger.offPeakOnly,
            depth: 0,
        });
    }

    /** Projects with a workflow run that is not over: their own file changes must not trigger runs. */
    activeProjects(): Set<string> {
        return new Set(
            [...this.#runs.values()]
                .filter((state) => !TERMINAL.has(state.record.status))
                .map((state) => state.record.projectId),
        );
    }

    // Runs -----------------------------------------------------------------------------------------------------

    async start(input: {
        projectId: string;
        key: string;
        inputs?: Record<string, WorkflowScalar>;
        budget?: number;
        offPeak?: boolean;
    }): Promise<WorkflowRunView> {
        await this.#ready;
        const project = await this.#deps.projects.get(input.projectId);
        if (project.missing) {
            throw new RpcError(RpcErrorCode.Rejected, `项目文件夹不存在：${project.path}`);
        }
        const entry = await this.#entry(project, input.key);
        if (!entry.parsed.ok) {
            const first = entry.parsed.issues[0];
            throw new RpcError(
                RpcErrorCode.Rejected,
                `工作流有问题：${first ? `${issuePath(first.path)} ${first.message}` : '无法解析'}`,
            );
        }
        if (entry.problems.length > 0) {
            throw new RpcError(RpcErrorCode.Rejected, entry.problems.join('；'));
        }
        return this.#begin({
            project,
            entry,
            given: input.inputs ?? {},
            trigger: { reason: 'manual' },
            unattended: false,
            offPeak: input.offPeak ?? false,
            depth: 0,
            ...(input.budget !== undefined ? { budget: input.budget } : {}),
        });
    }

    async #begin(input: {
        project: Project;
        entry: DefinitionEntry;
        given: Readonly<Record<string, unknown>>;
        trigger: RunTrigger;
        unattended: boolean;
        offPeak: boolean;
        depth: number;
        budget?: number;
        parentRunId?: string;
    }): Promise<WorkflowRunView> {
        const { threads, settings, log } = this.#deps;
        const { project, entry } = input;
        if (!entry.parsed.ok) {
            throw new RpcError(RpcErrorCode.Rejected, '工作流有问题');
        }
        const definition = entry.parsed.definition;
        const resolved = resolveInputs(definition.inputs, input.given);
        if ('errors' in resolved) {
            throw new RpcError(RpcErrorCode.InvalidParams, resolved.errors.join('；'));
        }
        const loaded = await loadTeamOrganization({
            orgsDir: this.#deps.orgsDir,
            projectDir: project.path,
            trusted: project.trusted,
        });
        const org = loaded.org;
        const warnings = [...loaded.warnings];
        if (definition.org && definition.org !== org.id) {
            warnings.push(`工作流指定的组织${definition.org}不存在，改用${org.id}`);
        }
        const problems: string[] = [];
        const agents: AgentSpec[] = [];
        for (const step of definition.steps) {
            const names =
                step.type === 'agent' ? [step.agent, ...(step.onFailure?.agent ? [step.onFailure.agent] : [])] : [];
            for (const name of names) {
                const agent = findAgent(org, name);
                if (agent) agents.push(agent);
                else problems.push(`组织${org.id}里没有agent ${name}（步骤${step.id}）`);
            }
        }
        const currency = settings.get().currency;
        const fromFile =
            definition.budget && (definition.budget.currency ?? currency) === currency
                ? definition.budget.perRun
                : undefined;
        const fromOrg = org.budgets.currency === currency && org.budgets.perRun ? org.budgets.perRun : undefined;
        const limit = input.budget ?? fromFile ?? fromOrg;
        const autonomy: AutonomyLevel = input.unattended ? 'L3' : (definition.autonomy ?? org.autonomy);
        if (input.unattended) {
            // Nobody watches an unattended run: API channels only, a budget, no full-access agents (06 §8, §12).
            const tiers = stepTiers(definition, (name) => findAgent(org, name)?.tier);
            const checked = validateAutonomy('L3', {
                channels: runChannels(this.#deps, org, project, true, tiers),
                ...(limit !== undefined ? { budget: limit } : {}),
                modes: agents.map((agent) => agent.mode),
            });
            if (!checked.ok) {
                problems.push(...checked.problems.map((problem) => problem.message));
            }
            // A budget only holds when every request can be priced.
            const unpriced = this.#runModels(org, project, tiers, true).filter((ref) => !this.#priced(ref));
            if (unpriced.length > 0) {
                problems.push(
                    `无人值守运行要能计价，这些模型没有价格表：${[...new Set(unpriced.map((ref) => ref.model))].join('、')}`,
                );
            }
        }
        if (problems.length > 0 && !input.unattended && input.parentRunId === undefined) {
            throw new RpcError(RpcErrorCode.Rejected, problems.join('；'));
        }
        const runId = newId('wf');
        const title = definition.title ?? definition.name;
        const thread = threads.create({
            projectId: project.id,
            title: `工作流：${shorten(title, 24)}`,
            engine: 'xora',
            model: null,
            mode: 'plan',
            effort: 'medium',
            extra: { workflowRunId: runId, role: 'workflow', group: runId },
        });
        const turnId = newId('turn');
        const now = Date.now();
        const shown = Object.entries(resolved.inputs)
            .map(([name, value]) => `${name}=${shorten(String(value), 60)}`)
            .join('，');
        threads.append(
            thread.id,
            'turn.started',
            {
                turnId,
                input: {
                    id: newId('i'),
                    turnId,
                    ts: now,
                    type: 'user_message',
                    text: `运行工作流“${title}”${shown ? `（${shown}）` : ''}`,
                    attachments: [],
                },
                model: null,
                mode: 'plan',
                effort: 'medium',
            },
            { turnId },
        );
        const steps: Record<string, StepState> = {};
        for (const step of definition.steps) {
            steps[step.id] = newStepState();
        }
        const record: RunRecord = {
            id: runId,
            projectId: project.id,
            key: entry.key,
            definition,
            org,
            autonomy,
            trigger: input.trigger,
            unattended: input.unattended,
            inputs: resolved.inputs,
            threadId: thread.id,
            turnId,
            ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
            depth: input.depth,
            status: 'running',
            warnings,
            ...(limit !== undefined ? { budget: { limit, currency } } : {}),
            steps,
            createdAt: now,
            updatedAt: now,
        };
        const state = this.#state(record);
        this.#runs.set(runId, state);
        this.#mute(record.id, project.path);
        log.info(`workflow ${runId} (${entry.key}) started in ${project.id}: ${input.trigger.reason}`);
        if (problems.length > 0) {
            this.#finish(state, 'failed', `没有开始：${problems.join('；')}`);
            return this.#view(state);
        }
        if (warnings.length > 0) {
            this.#notice(state, 'warning', '注意', warnings.join('\n'));
        }
        const startsAt = input.offPeak ? this.#offPeakStart(record, project) : undefined;
        if (startsAt !== undefined && startsAt > now) {
            record.status = 'queued';
            record.startsAt = startsAt;
            record.note = `等到空闲时段再开始（${new Date(startsAt).toLocaleString('zh-CN', { hour12: false })}）`;
            this.#notice(state, 'info', '排队', record.note);
            this.#armStart(state);
        } else {
            this.#notice(state, 'info', '开始运行', `${definition.steps.length}个步骤`);
            this.#pump(state);
        }
        this.#save(state);
        return this.#view(state);
    }

    /** The first model of each tier's chain, the ones the run's steps start on. */
    #runModels(org: Organization, project: Project, tiers: readonly Tier[], unattended: boolean): ModelRef[] {
        const models: ModelRef[] = [];
        for (const tier of tiers) {
            try {
                models.push(pickTierModel(this.#deps, { org, project, tier, unattended, warnings: [] }).ref);
            } catch {
                // No model for the tier: the step fails on its own.
            }
        }
        return models;
    }

    #priced(ref: ModelRef): boolean {
        const connection = this.#deps.connections.list().find((item) => item.id === ref.connectionId);
        const pricing = connection?.models.find((model) => model.id === ref.model)?.pricing;
        return (
            (pricing !== undefined && getPriceTable(pricing) !== undefined) ||
            findPriceTableForModel(ref.model) !== undefined
        );
    }

    /** The off-peak start of the models the run would use first, or `undefined` to start now. */
    #offPeakStart(record: RunRecord, project: Project): number | undefined {
        if (!this.#deps.offPeakAt) return undefined;
        const tiers = stepTiers(record.definition, (name) => findAgent(record.org, name)?.tier);
        return this.#deps.offPeakAt(this.#runModels(record.org, project, tiers, record.unattended), Date.now());
    }

    #armStart(state: RunState): void {
        clearTimeout(state.startTimer);
        const at = state.record.startsAt;
        if (at === undefined || this.#disposed) return;
        // Timers fire late after a sleep; re-check at least every minute.
        const delay = Math.max(0, Math.min(at - Date.now(), 60_000));
        state.startTimer = setTimeout(() => {
            const { record } = state;
            if (record.status !== 'queued') return;
            if (Date.now() < (record.startsAt ?? 0)) {
                this.#armStart(state);
                return;
            }
            record.status = 'running';
            delete record.startsAt;
            delete record.note;
            this.#notice(state, 'info', '开始运行', '到了空闲时段');
            this.#pump(state);
            this.#save(state);
        }, delay);
    }

    async runs(projectId?: string): Promise<WorkflowRunView[]> {
        await this.#ready;
        const rows = this.#deps.db.all<{ id: string }>(
            projectId
                ? 'select id from workflow_runs where project_id = ? order by created_at desc limit 50'
                : 'select id from workflow_runs order by created_at desc limit 100',
            projectId ? [projectId] : [],
        );
        const out: WorkflowRunView[] = [];
        for (const row of rows) {
            const state = this.#load(row.id);
            if (state) out.push(this.#view(state));
        }
        return out;
    }

    async get(runId: string): Promise<WorkflowRunView> {
        await this.#ready;
        return this.#view(this.#require(runId));
    }

    async stop(runId: string): Promise<WorkflowRunView> {
        await this.#ready;
        const state = this.#require(runId);
        if (!TERMINAL.has(state.record.status)) {
            this.#finish(state, 'cancelled', '用户停止了运行');
        }
        return this.#view(state);
    }

    /** Continues a paused run from the steps that had not finished, optionally with a new budget. */
    async resume(runId: string, budget?: number): Promise<WorkflowRunView> {
        await this.#ready;
        const state = this.#require(runId);
        const { record } = state;
        if (record.status !== 'paused') {
            throw new RpcError(RpcErrorCode.Rejected, '只有暂停的运行可以继续');
        }
        if (budget !== undefined) {
            record.budget = { limit: budget, currency: record.budget?.currency ?? this.#deps.settings.get().currency };
        }
        if (this.#overBudget(state)) {
            throw new RpcError(RpcErrorCode.Rejected, '预算还是不够：追加预算后再继续');
        }
        record.status = 'running';
        delete record.note;
        state.abort = new AbortController();
        this.#mute(record.id, (await this.#deps.projects.get(record.projectId)).path);
        this.#notice(state, 'info', '继续运行');
        this.#pump(state);
        this.#save(state);
        return this.#view(state);
    }

    onTurnEnded(event: TurnEnded): void {
        if (this.#disposed) return;
        for (const resolve of this.#idle.get(event.threadId)?.splice(0) ?? []) {
            resolve();
        }
        const waiter = this.#waiters.get(event.turnId);
        if (waiter) {
            this.#waiters.delete(event.turnId);
            waiter(event);
            return;
        }
        if (this.#deps.threads.find(event.threadId)?.workflowRunId) {
            this.#early.set(event.turnId, event);
            if (this.#early.size > RECENT_ENDS) {
                const oldest = this.#early.keys().next().value;
                if (oldest !== undefined) this.#early.delete(oldest);
            }
        }
    }

    dispose(): void {
        this.#disposed = true;
        for (const state of this.#runs.values()) {
            clearTimeout(state.startTimer);
            clearTimeout(state.broadcastTimer);
            state.abort.abort();
        }
    }

    // State and persistence ------------------------------------------------------------------------------------

    #mute(runId: string, projectDir: string): void {
        if (this.#deps.muteFiles && !this.#unmute.has(runId)) {
            this.#unmute.set(runId, this.#deps.muteFiles(projectDir));
        }
    }

    #state(record: RunRecord): RunState {
        return {
            record,
            abort: new AbortController(),
            working: new Set(),
            results: new Map(),
            pumping: false,
            again: false,
            startTimer: undefined,
            broadcastTimer: undefined,
        };
    }

    /** Runs that were going when the host stopped: queued ones wait on, the others are paused (06 §9). */
    async #recover(): Promise<void> {
        const rows = this.#deps.db.all<{ id: string }>(
            "select id from workflow_runs where status in ('queued', 'running', 'waiting')",
        );
        for (const row of rows) {
            const state = this.#load(row.id);
            if (!state) continue;
            const { record } = state;
            if (record.status === 'queued') {
                const project = await this.#deps.projects.get(record.projectId).catch(() => undefined);
                if (project) this.#mute(record.id, project.path);
                this.#armStart(state);
                continue;
            }
            for (const step of Object.values(record.steps)) {
                if (step.status === 'running' || step.status === 'waiting') {
                    step.status = 'pending';
                }
            }
            record.status = 'paused';
            record.note = '应用重启时这次运行还没结束，已暂停；继续后从没做完的步骤接着做';
            this.#save(state);
        }
    }

    #load(runId: string): RunState | undefined {
        const live = this.#runs.get(runId);
        if (live) return live;
        const row = this.#deps.db.get<{ run_json: string }>('select run_json from workflow_runs where id = ?', [runId]);
        const record = row ? fromJson<RunRecord | null>(row.run_json, null) : null;
        if (!record) return undefined;
        const state = this.#state(record);
        this.#runs.set(runId, state);
        return state;
    }

    #require(runId: string): RunState {
        const state = this.#load(runId);
        if (!state) {
            throw new RpcError(RpcErrorCode.NotFound, `找不到工作流运行${runId}`);
        }
        return state;
    }

    #save(state: RunState): void {
        if (this.#disposed) return;
        const { record } = state;
        record.updatedAt = Date.now();
        this.#deps.db.run(
            `insert into workflow_runs (id, project_id, workflow_key, status, parent_run_id, created_at, updated_at, run_json)
             values (?, ?, ?, ?, ?, ?, ?, ?)
             on conflict (id) do update set status = excluded.status, updated_at = excluded.updated_at,
                 run_json = excluded.run_json`,
            [
                record.id,
                record.projectId,
                record.key,
                record.status,
                record.parentRunId ?? null,
                record.createdAt,
                record.updatedAt,
                JSON.stringify(record),
            ],
        );
        this.#changed(state);
    }

    #changed(state: RunState): void {
        if (state.broadcastTimer || this.#disposed) return;
        state.broadcastTimer = setTimeout(() => {
            state.broadcastTimer = undefined;
            if (!this.#disposed) {
                this.#deps.bus.broadcast('workflow.changed', { run: this.#view(state) });
            }
        }, BROADCAST_MS);
    }

    /** Running, or waiting on an approval card while other steps go on. */
    #active(record: RunRecord): boolean {
        return record.status === 'running' || record.status === 'waiting';
    }

    #live(state: RunState): boolean {
        return this.#active(state.record) && !this.#disposed;
    }

    /** What a step's loop returns when the run stopped being live under it. */
    #interrupted(state: RunState): StepResult {
        return state.record.status === 'paused' ? { status: 'pending' } : { status: 'cancelled' };
    }

    #context(record: RunRecord): RunContext {
        return { runId: record.id, inputs: record.inputs, trigger: record.trigger, steps: record.steps };
    }

    // Scheduling -----------------------------------------------------------------------------------------------

    #pump(state: RunState): void {
        if (this.#disposed) return;
        if (state.pumping) {
            state.again = true;
            return;
        }
        state.pumping = true;
        try {
            do {
                state.again = false;
                this.#advance(state);
            } while (state.again);
        } finally {
            state.pumping = false;
        }
    }

    #advance(state: RunState): void {
        const { record } = state;
        if (!this.#active(record)) return;
        const { definition } = record;
        let runnable: WorkflowStep[] = [];
        for (;;) {
            const decisions = decideSteps(definition, this.#context(record));
            const skips = decisions.filter((decision) => decision.action === 'skip');
            for (const skip of skips) {
                this.#finishStep(state, skip.step, { status: 'skipped', note: skip.reason });
            }
            if (skips.length === 0) {
                runnable = decisions.map((decision) => decision.step);
                break;
            }
        }
        for (const step of runnable) {
            if (state.working.size >= definition.concurrency || !this.#active(record)) break;
            if (this.#overBudget(state)) {
                this.#pauseForBudget(state);
                break;
            }
            this.#launch(state, step);
        }
        if (state.working.size === 0 && this.#active(record)) {
            const outcome = runOutcome(definition, record.steps);
            if (outcome !== 'running') {
                this.#finish(state, outcome === 'completed' ? 'completed' : 'failed');
            }
        }
        this.#save(state);
    }

    #launch(state: RunState, step: WorkflowStep): void {
        const { record } = state;
        const current = record.steps[step.id] as StepState;
        current.status = 'running';
        current.startedAt = Date.now();
        delete current.note;
        state.working.add(step.id);
        this.#notice(state, 'info', `开始：${stepTitle(step)}`);
        void this.#execute(state, step)
            .catch((error): StepResult => ({ status: 'failed', note: errorText(error) }))
            .then((result) => {
                state.working.delete(step.id);
                if (this.#disposed) return;
                if (TERMINAL.has(record.status)) {
                    if (!isFinished(current.status)) {
                        current.status = 'cancelled';
                        current.endedAt = Date.now();
                    }
                    this.#save(state);
                    return;
                }
                this.#finishStep(state, step, result);
                this.#pump(state);
            });
    }

    #finishStep(state: RunState, step: WorkflowStep, result: StepResult): void {
        const { record } = state;
        const current = record.steps[step.id] as StepState;
        if (result.status === 'pending') {
            current.status = 'pending';
            this.#save(state);
            return;
        }
        current.status = result.status;
        current.endedAt = Date.now();
        if (result.summary !== undefined) current.summary = shorten(result.summary, SUMMARY_LIMIT);
        if (result.outputs) current.outputs = result.outputs;
        if (result.note !== undefined) current.note = result.note;
        const title = stepTitle(step);
        switch (result.status) {
            case 'succeeded':
                this.#notice(state, 'info', `完成：${title}`, current.summary);
                break;
            case 'skipped':
                this.#notice(state, 'info', `跳过：${title}`, result.note);
                break;
            case 'failed':
                this.#notice(state, 'error', `失败：${title}`, result.note);
                this.#finish(state, 'failed', `步骤${title}失败：${result.note ?? ''}`);
                break;
            case 'cancelled':
                break;
        }
        this.#save(state);
    }

    /** Ends the run: stops what is still going, cancels the steps that did not finish, writes the report. */
    #finish(state: RunState, status: 'completed' | 'failed' | 'cancelled', note?: string): void {
        const { record } = state;
        if (TERMINAL.has(record.status)) return;
        const { threads, turns, approvals, team, log } = this.#deps;
        record.status = status;
        record.endedAt = Date.now();
        if (note) record.note = note;
        else delete record.note;
        clearTimeout(state.startTimer);
        state.abort.abort();
        for (const [id, step] of Object.entries(record.steps)) {
            if (isFinished(step.status)) continue;
            const wasWorking = state.working.has(id);
            step.status = 'cancelled';
            step.endedAt = Date.now();
            if (!wasWorking) continue;
            const thread = step.threadIds.at(-1);
            if (thread && turns.isRunning(thread)) turns.cancel(thread);
            if (step.teamRunId) {
                void team.stop(step.teamRunId).catch(() => undefined);
            }
            if (step.childRunId) {
                const child = this.#runs.get(step.childRunId);
                if (child) this.#finish(child, 'cancelled', '上层工作流结束了');
            }
        }
        approvals.cancelThread(record.threadId);
        const cost = this.#cost(record);
        const lines = record.definition.steps.map((step) => {
            const current = record.steps[step.id] as StepState;
            return `- ${stepTitle(step)}：${STEP_LABELS[current.status]}${current.note ? `（${shorten(current.note, 120)}）` : ''}`;
        });
        const label = status === 'completed' ? '运行完成' : status === 'failed' ? '运行失败' : '运行已停止';
        this.#notice(
            state,
            status === 'completed' ? 'info' : status === 'failed' ? 'error' : 'warning',
            label,
            [...(note ? [note] : []), ...lines, `花费：${round(cost.total)} ${cost.currency}`].join('\n'),
        );
        threads.append(
            record.threadId,
            'turn.completed',
            {
                turnId: record.turnId,
                stopReason: status === 'cancelled' ? 'cancelled' : 'end_turn',
                durationMs: record.endedAt - record.createdAt,
                usage: {
                    requests: 0,
                    inputTokens: 0,
                    cachedTokens: 0,
                    outputTokens: 0,
                    cost: { amount: round(cost.total), currency: cost.currency },
                },
            },
            { turnId: record.turnId },
        );
        threads.update(record.threadId, { status: status === 'failed' ? 'failed' : 'idle' });
        log.info(`workflow ${record.id}: ${status}${note ? ` (${note})` : ''}`);
        this.#save(state);
        this.#unmute.get(record.id)?.();
        this.#unmute.delete(record.id);
        for (const resolve of this.#ends.get(record.id)?.splice(0) ?? []) {
            resolve(record);
        }
    }

    // Budget ---------------------------------------------------------------------------------------------------

    /** Every run whose spending counts for this one: itself, its team runs and its sub-workflows. */
    #costRuns(record: RunRecord, seen = new Set<string>()): string[] {
        if (seen.has(record.id)) return [];
        seen.add(record.id);
        const ids = [record.id];
        for (const step of Object.values(record.steps)) {
            if (step.teamRunId) ids.push(step.teamRunId);
            if (step.childRunId) {
                const child = this.#load(step.childRunId);
                if (child) ids.push(...this.#costRuns(child.record, seen));
            }
        }
        return ids;
    }

    #cost(record: RunRecord): { total: number; currency: string; byStep: Map<string, number> } {
        const { db, usage, settings } = this.#deps;
        const currency = settings.get().currency;
        const ids = this.#costRuns(record);
        const rows = db.all<{
            workflow_run_id: string;
            task_id: string | null;
            cost_amount: number | null;
            cost_currency: string | null;
        }>(
            `select workflow_run_id, task_id, cost_amount, cost_currency from usage_events where workflow_run_id in (${ids
                .map(() => '?')
                .join(', ')})`,
            ids,
        );
        const owner = new Map<string, string>();
        for (const [id, step] of Object.entries(record.steps)) {
            if (step.teamRunId) owner.set(step.teamRunId, id);
            if (step.childRunId) {
                const child = this.#load(step.childRunId);
                for (const run of child ? this.#costRuns(child.record) : []) owner.set(run, id);
            }
        }
        let total = 0;
        const byStep = new Map<string, number>();
        for (const row of rows) {
            if (row.cost_amount === null) continue;
            const amount = usage.toDisplay({ amount: row.cost_amount, currency: row.cost_currency ?? 'CNY' }).amount;
            total += amount;
            const step = row.workflow_run_id === record.id ? row.task_id : owner.get(row.workflow_run_id);
            if (step) byStep.set(step, (byStep.get(step) ?? 0) + amount);
        }
        return { total, currency, byStep };
    }

    #overBudget(state: RunState): boolean {
        const { budget } = state.record;
        return budget !== undefined && this.#cost(state.record).total >= budget.limit;
    }

    #remaining(state: RunState): number | undefined {
        const { budget } = state.record;
        if (!budget) return undefined;
        return Math.max(0.01, round(budget.limit - this.#cost(state.record).total));
    }

    #pauseForBudget(state: RunState): void {
        const { record } = state;
        const cost = this.#cost(record);
        record.status = 'paused';
        record.note = `预算用完：已花${round(cost.total)}/${record.budget?.limit ?? 0} ${cost.currency}，追加预算后继续`;
        this.#notice(state, 'warning', '暂停', record.note);
        this.#save(state);
    }

    // Steps ----------------------------------------------------------------------------------------------------

    async #execute(state: RunState, step: WorkflowStep): Promise<StepResult> {
        switch (step.type) {
            case 'gate':
                return this.#gate(state, step);
            case 'script':
                return this.#script(state, step);
            case 'agent':
                return this.#agent(state, step);
            case 'supervise':
                return this.#supervise(state, step);
            case 'workflow':
                return this.#subWorkflow(state, step);
        }
    }

    async #gate(state: RunState, step: GateStep): Promise<StepResult> {
        const { record } = state;
        const current = record.steps[step.id] as StepState;
        current.status = 'waiting';
        current.attempts += 1;
        this.#save(state);
        const message = step.message
            ? renderTemplate(step.message, this.#context(record))
            : `确认后继续工作流“${record.definition.title ?? record.definition.name}”`;
        for (;;) {
            if (!this.#live(state)) return this.#interrupted(state);
            const outcome = await this.#approve(state, {
                toolName: 'workflow_gate',
                title: `人工关卡：${stepTitle(step)}`,
                toolKind: 'other',
                summary: message,
                risks: [],
            });
            if (outcome.status === 'allowed') {
                current.status = 'running';
                return { status: 'succeeded', summary: outcome.message ? `已确认：${outcome.message}` : '已确认' };
            }
            if (outcome.status === 'denied') {
                const note = `关卡“${stepTitle(step)}”没有通过${outcome.message ? `：${outcome.message}` : ''}`;
                this.#finish(state, 'cancelled', note);
                return { status: 'cancelled', note };
            }
            // Expired or cancelled while the run goes on: ask again.
        }
    }

    async #script(state: RunState, step: ScriptStep): Promise<StepResult> {
        const { record } = state;
        const current = record.steps[step.id] as StepState;
        const retries = step.onFailure?.retries ?? 0;
        const last = step.onFailure?.finally ?? 'abort';
        const project = await this.#deps.projects.get(record.projectId);
        const mode = project.defaults?.mode ?? this.#deps.settings.get().defaultMode;
        for (let attempt = 0; ; attempt++) {
            if (!this.#live(state)) return this.#interrupted(state);
            current.attempts += 1;
            this.#save(state);
            const command = renderTemplate(step.run, this.#context(record), { command: true });
            const result = await this.#runCommand(state, command, stepTitle(step), mode, step.timeoutMinutes);
            if (!this.#live(state)) return this.#interrupted(state);
            if (!result) {
                return this.#lastResort(state, step, last, '命令被权限规则拒绝或没有被批准');
            }
            const passed = step.expect === 'pass' ? result.exit === 0 : result.exit !== 0 && result.exit !== null;
            if (passed) {
                return { status: 'succeeded', summary: result.output || `退出码${result.exit}` };
            }
            const note = `命令退出码${result.exit ?? '无'}，应为${step.expect === 'pass' ? '0' : '非0'}`;
            if (attempt < retries) continue;
            return this.#lastResort(state, step, last, `${note}\n${result.output}`);
        }
    }

    /** The failure policy's `finally`: stop the run, skip the step, or let the user choose. */
    async #lastResort(
        state: RunState,
        step: WorkflowStep,
        last: FailurePolicy['finally'],
        note: string,
    ): Promise<StepResult> {
        if (last === 'skip') {
            return { status: 'skipped', note: `失败后按设置跳过：${shorten(note, 600)}` };
        }
        if (last === 'ask') {
            const outcome = await this.#approve(state, {
                toolName: 'workflow_step_failed',
                title: `步骤“${stepTitle(step)}”失败：跳过它继续吗？`,
                toolKind: 'other',
                summary: `${shorten(note, 1200)}\n\n允许：跳过这一步，后面不依赖它的步骤照常运行；拒绝：结束运行。`,
                risks: [],
            });
            if (!this.#live(state)) return this.#interrupted(state);
            if (outcome.status === 'allowed') {
                return { status: 'skipped', note: `失败后由用户决定跳过：${shorten(note, 600)}` };
            }
        }
        return { status: 'failed', note: shorten(note, 1200) };
    }

    async #agent(state: RunState, step: AgentStep): Promise<StepResult> {
        const { record } = state;
        const { threads, turns } = this.#deps;
        const current = record.steps[step.id] as StepState;
        const policy: FailurePolicy = { ...DEFAULT_FAILURE_POLICY, ...step.onFailure };
        const project = await this.#deps.projects.get(record.projectId);
        let agent = findAgent(record.org, step.agent);
        if (!agent) {
            return { status: 'failed', note: `组织里没有agent ${step.agent}` };
        }
        let tier: Tier = step.tier ?? agent.tier;
        let threadId: string | undefined;
        let prompt: string;
        // A step that was going when the app stopped continues in its last thread.
        const previous = current.threadIds.at(-1);
        if (previous && current.agent === agent.id && threads.find(previous)) {
            threadId = previous;
            tier = (current.tier as Tier | undefined) ?? tier;
            turns.setHostTools(threadId, this.#stepTools(state, step, agent));
            prompt =
                '上次这一步没有做完（应用重启或运行暂停）。检查当前状态，完成剩下的工作，然后调用step_result交回结果。';
        } else {
            prompt = this.#agentPrompt(state, step);
        }
        let retriesLeft = policy.retries;
        let escalated = false;
        let switched = false;
        for (;;) {
            if (!this.#live(state)) return this.#interrupted(state);
            if (!threadId) {
                let pick: ReturnType<typeof pickTierModel>;
                try {
                    pick = pickTierModel(this.#deps, {
                        org: record.org,
                        project,
                        tier,
                        unattended: record.unattended,
                        warnings: record.warnings,
                    });
                } catch (error) {
                    return { status: 'failed', note: errorText(error) };
                }
                const thread = threads.create({
                    projectId: record.projectId,
                    title: `${shorten(stepTitle(step), 16)}·${agent.name}`,
                    engine: 'xora',
                    model: pick.ref,
                    mode: agent.mode,
                    effort: pick.effort,
                    extra: {
                        workflowRunId: record.id,
                        taskId: step.id,
                        agentId: agent.id,
                        role: agent.role,
                        tier,
                        group: record.id,
                    },
                });
                threadId = thread.id;
                current.threadIds.push(threadId);
                current.agent = agent.id;
                current.tier = tier;
                turns.setHostTools(threadId, this.#stepTools(state, step, agent));
            }
            current.attempts += 1;
            this.#save(state);
            state.results.delete(step.id);
            const ended = await this.#turn(threadId, prompt);
            if (!this.#live(state)) return this.#interrupted(state);
            let failure: string | undefined;
            let summary = '';
            let outputs: Record<string, string> = {};
            if (ended.outcome !== 'completed') {
                failure = ended.outcome === 'cancelled' ? '这一轮被取消了' : '这一轮出错了（模型或引擎错误）';
            } else {
                let result = state.results.get(step.id);
                let missing = step.outputs.filter((name) => !result?.outputs[name]);
                if (!result || missing.length > 0) {
                    const ask = result
                        ? `还缺这些outputs：${missing.join('、')}。调用step_result补交，不要重做工作。`
                        : '你还没有调用step_result。调用它交回summary和outputs，不要重做工作。';
                    const repaired = await this.#turn(threadId, ask);
                    if (!this.#live(state)) return this.#interrupted(state);
                    if (repaired.outcome === 'completed') {
                        result = state.results.get(step.id) ?? result;
                        missing = step.outputs.filter((name) => !result?.outputs[name]);
                    }
                }
                summary = result?.summary ?? shorten(ended.lastText, SUMMARY_LIMIT);
                outputs = result?.outputs ?? {};
                if (missing.length > 0) {
                    failure = `没有交出outputs：${missing.join('、')}`;
                } else if (step.verify) {
                    current.outputs = outputs;
                    const check = await this.#verify(state, step.verify, agent.mode);
                    if (!this.#live(state)) return this.#interrupted(state);
                    if (!check.ok) failure = check.note;
                }
            }
            if (failure === undefined) {
                return { status: 'succeeded', summary, outputs };
            }
            this.#notice(state, 'warning', `没有通过：${stepTitle(step)}`, shorten(failure, 600));
            if (retriesLeft > 0) {
                retriesLeft -= 1;
                prompt = `上一次没有通过：${failure}\n\n继续完成这一步，完成后再调用step_result。`;
                continue;
            }
            const higher = nextTier(tier);
            if (policy.escalate && !escalated && higher) {
                escalated = true;
                const from = `${agent.name}（${TIER_LABELS[tier]}档）`;
                tier = higher;
                threadId = undefined;
                this.#notice(state, 'info', `升档：${stepTitle(step)}`, `改用${TIER_LABELS[tier]}档重做`);
                prompt = this.#agentPrompt(
                    state,
                    step,
                    `之前由${from}做过，没有通过：${failure}${summary ? `\n它的总结：${summary}` : ''}`,
                );
                continue;
            }
            const fallback = policy.agent ? findAgent(record.org, policy.agent) : undefined;
            if (fallback && !switched) {
                switched = true;
                const from = `${agent.name}（${TIER_LABELS[tier]}档）`;
                agent = fallback;
                tier = step.tier ?? fallback.tier;
                threadId = undefined;
                this.#notice(state, 'info', `换人：${stepTitle(step)}`, `交给${fallback.name}`);
                prompt = this.#agentPrompt(
                    state,
                    step,
                    `之前由${from}做过，没有通过：${failure}${summary ? `\n它的总结：${summary}` : ''}`,
                );
                continue;
            }
            return this.#lastResort(state, step, policy.finally, failure);
        }
    }

    #agentPrompt(state: RunState, step: AgentStep, before?: string): string {
        const { record } = state;
        const task = renderTemplate(step.task, this.#context(record));
        const outputs = step.outputs.map((name) => `\`${name}\``).join('、');
        const lines = [
            `你在执行工作流“${record.definition.title ?? record.definition.name}”的步骤“${stepTitle(step)}”。`,
            '',
            '任务：',
            task,
            '',
            outputs
                ? `完成后调用step_result工具交回结果：summary写清做了什么、证据在哪；outputs里给出${outputs}。`
                : '完成后调用step_result工具，summary写清做了什么、证据在哪。',
        ];
        if (step.verify) {
            lines.push(
                `之后我会运行验收命令\`${step.verify.command}\`（引用的outputs用你交回的值代入），${
                    step.verify.expect === 'fail' ? '它应该失败（退出码非0）' : '退出码为0才算通过'
                }。`,
            );
        }
        lines.push('只做这一步的事；做不到时说明原因，照样调用step_result。');
        if (before) lines.push('', before);
        return lines.join('\n');
    }

    #stepTools(state: RunState, step: AgentStep, agent: AgentSpec): HostToolProvider {
        const declared = new Set(step.outputs);
        return {
            tools: [STEP_RESULT_TOOL],
            disabledTools: disabledBuiltins(agent),
            layers: systemLayers(state.record.org, agent),
            handle: async (name, input) => {
                if (name !== 'step_result') {
                    return fail(`Unknown tool ${name}`);
                }
                const value = input as { summary?: unknown; outputs?: unknown } | null;
                if (typeof value?.summary !== 'string' || !value.summary.trim()) {
                    return fail('`summary` is required.');
                }
                const outputs: Record<string, string> = {};
                const ignored: string[] = [];
                if (value.outputs && typeof value.outputs === 'object' && !Array.isArray(value.outputs)) {
                    for (const [key, raw] of Object.entries(value.outputs as Record<string, unknown>)) {
                        if (!declared.has(key)) {
                            ignored.push(key);
                        } else if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
                            outputs[key] = String(raw);
                        }
                    }
                }
                state.results.set(step.id, { summary: value.summary.trim(), outputs });
                const missing = step.outputs.filter((key) => !outputs[key]);
                return ok(
                    [
                        'Recorded.',
                        missing.length > 0 ? `Still missing outputs: ${missing.join(', ')}.` : '',
                        ignored.length > 0 ? `Ignored undeclared outputs: ${ignored.join(', ')}.` : '',
                    ]
                        .filter(Boolean)
                        .join(' '),
                );
            },
        };
    }

    async #verify(state: RunState, verify: StepVerify, mode: PermissionMode): Promise<{ ok: boolean; note: string }> {
        const command = renderTemplate(verify.command, this.#context(state.record), { command: true });
        const result = await this.#runCommand(state, command, '验收', mode, verify.timeoutMinutes);
        if (!result) {
            return { ok: false, note: `验收命令被权限规则拒绝或没有被批准：${command}` };
        }
        const passed = verify.expect === 'pass' ? result.exit === 0 : result.exit !== 0 && result.exit !== null;
        if (passed) {
            return { ok: true, note: '' };
        }
        return {
            ok: false,
            note: `验收命令\`${command}\`退出码${result.exit ?? '无'}，应为${verify.expect === 'pass' ? '0' : '非0'}。输出：\n${result.output || '（无输出）'}`,
        };
    }

    async #supervise(state: RunState, step: SuperviseStep): Promise<StepResult> {
        const { record } = state;
        const { team } = this.#deps;
        const current = record.steps[step.id] as StepState;
        const retries = step.onFailure?.retries ?? 0;
        const last = step.onFailure?.finally ?? 'abort';
        const project = await this.#deps.projects.get(record.projectId);
        const mode = project.defaults?.mode ?? this.#deps.settings.get().defaultMode;
        let feedback: string | undefined;
        for (let attempt = 0; ; attempt++) {
            if (!this.#live(state)) return this.#interrupted(state);
            let runId = current.teamRunId;
            // A team run left paused by a restart continues instead of starting over.
            const existing = runId ? await team.get(runId).catch(() => undefined) : undefined;
            if (existing && !TEAM_TERMINAL.has(existing.status) && feedback === undefined) {
                if (existing.status === 'paused') {
                    await team.resume(existing.id).catch(() => undefined);
                }
            } else {
                const remaining = this.#remaining(state);
                const goal = renderTemplate(step.goal, this.#context(record));
                try {
                    const started = await team.start({
                        projectId: record.projectId,
                        goal: feedback ? `${goal}\n\n上一次没有通过：${feedback}` : goal,
                        autonomy: step.autonomy ?? record.autonomy,
                        ...(step.budget !== undefined || remaining !== undefined
                            ? {
                                  budget: Math.min(
                                      step.budget ?? Number.POSITIVE_INFINITY,
                                      remaining ?? Number.POSITIVE_INFINITY,
                                  ),
                              }
                            : {}),
                    });
                    runId = started.id;
                } catch (error) {
                    return this.#lastResort(state, step, last, `团队没能启动：${errorText(error)}`);
                }
                current.teamRunId = runId;
                current.attempts += 1;
                const started = await team.get(runId);
                if (started.supervisorThreadId) current.threadIds.push(started.supervisorThreadId);
                this.#save(state);
            }
            const final = await this.#waitTeam(state, runId as string);
            if (!this.#live(state)) {
                if (state.record.status !== 'paused') await team.stop(runId as string).catch(() => undefined);
                return this.#interrupted(state);
            }
            let failure: string | undefined;
            const summary = final?.report ? shorten(final.report, SUMMARY_LIMIT) : '';
            if (final?.status !== 'done') {
                failure = `团队运行没有完成（${final?.status ?? '未知'}）${final?.note ? `：${final.note}` : ''}`;
            } else if (step.verify) {
                const check = await this.#verify(state, step.verify, mode);
                if (!this.#live(state)) return this.#interrupted(state);
                if (!check.ok) failure = check.note;
            }
            if (failure === undefined) {
                return { status: 'succeeded', summary: summary || '团队运行完成' };
            }
            if (attempt < retries) {
                feedback = failure;
                continue;
            }
            return this.#lastResort(state, step, last, failure);
        }
    }

    /** Polls a team run until it is over; `undefined` when this run stopped being live first. */
    async #waitTeam(state: RunState, runId: string): Promise<TeamRun | undefined> {
        for (;;) {
            const run = await this.#deps.team.get(runId).catch(() => undefined);
            if (!run) return undefined;
            if (TEAM_TERMINAL.has(run.status) || !this.#live(state)) return run;
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, TEAM_POLL_MS);
                state.abort.signal.addEventListener(
                    'abort',
                    () => {
                        clearTimeout(timer);
                        resolve();
                    },
                    { once: true },
                );
            });
        }
    }

    async #subWorkflow(state: RunState, step: SubWorkflowStep): Promise<StepResult> {
        const { record } = state;
        const current = record.steps[step.id] as StepState;
        if (record.depth + 1 >= MAX_DEPTH) {
            return { status: 'failed', note: `子工作流最多嵌套${MAX_DEPTH}层` };
        }
        let child = current.childRunId ? this.#load(current.childRunId) : undefined;
        if (child?.record.status === 'paused') {
            await this.resume(child.record.id).catch(() => undefined);
        } else if (!child || TERMINAL.has(child.record.status)) {
            const project = await this.#deps.projects.get(record.projectId);
            const entries = await this.#definitions(project);
            const source = record.key.split(':')[0];
            const entry =
                entries.find((item) => item.key === `${source}:${step.workflow}`) ??
                entries.find((item) => item.name === step.workflow);
            if (!entry?.parsed.ok || entry.problems.length > 0) {
                return { status: 'failed', note: `子工作流${step.workflow}不存在或有问题` };
            }
            const given: Record<string, WorkflowScalar> = {};
            for (const [name, value] of Object.entries(step.inputs)) {
                given[name] = typeof value === 'string' ? renderTemplate(value, this.#context(record)) : value;
            }
            const remaining = this.#remaining(state);
            let view: WorkflowRunView;
            try {
                view = await this.#begin({
                    project,
                    entry,
                    given,
                    trigger: { reason: 'parent' },
                    unattended: record.unattended,
                    offPeak: false,
                    depth: record.depth + 1,
                    parentRunId: record.id,
                    ...(remaining !== undefined ? { budget: remaining } : {}),
                });
            } catch (error) {
                return { status: 'failed', note: `子工作流没能启动：${errorText(error)}` };
            }
            current.childRunId = view.id;
            current.threadIds.push(view.threadId);
            current.attempts += 1;
            this.#save(state);
            child = this.#load(view.id);
        }
        if (!child) {
            return { status: 'failed', note: '子工作流不见了' };
        }
        const ended = TERMINAL.has(child.record.status)
            ? child.record
            : await new Promise<RunRecord | undefined>((resolve) => {
                  const list = this.#ends.get(child.record.id) ?? [];
                  list.push(resolve);
                  this.#ends.set(child.record.id, list);
                  state.abort.signal.addEventListener('abort', () => resolve(undefined), { once: true });
              });
        if (!this.#live(state)) {
            if (state.record.status !== 'paused' && child && !TERMINAL.has(child.record.status)) {
                this.#finish(child, 'cancelled', '上层工作流结束了');
            }
            return this.#interrupted(state);
        }
        if (ended?.status !== 'completed') {
            return {
                status: 'failed',
                note: `子工作流${step.workflow}没有完成${ended?.note ? `：${ended.note}` : ''}`,
            };
        }
        return { status: 'succeeded', summary: `子工作流${step.workflow}完成` };
    }

    // Host turns, commands and approvals -------------------------------------------------------------------

    /** Starts a host turn on a thread (after the current one, if any) and resolves when it ends. */
    async #turn(threadId: string, text: string): Promise<TurnEnded> {
        const { turns } = this.#deps;
        while (turns.isRunning(threadId) && !this.#disposed) {
            await new Promise<void>((resolve) => {
                const list = this.#idle.get(threadId) ?? [];
                list.push(resolve);
                this.#idle.set(threadId, list);
            });
        }
        const turnId = await turns.start(threadId, text);
        const early = this.#early.get(turnId);
        if (early) {
            this.#early.delete(turnId);
            return early;
        }
        return new Promise((resolve) => this.#waiters.set(turnId, resolve));
    }

    async #runCommand(
        state: RunState,
        command: string,
        label: string,
        mode: PermissionMode,
        timeoutMinutes: number,
    ): Promise<{ exit: number | null; output: string } | undefined> {
        const { record } = state;
        const { approvals, projects, log } = this.#deps;
        const project = await projects.get(record.projectId);
        const facts: CallFacts = {
            toolName: 'workflow_command',
            kind: 'execute',
            readOnly: false,
            command,
            readOnlyCommand: isReadOnlyCommand(command),
            paths: [],
            outside: [],
            sensitive: [],
            external: false,
        };
        const policy = approvals.evaluate(record.threadId, facts, {
            mode,
            projectId: record.projectId,
            projectRoot: project.path,
        });
        if (policy.decision === 'deny') {
            log.info(`workflow ${record.id}: command denied (${policy.reason}): ${command}`);
            return undefined;
        }
        if (policy.decision === 'ask') {
            const outcome = await this.#approve(state, {
                toolName: 'workflow_command',
                title: `${label}：运行命令`,
                toolKind: 'execute',
                summary: command,
                command,
                risks: policy.risks,
            });
            if (outcome.status !== 'allowed') return undefined;
        }
        if (!this.#live(state)) return undefined;
        const result = await runCheck(
            command,
            project.path,
            AbortSignal.any([state.abort.signal, AbortSignal.timeout(timeoutMinutes * 60_000)]),
            timeoutMinutes * 60_000,
        );
        return { exit: result.exitCode, output: tail(result.output) };
    }

    /** An approval card on the run's own thread; gates, failed steps and commands the policy asks about. */
    async #approve(state: RunState, request: ApproveRequest): Promise<ApprovalOutcome> {
        const { approvals, threads } = this.#deps;
        const { record } = state;
        const threadId = record.threadId;
        const turnId = record.turnId;
        const facts: CallFacts = {
            toolName: request.toolName,
            kind: request.toolKind,
            readOnly: request.toolKind !== 'execute',
            ...(request.command
                ? { command: request.command, readOnlyCommand: isReadOnlyCommand(request.command) }
                : {}),
            paths: [],
            outside: [],
            sensitive: [],
            external: false,
        };
        let item: ItemOf<'approval'> | undefined;
        const outcome = await approvals.request(
            {
                threadId,
                turnId,
                projectId: record.projectId,
                toolName: request.toolName,
                title: request.title,
                toolKind: request.toolKind,
                summary: request.summary,
                ...(request.command ? { command: request.command } : {}),
                paths: [],
                risks: [...request.risks],
                engine: 'xora',
            },
            facts,
            (approval) => {
                item = {
                    id: newId('i'),
                    turnId,
                    ts: Date.now(),
                    type: 'approval',
                    approvalId: approval.id,
                    title: approval.title,
                    toolKind: approval.toolKind,
                    summary: approval.summary,
                    risks: approval.risks,
                    status: 'pending',
                };
                threads.append(threadId, 'item.started', { item }, { turnId, itemId: item.id });
                threads.update(threadId, { status: 'awaiting_approval' });
                if (record.status === 'running') {
                    record.status = 'waiting';
                    this.#save(state);
                }
            },
        );
        if (item && !this.#disposed) {
            threads.append(
                threadId,
                'item.completed',
                {
                    item: {
                        ...item,
                        status: outcome.status,
                        ...(outcome.decision ? { decision: outcome.decision } : {}),
                        decidedBy: 'user',
                        ...(outcome.message ? { message: outcome.message } : {}),
                    },
                },
                { turnId, itemId: item.id },
            );
            if (approvals.pendingFor(threadId) === 0 && threads.get(threadId).status === 'awaiting_approval') {
                threads.update(threadId, { status: 'idle' });
            }
            if (record.status === 'waiting' && approvals.pendingFor(threadId) === 0) {
                record.status = 'running';
                this.#save(state);
            }
        }
        return outcome;
    }

    #notice(state: RunState, severity: 'info' | 'warning' | 'error', title: string, description?: string): void {
        if (this.#disposed) return;
        const { record } = state;
        const item: ItemOf<'notice'> = {
            id: newId('i'),
            turnId: record.turnId,
            ts: Date.now(),
            type: 'notice',
            severity,
            title,
            ...(description ? { description } : {}),
        };
        this.#deps.threads.append(
            record.threadId,
            'item.completed',
            { item },
            { turnId: record.turnId, itemId: item.id },
        );
    }

    // Views ----------------------------------------------------------------------------------------------------

    #view(state: RunState): WorkflowRunView {
        const { record } = state;
        const cost = this.#cost(record);
        const steps: WorkflowStepRun[] = record.definition.steps.map((step) => {
            const current = record.steps[step.id] ?? newStepState();
            const spent = cost.byStep.get(step.id);
            return {
                id: step.id,
                type: step.type,
                title: stepTitle(step),
                needs: step.needs,
                status: current.status,
                attempts: current.attempts,
                ...(current.agent ? { agent: current.agent } : {}),
                ...(current.tier ? { tier: current.tier } : {}),
                outputs: current.outputs,
                ...(current.summary !== undefined ? { summary: current.summary } : {}),
                ...(current.note !== undefined ? { note: current.note } : {}),
                threadIds: current.threadIds,
                ...(current.teamRunId ? { teamRunId: current.teamRunId } : {}),
                ...(current.childRunId ? { childRunId: current.childRunId } : {}),
                cost: spent === undefined ? null : { amount: round(spent), currency: cost.currency },
                ...(current.startedAt !== undefined ? { startedAt: current.startedAt } : {}),
                ...(current.endedAt !== undefined ? { endedAt: current.endedAt } : {}),
            };
        });
        return {
            id: record.id,
            projectId: record.projectId,
            key: record.key,
            name: record.definition.name,
            title: record.definition.title ?? record.definition.name,
            status: record.status,
            reason: record.trigger.reason,
            unattended: record.unattended,
            inputs: record.inputs,
            ...(record.note ? { note: record.note } : {}),
            warnings: record.warnings,
            ...(record.startsAt !== undefined ? { startsAt: record.startsAt } : {}),
            threadId: record.threadId,
            ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
            steps,
            budget: record.budget ? { amount: record.budget.limit, currency: record.budget.currency } : null,
            cost: { amount: round(cost.total), currency: cost.currency },
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
        };
    }
}

const STEP_LABELS: Readonly<Record<StepState['status'], string>> = {
    pending: '没有开始',
    running: '进行中',
    waiting: '等待确认',
    succeeded: '完成',
    failed: '失败',
    skipped: '跳过',
    cancelled: '取消',
};

type UiPeer = RpcPeer<HostMethods, HostNotifications>;

/** The `workflow.*` handlers, registered on every UI connection. */
export function registerWorkflowHandlers(peer: UiPeer, workflows: WorkflowService): void {
    peer.handle('workflow.list', ({ projectId }) => workflows.list(projectId));
    peer.handle('workflow.start', (params) => workflows.start(params));
    peer.handle('workflow.runs', ({ projectId }) => workflows.runs(projectId));
    peer.handle('workflow.get', ({ runId }) => workflows.get(runId));
    peer.handle('workflow.stop', ({ runId }) => workflows.stop(runId));
    peer.handle('workflow.resume', ({ runId, budget }) => workflows.resume(runId, budget));
    peer.handle('workflow.triggers', ({ projectId, key, enabled }) => workflows.setTriggers(projectId, key, enabled));
    peer.handle('workflow.webhook', ({ projectId, key }) => workflows.webhook(projectId, key));
}
