import type { Approval, WorkflowRun, WorkflowStepRun } from '@xora/protocol';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorMessage, host } from '../host.ts';
import { PendingApproval } from '../items/ItemView.tsx';
import { attempt, selectThread, toast, useApp, useStrings } from '../store.ts';
import { format, type Strings } from '../strings.ts';
import { absolutePath, filesIn, flowLevels, type RunFile, runFiles, stepGist } from '../workflow-run.ts';
import { BriefBody } from './BriefBody.tsx';
import { Choices, Popover } from './Controls.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { Badge, Empty, formatMoney, Modal, Spinner } from './primitives.tsx';
import { RunActions } from './RunActions.tsx';
import { RUN_MODE_ICONS, runModeChoices, runTone } from './WorkflowView.tsx';
import '../task.css';
import '../workflow-run.css';

type Preview = Awaited<ReturnType<typeof host.call<'fs.read'>>>;
type StepStatus = WorkflowStepRun['status'];

const OVER: ReadonlySet<WorkflowRun['status']> = new Set(['completed', 'failed', 'cancelled']);
const SETTLED: ReadonlySet<StepStatus> = new Set(['succeeded', 'failed', 'skipped', 'cancelled']);

const STATUS_ICONS: Record<StepStatus, IconName> = {
    pending: 'circle',
    running: 'refresh',
    waiting: 'alert',
    succeeded: 'check',
    failed: 'x',
    skipped: 'skip',
    cancelled: 'stop',
};

/** The board's columns; a step whose thread waits for an approval counts as waiting for you. */
const COLUMNS: ReadonlyArray<{ key: 'pending' | 'running' | 'waiting' | 'done' | 'other'; statuses: StepStatus[] }> = [
    { key: 'pending', statuses: ['pending'] },
    { key: 'running', statuses: ['running'] },
    { key: 'waiting', statuses: ['waiting'] },
    { key: 'done', statuses: ['succeeded'] },
    { key: 'other', statuses: ['failed', 'skipped', 'cancelled'] },
];

/** Opens a thread of a run in the main area. */
function openThread(threadId: string): void {
    void selectThread(threadId).then(() => useApp.setState({ workflowRunId: undefined, teamRunId: undefined }));
}

/** Ticks every second while `live`, for the clocks of a run that is going on. */
function useNow(live: boolean): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [live]);
    return now;
}

function spell(ms: number, s: Strings): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds >= 3600) {
        return format(s.workflow.hours, { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });
    }
    return seconds >= 60
        ? format(s.team.minutes, { m: Math.floor(seconds / 60), s: seconds % 60 })
        : format(s.team.seconds, { s: seconds });
}

/** How long a step took, or has taken so far. */
function stepTime(step: WorkflowStepRun, now: number): number | undefined {
    if (step.startedAt === undefined) return undefined;
    const live = step.status === 'running' || step.status === 'waiting';
    return (step.endedAt ?? (live ? now : step.startedAt)) - step.startedAt;
}

/** The threads of a run that may hold its approvals: its own and every step's. */
function runThreads(run: WorkflowRun): Set<string> {
    return new Set([run.threadId, ...run.steps.flatMap((step) => step.threadIds)]);
}

/** Steps whose threads wait for an approval: they are on hold until the user answers. */
function useAsking(run: WorkflowRun): Set<string> {
    const approvals = useApp((state) => state.approvals);
    return new Set(
        run.steps
            .filter((step) =>
                approvals.some((approval) => !approval.reviewer && step.threadIds.includes(approval.threadId)),
            )
            .map((step) => step.id),
    );
}

function typeLabel(step: WorkflowStepRun, s: Strings): string {
    return [
        s.workflow.types[step.type as keyof typeof s.workflow.types] ?? step.type,
        ...(step.agent ? [step.agent] : []),
        ...(step.tier ? [s.team.tiers[step.tier as keyof typeof s.team.tiers] ?? step.tier] : []),
    ].join(' · ');
}

function StepLink({ step }: { step: WorkflowStepRun }) {
    const s = useStrings();
    if (step.teamRunId) {
        return (
            <button
                type="button"
                className="link"
                onClick={() => useApp.setState({ teamRunId: step.teamRunId, workflowRunId: undefined })}
            >
                {s.workflow.openTeam}
            </button>
        );
    }
    if (step.childRunId) {
        return (
            <button type="button" className="link" onClick={() => useApp.setState({ workflowRunId: step.childRunId })}>
                {s.workflow.openChild}
            </button>
        );
    }
    const thread = step.threadIds.at(-1);
    return thread ? (
        <button type="button" className="link" onClick={() => openThread(thread)}>
            {s.workflow.openStep}
        </button>
    ) : null;
}

/** A step's status as a small icon: a spinner while it works, a warning sign while it waits for you. */
function StatusIcon({ step, held }: { step: WorkflowStepRun; held: boolean }) {
    return step.status === 'running' && !held ? (
        <Spinner size={12} />
    ) : (
        <Icon name={held ? 'alert' : STATUS_ICONS[step.status]} size={13} />
    );
}

