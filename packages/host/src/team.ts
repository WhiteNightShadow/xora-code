import { existsSync } from 'node:fs';
import {
    bilingual,
    type HostMethods,
    type HostNotifications,
    type ItemOf,
    type MethodParams,
    type ModelRef,
    type PermissionMode,
    type Project,
    type Risk,
    RpcError,
    RpcErrorCode,
    type RpcPeer,
    type TeamRun as TeamRunView,
    type TeamTask as TeamTaskView,
    type ToolKind,
} from '@xora/protocol';
import type { XoraDatabase } from '@xora/storage';
import { type HighRisk, type HighRiskAction, isReadOnlyCommand } from '@xora/tools';
import {
    type AgentSpec,
    type AutonomyLevel,
    agentsWithRole,
    type BoardError,
    type BoardTask,
    type BudgetPressure,
    budgetPressure,
    buildAgentLayers,
    type CommandResult,
    checkCard,
    createTeamRun,
    DEFAULT_STALL_WINDOW,
    type Deliverable,
    DeliverableSchema,
    deliveryReport,
    detectLoop,
    type EscalationDecision,
    findAgent,
    formatIssues,
    inferFamily,
    type Judgement,
    judge,
    loadTeamState,
    money,
    needsHuman,
    nextTier,
    type Organization,
    ProgressLedger,
    parseDeliverable,
    parseReview,
    planAcceptance,
    type ReviewOutcome,
    type Role,
    renderDeliverableRepair,
    renderTaskCard,
    resolveTier,
    retryFeedback,
    type StructuredParseError,
    shouldEscalate,
    TaskBoard,
    type TaskCard,
    TaskLedger,
    type TaskLedgerContent,
    type TeamRun,
    type TeamRunPhase,
    type TeamRunStatus,
    type TeamUsage,
    type Tier,
    taskGraph,
    tierLabel,
    tierRank,
    tierUnderPressure,
    toolsOf,
    uiStyle,
    validateAutonomy,
} from '@xora/workflows';
import { headCommit, releasePort } from '@xora/workspace';
import { type ModelPick, pickTierModel, runChannels } from './agent-models.ts';
import type { ApprovalOutcome, ApprovalService } from './approvals.ts';
import type { Bus } from './bus.ts';
import type { ConnectionService } from './connections.ts';
import type { HostToolResult } from './engines/manager.ts';
import { runCheck } from './goals.ts';
import { newId } from './ids.ts';
import type { Logger } from './log.ts';
import { type CallFacts, highRiskLabel, highRiskOf } from './policy.ts';
import type { ProjectService } from './projects.ts';
import type { SettingsService } from './settings.ts';
import {
    AskInput,
    agentFor,
    ChallengeInput,
    cardProblem,
    describeChecks,
    disabledBuiltins,
    EscalateInput,
    executorNote,
    LedgerUpdateInput,
    loadTeamOrganization,
    MEMBER_TOOLS,
    mcpToolsOf,
    planReviewFeedback,
    planReviewPrompt,
    RESUME_PROMPT,
    RequestReviewInput,
    reviewPrompt,
    SendMessageInput,
    SUPERVISOR_TOOLS,
    shorten,
    supervisorBrief,
    systemLayers,
    TaskAssignInput,
    TaskListInput,
    TaskUpdateInput,
    type TeamMode,
    wakeText,
} from './team-agents.ts';
import { SqliteTeamStore } from './team-store.ts';
import { hostLanguage, textOf } from './text.ts';
import type { ThreadStore } from './threads.ts';
import type { HostToolProvider, TurnEnded, TurnService } from './turns.ts';
import type { UsageService } from './usage.ts';
import type { WorktreeService } from './worktrees.ts';

/**
 * Agent teams on the host (06 §5–§9): a supervisor thread plans with team tools, the host dispatches its cards to
 * executor threads (writable ones in their own worktree), runs the acceptance commands and reviews, sends work
 * back, escalates tiers, integrates the worktrees in dependency order and writes the delivery report. The board
 * and both ledgers live in `@xora/workflows`; this service drives them and persists every change.
 */

/**
 * Model requests an executor may make for one card when its `budget.maxTurns` is not set (06 §6): per dispatch,
 * retries on the same thread included. Generous for one card; it stops an agent that goes round in circles.
 */
export const DEFAULT_MAX_TURNS = 80;
/** Bounds of the team concurrency setting (06 §1: a few members at a time is plenty). */
const MIN_PARALLEL = 1;
const MAX_PARALLEL = 8;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL = 4_000;
const BROADCAST_MS = 200;
const WAKE_DELAY_MS = 300;
const QUESTION_TIMEOUT_MS = 30 * 60 * 1000;
/** Conversation entries kept with a run (06 §7). */
const CONVERSATION_LIMIT = 400;
/** Challenges one investigation card may send in a competing-hypotheses run. */
const MAX_CHALLENGES = 3;
const RECENT_ACTIONS = 12;
const RECENT_ENDS = 64;

/** Model errors after which the next model of the tier's chain takes over (06 §3 rule 2). */
const FALLBACK_ERRORS = new Set(['rate_limit', 'overloaded', 'server', 'network', 'timeout', 'quota']);

/** Supervisor messages a run keeps as its feedback to the user. */
const FEEDBACK_KEPT = 30;

/** Planning turns that may end without a task card before a run with no person in the loop pauses. */
const MAX_PLAN_NUDGES = 2;

/** What the supervisor is told after a planning turn without a task card, when no person approves plans. */
const PLAN_NUDGE =
    'You ended your turn without creating any task card, and nobody approves plans in this conversation: at this ' +
    "run's autonomy level no person is involved before the report. Create the task cards now with task_create; they " +
    'are dispatched from there. If the goal cannot be done at all, say why in your final message.';

type RunStatus = TeamRunView['status'];
const TERMINAL: ReadonlySet<RunStatus> = new Set(['done', 'failed', 'cancelled']);
const WORKFLOW_STATE: Readonly<Record<RunStatus, { status: TeamRunStatus; phase?: TeamRunPhase }>> = {
    planning: { status: 'running', phase: 'plan' },
    awaiting_plan_approval: { status: 'waiting_user', phase: 'plan_approval' },
    running: { status: 'running', phase: 'execute' },
    integrating: { status: 'running', phase: 'integrate' },
    done: { status: 'completed', phase: 'done' },
    failed: { status: 'failed' },
    paused: { status: 'paused' },
    cancelled: { status: 'cancelled' },
};

/** The host's bookkeeping for one task, persisted with the run. */
interface TaskHost {
    /** The executor thread working the task now. */
    threadId?: string;
    /** Every executor, reviewer and repair thread the task used. */
    threads: string[];
    /** Board owner, e.g. `coder-T1`. */
    agentId?: string;
    /** Roster agent the executor was started from. */
    specId?: string;
    tier?: Tier;
    model?: ModelRef;
    family?: string;
    /** The rest of the tier's chain, for model errors. */
    fallbacks?: Array<{ ref: ModelRef; family?: string }>;
    location?: 'worktree' | 'local';
    worktree?: string;
    /** Thread id the worktree was created for (its directory name). */
    worktreeId?: string;
    /** Lines handed to the next executor after an escalation (06 §7). */
    handoff?: string[];
    /** The supervisor released a task it had taken over (task_assign). */
    released?: boolean;
    /** Model requests of the executor since the task was dispatched, retries included (`budget.maxTurns`). */
    turns?: number;
    /** Prompt for the executor's next turn, kept while the run is paused. */
    pending?: string;
    /** Messages (supervisor, user, challenges) queued for the executor's next turn. */
    messages?: string[];
    /** Challenges this card sent (competing hypotheses). */
    challenges?: number;
    /** Deliverable handed in through the deliver or escalate tool during the current turn. */
    delivered?: Deliverable;
    verdict?: { verdict: string; reasons: string[]; outOfOwnership: string[] };
    /** Files changed by a task that works in the project folder. */
    changed?: string[];
    integrated?: boolean;
}

/** The host's bookkeeping for one run, persisted as `host_json`. */
interface RunHost {
    projectId: string;
    status: RunStatus;
    /** Status to return to when a paused run continues. */
    resumeTo?: RunStatus;
    note?: string;
    /** Set while the run waits on nothing it can do itself. */
    stuck?: boolean;
    /** Planning turns that ended without a task card (see MAX_PLAN_NUDGES). */
    planNudges?: number;
    /** A planning turn ended without a task card while a person is in the loop: the note says so until there is one. */
    awaitingUser?: boolean;
    supervisorThreadId: string;
    /** Latest supervisor turn: host cards and notices are attached to it. */
    supervisorTurnId?: string;
    /** The rest of the flagship chain, for model errors of the supervisor. */
    supervisorFallbacks?: Array<{ ref: ModelRef; family?: string }>;
    /** Model family the supervisor runs on; the plan reviewer uses another one. */
    supervisorFamily?: string;
    /** The separate plan review (06 §5 ④) ran, or was skipped with a warning. */
    planReviewed?: boolean;
    planApproved: boolean;
    deliveryApproved: boolean;
    /** Commit every worktree of the run starts from. */
    base?: string;
    org: Organization;
    orgSources: string[];
    warnings: string[];
    /** Updates waiting for the supervisor's next turn. */
    inbox: string[];
    /** `standard`, or `hypotheses` for competing hypotheses (06 §7). */
    mode?: TeamMode;
    /** The supervisor's last message of each turn, newest last: its feedback to the user (at most FEEDBACK_KEPT). */
    feedback?: Array<{ ts: number; text: string }>;
    /** The earlier run of the project this one continues. */
    continues?: string;
    /** Every message of the run, for the team conversation view (06 §7). */
    conversation?: ConversationEntry[];
    tasks: Record<string, TaskHost>;
    reviewThreads: string[];
    /** Recent actions for loop detection. */
    actions: string[];
    report?: string;
    finalChecks?: Array<{ run: string; exit: number | null; ran: boolean }>;
}

interface ConversationEntry {
    readonly ts: number;
    /** `user`, `supervisor` or a task id. */
    readonly from: string;
    readonly to: string;
    readonly text: string;
    readonly kind: 'message' | 'question' | 'answer' | 'user' | 'challenge';
}

interface Question {
    delivered: boolean;
    readonly answer: (text: string) => void;
}

interface RunState {
    run: TeamRun;
    readonly board: TaskBoard;
    ledger: TaskLedger | undefined;
    readonly progress: ProgressLedger;
    readonly host: RunHost;
    /** Tasks whose host loop is running. */
    readonly working: Set<string>;
    readonly questions: Map<string, Question>;
    abort: AbortController;
    supervisorStarting: boolean;
    reviewingPlan: boolean;
    approvingPlan: boolean;
    integrating: boolean;
    wakeTimer: ReturnType<typeof setTimeout> | undefined;
    broadcastTimer: ReturnType<typeof setTimeout> | undefined;
}

interface Costs {
    readonly currency: string;
    readonly total: number;
    readonly supervisor: number;
    readonly byTier: Map<string, number>;
    readonly byTask: Map<string, number>;
    readonly usage: TeamUsage[];
}

interface ConfirmRequest {
    readonly toolName: string;
    readonly title: string;
    readonly toolKind: ToolKind;
    readonly summary: string;
    readonly risks: readonly Risk[];
    readonly command?: string;
    /** The command is a high-risk action (06 §8): approved once, never "always". */
    readonly highRisk?: HighRisk;
}

export interface TeamDeps {
    readonly db: XoraDatabase;
    readonly bus: Bus;
    readonly log: Logger;
    readonly threads: ThreadStore;
    readonly projects: ProjectService;
    readonly connections: ConnectionService;
    readonly settings: SettingsService;
    readonly approvals: ApprovalService;
    readonly usage: UsageService;
    readonly worktrees: WorktreeService;
    readonly turns: TurnService;
    /** `<data>/orgs`: user-level organizations, one directory each (06 §2). */
    readonly orgsDir: string;
    readonly commandTimeoutMs?: number;
}

// ---------------------------------------------------------------------------------------------------------
// What the user sees: errors, notes, warnings, notices, approval cards, board notes, thread titles, the report