/** The steps as a flow from left to right: a column per depth of dependency, a line for each dependency. */
function FlowGraph({
    run,
    asking,
    now,
    onPick,
}: {
    run: WorkflowRun;
    asking: Set<string>;
    now: number;
    onPick: (stepId: string) => void;
}) {
    const s = useStrings();
    const id = useId();
    const frame = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    useEffect(() => {
        const element = frame.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    const levels = useMemo(() => flowLevels(run.steps), [run.steps]);
    const columns: WorkflowStepRun[][] = [];
    for (const step of run.steps) {
        const level = Math.max(0, levels.get(step.id) ?? 0);
        columns[level] = [...(columns[level] ?? []), step];
    }
    const filled = columns.filter((column) => column.length > 0);
    const count = Math.max(1, filled.length);
    const NODE_H = 58;
    const COL_GAP = 40;
    const ROW_GAP = 12;
    // As wide as the area allows, between a readable minimum and a comfortable maximum; narrower areas scroll.
    const nodeW = Math.round(Math.min(220, Math.max(140, (width - (count - 1) * COL_GAP) / count)));
    const rows = Math.max(1, ...filled.map((column) => column.length));
    const height = rows * NODE_H + (rows - 1) * ROW_GAP;
    const graphWidth = count * nodeW + (count - 1) * COL_GAP;
    const at = new Map<string, { x: number; y: number }>();
    filled.forEach((column, index) => {
        const offset = (height - (column.length * NODE_H + (column.length - 1) * ROW_GAP)) / 2;
        column.forEach((step, row) => {
            at.set(step.id, { x: index * (nodeW + COL_GAP), y: offset + row * (NODE_H + ROW_GAP) });
        });
    });
    const byId = new Map(run.steps.map((step) => [step.id, step]));
    const edges = run.steps.flatMap((step) =>
        step.needs.flatMap((need) => {
            const from = at.get(need);
            const to = at.get(step.id);
            const source = byId.get(need);
            if (!from || !to || !source) return [];
            const x1 = from.x + nodeW;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x - 3;
            const y2 = to.y + NODE_H / 2;
            const bend = COL_GAP / 2;
            const state =
                step.status === 'running' || step.status === 'waiting'
                    ? 'active'
                    : source.status === 'succeeded' || source.status === 'skipped'
                      ? 'done'
                      : 'idle';
            return [
                {
                    key: `${need}>${step.id}`,
                    d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`,
                    state,
                },
            ];
        }),
    );
    return (
        <div className="flow" ref={frame}>
            {width > 0 && (
                <div className="flow__canvas" style={{ width: graphWidth, height }}>
                    <svg className="flow__edges" width={graphWidth} height={height} aria-hidden="true">
                        <defs>
                            {(['idle', 'done', 'active'] as const).map((state) => (
                                <marker
                                    key={state}
                                    id={`${id}-${state}`}
                                    className={`flow__arrow is-${state}`}
                                    viewBox="0 0 8 8"
                                    refX="6"
                                    refY="4"
                                    markerWidth="7"
                                    markerHeight="7"
                                    orient="auto"
                                >
                                    <path d="M0,0 L8,4 L0,8 z" />
                                </marker>
                            ))}
                        </defs>
                        {edges.map((edge) => (
                            <path
                                key={edge.key}
                                className={`flow__edge is-${edge.state}`}
                                d={edge.d}
                                markerEnd={`url(#${id}-${edge.state})`}
                            />
                        ))}
                    </svg>
                    {run.steps.map((step, index) => {
                        const spot = at.get(step.id);
                        if (!spot) return null;
                        const held = asking.has(step.id) && step.status === 'running';
                        const took = stepTime(step, now);
                        const meta = [
                            s.workflow.types[step.type as keyof typeof s.workflow.types] ?? step.type,
                            ...(step.agent ? [step.agent] : []),
                            ...(took !== undefined ? [spell(took, s)] : []),
                            ...(step.cost && step.cost.amount > 0 ? [formatMoney(step.cost)] : []),
                        ].join(' · ');
                        const status = held ? s.workflow.stepAsking : s.workflow.stepStatuses[step.status];
                        return (
                            <button
                                key={step.id}
                                type="button"
                                className={`flow-node is-${step.status}${held ? ' is-asking' : ''}`}
                                style={{
                                    left: spot.x,
                                    top: spot.y,
                                    width: nodeW,
                                    height: NODE_H,
                                    animationDelay: `${index * 40}ms`,
                                }}
                                title={`${step.title}（${status}）`}
                                aria-label={`${step.title}：${status}`}
                                onClick={() => onPick(step.id)}
                            >
                                <span className="flow-node__icon">
                                    <StatusIcon step={step} held={held} />
                                </span>
                                <span className="flow-node__text">
                                    <span className="flow-node__title">{step.title}</span>
                                    <span className="flow-node__meta">{meta}</span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/** The run's own questions: a gate, what to do with a failed step, a command of a script step. */
function RunDecision({ approval }: { approval: Approval }) {
    const s = useStrings();
    const [allow, deny] =
        approval.toolName === 'workflow_gate'
            ? [s.workflow.gateAllow, s.workflow.gateDeny]
            : approval.toolName === 'workflow_step_failed'
              ? [s.workflow.skipAllow, s.workflow.skipDeny]
              : [s.workflow.approve, s.workflow.deny];
    const respond = (decision: 'allow_once' | 'deny') =>
        void attempt(() => host.call('approval.respond', { approvalId: approval.id, decision }));
    return (
        <div className="approval approval--pending">
            <div className="approval__title">{approval.title}</div>
            <pre className="approval__summary">{approval.summary}</pre>
            <div className="approval__actions">
                <button type="button" className="button button--primary" onClick={() => respond('allow_once')}>
                    {allow}
                </button>
                <button type="button" className="button" onClick={() => respond('deny')}>
                    {deny}
                </button>
            </div>
        </div>
    );
}

/** Everything the run waits on from the user, wherever it was asked: the run's own questions and its steps' calls. */
function RunApprovals({ run }: { run: WorkflowRun }) {
    const s = useStrings();
    const approvals = useApp((state) => state.approvals);
    const threads = runThreads(run);
    // The supervisor answers some for the user (06 §24): those are not the user's to see here.
    const pending = approvals.filter((approval) => threads.has(approval.threadId) && !approval.reviewer);
    if (pending.length === 0) return null;
    return (
        <section className="team__approvals" aria-label={format(s.team.pendingApprovals, { count: pending.length })}>
            <h3>{format(s.team.pendingApprovals, { count: pending.length })}</h3>
            {pending.map((approval) =>
                approval.threadId === run.threadId ? (
                    <RunDecision key={approval.id} approval={approval} />
                ) : (
                    <div key={approval.id} className="approval approval--pending">
                        <PendingApproval approval={approval} />
                        <button type="button" className="link" onClick={() => openThread(approval.threadId)}>
                            {s.team.openThread}
                        </button>
                    </div>
                ),
            )}
        </section>
    );
}

/** A step's outputs as name and value; a value that names files opens them in place. */
function Outputs({
    step,
    root,
    onPreview,
}: {
    step: WorkflowStepRun;
    root: string;
    onPreview: (path: string) => void;
}) {
    const entries = Object.entries(step.outputs);
    if (entries.length === 0) return null;
    return (
        <dl className="wf-outputs">
            {entries.map(([name, value]) => {
                const files = filesIn(value, root);
                return (
                    <div key={name} className="wf-outputs__row">
                        <dt>{name}</dt>
                        <dd>
                            {files.length > 0
                                ? files.map((file) => (
                                      <button
                                          key={file}
                                          type="button"
                                          className="wf-file-link"
                                          onClick={() => onPreview(file)}
                                      >
                                          <Icon name="file" size={12} />
                                          {file}
                                      </button>
                                  ))
                                : value}
                        </dd>
                    </div>
                );
            })}
        </dl>
    );
}

/**
 * One stage of the process in a line, the second layer under the brief: status, who did it, the gist of what it
 * concluded. Opened, it shows everything the step handed in.
 */
function StageRow({
    step,
    root,
    held,
    picked,
    now,
    onPreview,
}: {
    step: WorkflowStepRun;
    root: string;
    held: boolean;
    picked: boolean;
    now: number;
    onPreview: (path: string) => void;
}) {
    const s = useStrings();
    const [expanded, setExpanded] = useState(false);
    useEffect(() => {
        if (picked) setExpanded(true);
    }, [picked]);
    const open = expanded || picked;
    const took = stepTime(step, now);
    const gist =
        stepGist(step) ||
        (held
            ? s.workflow.stepAsking
            : step.status === 'running'
              ? s.team.working
              : step.status === 'pending'
                ? s.team.waiting
                : s.workflow.noSummary);
    return (
        <li
            id={`wf-step-${step.id}`}
            className={`wf-stage is-${step.status}${held ? ' is-asking' : ''}${picked ? ' is-picked' : ''}`}
        >
            <button type="button" className="wf-stage__row" aria-expanded={open} onClick={() => setExpanded(!open)}>
                <span className="wf-stage__icon">
                    <StatusIcon step={step} held={held} />
                </span>
                <span className="wf-stage__main">
                    <span className="wf-stage__title">
                        {step.title}
                        <span className="wf-stage__who">{typeLabel(step, s)}</span>
                    </span>
                    <span className="wf-stage__gist">{gist}</span>
                </span>
                <span className="wf-stage__side">
                    {took !== undefined && <span>{spell(took, s)}</span>}
                    {step.cost && step.cost.amount > 0 && <span>{formatMoney(step.cost)}</span>}
                </span>
                <Icon name="chevronRight" size={14} className="wf-stage__chevron" />
            </button>
            {open && (
                <div className="wf-stage__detail">
                    {step.note && <div className={`wf-note is-${step.status}`}>{step.note}</div>}
                    {step.summary && (
                        <div className="conclusion-card__body">
                            <Markdown text={step.summary} />
                        </div>
                    )}
                    <Outputs step={step} root={root} onPreview={onPreview} />
                    <div className="wf-stage__foot">
                        {step.needs.length > 0 && (
                            <span>{format(s.team.dependsOn, { ids: step.needs.join(', ') })}</span>
                        )}
                        {step.attempts > 1 && <span>{format(s.workflow.attempts, { count: step.attempts })}</span>}
                        <StepLink step={step} />
                    </div>
                </div>
            )}
        </li>
    );
}

interface Progress {
    /** Steps done, with the skipped and failed ones. */
    readonly steps: string;
    readonly time: string;
    /** Spent, against the budget when there is one. */
    readonly cost: string;
    /** Share of the steps that are settled, 0 to 1. */
    readonly ratio: number;
}

/** How far the run got, in words: steps, time and money. */
function progressOf(run: WorkflowRun, now: number, s: Strings): Progress {
    const total = run.steps.length;
    const count = (status: StepStatus) => run.steps.filter((step) => step.status === status).length;
    const extra = [
        ...(count('skipped') > 0 ? [format(s.workflow.skippedCount, { count: count('skipped') })] : []),
        ...(count('failed') > 0 ? [format(s.workflow.failedCount, { count: count('failed') })] : []),
    ];
    const elapsed = (OVER.has(run.status) ? (run.endedAt ?? run.updatedAt) : now) - run.createdAt;
    return {
        steps:
            format(s.workflow.progress, { done: count('succeeded'), total }) +
            (extra.length > 0 ? format(s.workflow.progressExtra, { list: extra.join(s.workflow.listSep) }) : ''),
        time: format(s.team.elapsed, { time: spell(elapsed, s) }),
        cost: `${s.thread.cost} ${formatMoney(run.cost)}${run.budget ? ` / ${formatMoney(run.budget)}` : ''}`,
        ratio: total > 0 ? run.steps.filter((step) => SETTLED.has(step.status)).length / total : 0,
    };
}

function ProgressBar({ run, progress }: { run: WorkflowRun; progress: Progress }) {
    return (
        <div className="progress-bar" aria-hidden="true">
            <div
                className={`progress-bar__fill${run.status === 'failed' ? ' is-failed' : ''}`}
                style={{ width: `${Math.round(progress.ratio * 100)}%` }}
            />
        </div>
    );
}

/** The first layer while the run goes on: what it is doing, what waits for you, how far it got. */
function LiveCard({ run, asking, progress }: { run: WorkflowRun; asking: Set<string>; progress: Progress }) {
    const s = useStrings();
    const held = (step: WorkflowStepRun) =>
        step.status === 'waiting' || (step.status === 'running' && asking.has(step.id));
    const doing = run.steps.filter((step) => step.status === 'running' && !held(step)).map((step) => step.title);
    const waiting = run.steps.filter(held).map((step) => step.title);
    return (
        <section className="overview-card wf-brief is-live" aria-label={s.workflow.briefTitle}>
            <header className="wf-brief__head">
                <h3>
                    {run.status === 'running' && <Spinner />}
                    {s.workflow.statuses[run.status]}
                </h3>
                <span className="wf-brief__meta">
                    <span>{progress.steps}</span>
                    <span>{progress.time}</span>
                    <span>{progress.cost}</span>
                </span>
            </header>
            <ProgressBar run={run} progress={progress} />
            {doing.length > 0 && (
                <p className="wf-brief__line">{format(s.workflow.doing, { steps: doing.join(s.workflow.listSep) })}</p>
            )}
            {waiting.length > 0 && (
                <p className="wf-brief__line is-warn">
                    {format(s.workflow.waitingYou, { steps: waiting.join(s.workflow.listSep) })}
                </p>
            )}
            <p className="overview-muted">{s.workflow.briefLater}</p>
        </section>
    );
}

/**
 * The first layer once the run is over, written for whoever ordered it: what came of it, what is wrong, what to do
 * next, and the files it handed in. How each step got there is one level down.
 */
function BriefCard({
    run,
    files,
    progress,
    onPreview,
}: {
    run: WorkflowRun;
    files: readonly RunFile[];
    progress: Progress;
    onPreview: (path: string) => void;
}) {
    const s = useStrings();
    const brief = run.brief;
    const write = () =>
        void attempt(() => host.call('workflow.brief', { runId: run.id })).then(
            (updated) =>
                updated &&
                useApp.setState((state) => ({ workflowRuns: { ...state.workflowRuns, [updated.id]: updated } })),
        );
    return (
        <section className={`overview-card wf-brief is-${run.status}`} aria-label={s.workflow.briefTitle}>
            <header className="wf-brief__head">
                <h3>{s.workflow.briefTitle}</h3>
                <span className="wf-brief__meta">
                    <Badge tone={runTone(run.status)}>{s.workflow.statuses[run.status]}</Badge>
                    <span>{progress.steps}</span>
                    <span>{progress.time}</span>
                    <span>{progress.cost}</span>
                </span>
            </header>
            {brief === undefined ? (
                <div className="wf-brief__empty">
                    <p>{s.workflow.briefMissing}</p>
                    <button type="button" className="button button--small button--primary" onClick={write}>
                        {s.workflow.briefWrite}
                    </button>
                </div>
            ) : brief.status === 'writing' ? (
                <div className="wf-brief__writing" aria-busy="true">
                    <p className="overview-muted overview-pulse">{s.workflow.briefWriting}</p>
                    <span className="wf-skeleton" />
                    <span className="wf-skeleton" />
                    <span className="wf-skeleton is-short" />
                </div>
            ) : brief.status === 'failed' ? (
                <div className="wf-brief__empty">
                    <p className="wf-brief__failed">{format(s.workflow.briefFailed, { note: brief.note ?? '' })}</p>
                    <button type="button" className="button button--small" onClick={write}>
                        {s.workflow.briefRetry}
                    </button>
                </div>
            ) : (
                <BriefBody text={brief.text ?? ''} />
            )}
            {files.length > 0 && (
                <div className="wf-brief__files">
                    <span className="wf-brief__files-label">{s.workflow.deliverables}</span>
                    {files.map((file) => (
                        <button
                            key={file.path}
                            type="button"
                            className="wf-file-chip"
                            title={file.from}
                            onClick={() => onPreview(file.path)}
                        >
                            <Icon name="file" size={13} />
                            {file.path}
                        </button>
                    ))}
                </div>
            )}
            {brief?.status === 'ready' && (
                <footer className="wf-brief__foot">
                    <time>
                        {format(s.workflow.briefAt, {
                            time: new Date(brief.at).toLocaleString(undefined, { hour12: false }),
                        })}
                    </time>
                    <button type="button" className="link" onClick={write}>
                        {s.workflow.briefRewrite}
                    </button>
                </footer>
            )}
        </section>
    );
}

/** Asks about the run: a new thread answers with the run's record and files at hand. */
function AskBox({ run }: { run: WorkflowRun }) {
    const s = useStrings();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const send = async () => {
        const question = text.trim();
        if (!question || busy) return;
        setBusy(true);
        const thread = await attempt(() =>
            host.call('workflow.ask', { runId: run.id, question }, { timeoutMs: 120_000 }),
        );
        setBusy(false);
        if (thread) {
            setText('');
            useApp.setState((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
            openThread(thread.id);
        }
    };
    return (
        <section className="overview-card wf-ask" aria-label={s.workflow.askTitle}>
            <h3>
                <Icon name="message" size={15} />
                {s.workflow.askTitle}
                <span className="wf-hint">{s.workflow.askHint}</span>
            </h3>
            <textarea
                className="textarea"
                rows={2}
                value={text}
                placeholder={s.workflow.askPlaceholder}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void send();
                    }
                }}
            />
            <div className="row">
                <button
                    type="button"
                    className="button button--primary"
                    disabled={busy || !text.trim()}
                    onClick={() => void send()}
                >
                    {busy ? <Spinner /> : null} {s.workflow.askButton}
                </button>
            </div>
        </section>
    );
}

interface RunEvent {
    readonly ts: number;
    readonly text: string;
    readonly tone: 'ok' | 'error' | 'accent' | 'muted';
}

/** What happened when, newest first: the run's start and end, each step's start and end. */
function runEvents(run: WorkflowRun, s: Strings): RunEvent[] {
    const events: RunEvent[] = [
        {
            ts: run.createdAt,
            text: format(s.workflow.events.runStarted, { reason: s.workflow.reasons[run.reason] }),
            tone: 'accent',
        },
    ];
    for (const step of run.steps) {
        if (step.startedAt !== undefined) {
            events.push({
                ts: step.startedAt,
                text: format(s.workflow.events.started, { step: step.title }),
                tone: 'muted',
            });
        }
        if (step.endedAt !== undefined && SETTLED.has(step.status)) {
            const tone = step.status === 'succeeded' ? 'ok' : step.status === 'failed' ? 'error' : 'muted';
            events.push({
                ts: step.endedAt,
                text: format(s.workflow.events[step.status as 'succeeded' | 'failed' | 'skipped' | 'cancelled'], {
                    step: step.title,
                }),
                tone,
            });
        }
    }
    if (OVER.has(run.status) && run.endedAt !== undefined) {
        events.push({
            ts: run.endedAt,
            text: format(s.workflow.events.runEnded, { status: s.workflow.statuses[run.status] }),
            tone: run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'error' : 'muted',
        });
    }
    // Ties keep the order above (start before end) when shown newest first.
    return events
        .map((event, index) => ({ event, index }))
        .sort((a, b) => b.event.ts - a.event.ts || b.index - a.index)
        .map(({ event }) => event);
}

function RunTimeline({ run }: { run: WorkflowRun }) {
    const s = useStrings();
    const [showAll, setShowAll] = useState(false);
    const events = runEvents(run, s);
    return (
        <section className="overview-section" aria-label={s.workflow.timeline}>
            <h3>{s.workflow.timeline}</h3>
            <ol className="progress-timeline">
                {(showAll ? events : events.slice(0, 8)).map((event) => (
                    <li key={`${event.ts}:${event.text}`} className={`progress-timeline__item is-${event.tone}`}>
                        <time>{new Date(event.ts).toLocaleTimeString(undefined, { hour12: false })}</time>
                        <span>{event.text}</span>
                    </li>
                ))}
            </ol>
            {!showAll && events.length > 8 && (
                <button type="button" className="link" onClick={() => setShowAll(true)}>
                    {format(s.team.showAll, { count: events.length })}
                </button>
            )}
        </section>
    );
}

/**
 * The run in layers (the default tab): first the result — the brief once it is over, what goes on while it runs —
 * then the process, folded once the run is over: the flow and each stage's conclusion in a line, every detail a
 * click further. A question about the run opens a thread that answers it.
 */
function RunOverview({
    run,
    asking,
    now,
    picked,
    onPick,
    onPreview,
}: {
    run: WorkflowRun;
    asking: Set<string>;
    now: number;
    picked: string | undefined;
    onPick: (stepId: string) => void;
    onPreview: (path: string) => void;
}) {
    const s = useStrings();
    const project = useApp((state) => state.projects.find((item) => item.id === run.projectId));
    const root = project?.path ?? '';
    const over = OVER.has(run.status);
    const [showProcess, setShowProcess] = useState<boolean | undefined>();
    // A step picked on the flow or the board opens the process and stays open.
    useEffect(() => {
        if (picked !== undefined) setShowProcess(true);
    }, [picked]);
    const processOpen = picked !== undefined || (showProcess ?? !over);
    const progress = progressOf(run, now, s);
    const files = runFiles(run, root);
    return (
        <div className="task-overview">
            {over ? (
                <BriefCard run={run} files={files} progress={progress} onPreview={onPreview} />
            ) : (
                <LiveCard run={run} asking={asking} progress={progress} />
            )}
            <section className="overview-section wf-process" aria-label={s.workflow.process}>
                <button
                    type="button"
                    className="wf-process__toggle"
                    aria-expanded={processOpen}
                    onClick={() => setShowProcess(!processOpen)}
                >
                    <Icon name="chevronRight" size={14} className="wf-process__chevron" />
                    <span className="wf-process__title">{s.workflow.process}</span>
                    <span className="wf-process__summary">{processOpen ? s.workflow.processHint : progress.steps}</span>
                </button>
                {processOpen && (
                    <>
                        <div className="overview-card wf-flow-card">
                            <FlowGraph run={run} asking={asking} now={now} onPick={onPick} />
                        </div>
                        <ol className="wf-stages">
                            {run.steps.map((step) => (
                                <StageRow
                                    key={step.id}
                                    step={step}
                                    root={root}
                                    held={asking.has(step.id) && step.status === 'running'}
                                    picked={picked === step.id}
                                    now={now}
                                    onPreview={onPreview}
                                />
                            ))}
                        </ol>
                    </>
                )}
            </section>
            <AskBox run={run} />
        </div>
    );
}

/** The steps by status, a column each: waiting to start, going, waiting for you, done, failed or skipped. */
function RunBoard({
    run,
    asking,
    now,
    onPick,
}: {
    run: WorkflowRun;
    asking: Set<string>;
    now: number;
    onPick: (stepId: string) => void;
}) {
    const s = useStrings();
    const column = (step: WorkflowStepRun) =>
        asking.has(step.id) && step.status === 'running'
            ? 'waiting'
            : (COLUMNS.find((item) => item.statuses.includes(step.status))?.key ?? 'pending');
    return (
        <div className="board wf-run-board">
            {COLUMNS.map((item) => {
                const steps = run.steps.filter((step) => column(step) === item.key);
                return (
                    <div key={item.key} className="board__column">
                        <div className="board__title">
                            {s.workflow.columns[item.key]} <span>{steps.length}</span>
                        </div>
                        {steps.map((step) => {
                            const took = stepTime(step, now);
                            const text = step.note ?? step.summary;
                            return (
                                <button
                                    key={step.id}
                                    type="button"
                                    className="task-card"
                                    onClick={() => onPick(step.id)}
                                >
                                    <div className="task-card__title">
                                        {step.title !== step.id && <code>{step.id}</code>} {step.title}
                                    </div>
                                    <div className="task-card__meta">
                                        <span>{typeLabel(step, s)}</span>
                                        {took !== undefined && <span>{spell(took, s)}</span>}
                                        {step.cost && step.cost.amount > 0 && <span>{formatMoney(step.cost)}</span>}
                                    </div>
                                    {text && <div className="wf-card-text">{text}</div>}
                                    {step.needs.length > 0 && (
                                        <div className="task-card__deps">
                                            {format(s.team.dependsOn, { ids: step.needs.join(', ') })}
                                        </div>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
}

/** A step in full, for the details tab: everything it handed in, unfolded. */
function StepDetail({
    step,
    root,
    onPreview,
}: {
    step: WorkflowStepRun;
    root: string;
    onPreview: (path: string) => void;
}) {
    const s = useStrings();
    return (
        <li className={`workflow-step is-${step.status}`}>
            <div className="workflow-step__head">
                <Badge tone={step.status === 'succeeded' ? 'ok' : step.status === 'failed' ? 'error' : 'accent'}>
                    {s.workflow.stepStatuses[step.status]}
                </Badge>
                <strong>{step.title}</strong>
                <span className="workflow-step__meta">
                    {typeLabel(step, s)}
                    {step.attempts > 1 ? ` · ${format(s.workflow.attempts, { count: step.attempts })}` : ''}
                    {step.cost ? ` · ${formatMoney(step.cost)}` : ''}
                </span>
                <span className="workflow-step__actions">
                    <StepLink step={step} />
                </span>
            </div>
            {step.needs.length > 0 && (
                <div className="workflow-step__deps">{format(s.team.dependsOn, { ids: step.needs.join(', ') })}</div>
            )}
            {step.note && <div className="workflow-step__note">{step.note}</div>}
            {step.summary && (
                <div className="workflow-step__summary">
                    <Markdown text={step.summary} />
                </div>
            )}
            <Outputs step={step} root={root} onPreview={onPreview} />
        </li>
    );
}

/** A file the run handed in, read in place, with a way to open it outside. */
function FilePreview({ run, path, onClose }: { run: WorkflowRun; path: string; onClose: () => void }) {
    const s = useStrings();
    const project = useApp((state) => state.projects.find((item) => item.id === run.projectId));
    const [preview, setPreview] = useState<Preview | undefined>();
    const [error, setError] = useState<string | undefined>();
    useEffect(() => {
        let live = true;
        host.call('fs.read', { threadId: run.threadId, path })
            .then((value) => live && setPreview(value))
            .catch((reason) => live && setError(errorMessage(reason)));
        return () => {
            live = false;
        };
    }, [run.threadId, path]);
    const absolute = absolutePath(project, path);
    const open = (kind: 'path' | 'reveal') => {
        if (absolute === undefined) return;
        void host
            .call('system.open', { kind, target: absolute })
            .catch((reason) => toast(errorMessage(reason), 'error'));
    };
    return (
        <Modal title={path} onClose={onClose} wide>
            <div className="wf-preview">
                {absolute && (
                    <div className="row wf-preview__actions">
                        <button type="button" className="button button--small" onClick={() => open('path')}>
                            {s.review.openFile}
                        </button>
                        <button type="button" className="button button--small" onClick={() => open('reveal')}>
                            {s.review.reveal}
                        </button>
                    </div>
                )}
                {error !== undefined ? (
                    <p className="wf-preview__note">{format(s.workflow.fileUnreadable, { path, reason: error })}</p>
                ) : !preview ? (
                    <Empty>
                        <Spinner />
                    </Empty>
                ) : preview.kind === 'text' ? (
                    /\.(md|markdown|mdx)$/i.test(path) ? (
                        <div className="wf-preview__doc">
                            <Markdown text={preview.text ?? ''} />
                        </div>
                    ) : (
                        <pre className="wf-preview__text">{preview.text}</pre>
                    )
                ) : preview.kind === 'image' ? (
                    <img
                        className="wf-preview__image"
                        src={`data:${preview.mimeType};base64,${preview.data}`}
                        alt={path}
                    />
                ) : (
                    <p className="wf-preview__note">
                        {preview.kind === 'too_large' ? s.workflow.fileTooLarge : s.review.binary}
                    </p>
                )}
            </div>
        </Modal>
    );
}

export function WorkflowRunView({ runId }: { runId: string }) {
    const s = useStrings();
    const run = useApp((state) => state.workflowRuns[runId]);
    const project = useApp((state) => state.projects.find((item) => item.id === run?.projectId));
    const [budget, setBudget] = useState('');
    const [tab, setTab] = useState<'overview' | 'board' | 'steps'>('overview');
    const [picked, setPicked] = useState<string | undefined>();
    const [preview, setPreview] = useState<string | undefined>();
    useEffect(() => {
        void host
            .call('workflow.get', { runId })
            .then((loaded) =>
                useApp.setState((state) => ({ workflowRuns: { ...state.workflowRuns, [loaded.id]: loaded } })),
            )
            .catch((error) => toast(errorMessage(error), 'error'));
    }, [runId]);
    // A step picked on the flow or the board: its card scrolls into view and lights up for a moment.
    useEffect(() => {
        if (picked === undefined) return;
        const card = document.getElementById(`wf-step-${picked}`);
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        card?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'center' });
        const timer = setTimeout(() => setPicked(undefined), 1600);
        return () => clearTimeout(timer);
    }, [picked]);
    const live = run !== undefined && !OVER.has(run.status);
    const now = useNow(live);
    const asking = useAsking(run ?? EMPTY_RUN);
    if (!run)
        return (
            <Empty>
                <Spinner />
            </Empty>
        );
    // A run paused on its budget continues only with a larger one.
    const spent = run.status === 'paused' && run.budget !== null && run.cost.amount >= run.budget.amount;
    const pick = (stepId: string) => {
        setTab('overview');
        setPicked(stepId);
    };
    const inputs = Object.entries(run.inputs);
    const root = project?.path ?? '';
    return (
        <div className="team workflow">
            <header className="team__header">
                <div className="team__goal">
                    <h1>{run.title}</h1>
                    <div className="team__meta">
                        <Badge tone={runTone(run.status)}>{s.workflow.statuses[run.status]}</Badge>
                        <span>{s.workflow.reasons[run.reason]}</span>
                        <span>
                            {s.thread.cost} {formatMoney(run.cost)}
                            {run.budget ? ` / ${formatMoney(run.budget)}` : ''}
                        </span>
                        {run.startsAt !== undefined && (
                            <span>
                                {format(s.workflow.startsAt, {
                                    time: new Date(run.startsAt).toLocaleString(undefined, { hour12: false }),
                                })}
                            </span>
                        )}
                    </div>
                    {inputs.length > 0 && (
                        <details className="wf-inputs">
                            <summary>{format(s.workflow.inputsCount, { count: inputs.length })}</summary>
                            <dl className="wf-outputs">
                                {inputs.map(([name, value]) => (
                                    <div key={name} className="wf-outputs__row">
                                        <dt>{name}</dt>
                                        <dd>{String(value)}</dd>
                                    </div>
                                ))}
                            </dl>
                        </details>
                    )}
                    {run.note && <div className="team__note">{run.note}</div>}
                    {run.warnings.map((warning) => (
                        <div key={warning} className="team__warning">
                            {warning}
                        </div>
                    ))}
                </div>
                <div className="row">
                    <Popover
                        label={`${s.workflow.mode}：${s.workflow.modes[run.mode ?? 'default']}`}
                        placement="down"
                        align="end"
                        className="picker"
                        triggerClassName={`picker__trigger mode-chip is-${run.mode ?? 'default'}`}
                        disabled={!live}
                        trigger={
                            <>
                                <Icon name={RUN_MODE_ICONS[run.mode ?? 'default']} size={13} />
                                {s.workflow.modes[run.mode ?? 'default']}
                                <Icon name="chevronDown" size={12} className="picker__chevron" />
                            </>
                        }
                    >
                        {(close) => (
                            <>
                                <div className="popover__title">{s.workflow.mode}</div>
                                <Choices
                                    value={run.mode ?? 'default'}
                                    options={runModeChoices(s)}
                                    onPick={(mode) => {
                                        close();
                                        void attempt(() => host.call('workflow.setMode', { runId, mode })).then(
                                            (updated) =>
                                                updated &&
                                                useApp.setState((state) => ({
                                                    workflowRuns: { ...state.workflowRuns, [updated.id]: updated },
                                                })),
                                        );
                                    }}
                                />
                            </>
                        )}
                    </Popover>
                    <button type="button" className="button button--small" onClick={() => openThread(run.threadId)}>
                        {s.workflow.openThread}
                    </button>
                    {spent && (
                        <input
                            className="input team__budget"
                            type="number"
                            min={0}
                            step={1}
                            value={budget}
                            placeholder={s.workflow.newBudget}
                            aria-label={s.workflow.newBudget}
                            onChange={(event) => setBudget(event.target.value)}
                        />
                    )}
                    {run.status === 'paused' && (
                        <button
                            type="button"
                            className="button button--small button--primary"
                            disabled={spent && !(Number(budget) > (run.budget?.amount ?? 0))}
                            onClick={() =>
                                void attempt(() =>
                                    host.call('workflow.resume', {
                                        runId,
                                        ...(Number(budget) > 0 ? { budget: Number(budget) } : {}),
                                    }),
                                )
                            }
                        >
                            {s.workflow.resume}
                        </button>
                    )}
                    {live && (
                        <button
                            type="button"
                            className="button button--small button--danger"
                            onClick={() => void attempt(() => host.call('workflow.stop', { runId }))}
                        >
                            {s.workflow.stop}
                        </button>
                    )}
                    {['completed', 'failed', 'cancelled'].includes(run.status) && !run.parentRunId && (
                        <RunActions kind="workflow" runId={runId} archived={Boolean(run.archived)} />
                    )}
                </div>
            </header>
            <RunApprovals run={run} />
            <div className="segmented team__tabs" role="tablist">
                {(['overview', 'board', 'steps'] as const).map((key) => (
                    <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={tab === key}
                        className={tab === key ? 'is-active' : ''}
                        onClick={() => setTab(key)}
                    >
                        {s.workflow.tabs[key]}
                    </button>
                ))}
            </div>
            {tab === 'overview' && (
                <RunOverview run={run} asking={asking} now={now} picked={picked} onPick={pick} onPreview={setPreview} />
            )}
            {tab === 'board' && <RunBoard run={run} asking={asking} now={now} onPick={pick} />}
            {tab === 'steps' && (
                <>
                    <ol className="workflow-steps">
                        {run.steps.map((step) => (
                            <StepDetail key={step.id} step={step} root={root} onPreview={setPreview} />
                        ))}
                    </ol>
                    <RunTimeline run={run} />
                </>
            )}
            {preview !== undefined && <FilePreview run={run} path={preview} onClose={() => setPreview(undefined)} />}
        </div>
    );
}

/** Stands in for a run not loaded yet, so the hooks above run the same way on every render. */
const EMPTY_RUN: WorkflowRun = {
    id: '',
    projectId: '',
    key: '',
    name: '',
    title: '',
    status: 'queued',
    reason: 'manual',
    unattended: false,
    inputs: {},
    warnings: [],
    threadId: '',
    steps: [],
    budget: null,
    cost: { amount: 0, currency: 'CNY' },
    createdAt: 0,
    updatedAt: 0,
};