const TEXT = bilingual(
    {
        projectMissing: (folder: string) => `项目文件夹不存在：${folder}`,
        emptyGoal: '目标不能为空',
        autonomyProblems: (problems: readonly string[]) => problems.join('；'),
        noSupervisor: '组织里没有主管',
        uncommitted: '项目里有没提交的改动：各任务的worktree从最近一次提交开始，看不到这些改动',
        supervisorTitle: (goal: string) => `团队：${goal}`,
        supervisorNotStarted: (error: string) => `主管线程没能启动：${error}`,
        stoppedByYou: '你停止了这次运行',
        runStopped: '运行已停止',
        onlyPaused: '只有已暂停的运行可以继续',
        budgetSpent: '预算已用完：追加预算后再继续',
        restarted: '应用重启了，运行已暂停；点继续接着做，已完成的任务不会重跑',
        pausedTitle: '团队运行已暂停',
        budgetNote: (spent: number, currency: string, limit: number, limitCurrency: string) =>
            `预算已用完（已花${spent}${currency}，预算${limit}${limitCurrency}）；追加预算后点继续，或者缩小范围`,
        supervisorTurnFailed: (errorClass: string) =>
            `主管这一轮出错了（${errorClass}），详情在主管线程里；处理后点继续`,
        supervisorModelSwitched: (errorClass: string, model: string) =>
            `主管的模型出错（${errorClass}），换成了${model}`,
        planAutoApproved: '计划按自主级别自动确认',
        planApproval: '确认团队计划',
        planApproved: '你确认了计划',
        planApprovalLapsed: '计划确认过期或被取消了；点继续重新确认',
        noPlanReviewer: '组织里没有计划评审，跳过了独立的计划评审',
        planReviewNoModel: (error: string) => `计划评审没有可用的模型，跳过了：${error}`,
        planReviewNoFamily: (family: string | undefined, tier: Tier) =>
            `没有连接${family ?? '主管'}以外家族的${tierLabel(tier, 'zh-CN')}档模型，跳过了独立的计划评审`,
        planReviewTitle: '评审计划',
        planReviewing: '计划评审中',
        planReviewUnfinished: (outcome: string) => `计划评审没有做完（${outcome}），计划直接去确认`,
        planGoal: (goal: string) => `目标：${goal}`,
        planTask: (card: TaskCard, tier: Tier, checks: string) =>
            `- ${card.id} ${card.title}（${card.category}，${tierLabel(tier, 'zh-CN')}档，${card.workspace}${card.dependsOn.length > 0 ? `，依赖${card.dependsOn.join('、')}` : ''}）验收：${checks}`,
        planBudget: (limit: number, currency: string) => `预算：${limit}${currency}`,
        runEnded: '运行已经结束，消息不会送达',
        noTask: (id: string) => `没有任务${id}`,
        taskEnded: (id: string) => `任务${id}已经结束，可以发给主管`,
        blocker: (id: string, held: boolean, status: string) => `${id}${held ? '（主管接手）' : ''}：${status}`,
        stuck: (blockers: readonly string[]) =>
            `没有能继续的任务（${blockers.join('，')}）；在主管线程里说明怎么处理，或者停止这次运行`,
        stuckTitle: '团队卡住了',
        noPreviousRun: (id: string) => `这个项目里没有运行${id}`,
        previousRunActive: '上一次运行还没结束：等它结束，或者先停止它',
        awaitingUser: '主管这一轮没有拆出任务，可能在主管线程里等你回复：回复它，或者停止这次运行',
        noPlan: '主管几次结束都没有拆出任务；在主管线程里说明怎么做后点继续，或者停止这次运行',
        tierLowered: (taskId: string, tier: Tier, percent: number) =>
            `${taskId}降到${tierLabel(tier, 'zh-CN')}档执行（预算已用到${percent}%）`,
        notGitRepo: (taskId: string) => `项目不是git仓库，${taskId}改在项目目录里执行`,
        notSeeded: (from: string, taskId: string, reason: string) =>
            `${from}的结果没能带进${taskId}的worktree：${reason}`,
        dispatchTitle: (taskId: string, title: string) => `派工：${taskId} ${title}`,
        dispatchSummary: (agent: string, tier: Tier, workspace: string, goal: string) =>
            `交给${agent}（${tierLabel(tier, 'zh-CN')}档，${workspace}）\n目标：${goal}`,
        dispatchDeclined: (message: string | undefined) => `你没有同意派工${message ? `：${message}` : ''}`,
        hostError: (error: string) => `宿主出错：${error}`,
        executorCancelled: '执行者这一轮被取消了',
        executorFailed: (errorClass: string) => `执行者这一轮出错了（${errorClass}）`,
        taskModelSwitched: (taskId: string, errorClass: string, model: string) =>
            `${taskId}的模型出错（${errorClass}），换成了${model}`,
        repairTitle: (taskId: string) => `整理${taskId}的交付单`,
        acceptanceLabel: (taskId: string) => `验收${taskId}`,
        finalLabel: '全量验收',
        runAcceptance: (label: string) => `${label}：运行验收命令`,
        runHighRisk: (label: string, action: HighRiskAction) =>
            `${label}：运行验收命令（高风险动作：${highRiskLabel(action, 'zh-CN')}）`,
        manualTitle: (taskId: string, title: string) => `人工检查${taskId}：${title}`,
        acceptanceTitle: (taskId: string, title: string) => `需要你确认：${taskId} ${title}`,
        deliverable: (summary: string) => `交付：${summary}`,
        reviewTitle: (taskId: string, title: string) => `审查${taskId}：${title}`,
        changed: (files: readonly string[]) => `改动：${files.join('、')}`,
        reviewThread: (taskId: string) => `审查${taskId}`,
        needsPerson: (why: string) => `主管接手后仍然没有通过，需要人处理：${why}`,
        needsYou: (taskId: string) => `${taskId}需要你处理`,
        deliveryTitle: '确认交付：把团队的改动应用到项目',
        deliveryDeclined: (message: string | undefined) =>
            `你没有确认交付${message ? `：${message}` : ''}；改动还在各自的worktree里，点继续重新确认`,
        deliveryLapsed: '交付确认过期或被取消了；点继续重新确认',
        files: (paths: readonly string[]) => paths.join('、'),
        integrateFailed: (taskId: string, files: string, message: string | undefined) =>
            `整合${taskId}失败（${files}）：${message ?? '改动应用不上'}；处理后点继续`,
        integrateConflicts: (taskId: string, files: string) =>
            `整合${taskId}时有冲突（${files}），冲突标记已经写进项目目录；解决后点继续`,
        finalFailed: (runs: readonly string[]) => `全量验收没有通过：${runs.join('；')}`,
        endedFailed: '团队运行结束，全量验收没有通过',
        completed: '团队运行完成',
        reportInView: '交付报告在团队视图里',
        deliveryIntro: '按依赖顺序把这些任务的改动应用到项目目录：',
        deliveryTask: (taskId: string, title: string, files: readonly string[]) =>
            `- ${taskId} ${title}${files.length > 0 ? `：${files.join('、')}` : ''}`,
        deliveryOutro: '应用后会在项目里把验收命令再跑一遍。',
        finalTitle: '## 全量验收',
        noFinalChecks: '没有可以在项目里重跑的验收命令。',
        finalCheck: (run: string, ran: boolean, exit: number | null) =>
            `- \`${run}\`：${!ran ? '没有运行' : exit === 0 ? '通过' : `退出码${exit ?? '无'}`}`,
    },
    {
        projectMissing: (folder) => `The project folder does not exist: ${folder}`,
        emptyGoal: 'The goal cannot be empty',
        autonomyProblems: (problems) => problems.join('; '),
        noSupervisor: 'The organization has no supervisor',
        uncommitted:
            "The project has uncommitted changes: each task's worktree starts from the latest commit and does not see them",
        supervisorTitle: (goal) => `Team: ${goal}`,
        supervisorNotStarted: (error) => `The supervisor thread could not start: ${error}`,
        stoppedByYou: 'You stopped this run',
        runStopped: 'The run was stopped',
        onlyPaused: 'Only a paused run can continue',
        budgetSpent: 'The budget is used up: add to it before you continue',
        restarted:
            'The app restarted and the run is paused; click Continue to pick it up (finished tasks are not run again)',
        pausedTitle: 'Team run paused',
        budgetNote: (spent, currency, limit, limitCurrency) =>
            `The budget is used up (spent ${money(spent, currency, 'en')} of ${money(limit, limitCurrency || currency, 'en')}); add to it and click Continue, or narrow the scope`,
        supervisorTurnFailed: (errorClass) =>
            `The supervisor's turn failed (${errorClass}): see the supervisor thread, deal with it, then click Continue`,
        supervisorModelSwitched: (errorClass, model) =>
            `The supervisor's model failed (${errorClass}); switched to ${model}`,
        planAutoApproved: 'The plan was approved automatically, as the autonomy level allows',
        planApproval: 'Approve the team plan',
        planApproved: 'You approved the plan',
        planApprovalLapsed: 'The plan approval expired or was cancelled; click Continue to approve it again',
        noPlanReviewer: 'The organization has no plan reviewer; the separate plan review was skipped',
        planReviewNoModel: (error) => `No model is available for the plan review, so it was skipped: ${error}`,
        planReviewNoFamily: (family, tier) =>
            `No ${tierLabel(tier, 'en')} tier model of a family other than ${family ?? "the supervisor's"} is connected; the separate plan review was skipped`,
        planReviewTitle: 'Review the plan',
        planReviewing: 'Reviewing the plan',
        planReviewUnfinished: (outcome) =>
            `The plan review did not finish (${outcome}); the plan goes straight to approval`,
        planGoal: (goal) => `Goal: ${goal}`,
        planTask: (card, tier, checks) =>
            `- ${card.id} ${card.title} (${card.category}, ${tierLabel(tier, 'en')} tier, ${card.workspace}${card.dependsOn.length > 0 ? `, depends on ${card.dependsOn.join(', ')}` : ''}). Acceptance: ${checks}`,
        planBudget: (limit, currency) => `Budget: ${money(limit, currency, 'en')}`,
        runEnded: 'The run has ended, so the message cannot be delivered',
        noTask: (id) => `There is no task ${id}`,
        taskEnded: (id) => `Task ${id} has ended; you can write to the supervisor instead`,
        blocker: (id, held, status) => `${id}${held ? ' (held by the supervisor)' : ''}: ${status}`,
        stuck: (blockers) =>
            `No task can go on (${blockers.join(', ')}); tell the supervisor in its thread what to do, or stop the run`,
        stuckTitle: 'The team is stuck',
        noPreviousRun: (id) => `This project has no run ${id}`,
        previousRunActive: 'The earlier run has not ended: wait for it, or stop it first',
        awaitingUser:
            'The supervisor ended its turn without task cards and may be waiting for you in its thread: reply there, or stop the run',
        noPlan: 'The supervisor ended several turns without task cards; tell it what to do in its thread and click Continue, or stop the run',
        tierLowered: (taskId, tier, percent) =>
            `${taskId} runs at the ${tierLabel(tier, 'en')} tier instead (${percent}% of the budget is spent)`,
        notGitRepo: (taskId) => `The project is not a git repository; ${taskId} runs in the project folder instead`,
        notSeeded: (from, taskId, reason) =>
            `The results of ${from} could not be brought into the worktree of ${taskId}: ${reason}`,
        dispatchTitle: (taskId, title) => `Dispatch: ${taskId} ${title}`,
        dispatchSummary: (agent, tier, workspace, goal) =>
            `To ${agent} (${tierLabel(tier, 'en')} tier, ${workspace})\nGoal: ${goal}`,
        dispatchDeclined: (message) => `You did not approve the dispatch${message ? `: ${message}` : ''}`,
        hostError: (error) => `Host error: ${error}`,
        executorCancelled: "The executor's turn was cancelled",
        executorFailed: (errorClass) => `The executor's turn failed (${errorClass})`,
        taskModelSwitched: (taskId, errorClass, model) =>
            `The model of ${taskId} failed (${errorClass}); switched to ${model}`,
        repairTitle: (taskId) => `Tidy up the deliverable of ${taskId}`,
        acceptanceLabel: (taskId) => `Acceptance of ${taskId}`,
        finalLabel: 'Final acceptance',
        runAcceptance: (label) => `${label}: run the acceptance command`,
        runHighRisk: (label, action) =>
            `${label}: run the acceptance command (high-risk action: ${highRiskLabel(action, 'en')})`,
        manualTitle: (taskId, title) => `Manual check of ${taskId}: ${title}`,
        acceptanceTitle: (taskId, title) => `Needs your approval: ${taskId} ${title}`,
        deliverable: (summary) => `Deliverable: ${summary}`,
        reviewTitle: (taskId, title) => `Review ${taskId}: ${title}`,
        changed: (files) => `Changes: ${files.join(', ')}`,
        reviewThread: (taskId) => `Review ${taskId}`,
        needsPerson: (why) => `Still not passing after the supervisor took over; a person has to deal with it: ${why}`,
        needsYou: (taskId) => `${taskId} needs you`,
        deliveryTitle: "Confirm the delivery: apply the team's changes to the project",
        deliveryDeclined: (message) =>
            `You did not confirm the delivery${message ? `: ${message}` : ''}. The changes are still in their worktrees; click Continue to confirm again`,
        deliveryLapsed: 'The delivery confirmation expired or was cancelled; click Continue to confirm again',
        files: (paths) => paths.join(', '),
        integrateFailed: (taskId, files, message) =>
            `Integrating ${taskId} failed (${files}): ${message ?? 'the changes do not apply'}; deal with it, then click Continue`,
        integrateConflicts: (taskId, files) =>
            `Integrating ${taskId} left conflicts (${files}), marked in the project folder; resolve them, then click Continue`,
        finalFailed: (runs) => `Final acceptance failed: ${runs.join('; ')}`,
        endedFailed: 'The team run ended: final acceptance failed',
        completed: 'The team run is complete',
        reportInView: 'The delivery report is in the team view',
        deliveryIntro: 'Apply the changes of these tasks to the project folder, in dependency order:',
        deliveryTask: (taskId, title, files) =>
            `- ${taskId} ${title}${files.length > 0 ? `: ${files.join(', ')}` : ''}`,
        deliveryOutro: 'Afterwards the acceptance commands run once more in the project.',
        finalTitle: '## Final acceptance',
        noFinalChecks: 'No acceptance command can be run again in the project.',
        finalCheck: (run, ran, exit) =>
            `- \`${run}\`: ${!ran ? 'not run' : exit === 0 ? 'passed' : `exit code ${exit ?? 'none'}`}`,
    },
);

type TeamText = (typeof TEXT)['zh-CN'];

// ---------------------------------------------------------------------------------------------------------
// Text helpers

function tail(output: string): string {
    const trimmed = output.trimEnd();
    return trimmed.length > OUTPUT_TAIL ? `…${trimmed.slice(-OUTPUT_TAIL)}` : trimmed;
}

function round(amount: number): number {
    return Math.round(amount * 1e6) / 1e6;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function boardError(error: BoardError): string {
    return error.details.length > 0 ? `${error.message}\n- ${error.details.join('\n- ')}` : error.message;
}

function ok(content: string): HostToolResult {
    return { content };
}

function fail(content: string): HostToolResult {
    return { content, isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------------------

export class TeamService {
    readonly #deps: TeamDeps;
    readonly #store: SqliteTeamStore;
    readonly #commandTimeoutMs: number;
    readonly #runs = new Map<string, RunState>();
    readonly #loading = new Map<string, Promise<RunState | undefined>>();
    /** Host-started turns waiting for their end, by turn id. */
    readonly #waiters = new Map<string, (event: TurnEnded) => void>();
    /** Ends nobody waited for yet, by turn id. */
    readonly #early = new Map<string, TurnEnded>();
    /** Waiting for any turn of a thread to end, by thread id. */
    readonly #idle = new Map<string, Array<() => void>>();
    readonly #ready: Promise<void>;
    #disposed = false;

    constructor(deps: TeamDeps) {
        this.#deps = deps;
        this.#store = new SqliteTeamStore(deps.db);
        this.#commandTimeoutMs = deps.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
        this.#ready = this.#recover().catch((error) => deps.log.warn(`team: recovery failed: ${errorText(error)}`));
    }

    // Public API ------------------------------------------------------------------------------------------

    async start(input: {
        projectId: string;
        goal: string;
        autonomy?: AutonomyLevel;
        budget?: number;
        mode?: TeamMode;
        /** An earlier run of the project, finished, that this one continues. */
        continues?: string;
    }): Promise<TeamRunView> {
        await this.#ready;
        const { projects, settings, threads } = this.#deps;
        const text = textOf(TEXT);
        const project = await projects.get(input.projectId);
        if (project.missing) {
            throw new RpcError(RpcErrorCode.Rejected, text.projectMissing(project.path));
        }
        const goal = input.goal.trim();
        if (!goal) {
            throw new RpcError(RpcErrorCode.InvalidParams, text.emptyGoal);
        }
        const before = input.continues ? await this.#load(input.continues) : undefined;
        if (input.continues && (!before || before.host.projectId !== project.id)) {
            throw new RpcError(RpcErrorCode.NotFound, text.noPreviousRun(input.continues));
        }
        if (before && this.#live(before)) {
            throw new RpcError(RpcErrorCode.Rejected, text.previousRunActive);
        }
        const loaded = await loadTeamOrganization({
            orgsDir: this.#deps.orgsDir,
            projectDir: project.path,
            trusted: project.trusted,
        });
        const org = loaded.org;
        const autonomy = input.autonomy ?? org.autonomy;
        const currency = settings.get().currency;
        const limit =
            input.budget ?? (org.budgets.currency === currency && org.budgets.perRun ? org.budgets.perRun : undefined);
        const checked = validateAutonomy(autonomy, {
            channels: this.#channels(org, autonomy, project),
            ...(limit !== undefined ? { budget: limit } : {}),
            modes: org.roster.map((agent) => agent.mode),
        });
        if (!checked.ok) {
            throw new RpcError(
                RpcErrorCode.Rejected,
                text.autonomyProblems(checked.problems.map((problem) => problem.message)),
            );
        }
        const supervisor = org.roster.find((agent) => agent.role === 'supervisor');
        if (!supervisor) {
            throw new RpcError(RpcErrorCode.Rejected, text.noSupervisor);
        }
        const runId = newId('team');
        const warnings = [...loaded.warnings];
        const tier = resolveTier('supervisor', undefined, org).tier;
        const pick = this.#pickModel(org, autonomy, project, tier, warnings);
        const base = project.git.isRepo ? await headCommit(project.path).catch(() => undefined) : undefined;
        if (base && (await this.#deps.worktrees.changedFiles(project.path)).length > 0) {
            warnings.push(text.uncommitted);
        }
        const thread = threads.create({
            projectId: project.id,
            title: text.supervisorTitle(shorten(goal, 20)),
            engine: 'xora',
            model: pick.ref,
            mode: 'plan',
            effort: pick.effort,
            extra: { teamRunId: runId, role: 'supervisor', tier, agentId: supervisor.id, group: runId },
        });
        const run = createTeamRun({
            id: runId,
            goal,
            orgId: org.id,
            projectId: project.id,
            autonomy,
            phase: 'plan',
            ...(limit !== undefined ? { budget: { limit, currency } } : {}),
        });
        const host: RunHost = {
            projectId: project.id,
            status: 'planning',
            supervisorThreadId: thread.id,
            supervisorFallbacks: pick.fallbacks,
            ...(pick.family ? { supervisorFamily: pick.family } : {}),
            planApproved: false,
            deliveryApproved: false,
            ...(base ? { base } : {}),
            org,
            orgSources: [...loaded.sources],
            warnings,
            inbox: [],
            ...(input.mode === 'hypotheses' ? { mode: 'hypotheses' as const } : {}),
            ...(before ? { continues: before.run.id } : {}),
            tasks: {},
            reviewThreads: [],
            actions: [],
        };
        const state = this.#state(run, new TaskBoard(), undefined, new ProgressLedger(), host);
        this.#runs.set(runId, state);
        this.#save(state);
        this.#attachTools(state);
        try {
            const previous = before
                ? {
                      goal: before.run.goal,
                      status: before.host.status,
                      ...(before.host.report ? { report: before.host.report } : {}),
                  }
                : undefined;
            await this.#startSupervisor(state, supervisorBrief(goal, run, this.#maxParallel(), host.mode, previous));
        } catch (error) {
            this.#setStatus(state, 'failed', textOf(TEXT).supervisorNotStarted(errorText(error)));
            throw error;
        }
        this.#deps.log.info(`team ${runId} started in ${project.id}: ${shorten(goal, 60)}`);
        return this.#view(state);
    }

    async list(projectId?: string): Promise<TeamRunView[]> {
        await this.#ready;
        const runs = await this.#store.listRuns(projectId ? { projectId } : {});
        const views: TeamRunView[] = [];
        for (const run of runs) {
            const state = await this.#load(run.id);
            if (state) {
                views.push(this.#view(state));
            }
        }
        return views;
    }

    async get(runId: string): Promise<TeamRunView> {
        await this.#ready;
        return this.#view(await this.#require(runId));
    }

    /** Cancels every running turn of the run; finished tasks stay done. */
    async stop(runId: string): Promise<TeamRunView> {
        await this.#ready;
        const state = await this.#require(runId);
        if (TERMINAL.has(state.host.status)) {
            return this.#view(state);
        }
        state.abort.abort();
        if (state.wakeTimer) {
            clearTimeout(state.wakeTimer);
            state.wakeTimer = undefined;
        }
        state.host.inbox = [];
        const text = textOf(TEXT);
        this.#setStatus(state, 'cancelled', text.stoppedByYou);
        for (const threadId of this.#threadsOf(state)) {
            this.#deps.turns.cancel(threadId);
        }
        this.#deps.approvals.cancelThread(state.host.supervisorThreadId);
        for (const question of state.questions.values()) {
            question.answer('The run was stopped.');
        }
        state.questions.clear();
        for (const task of state.board.list()) {
            if (task.status !== 'done' && task.status !== 'cancelled') {
                state.board.cancel(task.card.id, text.runStopped);
            }
        }
        this.#save(state);
        return this.#view(state);
    }

    /**
     * Continues a paused run (06 §9): interrupted tasks pick up where they stopped, a delivery waiting for
     * confirmation asks again, and finished tasks are never run again.
     */
    async resume(runId: string, budget?: number): Promise<TeamRunView> {
        await this.#ready;
        const state = await this.#require(runId);
        const host = state.host;
        if (host.status !== 'paused') {
            throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).onlyPaused);
        }
        if (budget !== undefined) {
            state.run = {
                ...state.run,
                budget: { limit: budget, currency: state.run.budget?.currency ?? this.#deps.settings.get().currency },
            };
        }
        if (this.#pressure(state).state === 'exhausted') {
            throw new RpcError(RpcErrorCode.Rejected, textOf(TEXT).budgetSpent);
        }
        state.abort = new AbortController();
        const to = host.resumeTo ?? (host.planApproved ? 'running' : 'planning');
        host.resumeTo = undefined;
        host.stuck = false;
        host.planNudges = 0;
        this.#setStatus(state, to === 'awaiting_plan_approval' ? 'planning' : to);
        this.#attachTools(state);
        for (const task of state.board.list({ status: ['assigned', 'in_progress', 'in_review'] })) {
            const taskId = task.card.id;
            const threadId = host.tasks[taskId]?.threadId;
            if (state.working.has(taskId)) {
                continue;
            }
            if (task.status === 'in_review') {
                void this.#work(state, taskId, 'review');
            } else if (task.status === 'in_progress' && threadId && this.#deps.threads.find(threadId)) {
                void this.#work(state, taskId, 'continue');
            } else if (task.owner) {
                state.board.release(taskId, task.owner, 'dispatched again after a restart');
            }
        }
        if (to === 'awaiting_plan_approval') {
            void this.#planReady(state);
        } else if (to === 'planning') {
            this.#wake(
                state,
                'The run continues after a pause. Check the board with task_list, finish the plan and end your turn.',
            );
        } else if (to === 'integrating') {
            void this.#integrate(state);
        }
        this.#save(state);
        this.#advance(state);
        this.#scheduleWake(state);
        return this.#view(state);
    }

    /** The organization's members and the model chain of each tier. */
    async roster(projectId: string): Promise<{
        org: string;
        agents: Array<{ id: string; name: string; role: string; tier: string; category?: string }>;
        tiers: Record<string, string[]>;
    }> {
        const project = await this.#deps.projects.get(projectId);
        const { org } = await loadTeamOrganization({
            orgsDir: this.#deps.orgsDir,
            projectDir: project.path,
            trusted: project.trusted,
        });
        return {
            org: org.name,
            agents: org.roster.map((agent) => ({
                id: agent.id,
                name: agent.name,
                role: agent.role,
                tier: agent.tier,
                ...(agent.category ? { category: agent.category } : {}),
            })),
            tiers: Object.fromEntries(
                Object.entries(org.tiers).map(([tier, spec]) => [tier, spec.models.map((entry) => entry.model)]),
            ),
        };
    }

    /** Turn hook: resolves the host loops waiting on a turn, and lets the supervisor's turns drive the run. */
    onTurnEnded(event: TurnEnded): void {
        if (this.#disposed) {
            return;
        }
        for (const resolve of this.#idle.get(event.threadId)?.splice(0) ?? []) {
            resolve();
        }
        const waiter = this.#waiters.get(event.turnId);
        if (waiter) {
            this.#waiters.delete(event.turnId);
            waiter(event);
            return;
        }
        const thread = this.#deps.threads.find(event.threadId);
        if (!thread?.teamRunId) {
            return;
        }
        if (thread.role !== 'supervisor') {
            this.#early.set(event.turnId, event);
            if (this.#early.size > RECENT_ENDS) {
                const oldest = this.#early.keys().next().value;
                if (oldest !== undefined) this.#early.delete(oldest);
            }
            return;
        }
        void this.#load(thread.teamRunId)
            .then((state) => (state ? this.#afterSupervisorTurn(state, event) : undefined))
            .catch((error) => this.#deps.log.warn(`team: supervisor turn: ${errorText(error)}`));
    }

    dispose(): void {
        this.#disposed = true;
        for (const state of this.#runs.values()) {
            if (state.wakeTimer) clearTimeout(state.wakeTimer);
            if (state.broadcastTimer) clearTimeout(state.broadcastTimer);
            state.abort.abort();
            for (const question of state.questions.values()) {
                question.answer('The app is shutting down.');
            }
        }
        for (const [turnId, resolve] of [...this.#waiters]) {
            resolve({ threadId: '', turnId, outcome: 'cancelled', lastText: '', changedFiles: [], requests: 0 });
        }
        this.#waiters.clear();
        for (const resolvers of this.#idle.values()) {
            for (const resolve of resolvers) resolve();
        }
        this.#idle.clear();
    }

    // State ----------------------------------------------------------------------------------------------

    #state(
        run: TeamRun,
        board: TaskBoard,
        ledger: TaskLedger | undefined,
        progress: ProgressLedger,
        host: RunHost,
    ): RunState {
        const state: RunState = {
            run,
            board,
            ledger,
            progress,
            host,
            working: new Set(),
            questions: new Map(),
            abort: new AbortController(),
            supervisorStarting: false,
            reviewingPlan: false,
            approvingPlan: false,
            integrating: false,
            wakeTimer: undefined,
            broadcastTimer: undefined,
        };
        board.onEvent((event) => {
            if (!this.#disposed) {
                this.#store.writeEvents(run.id, [event]);
                this.#changed(state);
            }
        });
        return state;
    }

    /** Non-terminal runs are paused at startup and never continue on their own (06 §9). */
    async #recover(): Promise<void> {
        const runs = await this.#store.listRuns({ status: ['running', 'waiting_user', 'paused'] });
        for (const run of runs) {
            const state = await this.#load(run.id);
            if (!state) {
                continue;
            }
            if (state.host.status !== 'paused' && !TERMINAL.has(state.host.status)) {
                state.host.resumeTo = state.host.status;
                state.host.status = 'paused';
                state.host.note = textOf(TEXT).restarted;
                this.#save(state);
            }
            this.#attachTools(state);
        }
    }

    async #load(runId: string): Promise<RunState | undefined> {
        const cached = this.#runs.get(runId);
        if (cached) {
            return cached;
        }
        let pending = this.#loading.get(runId);
        if (!pending) {
            pending = this.#restore(runId);
            this.#loading.set(runId, pending);
        }
        try {
            return await pending;
        } finally {
            this.#loading.delete(runId);
        }
    }

    async #restore(runId: string): Promise<RunState | undefined> {
        const loaded = await loadTeamState(this.#store, runId);
        const host = this.#store.readHost<RunHost>(runId);
        if (!loaded || !host) {
            return undefined;
        }
        const state = this.#state(loaded.run, loaded.board, loaded.taskLedger, loaded.progress, host);
        this.#runs.set(runId, state);
        return state;
    }

    async #require(runId: string): Promise<RunState> {
        const state = await this.#load(runId);
        if (!state) {
            throw new RpcError(RpcErrorCode.NotFound, `team run not found: ${runId}`);
        }
        return state;
    }

    /** Persists the run, board, ledgers and bookkeeping, then schedules a `team.changed`. */
    #save(state: RunState): void {
        if (this.#disposed) {
            return;
        }
        const { host } = state;
        const mapped = WORKFLOW_STATE[host.status];
        const now = Date.now();
        const { note: _note, ...rest } = state.run;
        state.run = {
            ...rest,
            status: mapped.status,
            ...(mapped.phase ? { phase: mapped.phase } : {}),
            updatedAt: now,
            ...(host.note ? { note: host.note } : {}),
            ...(TERMINAL.has(host.status) ? { finishedAt: state.run.finishedAt ?? now } : {}),
        };
        try {
            this.#store.writeRun(state.run);
            this.#store.writeBoard(state.run.id, state.board.snapshot());
            if (state.ledger) {
                this.#store.writeTaskLedger(state.run.id, state.ledger.snapshot());
            }
            this.#store.writeProgress(state.run.id, state.progress.snapshot());
            this.#store.writeHost(state.run.id, host);
        } catch (error) {
            this.#deps.log.warn(`team ${state.run.id}: could not save: ${errorText(error)}`);
        }
        this.#changed(state);
    }

    /** Broadcasts `team.changed` at most every {@link BROADCAST_MS}. */
    #changed(state: RunState): void {
        if (state.broadcastTimer || this.#disposed) {
            return;
        }
        state.broadcastTimer = setTimeout(() => {
            state.broadcastTimer = undefined;
            if (!this.#disposed) {
                this.#deps.bus.broadcast('team.changed', { run: this.#view(state) });
            }
        }, BROADCAST_MS);
    }

    #setStatus(state: RunState, status: RunStatus, note?: string): void {
        state.host.status = status;
        state.host.note = note;
        this.#save(state);
    }

    #pause(state: RunState, note: string): void {
        if (!this.#live(state) || state.host.status === 'paused') {
            return;
        }
        state.host.resumeTo = state.host.status;
        this.#setStatus(state, 'paused', note);
        this.#notice(state, 'warning', textOf(TEXT).pausedTitle, note);
    }

    /** Not finished: may still change. */
    #live(state: RunState): boolean {
        return !this.#disposed && !TERMINAL.has(state.host.status);
    }

    /** Live and not paused: may start new work. */
    #active(state: RunState): boolean {
        return this.#live(state) && state.host.status !== 'paused';
    }

    /** Adds a warning once. One written before a language switch is in the other language and counts too. */
    #warn(state: RunState, warning: (text: TeamText) => string): void {
        const { warnings } = state.host;
        if (!Object.values(TEXT).some((text) => warnings.includes(warning(text)))) {
            warnings.push(warning(textOf(TEXT)));
        }
    }

    #threadsOf(state: RunState): string[] {
        return [
            state.host.supervisorThreadId,
            ...Object.values(state.host.tasks).flatMap((task) => task.threads),
            ...state.host.reviewThreads,
        ];
    }

    /** A notice in the supervisor thread, under its latest turn. */
    #notice(state: RunState, severity: 'info' | 'warning' | 'error', title: string, description?: string): void {
        const turnId = state.host.supervisorTurnId;
        if (!turnId || this.#disposed) {
            return;
        }
        const item: ItemOf<'notice'> = {
            id: newId('i'),
            turnId,
            ts: Date.now(),
            type: 'notice',
            severity,
            title,
            ...(description ? { description } : {}),
        };
        this.#deps.threads.append(
            state.host.supervisorThreadId,
            'item.completed',
            { item },
            { turnId, itemId: item.id },
        );
    }

    /** Members working at once in one run: the setting, read at every dispatch so a change applies right away. */
    #maxParallel(): number {
        const wanted = this.#deps.settings.get().team.maxParallel;
        return Math.min(MAX_PARALLEL, Math.max(MIN_PARALLEL, Math.round(wanted)));
    }

    // Models and costs -----------------------------------------------------------------------------------

    /** Connected, usable models with their family and channel, for the tiers' chains. */
    #pickModel(
        org: Organization,
        autonomy: AutonomyLevel,
        project: Project,
        tier: Tier,
        warnings: string[],
        reviewerOf?: string,
    ): ModelPick {
        return pickTierModel(this.#deps, {
            org,
            project,
            tier,
            unattended: autonomy === 'L3',
            warnings,
            ...(reviewerOf !== undefined ? { reviewerOf } : {}),
        });
    }

    /** Channels the run would use, for the L3 check. */
    #channels(org: Organization, autonomy: AutonomyLevel, project: Project): string[] {
        return runChannels(this.#deps, org, project, autonomy === 'L3');
    }

    /** The run's spending from the usage events, in the display currency. */
    #costs(state: RunState): Costs {
        const { db, usage, settings } = this.#deps;
        const currency = settings.get().currency;
        const rows = db.all<{
            agent_id: string | null;
            role: string | null;
            tier: string | null;
            task_id: string | null;
            cost_amount: number | null;
            cost_currency: string | null;
        }>(
            'select agent_id, role, tier, task_id, cost_amount, cost_currency from usage_events where workflow_run_id = ?',
            [state.run.id],
        );
        let total = 0;
        let supervisor = 0;
        const byTier = new Map<string, number>();
        const byTask = new Map<string, number>();
        const records: TeamUsage[] = [];
        for (const row of rows) {
            if (row.cost_amount === null) {
                continue;
            }
            const amount = usage.toDisplay({ amount: row.cost_amount, currency: row.cost_currency ?? 'CNY' }).amount;
            total += amount;
            if (row.role === 'supervisor') {
                supervisor += amount;
            }
            if (row.tier) {
                byTier.set(row.tier, (byTier.get(row.tier) ?? 0) + amount);
            }
            if (row.task_id) {
                byTask.set(row.task_id, (byTask.get(row.task_id) ?? 0) + amount);
            }
            records.push({
                ...(row.agent_id ? { agentId: row.agent_id } : {}),
                ...(row.role ? { role: row.role } : {}),
                ...(row.tier ? { tier: row.tier } : {}),
                ...(row.task_id ? { taskId: row.task_id } : {}),
                cost: { amount, currency },
            });
        }
        return { currency, total, supervisor, byTier, byTask, usage: records };
    }

    #pressure(state: RunState): BudgetPressure {
        const budget = state.run.budget;
        if (!budget) {
            return { ratio: 0, state: 'ok' };
        }
        const limit = this.#deps.usage.toDisplay({ amount: budget.limit, currency: budget.currency }).amount;
        return budgetPressure(this.#costs(state).total, limit);
    }

    #budgetNote(state: RunState): string {
        const costs = this.#costs(state);
        const budget = state.run.budget;
        return textOf(TEXT).budgetNote(round(costs.total), costs.currency, budget?.limit ?? 0, budget?.currency ?? '');
    }

    // View -----------------------------------------------------------------------------------------------

    #view(state: RunState): TeamRunView {
        const { host, run } = state;
        const costs = this.#costs(state);
        const tasks: TeamTaskView[] = state.board.list().map((task) => {
            const info = host.tasks[task.card.id];
            const active = task.status === 'assigned' || task.status === 'in_progress' || task.status === 'in_review';
            const cost = costs.byTask.get(task.card.id);
            const assignee = task.owner ?? task.card.assignee;
            return {
                id: task.card.id,
                title: task.card.title,
                goal: task.card.goal,
                category: task.card.category,
                tier: task.tier,
                status: task.status,
                ...(assignee ? { assignee } : {}),
                ...(info?.threadId ? { threadId: info.threadId } : {}),
                dependsOn: [...task.card.dependsOn],
                ownership: [...task.card.ownership],
                acceptance: [...task.card.acceptance],
                attempts: task.attempts.length + (active ? 1 : 0),
                ...(task.deliverable ? { deliverable: task.deliverable } : {}),
                ...(info?.verdict ? { verdict: info.verdict } : {}),
                cost: cost === undefined ? null : { amount: round(cost), currency: costs.currency },
            };
        });
        return {
            id: run.id,
            projectId: host.projectId,
            goal: run.goal,
            status: host.status,
            autonomy: run.autonomy,
            budget: run.budget ? { amount: run.budget.limit, currency: run.budget.currency } : null,
            ...(host.note ? { note: host.note } : {}),
            ...(host.warnings.length > 0 ? { warnings: [...host.warnings] } : {}),
            mode: host.mode ?? 'standard',
            ...(host.continues ? { continues: host.continues } : {}),
            feedback: [...(host.feedback ?? [])],
            conversation: [...(host.conversation ?? [])],
            supervisorThreadId: host.supervisorThreadId,
            tasks,
            ...(state.ledger
                ? {
                      ledger: {
                          version: state.ledger.version,
                          ...state.ledger.current,
                          revisions: state.ledger.revisions.map((revision) => ({
                              version: revision.version,
                              ts: revision.ts,
                              reason: revision.reason,
                              ...(revision.author ? { author: revision.author } : {}),
                          })),
                      },
                  }
                : {}),
            progress: [...state.progress.entries],
            ...(host.report ? { report: host.report } : {}),
            cost: { amount: round(costs.total), currency: costs.currency },
            supervisionShare: costs.total > 0 ? costs.supervisor / costs.total : 0,
            costByTier: Object.fromEntries([...costs.byTier].map(([tier, amount]) => [tier, round(amount)])),
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
        };
    }

    // Threads and turns ----------------------------------------------------------------------------------

    #attachTools(state: RunState): void {
        const { turns } = this.#deps;
        const org = state.host.org;
        const supervisor = org.roster.find((agent) => agent.role === 'supervisor');
        if (supervisor) {
            turns.setHostTools(state.host.supervisorThreadId, this.#supervisorProvider(state, supervisor));
        }
        for (const [taskId, info] of Object.entries(state.host.tasks)) {
            const agent = info.specId ? findAgent(org, info.specId) : undefined;
            if (info.threadId && agent) {
                turns.setHostTools(info.threadId, this.#memberProvider(state, taskId, agent));
            }
        }
    }

    #supervisorProvider(state: RunState, agent: AgentSpec): HostToolProvider {
        const allowed = new Set(toolsOf(agent));
        const runId = state.run.id;
        return {
            tools: SUPERVISOR_TOOLS.filter((tool) => allowed.has(tool.name)),
            disabledTools: disabledBuiltins(agent),
            mcpTools: mcpToolsOf(agent),
            layers: systemLayers(state.host.org, agent),
            highRiskApproval: true,
            handle: (name, input) => this.#supervisorTool(runId, name, input),
        };
    }

    #memberProvider(state: RunState, taskId: string, agent: AgentSpec): HostToolProvider {
        const allowed = new Set(toolsOf(agent));
        const runId = state.run.id;
        return {
            tools: MEMBER_TOOLS.filter(
                (tool) => allowed.has(tool.name) && (tool.name !== 'challenge' || state.host.mode === 'hypotheses'),
            ),
            disabledTools: disabledBuiltins(agent),
            mcpTools: mcpToolsOf(agent),
            layers: systemLayers(state.host.org, agent),
            highRiskApproval: true,
            // The engine stops the turn where the card's turn budget runs out.
            maxTurnRequests: () => this.#turnsLeft(state, taskId),
            handle: (name, input, signal) => this.#memberTool(runId, taskId, name, input, signal),
        };
    }

    /** A thread of the run; `worktree` places it in an existing checkout (a reviewer reads the executor's). */
    #createThread(
        state: RunState,
        spec: {
            title: string;
            role: Role;
            tier: Tier;
            agentId: string;
            taskId?: string;
            pick: ModelPick;
            mode: PermissionMode;
            worktree?: { path: string; id: string };
        },
    ) {
        const { threads } = this.#deps;
        const thread = threads.create({
            projectId: state.host.projectId,
            title: spec.title,
            engine: 'xora',
            model: spec.pick.ref,
            mode: spec.mode,
            effort: spec.pick.effort,
            extra: {
                teamRunId: state.run.id,
                role: spec.role,
                tier: spec.tier,
                agentId: spec.agentId,
                ...(spec.taskId ? { taskId: spec.taskId } : {}),
                group: state.run.id,
            },
        });
        if (spec.worktree) {
            return threads.update(thread.id, {
                location: { kind: 'worktree', path: spec.worktree.path, worktreeId: spec.worktree.id },
            });
        }
        return thread;
    }

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

    #lastError(threadId: string): string | undefined {
        const events = this.#deps.threads.events(threadId);
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            if (event?.kind === 'turn.failed') {
                return (event.payload as { error?: { errorClass?: string } }).error?.errorClass;
            }
        }
        return undefined;
    }

    // Supervisor -----------------------------------------------------------------------------------------

    async #startSupervisor(state: RunState, text: string): Promise<boolean> {
        const threadId = state.host.supervisorThreadId;
        if (state.supervisorStarting || this.#deps.turns.isRunning(threadId)) {
            return false;
        }
        state.supervisorStarting = true;
        try {
            state.host.supervisorTurnId = await this.#deps.turns.start(threadId, text);
            this.#save(state);
            return true;
        } finally {
            state.supervisorStarting = false;
        }
    }

    #wake(state: RunState, line: string): void {
        state.host.inbox.push(line);
        this.#scheduleWake(state);
    }

    #scheduleWake(state: RunState): void {
        if (state.wakeTimer || this.#disposed || state.host.inbox.length === 0) {
            return;
        }
        state.wakeTimer = setTimeout(() => {
            state.wakeTimer = undefined;
            void this.#pumpSupervisor(state);
        }, WAKE_DELAY_MS);
    }

    /** Sends the queued updates to the supervisor as one turn; queued again while it is busy (never two turns). */
    async #pumpSupervisor(state: RunState): Promise<void> {
        const { host } = state;
        if (!this.#active(state) || host.inbox.length === 0) {
            return;
        }
        if (state.supervisorStarting || this.#deps.turns.isRunning(host.supervisorThreadId)) {
            return;
        }
        const lines = host.inbox.splice(0);
        // Every open question has its line in the inbox; it counts as asked once the turn carrying it starts.
        const asked = [...state.questions.values()].filter((question) => !question.delivered);
        try {
            if (await this.#startSupervisor(state, wakeText(lines, state.board))) {
                for (const question of asked) {
                    question.delivered = true;
                }
            } else {
                host.inbox.unshift(...lines);
            }
        } catch (error) {
            host.inbox.unshift(...lines);
            // The user started a turn in the meantime: its end pumps again.
            if (!this.#deps.turns.isRunning(host.supervisorThreadId)) {
                this.#pause(state, textOf(TEXT).supervisorNotStarted(errorText(error)));
            }
        }
        this.#save(state);
    }

    async #afterSupervisorTurn(state: RunState, event: TurnEnded): Promise<void> {
        const { host } = state;
        host.supervisorTurnId = event.turnId;
        // Questions the supervisor saw in this turn but did not answer with send_message get its final message.
        for (const [taskId, question] of [...state.questions]) {
            if (question.delivered) {
                state.questions.delete(taskId);
                const reply = event.lastText.trim();
                question.answer(
                    reply
                        ? `The supervisor did not use send_message; its reply was:\n${reply}`
                        : 'The supervisor did not answer. Decide from the card, or deliver blocked with the question.',
                );
            }
        }
        // Its last words of the turn are its feedback to the user, also after the run ended.
        const said = event.lastText.trim();
        if (said) {
            host.feedback = [...(host.feedback ?? []), { ts: Date.now(), text: shorten(said, 8000) }].slice(
                -FEEDBACK_KEPT,
            );
        }
        if (!this.#live(state)) {
            this.#save(state);
            return;
        }
        if (event.outcome === 'failed') {
            // A model error moves the supervisor to the next model of the flagship chain (06 §3 rule 2).
            const errorClass = this.#lastError(host.supervisorThreadId);
            const next = errorClass && FALLBACK_ERRORS.has(errorClass) ? host.supervisorFallbacks?.shift() : undefined;
            if (!next) {
                this.#pause(state, textOf(TEXT).supervisorTurnFailed(errorClass ?? 'unknown'));
                return;
            }
            this.#deps.threads.update(host.supervisorThreadId, { model: next.ref });
            host.supervisorFamily = next.family;
            this.#warn(state, (text) => text.supervisorModelSwitched(errorClass ?? 'unknown', next.ref.model));
            this.#wake(
                state,
                `The previous request failed (${errorClass}); you now run on ${next.ref.model}. Continue where you stopped.`,
            );
            this.#save(state);
            return;
        }
        if (host.status === 'planning' && event.outcome === 'completed') {
            if (state.board.list().length > 0) {
                if (host.awaitingUser) {
                    host.awaitingUser = false;
                    delete host.note;
                }
                void this.#planReady(state);
            } else if (!this.#plannedNothing(state)) {
                return;
            }
        }
        this.#save(state);
        this.#advance(state);
        this.#scheduleWake(state);
    }

    /**
     * The supervisor ended a planning turn without a task card. With a person in the loop it may be asking them
     * something, which the board says; without one it is told to plan, MAX_PLAN_NUDGES times, before the run pauses
     * instead of waiting for nobody. False when the run paused.
     */
    #plannedNothing(state: RunState): boolean {
        const { host } = state;
        if (needsHuman(state.run.autonomy, 'plan_approval')) {
            host.awaitingUser = true;
            host.note = textOf(TEXT).awaitingUser;
            return true;
        }
        host.planNudges = (host.planNudges ?? 0) + 1;
        if (host.planNudges > MAX_PLAN_NUDGES) {
            this.#pause(state, textOf(TEXT).noPlan);
            return false;
        }
        this.#wake(state, PLAN_NUDGE);
        return true;
    }

    /** The plan is ready: the user confirms it when the autonomy level asks for that (06 §8), then dispatch starts. */
    async #planReady(state: RunState): Promise<void> {
        const { host } = state;
        if (host.planApproved || state.approvingPlan || state.reviewingPlan || host.status !== 'planning') {
            return;
        }
        if (!host.planReviewed) {
            state.reviewingPlan = true;
            let revising = false;
            try {
                revising = await this.#reviewPlan(state);
            } finally {
                state.reviewingPlan = false;
            }
            // With findings the supervisor revises first; its turn's end brings the plan back here.
            if (revising || !this.#active(state) || (host.status as RunStatus) !== 'planning') {
                return;
            }
        }
        if (!needsHuman(state.run.autonomy, 'plan_approval')) {
            this.#approvePlan(state, textOf(TEXT).planAutoApproved);
            return;
        }
        state.approvingPlan = true;
        this.#setStatus(state, 'awaiting_plan_approval');
        try {
            const outcome = await this.#confirm(state, {
                toolName: 'team_plan',
                title: textOf(TEXT).planApproval,
                toolKind: 'other',
                summary: this.#planSummary(state),
                risks: ['write'],
            });
            // The status may have moved on while the card was open (stopped, paused).
            if (!this.#live(state) || (host.status as RunStatus) !== 'awaiting_plan_approval') {
                return;
            }
            if (outcome.status === 'allowed') {
                this.#approvePlan(state, textOf(TEXT).planApproved);
            } else if (outcome.status === 'denied') {
                this.#setStatus(state, 'planning');
                this.#wake(
                    state,
                    `The user did not approve the plan${outcome.message ? `: ${outcome.message}` : '.'} Revise the cards (task_update, task_create, or task_update with status "cancelled") and end your turn to submit the plan again.`,
                );
            } else {
                this.#pause(state, textOf(TEXT).planApprovalLapsed);
            }
        } finally {
            state.approvingPlan = false;
        }
    }

    /**
     * Separate plan review (06 §5 ④): before the plan is confirmed, the plan reviewer audits it once on a model of
     * another family than the supervisor's, and the supervisor gets the findings for one revision turn. Without a
     * plan reviewer, or without a connected model of another family on its tier, the run goes on with a warning.
     * Returns true when the findings went to the supervisor.
     */
    async #reviewPlan(state: RunState): Promise<boolean> {
        const { host } = state;
        const skip = (warning: (text: TeamText) => string): false => {
            host.planReviewed = true;
            this.#warn(state, warning);
            this.#save(state);
            return false;
        };
        const reviewer = agentsWithRole(host.org, 'plan_reviewer')[0];
        if (!reviewer) {
            return skip((text) => text.noPlanReviewer);
        }
        const family =
            host.supervisorFamily ?? inferFamily(this.#deps.threads.find(host.supervisorThreadId)?.model?.model ?? '');
        const crossFamily = reviewer.crossFamily !== false;
        const project = await this.#deps.projects.get(host.projectId);
        let pick: ModelPick;
        try {
            pick = this.#pickModel(
                host.org,
                state.run.autonomy,
                project,
                reviewer.tier,
                host.warnings,
                crossFamily ? (family ?? '') : undefined,
            );
        } catch (error) {
            return skip((text) => text.planReviewNoModel(errorText(error)));
        }
        if (crossFamily && pick.crossFamily !== true) {
            return skip((text) => text.planReviewNoFamily(family, reviewer.tier));
        }
        const thread = this.#createThread(state, {
            title: textOf(TEXT).planReviewTitle,
            role: reviewer.role,
            tier: reviewer.tier,
            agentId: reviewer.id,
            pick,
            mode: 'plan',
        });
        host.reviewThreads.push(thread.id);
        this.#deps.turns.setHostTools(thread.id, {
            tools: [],
            disabledTools: disabledBuiltins(reviewer),
            mcpTools: mcpToolsOf(reviewer),
            layers: systemLayers(host.org, reviewer),
            highRiskApproval: true,
            handle: async (name) => fail(`Tool ${name} is not available here.`),
        });
        const reviewing = textOf(TEXT).planReviewing;
        host.note = reviewing;
        this.#save(state);
        const cards = state.board
            .list()
            .filter((task) => task.status !== 'cancelled')
            .map((task) => task.card);
        const ended = await this.#turn(thread.id, planReviewPrompt(state.run.goal, state.ledger?.current, cards));
        // Unless a pause or a stop replaced it meanwhile. Compared with the note as written: the language may have
        // changed since.
        if (host.note === reviewing) {
            host.note = undefined;
        }
        if (!this.#live(state)) {
            return false;
        }
        if (ended.outcome !== 'completed') {
            return skip((text) => text.planReviewUnfinished(ended.outcome));
        }
        host.planReviewed = true;
        // A paused run keeps the findings in the inbox for when it continues.
        this.#wake(state, planReviewFeedback(parseReview(ended.lastText), ended.lastText, pick.ref.model));
        this.#save(state);
        return true;
    }

    #approvePlan(state: RunState, decision: string): void {
        state.host.planApproved = true;
        state.ledger?.append('decisions', [decision], 'plan approved', 'host');
        this.#setStatus(state, 'running');
        this.#advance(state);
    }

    #planSummary(state: RunState): string {
        const text = textOf(TEXT);
        const lines = [text.planGoal(shorten(state.run.goal, 200))];
        for (const task of state.board.list()) {
            lines.push(text.planTask(task.card, task.tier, describeChecks(task.card)));
        }
        if (state.run.budget) {
            lines.push(text.planBudget(state.run.budget.limit, state.run.budget.currency));
        }
        return lines.join('\n');
    }

    // Approvals ------------------------------------------------------------------------------------------

    /** An earlier "always allow" for this kind of card (policy may settle anything but high-risk actions, 06 §8). */
    #ruleAllows(projectId: string, toolName: string): boolean {
        const rules = this.#deps.approvals
            .rules()
            .filter(
                (rule) =>
                    rule.tool === toolName &&
                    rule.pattern === '*' &&
                    (rule.scope === 'global' || rule.projectId === projectId),
            );
        return rules.some((rule) => rule.decision === 'allow') && !rules.some((rule) => rule.decision !== 'allow');
    }

    /**
     * An approval card in the supervisor thread (no new UI: the same cards as tool calls). A card cancelled with a
     * supervisor turn is asked again while the run is live.
     */
    async #confirm(state: RunState, request: ConfirmRequest): Promise<ApprovalOutcome> {
        const { approvals, threads, turns } = this.#deps;
        const { host } = state;
        if (!request.command && this.#ruleAllows(host.projectId, request.toolName)) {
            return { status: 'allowed' };
        }
        for (;;) {
            if (!this.#live(state) || state.abort.signal.aborted) {
                return { status: 'cancelled' };
            }
            const threadId = host.supervisorThreadId;
            const turnId = host.supervisorTurnId ?? 'team';
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
                ...(request.highRisk ? { highRisk: request.highRisk } : {}),
            };
            let item: ItemOf<'approval'> | undefined;
            const outcome = await approvals.request(
                {
                    threadId,
                    turnId,
                    projectId: host.projectId,
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
                    if (!turns.isRunning(threadId)) {
                        threads.update(threadId, { status: 'awaiting_approval' });
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
                if (
                    !turns.isRunning(threadId) &&
                    approvals.pendingFor(threadId) === 0 &&
                    threads.get(threadId).status === 'awaiting_approval'
                ) {
                    threads.update(threadId, { status: 'idle' });
                }
            }
            if (outcome.status !== 'cancelled' || this.#disposed || state.abort.signal.aborted) {
                return outcome;
            }
        }
    }

    // Supervisor tools -----------------------------------------------------------------------------------

    async #supervisorTool(runId: string, name: string, input: unknown): Promise<HostToolResult> {
        const state = await this.#load(runId);
        if (!state || this.#disposed) {
            return fail('This team run is not available.');
        }
        if (!this.#live(state)) {
            return fail(`The run is ${state.host.status}; the board cannot change any more.`);
        }
        switch (name) {
            case 'task_create':
                return this.#taskCreate(state, input);
            case 'task_assign':
                return this.#taskAssign(state, input);
            case 'task_update':
                return this.#taskUpdate(state, input);
            case 'task_list':
                return this.#taskList(state, input);
            case 'send_message':
                return this.#sendMessage(state, input);
            case 'ledger_update':
                return this.#ledgerUpdate(state, input);
            case 'request_review':
                return this.#requestReview(state, input);
            default:
                return fail(`Unknown team tool ${name}.`);
        }
    }

    #taskCreate(state: RunState, input: unknown): HostToolResult {
        if (state.host.status === 'integrating') {
            return fail('The run is integrating its results; new tasks belong in a new run.');
        }
        const raw = isRecord(input)
            ? Array.isArray(input.tasks)
                ? input.tasks
                : isRecord(input.task)
                  ? [input.task]
                  : 'id' in input
                    ? [input]
                    : undefined
            : undefined;
        if (!raw || raw.length === 0) {
            return fail('task_create needs {"tasks": [<task card>, ...]}.');
        }
        for (const entry of raw) {
            const checked = checkCard(entry);
            if (!checked.ok) {
                return fail(boardError(checked.error));
            }
            const problem = cardProblem(state.host.org, checked.value);
            if (problem) {
                return fail(problem);
            }
        }
        const added = state.board.addMany(raw);
        if (!added.ok) {
            return fail(boardError(added.error));
        }
        this.#syncLedger(state, 'tasks created');
        this.#save(state);
        this.#advance(state);
        const unknown = added.value
            .map((task) => task.card.assignee)
            .filter((assignee): assignee is string => assignee !== undefined && !findAgent(state.host.org, assignee));
        const when = state.host.planApproved
            ? 'They are dispatched as soon as their dependencies are done.'
            : 'They are dispatched once the plan is approved.';
        return ok(
            `Created ${added.value.map((task) => `${task.card.id} (${task.status})`).join(', ')}. ${when}` +
                (unknown.length > 0 ? ` Unknown assignees (${unknown.join(', ')}): the host picks by category.` : ''),
        );
    }

    #taskAssign(state: RunState, input: unknown): HostToolResult {
        const parsed = TaskAssignInput.safeParse(input);
        if (!parsed.success) {
            return fail(`Invalid arguments: ${formatIssues(parsed.error.issues).join('; ')}`);
        }
        const { taskId, assignee, tier, tierReason } = parsed.data;
        const { board, host } = state;
        const task = board.get(taskId);
        if (!task) {
            return fail(`There is no task ${taskId}.`);
        }
        if (assignee) {
            const agent = findAgent(host.org, assignee);
            if (!agent || agent.role === 'supervisor') {
                const members = host.org.roster.filter((member) => member.role !== 'supervisor').map((m) => m.id);
                return fail(`Unknown member ${assignee}; members: ${members.join(', ')}.`);
            }
        }
        if (['assigned', 'in_progress', 'in_review'].includes(task.status)) {
            return fail(`Task ${taskId} is ${task.status}; wait for its delivery.`);
        }
        if (task.status === 'done' || task.status === 'cancelled') {
            return fail(`Task ${taskId} is ${task.status}.`);
        }
        // A blocked task is taken from its executor; it starts over on a new thread.
        if (task.status === 'blocked') {
            const failed = board.fail(taskId, 'reassigned by the supervisor');
            if (!failed.ok) return fail(boardError(failed.error));
        }
        // After attempts the tier only moves up, through the board's escalation from failed back to ready; a task
        // the supervisor holds goes to a specialist at flagship anyway.
        const raise =
            tier !== undefined &&
            task.attempts.length > 0 &&
            tierRank(tier) > tierRank(task.tier) &&
            board.get(taskId)?.status === 'failed';
        if (raise) {
            const escalated = board.escalate(taskId, tier, tierReason ?? 'raised by the supervisor');
            if (!escalated.ok) return fail(boardError(escalated.error));
        }
        const patch = {
            ...(assignee ? { assignee } : {}),
            ...(tier && task.attempts.length === 0 ? { tier } : {}),
            ...(tierReason ? { tierReason } : {}),
        };
        if (Object.keys(patch).length > 0) {
            const problem = cardProblem(state.host.org, { ...(board.get(taskId) as BoardTask).card, ...patch });
            if (problem) return fail(problem);
            const updated = board.update(taskId, patch);
            if (!updated.ok) return fail(boardError(updated.error));
        }
        if ((board.get(taskId) as BoardTask).status === 'failed') {
            const retried = board.retry(taskId, 'reassigned by the supervisor');
            if (!retried.ok) return fail(boardError(retried.error));
        }
        const info = this.#taskHost(state, taskId);
        info.released = true;
        info.threadId = undefined;
        this.#save(state);
        this.#advance(state);
        const after = board.get(taskId) as BoardTask;
        return ok(
            `Task ${taskId}: ${after.status}, tier ${after.tier}${after.card.assignee ? `, assignee ${after.card.assignee}` : ''}.`,
        );
    }

    #taskUpdate(state: RunState, input: unknown): HostToolResult {
        const parsed = TaskUpdateInput.safeParse(input);
        if (!parsed.success) {
            return fail(`Invalid arguments: ${formatIssues(parsed.error.issues).join('; ')}`);
        }
        const { taskId, changes, status, reason } = parsed.data;
        const { board, host } = state;
        const task = board.get(taskId);
        if (!task) {
            return fail(`There is no task ${taskId}.`);
        }
        if (changes && Object.keys(changes).length > 0) {
            const checked = checkCard({ ...task.card, ...changes, id: task.card.id });
            if (!checked.ok) return fail(boardError(checked.error));
            const problem = cardProblem(state.host.org, checked.value);
            if (problem) return fail(problem);
            const updated = board.update(taskId, changes);
            if (!updated.ok) return fail(boardError(updated.error));
            this.#syncLedger(state, `task ${taskId} updated`);
        }
        if (status === 'cancelled') {
            const threadId = host.tasks[taskId]?.threadId;
            const cancelled = board.cancel(taskId, reason ?? 'cancelled by the supervisor');
            if (!cancelled.ok) return fail(boardError(cancelled.error));
            if (threadId) this.#deps.turns.cancel(threadId);
        } else if (status === 'ready') {
            const current = board.get(taskId) as BoardTask;
            if (current.status === 'failed') {
                const retried = board.retry(taskId, reason ?? 'retried by the supervisor');
                if (!retried.ok) return fail(boardError(retried.error));
                this.#taskHost(state, taskId).threadId = undefined;
            } else if (current.status === 'blocked') {
                const info = host.tasks[taskId];
                const unblocked = board.unblock(taskId, reason ?? 'unblocked by the supervisor');
                if (!unblocked.ok) return fail(boardError(unblocked.error));
                if (unblocked.value.status === 'in_progress' && info?.threadId) {
                    info.pending = reason ? `The supervisor says: ${reason}\nContinue the task.` : 'Continue the task.';
                    void this.#work(state, taskId, 'continue');
                } else if (unblocked.value.status === 'in_progress' && unblocked.value.owner) {
                    board.release(taskId, unblocked.value.owner, 'no executor thread; dispatched again');
                }
            } else {
                return fail(`Task ${taskId} is ${current.status}; only failed or blocked tasks can be set to ready.`);
            }
        }
        this.#save(state);
        this.#advance(state);
        const after = board.get(taskId) as BoardTask;
        return ok(`Task ${taskId}: ${after.status}.`);
    }

    #taskList(state: RunState, input: unknown): HostToolResult {
        const parsed = TaskListInput.safeParse(input ?? {});
        const filter = parsed.success && parsed.data.status ? { status: parsed.data.status } : {};
        const tasks = state.board.list(filter).map((task) => {
            const info = state.host.tasks[task.card.id];
            return {
                id: task.card.id,
                title: task.card.title,
                status: task.status,
                tier: task.tier,
                ...(task.owner ? { owner: task.owner } : {}),
                ...(task.handler === 'supervisor' ? { heldBy: 'supervisor' } : {}),
                dependsOn: task.card.dependsOn,
                ...(state.board.waitingOn(task.card.id).length > 0
                    ? { waitingOn: state.board.waitingOn(task.card.id) }
                    : {}),
                attempts: task.attempts.map((attempt) => `${attempt.outcome}@${attempt.tier}`),
                ...(task.deliverable
                    ? { deliverable: { status: task.deliverable.status, summary: task.deliverable.summary } }
                    : {}),
                ...(info?.verdict && info.verdict.verdict !== 'pass' ? { verdict: info.verdict } : {}),
                ...(task.note ? { note: task.note } : {}),
            };
        });
        return ok(JSON.stringify({ status: state.host.status, tasks }, null, 2));
    }

    #sendMessage(state: RunState, input: unknown): HostToolResult {
        const parsed = SendMessageInput.safeParse(input);
        if (!parsed.success) {
            return fail(`Invalid arguments: ${formatIssues(parsed.error.issues).join('; ')}`);
        }
        const { to, text } = parsed.data;
        const taskId = state.board.get(to)
            ? to
            : (Object.entries(state.host.tasks).find(([, info]) => info.agentId === to)?.[0] ??
              state.board.list({ status: ['assigned', 'in_progress', 'in_review', 'blocked'] }).find((task) => {
                  const agent = task.owner ? findAgent(state.host.org, task.owner) : undefined;
                  return agent?.id === to;
              })?.card.id);
        const task = taskId ? state.board.get(taskId) : undefined;
        if (!taskId || !task) {
            return fail(`Nobody is working on "${to}"; use a task id.`);
        }
        const question = state.questions.get(taskId);
        if (question) {
            state.questions.delete(taskId);
            question.answer(`The supervisor answers: ${text}`);
            this.#record(state, { from: 'supervisor', to: taskId, text, kind: 'answer' });
            return ok(`Answered the question of ${taskId}.`);
        }
        if (task.status === 'done' || task.status === 'cancelled' || task.status === 'failed') {
            return fail(`Task ${taskId} is ${task.status}; nobody reads messages for it. Create or update a task.`);
        }
        const info = this.#taskHost(state, taskId);
        info.messages = [...(info.messages ?? []), `From the supervisor: ${text}`];
        this.#record(state, { from: 'supervisor', to: taskId, text, kind: 'message' });
        this.#save(state);
        return ok(`Queued for ${taskId}: the member reads it at its next turn.`);
    }

    /** One line of the team conversation (06 §7); the oldest go once there are too many. */
    #record(state: RunState, entry: Omit<ConversationEntry, 'ts'>): void {
        const list = state.host.conversation ?? [];
        list.push({ ts: Date.now(), ...entry });
        state.host.conversation = list.slice(-CONVERSATION_LIMIT);
        this.#changed(state);
    }

    /** A member challenges another investigation card (competing hypotheses, 06 §7). */
    #challenge(state: RunState, from: string, input: unknown): HostToolResult {
        if (state.host.mode !== 'hypotheses') {
            return fail('challenge is only for competing-hypotheses runs.');
        }
        const parsed = ChallengeInput.safeParse(input);
        if (!parsed.success) {
            return fail(`Invalid arguments: ${formatIssues(parsed.error.issues).join('; ')}`);
        }
        const { to, text } = parsed.data;
        const target = state.board.get(to);
        if (!target || to === from) {
            return fail(`No other card ${to}; challenge another investigation card by its task id.`);
        }
        if (target.status === 'done' || target.status === 'cancelled' || target.status === 'failed') {
            return fail(`${to} is ${target.status}; raise it with the supervisor through ask_supervisor instead.`);
        }
        const info = this.#taskHost(state, from);
        if ((info.challenges ?? 0) >= MAX_CHALLENGES) {
            return fail(`You sent ${MAX_CHALLENGES} challenges already; put the rest into your deliverable.`);
        }
        info.challenges = (info.challenges ?? 0) + 1;
        const other = this.#taskHost(state, to);
        other.messages = [
            ...(other.messages ?? []),
            `Challenge from ${from}: ${text}\nAnswer it in your deliverable (concede, or show why your evidence holds).`,
        ];
        state.host.inbox.push(`${from} challenged ${to}: ${shorten(text, 300)}`);
        this.#record(state, { from, to, text, kind: 'challenge' });
        this.#save(state);
        return ok(`Sent to ${to}; its member reads it at its next turn. Carry on with your own investigation.`);
    }

    /**
     * The user writes to the supervisor or to a member while the run goes on (06 §7). The supervisor is woken; a
     * member reads it at its next turn, and the supervisor hears of it. A message directs; it never approves.
     */
    async message(runId: string, to: string, text: string): Promise<TeamRunView> {
        await this.#ready;
        const state = await this.#require(runId);
        const words = textOf(TEXT);
        if (TERMINAL.has(state.host.status)) {
            throw new RpcError(RpcErrorCode.Rejected, words.runEnded);
        }
        if (to === 'supervisor') {
            this.#record(state, { from: 'user', to, text, kind: 'user' });
            this.#wake(state, `Message from the user: ${text}`);
            this.#save(state);
            return this.#view(state);
        }
        const task = state.board.get(to);
        if (!task) {
            throw new RpcError(RpcErrorCode.NotFound, words.noTask(to));
        }
        if (task.status === 'done' || task.status === 'cancelled' || task.status === 'failed') {
            throw new RpcError(RpcErrorCode.Rejected, words.taskEnded(to));
        }
        this.#record(state, { from: 'user', to, text, kind: 'user' });
        const question = state.questions.get(to);
        if (question) {
            state.questions.delete(to);
            question.answer(`The user answers: ${text}`);
        } else {
            const info = this.#taskHost(state, to);
            info.messages = [...(info.messages ?? []), `From the user: ${text}`];
        }
        state.host.inbox.push(`The user wrote to ${to}: ${shorten(text, 300)}`);
        this.#save(state);
        return this.#view(state);
    }

    #syncLedger(state: RunState, reason: string): void {
        const tasks = taskGraph(state.board.list());
        if (state.ledger) {
            state.ledger.revise({ tasks }, reason, 'host');
        } else {
            state.ledger = new TaskLedger({ goal: state.run.goal, tasks }, { reason, author: 'host' });
        }
    }

    #ledgerUpdate(state: RunState, input: unknown): HostToolResult {
        const parsed = LedgerUpdateInput.safeParse(input);
        if (!parsed.success) {
            return fail(`Invalid arguments: ${formatIssues(parsed.error.issues).join('; ')}`);
        }
        const { reason, replace, progress, ...fields } = parsed.data;
        const lists = ['facts', 'assumptions', 'decisions', 'risks'] as const;
        const current = state.ledger?.current;
        const changes: Partial<TaskLedgerContent> = {
            ...(fields.goal ? { goal: fields.goal } : {}),
            ...(fields.plan !== undefined ? { plan: fields.plan } : {}),
            tasks: taskGraph(state.board.list()),
        };
        const merged: Partial<Record<(typeof lists)[number], string[]>> = {};
        for (const list of lists) {
            const items = fields[list];
            if (items) {
                merged[list] = replace ? items : [...new Set([...(current?.[list] ?? []), ...items])];
            }
        }
        if (state.ledger) {
            state.ledger.revise({ ...changes, ...merged }, reason, 'supervisor');
        } else {
            state.ledger = new TaskLedger(
                { goal: state.run.goal, ...changes, ...merged },
                { reason, author: 'supervisor' },
            );
        }
        if (progress) {
            state.progress.record({
                complete: progress.complete ?? false,
                progressing: progress.progressing,
                looping: progress.looping ?? false,
                ...(progress.nextAssignee ? { nextAssignee: progress.nextAssignee } : {}),
                ...(progress.instruction ? { instruction: progress.instruction } : {}),
                reason: progress.reason,
            });
        }
        this.#save(state);
        return ok(`Task ledger is at version ${state.ledger?.version ?? 0}.`);
    }

    #requestReview(state: RunState, input: unknown): HostToolResult {
        const parsed = RequestReviewInput.safeParse(input);
        if (!parsed.success) {
            return fail(`Invalid arguments: ${formatIssues(parsed.error.issues).join('; ')}`);
        }
        const { taskId, focus } = parsed.data;
        const task = state.board.get(taskId);
        if (!task?.deliverable) {
            return fail(`Task ${taskId} has no deliverable to review yet.`);
        }
        void (async () => {
            const changed = await this.#changedFiles(state, taskId);
            const review = await this.#review(state, taskId, 'reviewer', [], changed, focus);
            if (!this.#live(state)) return;
            const issues = review?.issues.map((issue) => issue.problem).join('; ');
            this.#wake(
                state,
                review
                    ? `Review of ${taskId} you asked for: ${review.verdict}${review.summary ? ` — ${review.summary}` : ''}${issues ? ` Issues: ${issues}` : ''}`
                    : `The review of ${taskId} you asked for gave no readable verdict.`,
            );
        })().catch((error) => this.#deps.log.warn(`team: review of ${taskId}: ${errorText(error)}`));
        return ok(`Review of ${taskId} started; the verdict arrives in a team update.`);
    }

    // Member tools ---------------------------------------------------------------------------------------

    async #memberTool(
        runId: string,
        taskId: string,
        name: string,
        input: unknown,
        signal: AbortSignal,
    ): Promise<HostToolResult> {
        const state = await this.#load(runId);
        const task = state?.board.get(taskId);
        if (!state || !task || this.#disposed) {
            return fail('This team task is not available.');
        }
        const info = this.#taskHost(state, taskId);
        switch (name) {
            case 'deliver': {
                const parsed = parseDeliverable(JSON.stringify(input ?? {}), { taskId });
                if (!parsed.ok) {
                    const issues = parsed.error.issues.length > 0 ? `\n- ${parsed.error.issues.join('\n- ')}` : '';
                    return fail(`${parsed.error.message}${issues}`);
                }
                info.delivered = parsed.deliverable;
                this.#save(state);
                return ok(
                    `Deliverable for ${taskId} recorded (${parsed.deliverable.status}). End your turn now: the host runs the acceptance checks.`,
                );
            }
            case 'escalate': {
                const parsed = EscalateInput.safeParse(input);
                if (!parsed.success) {
                    return fail(`Invalid arguments: ${formatIssues(parsed.error.issues).join('; ')}`);
                }
                const to = parsed.data.to ?? nextTier(task.tier) ?? 'flagship';
                const deliverable = DeliverableSchema.safeParse({
                    taskId,
                    status: 'escalate',
                    summary: parsed.data.reason,
                    escalate: { to, reason: parsed.data.reason, findings: parsed.data.findings ?? [] },
                });
                if (!deliverable.success) {
                    return fail(`Invalid escalation: ${formatIssues(deliverable.error.issues).join('; ')}`);
                }
                info.delivered = deliverable.data;
                this.#save(state);
                return ok(`Escalation of ${taskId} to ${to} recorded. End your turn now.`);
            }
            case 'ask_supervisor': {
                const parsed = AskInput.safeParse(input);
                if (!parsed.success) {
                    return fail(`Invalid arguments: ${formatIssues(parsed.error.issues).join('; ')}`);
                }
                return this.#ask(state, taskId, parsed.data.question, signal);
            }
            case 'challenge':
                return this.#challenge(state, taskId, input);
            default:
                return fail(`Unknown team tool ${name}.`);
        }
    }

    /** Waits for the supervisor's answer: `send_message`, else its next reply (agent messages are information). */
    #ask(state: RunState, taskId: string, question: string, signal: AbortSignal): Promise<HostToolResult> {
        if (!this.#active(state)) {
            return Promise.resolve(fail('The run is paused; decide from the card or deliver blocked.'));
        }
        const owner = state.host.tasks[taskId]?.agentId ?? taskId;
        return new Promise((resolve) => {
            let settled = false;
            const settle = (result: HostToolResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (state.questions.get(taskId) === entry) state.questions.delete(taskId);
                resolve(result);
            };
            const entry: Question = { delivered: false, answer: (text) => settle(ok(text)) };
            const timer = setTimeout(
                () => settle(ok('The supervisor did not answer in time. Decide from the card, or deliver blocked.')),
                QUESTION_TIMEOUT_MS,
            );
            signal.addEventListener('abort', () => settle(fail('The question was cancelled.')), { once: true });
            state.questions.get(taskId)?.answer('Superseded by a newer question.');
            state.questions.set(taskId, entry);
            this.#record(state, { from: taskId, to: 'supervisor', text: question, kind: 'question' });
            this.#wake(
                state,
                `Question from ${owner} on ${taskId}: ${question}\nAnswer with send_message to ${taskId}.`,
            );
        });
    }

    // Dispatch -------------------------------------------------------------------------------------------

    #taskHost(state: RunState, taskId: string): TaskHost {
        let info = state.host.tasks[taskId];
        if (!info) {
            info = { threads: [] };
            state.host.tasks[taskId] = info;
        }
        return info;
    }

    /** Re-evaluates the run: dispatch ready tasks, integrate when everything is done, flag a run that is stuck. */
    #advance(state: RunState): void {
        const { host, board } = state;
        if (!this.#active(state) || host.status !== 'running') {
            return;
        }
        if (this.#pressure(state).state === 'exhausted') {
            this.#pause(state, this.#budgetNote(state));
            return;
        }
        this.#dispatch(state);
        const quiet =
            state.working.size === 0 &&
            !state.supervisorStarting &&
            !this.#deps.turns.isRunning(host.supervisorThreadId) &&
            host.inbox.length === 0 &&
            state.wakeTimer === undefined;
        if (!quiet) {
            return;
        }
        const tasks = board.list();
        if (tasks.length > 0 && board.isComplete()) {
            void this.#integrate(state);
            return;
        }
        if (board.active().length === 0 && tasks.length > 0 && !host.stuck) {
            const text = textOf(TEXT);
            const blockers = tasks
                .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
                .map((task) => text.blocker(task.card.id, task.handler === 'supervisor', task.status));
            // The flag marks the note as the stuck note: #dispatch clears both.
            host.stuck = true;
            host.note = text.stuck(blockers);
            this.#save(state);
            this.#notice(state, 'warning', text.stuckTitle, host.note);
        }
    }

    /** Claims ready tasks up to the parallel limit synchronously, then starts each one's executor. */
    #dispatch(state: RunState): void {
        const { board, host } = state;
        const running = board.list({ status: ['assigned', 'in_progress'] }).length;
        let free = this.#maxParallel() - running;
        if (free <= 0) {
            return;
        }
        const pressure = this.#pressure(state);
        let dispatched = false;
        for (const candidate of board.dispatchable()) {
            if (free <= 0) {
                break;
            }
            const taskId = candidate.card.id;
            if (candidate.handler === 'supervisor' && !host.tasks[taskId]?.released) {
                continue;
            }
            // A tight budget runs non-critical work one tier lower (06 §3 rule 5).
            const lower =
                candidate.attempts.length === 0
                    ? tierUnderPressure(candidate.tier, candidate.card, pressure)
                    : candidate.tier;
            if (lower !== candidate.tier && board.update(taskId, { tier: lower }).ok) {
                const percent = Math.round(pressure.ratio * 100);
                this.#warn(state, (text) => text.tierLowered(taskId, lower, percent));
            }
            const task = board.get(taskId) as BoardTask;
            const agent = agentFor(state.host.org, task);
            const owner = `${agent.id}-${taskId}`;
            if (!board.claim(taskId, owner).ok || !board.start(taskId, owner).ok) {
                continue;
            }
            free -= 1;
            dispatched = true;
            // A running run that is stuck shows the stuck note (#advance); it goes with the flag.
            if (host.stuck) {
                host.stuck = false;
                host.note = undefined;
            }
            void this.#work(state, taskId, 'dispatch', agent);
        }
        if (dispatched) {
            this.#save(state);
        }
    }

    /** Creates the executor thread (and worktree) of a freshly claimed task; returns its first prompt. */
    async #prepare(state: RunState, taskId: string, agent: AgentSpec): Promise<string> {
        const { projects, worktrees, turns } = this.#deps;
        const { board, host } = state;
        const task = board.get(taskId) as BoardTask;
        const card = task.card;
        const project = await projects.get(host.projectId);
        const info = this.#taskHost(state, taskId);
        // A new dispatch starts clean: the worktree of an earlier, abandoned attempt is removed.
        await this.#dropWorktree(state, taskId, project);
        const pick = this.#pickModel(host.org, state.run.autonomy, project, task.tier, host.warnings);
        const writable = card.workspace !== 'readonly';
        let location: 'worktree' | 'local' = 'local';
        if (card.workspace === 'worktree') {
            if (project.git.isRepo) {
                location = 'worktree';
            } else {
                this.#warn(state, (text) => text.notGitRepo(taskId));
            }
        }
        const owner = task.owner ?? `${agent.id}-${taskId}`;
        const mode: PermissionMode = !writable ? 'plan' : agent.mode === 'plan' ? 'auto_edit' : agent.mode;
        const thread = this.#createThread(state, {
            title: `${taskId}·${shorten(card.title, 30)}`,
            role: agent.role,
            tier: task.tier,
            agentId: owner,
            taskId,
            pick,
            mode,
        });
        const handoff = [...(info.handoff ?? [])];
        let cwd = project.path;
        if (location === 'worktree') {
            try {
                const created = await worktrees.create(project, thread.id, host.base);
                cwd = created.path;
                this.#deps.threads.update(thread.id, {
                    location: { kind: 'worktree', path: created.path, worktreeId: thread.id },
                });
                void worktrees.runSetup(project, created.path, created.port).catch(() => undefined);
                info.worktree = created.path;
                info.worktreeId = thread.id;
            } catch (error) {
                this.#deps.threads.delete(thread.id);
                throw error;
            }
            const sources = this.#dependencyWorktrees(state, taskId);
            if (sources.length > 0) {
                const seeded = await worktrees.seed(cwd, sources);
                for (const failure of seeded.failed) {
                    handoff.push(
                        `The results of ${failure.label} could not be copied into your worktree (${failure.reason}); ask the supervisor if you need them.`,
                    );
                    this.#warn(state, (text) => text.notSeeded(failure.label, taskId, shorten(failure.reason, 120)));
                }
            }
        } else {
            info.worktree = undefined;
            info.worktreeId = undefined;
        }
        info.threadId = thread.id;
        info.threads.push(thread.id);
        info.agentId = owner;
        info.specId = agent.id;
        info.tier = task.tier;
        info.model = pick.ref;
        info.family = pick.family;
        info.fallbacks = pick.fallbacks;
        info.location = location;
        info.changed = [];
        info.verdict = undefined;
        info.released = false;
        info.turns = 0;
        turns.setHostTools(thread.id, this.#memberProvider(state, taskId, agent));
        this.#save(state);
        const layers = buildAgentLayers({
            org: host.org,
            agent,
            card,
            ...(handoff.length > 0 ? { handoff } : {}),
        });
        const taskLayer = layers.find((layer) => layer.placement === 'user')?.text ?? renderTaskCard(card);
        return `${taskLayer}\n\n${executorNote(card, location, this.#turnLimit(state, taskId))}`;
    }

    /** L0 confirms every step (06 §8): each dispatch waits for the user; a refusal fails the task for the supervisor. */
    async #confirmDispatch(state: RunState, taskId: string, agent: AgentSpec): Promise<boolean> {
        if (!needsHuman(state.run.autonomy, 'every_step')) {
            return true;
        }
        const task = state.board.get(taskId) as BoardTask;
        const text = textOf(TEXT);
        const outcome = await this.#confirm(state, {
            toolName: 'team_dispatch',
            title: text.dispatchTitle(taskId, shorten(task.card.title, 30)),
            toolKind: 'other',
            summary: text.dispatchSummary(agent.name, task.tier, task.card.workspace, task.card.goal),
            risks: task.card.workspace === 'readonly' ? [] : ['write'],
        });
        if (outcome.status === 'allowed' || !this.#live(state)) {
            return outcome.status === 'allowed';
        }
        state.board.fail(taskId, textOf(TEXT).dispatchDeclined(outcome.message));
        this.#wake(
            state,
            `The user declined to dispatch ${taskId}${outcome.message ? `: ${outcome.message}` : ''}. Change or cancel it, or put it back with task_update status "ready".`,
        );
        this.#save(state);
        return false;
    }

    /** Worktrees of the finished tasks this one depends on, directly or not, dependencies first. */
    #dependencyWorktrees(state: RunState, taskId: string): Array<{ dir: string; label: string }> {
        const needed = new Set<string>();
        const visit = (id: string) => {
            for (const dependency of state.board.get(id)?.card.dependsOn ?? []) {
                if (!needed.has(dependency)) {
                    needed.add(dependency);
                    visit(dependency);
                }
            }
        };
        visit(taskId);
        return state.board.topologicalOrder().flatMap((id) => {
            const info = state.host.tasks[id];
            return needed.has(id) &&
                state.board.get(id)?.status === 'done' &&
                info?.worktree &&
                existsSync(info.worktree)
                ? [{ dir: info.worktree, label: id }]
                : [];
        });
    }

    async #dropWorktree(state: RunState, taskId: string, project: Project): Promise<void> {
        const info = state.host.tasks[taskId];
        if (!info?.worktree || !info.worktreeId || info.integrated) {
            return;
        }
        const { worktree, worktreeId } = info;
        info.worktree = undefined;
        info.worktreeId = undefined;
        await this.#deps.worktrees
            .remove(project, worktreeId, worktree, true)
            .catch((error) => this.#deps.log.warn(`team: could not remove ${worktree}: ${errorText(error)}`));
    }

    // The task loop --------------------------------------------------------------------------------------

    /**
     * One task from dispatch to acceptance: the executor's turn, its deliverable, acceptance, and retries with
     * feedback on the same thread. Escalations end the loop; the next dispatch starts a new one.
     */
    async #work(state: RunState, taskId: string, mode: 'dispatch' | 'continue' | 'review', agent?: AgentSpec) {
        if (state.working.has(taskId)) {
            return;
        }
        state.working.add(taskId);
        try {
            let prompt: string | undefined;
            if (mode === 'dispatch' && agent) {
                if (!(await this.#confirmDispatch(state, taskId, agent))) {
                    return;
                }
                prompt = await this.#prepare(state, taskId, agent);
            } else if (mode === 'continue') {
                prompt = state.host.tasks[taskId]?.pending ?? RESUME_PROMPT;
            }
            // The prompt is feedback on a failed acceptance, which is on the board as an attempt already.
            let retry = false;
            for (;;) {
                if (prompt !== undefined) {
                    if (!this.#active(state)) {
                        this.#taskHost(state, taskId).pending = prompt;
                        this.#save(state);
                        return;
                    }
                    if (this.#turnsLeft(state, taskId) <= 0) {
                        this.#outOfTurns(state, taskId, !retry);
                        return;
                    }
                    const ended = await this.#executorTurn(state, taskId, prompt);
                    if (!ended) {
                        return;
                    }
                    if (
                        ended.stopReason === 'max_turn_requests' &&
                        this.#turnsLeft(state, taskId) <= 0 &&
                        !this.#taskHost(state, taskId).delivered
                    ) {
                        this.#outOfTurns(state, taskId, true, ended.lastText);
                        return;
                    }
                    if (!(await this.#submit(state, taskId, ended))) {
                        return;
                    }
                    prompt = undefined;
                }
                if (!this.#active(state)) {
                    return;
                }
                prompt = await this.#accept(state, taskId);
                if (prompt === undefined) {
                    return;
                }
                retry = true;
            }
        } catch (error) {
            if (!this.#disposed) {
                this.#deps.log.warn(`team ${state.run.id}: task ${taskId}: ${errorText(error)}`);
                const task = state.board.get(taskId);
                if (task && task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'failed') {
                    state.board.fail(taskId, textOf(TEXT).hostError(errorText(error)));
                    this.#recordProgress(state, false, `${taskId} failed: ${errorText(error)}`, `fail:${taskId}`);
                    this.#wake(
                        state,
                        `${taskId} failed on the host side: ${errorText(error)}. Retry it with task_update status "ready", or change the plan.`,
                    );
                }
                this.#save(state);
            }
        } finally {
            state.working.delete(taskId);
            if (!this.#disposed) {
                this.#advance(state);
            }
        }
    }

    /** Runs one executor turn, falling back along the tier's chain on model errors. */
    async #executorTurn(state: RunState, taskId: string, prompt: string): Promise<TurnEnded | undefined> {
        const info = this.#taskHost(state, taskId);
        const threadId = info.threadId;
        if (!threadId) {
            throw new Error(`task ${taskId} has no executor thread`);
        }
        const queued = info.messages?.splice(0) ?? [];
        let text = queued.length > 0 ? `${prompt}\n\n<team_messages>\n${queued.join('\n')}\n</team_messages>` : prompt;
        info.delivered = undefined;
        info.pending = undefined;
        this.#save(state);
        for (;;) {
            const ended = await this.#turn(threadId, text);
            info.turns = (info.turns ?? 0) + ended.requests;
            this.#save(state);
            if (!this.#live(state) || state.board.get(taskId)?.status === 'cancelled') {
                return undefined;
            }
            if (ended.outcome === 'completed') {
                if (info.location !== 'worktree') {
                    info.changed = [...new Set([...(info.changed ?? []), ...ended.changedFiles])];
                }
                return ended;
            }
            if (ended.outcome === 'cancelled') {
                state.board.block(taskId, textOf(TEXT).executorCancelled);
                this.#recordProgress(state, false, `${taskId}: the executor's turn was cancelled`, `cancel:${taskId}`);
                this.#wake(
                    state,
                    `The executor turn of ${taskId} was cancelled; the task is blocked. Set it back with task_update status "ready" when it should continue.`,
                );
                this.#save(state);
                return undefined;
            }
            const errorClass = this.#lastError(threadId);
            const next =
                errorClass && FALLBACK_ERRORS.has(errorClass) && this.#turnsLeft(state, taskId) > 0
                    ? info.fallbacks?.shift()
                    : undefined;
            if (!next) {
                state.board.block(taskId, textOf(TEXT).executorFailed(errorClass ?? 'unknown'));
                this.#recordProgress(
                    state,
                    false,
                    `${taskId}: the executor's turn failed (${errorClass})`,
                    `error:${taskId}`,
                );
                this.#wake(
                    state,
                    `The executor turn of ${taskId} failed (${errorClass ?? 'unknown error'}); the task is blocked. Set it back with task_update status "ready" to try again.`,
                );
                this.#save(state);
                return undefined;
            }
            this.#deps.threads.update(threadId, { model: next.ref });
            info.model = next.ref;
            info.family = next.family;
            this.#warn(state, (text) => text.taskModelSwitched(taskId, errorClass ?? 'unknown', next.ref.model));
            this.#save(state);
            text = `The previous model request failed (${errorClass}); you now run on ${next.ref.model}. Continue the task from where it stopped and deliver.`;
        }
    }

    /** The card's turn budget (06 §6): `budget.maxTurns`, else {@link DEFAULT_MAX_TURNS}. */
    #turnLimit(state: RunState, taskId: string): number {
        return state.board.get(taskId)?.card.budget.maxTurns ?? DEFAULT_MAX_TURNS;
    }

    #turnsLeft(state: RunState, taskId: string): number {
        return this.#turnLimit(state, taskId) - (state.host.tasks[taskId]?.turns ?? 0);
    }

    /**
     * The executor used up the card's turn budget (06 §6): the attempt counts as failed and, with no turns left at
     * this tier, goes straight on the escalation path: one tier up with what it wrote, the supervisor after
     * flagship, then the user (06 §9). `record` is false when the failed attempt is already on the board (a retry
     * that has no turns left).
     */
    #outOfTurns(state: RunState, taskId: string, record: boolean, lastText = ''): void {
        const { board } = state;
        const info = this.#taskHost(state, taskId);
        const why = `used up its turn budget (${info.turns ?? 0} of ${this.#turnLimit(state, taskId)} model requests)`;
        const task = board.get(taskId);
        if (!task) {
            return;
        }
        if (record && task.owner && (task.status === 'assigned' || task.status === 'in_progress')) {
            const progress = shorten(lastText, 600);
            board.submit(
                taskId,
                task.owner,
                DeliverableSchema.parse({
                    taskId,
                    status: 'partial',
                    summary: `The executor ${why} before delivering.`,
                    ...(progress ? { evidence: [{ type: 'note', text: `Its last message: ${progress}` }] } : {}),
                }),
            );
            if (board.get(taskId)?.status === 'in_review') {
                board.reject(taskId, why);
            }
        }
        info.verdict = { verdict: 'fail', reasons: [why], outOfOwnership: [] };
        this.#recordProgress(state, false, `${taskId} ${why}`, `turns:${taskId}`);
        const decision = shouldEscalate(board.get(taskId)?.attempts ?? [], 1);
        if (decision.action === 'escalate' || decision.action === 'supervisor' || decision.action === 'human') {
            this.#escalate(state, taskId, decision, { reason: why });
            return;
        }
        // No failed attempt to go on (the board changed meanwhile): leave it to the supervisor.
        board.fail(taskId, why);
        this.#wake(state, `${taskId} ${why}. Retry it with task_update status "ready", or change the plan.`);
        this.#save(state);
    }

    /** Takes the turn's deliverable (deliver tool, else the final message, else a reviewer's repair) to review. */
    async #submit(state: RunState, taskId: string, ended: TurnEnded): Promise<boolean> {
        const info = this.#taskHost(state, taskId);
        let deliverable = info.delivered;
        info.delivered = undefined;
        if (!deliverable) {
            const parsed = parseDeliverable(ended.lastText, { taskId });
            deliverable = parsed.ok
                ? parsed.deliverable
                : await this.#repairDeliverable(state, taskId, ended.lastText, parsed.error);
        }
        if (!this.#live(state)) {
            return false;
        }
        deliverable ??= DeliverableSchema.parse({
            taskId,
            status: 'partial',
            summary:
                'No readable deliverable: the final message had no deliverable JSON and the deliver tool was not called.',
            evidence: [
                { type: 'note', text: 'Call the deliver tool with the deliverable, or end with the JSON block.' },
            ],
        });
        // The host's metering is authoritative (06 §6): the task's real spend replaces a self-reported one.
        const spent = this.#costs(state).byTask.get(taskId);
        const currency = this.#deps.settings.get().currency;
        if (spent !== undefined && (currency === 'CNY' || currency === 'USD')) {
            deliverable = { ...deliverable, usage: { cost: round(spent), currency } };
        }
        const task = state.board.get(taskId);
        const owner = task?.owner;
        if (!task || !owner) {
            return false;
        }
        const submitted = state.board.submit(taskId, owner, deliverable);
        if (!submitted.ok) {
            this.#deps.log.warn(`team: ${taskId} could not be submitted: ${submitted.error.message}`);
            return false;
        }
        this.#save(state);
        return true;
    }

    /** 06 §16: a reviewer turns an unreadable final message into a deliverable, adding nothing. */
    async #repairDeliverable(
        state: RunState,
        taskId: string,
        text: string,
        error: StructuredParseError,
    ): Promise<Deliverable | undefined> {
        const reviewer = agentsWithRole(state.host.org, 'reviewer')[0];
        if (!reviewer || !text.trim()) {
            return undefined;
        }
        const project = await this.#deps.projects.get(state.host.projectId);
        const pick = this.#pickModel(state.host.org, state.run.autonomy, project, reviewer.tier, state.host.warnings);
        const thread = this.#createThread(state, {
            title: textOf(TEXT).repairTitle(taskId),
            role: 'reviewer',
            tier: reviewer.tier,
            agentId: `${reviewer.id}-${taskId}`,
            taskId,
            pick,
            mode: 'plan',
        });
        state.host.reviewThreads.push(thread.id);
        this.#deps.turns.setHostTools(thread.id, {
            tools: [],
            disabledTools: disabledBuiltins(reviewer),
            mcpTools: mcpToolsOf(reviewer),
            layers: systemLayers(state.host.org, reviewer),
            highRiskApproval: true,
            handle: async (name) => fail(`Tool ${name} is not available here.`),
        });
        this.#save(state);
        const ended = await this.#turn(thread.id, renderDeliverableRepair({ taskId, text, error }));
        const parsed = parseDeliverable(ended.lastText, { taskId });
        return parsed.ok ? parsed.deliverable : undefined;
    }

    async #changedFiles(state: RunState, taskId: string): Promise<string[]> {
        const info = state.host.tasks[taskId];
        const card = state.board.get(taskId)?.card;
        if (card?.workspace === 'readonly') {
            return [];
        }
        if (info?.location === 'worktree' && info.worktree && existsSync(info.worktree)) {
            return this.#deps.worktrees.changedFiles(info.worktree);
        }
        return info?.changed ?? [];
    }

    #cwdOf(state: RunState, taskId: string, project: Project): string {
        const info = state.host.tasks[taskId];
        return info?.location === 'worktree' && info.worktree ? info.worktree : project.path;
    }

    /**
     * Runs an acceptance command through the permission policy as an `execute` action (10 §2): an "ask" becomes a
     * card in the supervisor thread, a denial means the command was not run.
     */
    async #runCommand(
        state: RunState,
        run: string,
        cwd: string,
        mode: PermissionMode,
        label: string,
    ): Promise<CommandResult | undefined> {
        const { approvals, log } = this.#deps;
        const { host } = state;
        // A card's command may push or publish too: that still needs the user, whatever the mode (06 §8).
        const highRisk = highRiskOf({ toolName: 'acceptance', command: run }, { cwd });
        const facts: CallFacts = {
            toolName: 'acceptance',
            kind: 'execute',
            readOnly: false,
            command: run,
            readOnlyCommand: isReadOnlyCommand(run),
            paths: [],
            outside: [],
            sensitive: [],
            external: false,
            ...(highRisk ? { highRisk } : {}),
        };
        const policy = approvals.evaluate(host.supervisorThreadId, facts, {
            mode,
            projectId: host.projectId,
            projectRoot: cwd,
        });
        if (policy.decision === 'deny') {
            log.info(`team ${state.run.id}: acceptance command denied (${policy.reason}): ${run}`);
            return undefined;
        }
        if (policy.decision === 'ask') {
            const text = textOf(TEXT);
            const outcome = await this.#confirm(state, {
                toolName: 'acceptance',
                title: highRisk ? text.runHighRisk(label, highRisk.action) : text.runAcceptance(label),
                toolKind: 'execute',
                summary: run,
                command: run,
                risks: policy.risks,
                ...(highRisk ? { highRisk } : {}),
            });
            if (outcome.status !== 'allowed') {
                return undefined;
            }
        }
        if (!this.#live(state) || state.abort.signal.aborted) {
            return undefined;
        }
        const started = Date.now();
        const result = await runCheck(
            run,
            cwd,
            AbortSignal.any([state.abort.signal, AbortSignal.timeout(this.#commandTimeoutMs)]),
        );
        return { run, exit: result.exitCode, output: tail(result.output), durationMs: Date.now() - started };
    }

    /**
     * Acceptance (06 §5 ⑧): commands first, then reviews and manual checks; pass, send back with feedback (the
     * returned prompt), escalate, hand to the supervisor or ask the user.
     */
    async #accept(state: RunState, taskId: string): Promise<string | undefined> {
        const { board, host } = state;
        const task = board.get(taskId);
        const deliverable = task?.deliverable;
        if (!task || !deliverable || task.status !== 'in_review') {
            return undefined;
        }
        const card = task.card;
        const info = this.#taskHost(state, taskId);
        if (deliverable.status === 'escalate') {
            this.#escalate(state, taskId, shouldEscalate(task.attempts), { deliverable });
            return undefined;
        }
        const project = await this.#deps.projects.get(host.projectId);
        const cwd = this.#cwdOf(state, taskId, project);
        const mode = (info.threadId ? this.#deps.threads.find(info.threadId)?.mode : undefined) ?? 'ask';
        const changedFiles = await this.#changedFiles(state, taskId);
        const commands: CommandResult[] = [];
        for (const { check } of planAcceptance(card)) {
            if (check.type !== 'command') {
                continue;
            }
            const result = await this.#runCommand(state, check.run, cwd, mode, textOf(TEXT).acceptanceLabel(taskId));
            if (!this.#live(state)) {
                return undefined;
            }
            if (result) {
                commands.push(result);
            }
        }
        // Reviews cost model time: they only run once the commands and the evidence hold up.
        const commandCard = { ...card, acceptance: card.acceptance.filter((check) => check.type === 'command') };
        let judgement: Judgement = judge(commandCard, deliverable, commands, [], { changedFiles });
        if (judgement.verdict !== 'fail') {
            const reviews: ReviewOutcome[] = [];
            for (const { check } of planAcceptance(card)) {
                if (check.type === 'review') {
                    const review = await this.#review(state, taskId, check.by, commands, changedFiles);
                    if (!this.#live(state)) {
                        return undefined;
                    }
                    if (review) {
                        reviews.push(review);
                    }
                }
            }
            const manual = card.acceptance.filter((check) => check.type === 'manual');
            let manualConfirmed = false;
            let manualRejected: string | undefined;
            if (manual.length > 0) {
                const outcome = await this.#confirm(state, {
                    toolName: 'team_manual_check',
                    title: textOf(TEXT).manualTitle(taskId, shorten(card.title, 30)),
                    toolKind: 'other',
                    summary: [
                        deliverable.summary,
                        ...manual.map((check) => (check.type === 'manual' ? `- ${check.note}` : '')),
                    ].join('\n'),
                    risks: [],
                });
                manualConfirmed = outcome.status === 'allowed';
                if (outcome.status === 'denied') {
                    manualRejected = `the user rejected the manual check${outcome.message ? `: ${outcome.message}` : ''}`;
                }
            }
            judgement = judge(card, deliverable, commands, reviews, { changedFiles, manualConfirmed });
            if (manualRejected) {
                judgement = { ...judgement, verdict: 'fail', reasons: [...judgement.reasons, manualRejected] };
            }
        }
        if (!this.#live(state)) {
            return undefined;
        }
        if (judgement.verdict === 'needs_human') {
            const text = textOf(TEXT);
            const outcome = await this.#confirm(state, {
                toolName: 'team_acceptance',
                title: text.acceptanceTitle(taskId, shorten(card.title, 30)),
                toolKind: 'other',
                summary: [
                    text.deliverable(deliverable.summary),
                    ...judgement.reasons.map((reason) => `- ${reason}`),
                ].join('\n'),
                risks: [],
            });
            if (!this.#live(state)) {
                return undefined;
            }
            judgement =
                outcome.status === 'allowed'
                    ? { ...judgement, verdict: 'pass', reasons: [] }
                    : {
                          ...judgement,
                          verdict: 'fail',
                          reasons: [
                              ...judgement.reasons,
                              outcome.message ? `the user declined: ${outcome.message}` : 'the user did not accept it',
                          ],
                      };
        }
        info.verdict = {
            verdict: judgement.verdict,
            reasons: [...judgement.reasons],
            outOfOwnership: [...judgement.outOfOwnership],
        };
        if (judgement.verdict === 'pass') {
            const accepted = board.accept(
                taskId,
                judgement.warnings.length > 0 ? `accepted; ${judgement.warnings.join('; ')}` : 'accepted',
            );
            if (!accepted.ok) {
                return undefined;
            }
            this.#recordProgress(state, true, `${taskId} accepted`, `accept:${taskId}`);
            const ready = board.dependents(taskId).filter((dependent) => dependent.status === 'ready');
            this.#wake(
                state,
                `${taskId} accepted (${info.agentId ?? 'executor'}, ${task.tier}): ${deliverable.summary}` +
                    (ready.length > 0 ? ` Now ready: ${ready.map((item) => item.card.id).join(', ')}.` : '') +
                    (board.isComplete() ? ' Every task is done; the host integrates next.' : ''),
            );
            this.#save(state);
            return undefined;
        }
        const rejected = board.reject(taskId, judgement.reasons.join('; ') || 'acceptance failed');
        if (!rejected.ok) {
            return undefined;
        }
        const decision = shouldEscalate(rejected.value.attempts);
        if (decision.action === 'retry') {
            const feedback = retryFeedback(judgement, { failures: decision.failures });
            this.#recordProgress(
                state,
                false,
                `${taskId} failed acceptance (${decision.failures})`,
                `reject:${taskId}`,
                {
                    nextAssignee: info.agentId,
                    instruction: shorten(judgement.reasons.join('; '), 300),
                },
            );
            this.#wake(
                state,
                `${taskId} failed acceptance and went back to ${info.agentId ?? 'its executor'} (attempt ${decision.failures} at ${task.tier}): ${shorten(judgement.reasons.join('; '), 300)}`,
            );
            this.#save(state);
            return feedback;
        }
        this.#escalate(state, taskId, decision, { judgement });
        return undefined;
    }

    /** A reviewer of another model family reads the work in the executor's workspace (06 §3 rule 6). */
    async #review(
        state: RunState,
        taskId: string,
        by: string,
        commands: readonly CommandResult[],
        changed: readonly string[],
        focus?: string,
    ): Promise<ReviewOutcome | undefined> {
        const { host, board } = state;
        const task = board.get(taskId);
        const deliverable = task?.deliverable;
        if (!task || !deliverable) {
            return undefined;
        }
        const wanted = by.trim().toLowerCase();
        if (wanted === 'human' || wanted === 'user') {
            const text = textOf(TEXT);
            const outcome = await this.#confirm(state, {
                toolName: 'team_review',
                title: text.reviewTitle(taskId, shorten(task.card.title, 30)),
                toolKind: 'other',
                summary: [
                    text.deliverable(deliverable.summary),
                    ...(changed.length > 0 ? [text.changed(changed)] : []),
                ].join('\n'),
                risks: [],
            });
            if (outcome.status === 'allowed') {
                return { by: 'human', verdict: 'pass', issues: [] };
            }
            if (outcome.status === 'denied') {
                return {
                    by: 'human',
                    verdict: 'fail',
                    ...(outcome.message ? { summary: outcome.message } : {}),
                    issues: outcome.message ? [{ problem: outcome.message, blocking: true }] : [],
                };
            }
            return undefined;
        }
        const supervisorReview = wanted === 'supervisor';
        const named = supervisorReview ? undefined : findAgent(host.org, by);
        const reviewer =
            named && (named.role === 'reviewer' || named.role === 'plan_reviewer' || named.role === 'specialist')
                ? named
                : agentsWithRole(host.org, 'reviewer')[0];
        if (!reviewer) {
            return undefined;
        }
        const info = this.#taskHost(state, taskId);
        const tier: Tier = supervisorReview ? 'flagship' : reviewer.tier;
        const project = await this.#deps.projects.get(host.projectId);
        const pick = this.#pickModel(
            host.org,
            state.run.autonomy,
            project,
            tier,
            host.warnings,
            reviewer.crossFamily === false ? undefined : (info.family ?? ''),
        );
        const reviewerId = supervisorReview ? 'supervisor' : reviewer.id;
        const thread = this.#createThread(state, {
            title: textOf(TEXT).reviewThread(taskId),
            role: 'reviewer',
            tier,
            agentId: `${reviewerId}-${taskId}`,
            taskId,
            pick,
            mode: 'plan',
            ...(info.location === 'worktree' && info.worktree && info.worktreeId
                ? { worktree: { path: info.worktree, id: info.worktreeId } }
                : {}),
        });
        host.reviewThreads.push(thread.id);
        this.#deps.turns.setHostTools(thread.id, {
            tools: [],
            disabledTools: disabledBuiltins(reviewer),
            mcpTools: mcpToolsOf(reviewer),
            layers: systemLayers(host.org, reviewer),
            highRiskApproval: true,
            handle: async (name) => fail(`Tool ${name} is not available here.`),
        });
        this.#save(state);
        try {
            let ended = await this.#turn(thread.id, reviewPrompt(task.card, deliverable, commands, changed, focus));
            let parsed = parseReview(ended.lastText);
            if (!parsed.ok && ended.outcome === 'completed' && this.#live(state)) {
                ended = await this.#turn(
                    thread.id,
                    `Your verdict could not be read (${parsed.error.message}). Reply with only the verdict JSON object.`,
                );
                parsed = parseReview(ended.lastText);
            }
            if (!parsed.ok) {
                return undefined;
            }
            return {
                by: reviewerId,
                verdict: parsed.review.verdict,
                ...(parsed.review.summary ? { summary: parsed.review.summary } : {}),
                issues: parsed.review.issues,
            };
        } finally {
            releasePort(thread.id);
        }
    }

    /**
     * Escalation (06 §9): one tier up with the findings, then the supervisor, then the user. `reason` says what
     * went wrong when it was neither the executor's request nor failed acceptance (a spent turn budget).
     */
    #escalate(
        state: RunState,
        taskId: string,
        decision: EscalationDecision,
        details: { deliverable?: Deliverable; judgement?: Judgement; reason?: string } = {},
    ): void {
        const { board } = state;
        const { deliverable, judgement, reason } = details;
        const task = board.get(taskId) as BoardTask;
        const info = this.#taskHost(state, taskId);
        const findings = deliverable?.escalate?.findings ?? [];
        const why =
            reason ?? deliverable?.escalate?.reason ?? judgement?.reasons.slice(0, 3).join('; ') ?? 'acceptance failed';
        if (decision.action === 'escalate') {
            const escalated = board.escalate(taskId, decision.to, `${decision.reason}: ${shorten(why, 200)}`);
            if (!escalated.ok) {
                this.#deps.log.warn(`team: ${taskId} could not escalate: ${escalated.error.message}`);
                return;
            }
            info.handoff = [
                decision.reason === 'requested'
                    ? `${info.agentId ?? 'The executor'} at ${decision.from} escalated: ${why}`
                    : reason !== undefined
                      ? `${info.agentId ?? 'The executor'} at ${decision.from} ${why}`
                      : `Acceptance failed twice at ${decision.from}: ${why}`,
                ...findings,
                ...(task.deliverable && task.deliverable.status !== 'escalate'
                    ? [`Its last deliverable said: ${task.deliverable.summary}`]
                    : []),
            ];
            info.threadId = undefined;
            this.#recordProgress(
                state,
                false,
                `${taskId} escalated ${decision.from} → ${decision.to}`,
                `escalate:${taskId}`,
                {
                    instruction: shorten(why, 300),
                },
            );
            this.#wake(
                state,
                `${taskId} escalated from ${decision.from} to ${decision.to} (${decision.reason}): ${shorten(why, 300)}. It is dispatched again with the findings.`,
            );
        } else if (decision.action === 'supervisor') {
            const escalated = board.escalate(taskId, 'supervisor', `${decision.reason}: ${shorten(why, 200)}`);
            if (!escalated.ok) {
                this.#deps.log.warn(`team: ${taskId} could not go to the supervisor: ${escalated.error.message}`);
                return;
            }
            info.released = false;
            info.threadId = undefined;
            info.handoff = [`Flagship could not finish it: ${why}`, ...findings];
            this.#recordProgress(state, false, `${taskId} handed to the supervisor`, `supervisor:${taskId}`);
            this.#wake(
                state,
                `${taskId} failed at the flagship tier and is yours now (${shorten(why, 300)}). Rewrite or split it with task_update / task_create, cancel it, or re-dispatch it with task_assign.`,
            );
        } else if (decision.action === 'human') {
            const text = textOf(TEXT);
            board.fail(taskId, text.needsPerson(shorten(why, 200)));
            this.#recordProgress(state, false, `${taskId} needs a person`, `human:${taskId}`);
            this.#notice(state, 'warning', text.needsYou(taskId), why);
            this.#wake(
                state,
                `${taskId} failed even under your direction; it needs the user. Explain the problem to the user in your reply.`,
            );
        }
        // The abandoned worktree is removed when the task is dispatched again (#prepare).
        this.#save(state);
    }

    /** Progress ledger after every event (06 §5 ⑨); three entries without progress trigger a replan. */
    #recordProgress(
        state: RunState,
        progressing: boolean,
        reason: string,
        action: string,
        extra: { nextAssignee?: string | undefined; instruction?: string } = {},
    ): void {
        const { host, progress, board } = state;
        host.actions = [...host.actions, action].slice(-RECENT_ACTIONS);
        const looping = detectLoop(host.actions).looping;
        progress.record({
            complete: board.list().length > 0 && board.isComplete(),
            progressing,
            looping,
            ...(extra.nextAssignee ? { nextAssignee: extra.nextAssignee } : {}),
            ...(extra.instruction ? { instruction: extra.instruction } : {}),
            reason,
        });
        if (progress.stalled()) {
            const recent = progress.current.slice(-DEFAULT_STALL_WINDOW).map((entry) => entry.reason);
            progress.markReplanned();
            this.#wake(
                state,
                `No progress in the last ${DEFAULT_STALL_WINDOW} events (${recent.join('; ')}). Replan: revise the task ledger with ledger_update, then fix, split or cancel the cards that are stuck.`,
            );
        }
    }

    // Integration ----------------------------------------------------------------------------------------

    /**
     * Integration (06 §5 ⑩–⑪): after the user confirms the delivery when the autonomy level asks for it, every
     * worktree is applied to the project in dependency order; a conflict pauses the run. Then the acceptance
     * commands run once more in the project and the delivery report is written.
     */
    async #integrate(state: RunState): Promise<void> {
        const { host, board } = state;
        if (state.integrating || !this.#active(state)) {
            return;
        }
        state.integrating = true;
        try {
            if (host.status !== 'integrating') {
                this.#setStatus(state, 'integrating');
            }
            const done = board.list({ status: 'done' });
            if (needsHuman(state.run.autonomy, 'final_delivery') && !host.deliveryApproved) {
                const outcome = await this.#confirm(state, {
                    toolName: 'team_delivery',
                    title: textOf(TEXT).deliveryTitle,
                    toolKind: 'edit',
                    summary: this.#deliverySummary(state),
                    risks: ['write'],
                });
                if (!this.#live(state)) {
                    return;
                }
                if (outcome.status !== 'allowed') {
                    const text = textOf(TEXT);
                    this.#pause(
                        state,
                        outcome.status === 'denied' ? text.deliveryDeclined(outcome.message) : text.deliveryLapsed,
                    );
                    return;
                }
                host.deliveryApproved = true;
                this.#save(state);
            }
            const project = await this.#deps.projects.get(host.projectId);
            for (const taskId of board.topologicalOrder()) {
                const info = host.tasks[taskId];
                if (
                    board.get(taskId)?.status !== 'done' ||
                    !info?.worktree ||
                    info.location !== 'worktree' ||
                    info.integrated
                ) {
                    continue;
                }
                const result = await this.#deps.worktrees.handoff(project, info.worktree, project.path);
                if (!this.#live(state)) {
                    return;
                }
                if (result.status === 'failed') {
                    const text = textOf(TEXT);
                    const files = text.files(result.conflicts.map((conflict) => conflict.path));
                    this.#wake(
                        state,
                        `Integrating ${taskId} into the project failed (${files}: ${result.message ?? 'does not apply'}). The run is paused.`,
                    );
                    this.#pause(state, text.integrateFailed(taskId, files, result.message));
                    return;
                }
                info.integrated = true;
                this.#save(state);
                if (result.status === 'conflicts') {
                    const text = textOf(TEXT);
                    const files = text.files(result.conflicts.map((conflict) => conflict.path));
                    this.#wake(
                        state,
                        `Integrating ${taskId} left merge conflicts in the project (${files}). The run is paused until they are resolved.`,
                    );
                    this.#pause(state, text.integrateConflicts(taskId, files));
                    return;
                }
            }
            // The full acceptance run, in the project folder (06 §5 ⑩).
            const seen = new Set<string>();
            const checks: NonNullable<RunHost['finalChecks']> = [];
            const mode = project.defaults?.mode ?? this.#deps.settings.get().defaultMode;
            for (const task of done) {
                for (const check of task.card.acceptance) {
                    if (check.type !== 'command' || check.expect === 'fail' || seen.has(check.run)) {
                        continue;
                    }
                    seen.add(check.run);
                    const label = textOf(TEXT).finalLabel;
                    const result = await this.#runCommand(state, check.run, project.path, mode, label);
                    if (!this.#live(state)) {
                        return;
                    }
                    checks.push({ run: check.run, exit: result?.exit ?? null, ran: result !== undefined });
                }
            }
            host.finalChecks = checks;
            const failed = checks.filter((check) => !check.ran || check.exit !== 0);
            host.report = this.#report(state);
            const words = textOf(TEXT);
            this.#setStatus(
                state,
                failed.length > 0 ? 'failed' : 'done',
                failed.length > 0 ? words.finalFailed(failed.map((check) => check.run)) : undefined,
            );
            this.#notice(
                state,
                failed.length > 0 ? 'warning' : 'info',
                failed.length > 0 ? words.endedFailed : words.completed,
                words.reportInView,
            );
            for (const taskId of board.topologicalOrder()) {
                const info = host.tasks[taskId];
                if (info?.integrated && info.worktree && info.worktreeId) {
                    await this.#deps.worktrees
                        .remove(project, info.worktreeId, info.worktree, false)
                        .catch((error) => this.#deps.log.info(`team: kept ${info.worktree}: ${errorText(error)}`));
                }
            }
            this.#deps.log.info(`team ${state.run.id} finished: ${host.status}`);
        } finally {
            state.integrating = false;
        }
    }

    #deliverySummary(state: RunState): string {
        const text = textOf(TEXT);
        const lines = [text.deliveryIntro];
        for (const taskId of state.board.topologicalOrder()) {
            const task = state.board.get(taskId);
            if (task?.status !== 'done') {
                continue;
            }
            const changes = (task.deliverable?.changes ?? []).map((change) => change.file);
            lines.push(text.deliveryTask(taskId, task.card.title, changes));
        }
        lines.push(text.deliveryOutro);
        return lines.join('\n');
    }

    #report(state: RunState): string {
        const language = hostLanguage();
        const text = TEXT[language];
        const costs = this.#costs(state);
        const report = deliveryReport({
            goal: state.run.goal,
            cards: state.board.list(),
            ...(state.ledger ? { ledger: state.ledger.current } : {}),
            usage: costs.usage,
            alertRatio: state.host.org.supervisionAlertRatio,
            language,
            currency: costs.currency,
        });
        const checks = state.host.finalChecks ?? [];
        const lines = [text.finalTitle, ''];
        if (checks.length === 0) {
            lines.push(text.noFinalChecks);
        }
        for (const check of checks) {
            lines.push(text.finalCheck(check.run, check.ran, check.exit));
        }
        return `${report}\n${uiStyle(lines.join('\n'), language)}\n`;
    }
}

type UiPeer = RpcPeer<HostMethods, HostNotifications>;

/** The `team.*` handlers, registered on every UI connection; `started` hears of each run the user starts. */
export function registerTeamHandlers(
    peer: UiPeer,
    team: TeamService,
    started?: (params: MethodParams<'team.start'>, run: TeamRunView) => void,
): void {
    peer.handle('team.start', async (params) => {
        const run = await team.start(params);
        started?.(params, run);
        return run;
    });
    peer.handle('team.list', ({ projectId }) => team.list(projectId));
    peer.handle('team.get', ({ runId }) => team.get(runId));
    peer.handle('team.stop', ({ runId }) => team.stop(runId));
    peer.handle('team.resume', ({ runId, budget }) => team.resume(runId, budget));
    peer.handle('team.roster', ({ projectId }) => team.roster(projectId));
    peer.handle('team.message', ({ runId, to, text }) => team.message(runId, to, text));
}
