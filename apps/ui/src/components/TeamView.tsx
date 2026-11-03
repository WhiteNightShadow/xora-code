import type { TeamRun, TeamTask } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { errorMessage, host } from '../host.ts';
import { PendingApproval } from '../items/ItemView.tsx';
import {
    ALL_PROJECTS,
    attempt,
    loadMembers,
    openRun,
    openTeamBoard,
    selectThread,
    toast,
    useApp,
    useStrings,
} from '../store.ts';
import { format } from '../strings.ts';
import { Choices, Popover } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import '../task.css';
import { BriefBody } from './BriefBody.tsx';
import { TeamTabs } from './OrgView.tsx';
import { Badge, Empty, Field, formatMoney, IconButton, Modal, relativeTime, Select, Spinner } from './primitives.tsx';
import { RunActions } from './RunActions.tsx';
import { RUN_MODE_ICONS } from './WorkflowView.tsx';

const COLUMNS: Array<{ key: string; statuses: string[] }> = [
    { key: 'pending', statuses: ['pending', 'ready'] },
    { key: 'running', statuses: ['assigned', 'in_progress'] },
    { key: 'review', statuses: ['in_review'] },
    { key: 'done', statuses: ['done'] },
    { key: 'blocked', statuses: ['failed', 'blocked', 'cancelled'] },
];

function TaskCard({ task }: { task: TeamTask }) {
    const s = useStrings();
    return (
        <button
            type="button"
            className="task-card"
            disabled={!task.threadId}
            onClick={() =>
                task.threadId && void selectThread(task.threadId).then(() => useApp.setState({ teamRunId: undefined }))
            }
        >
            <div className="task-card__title">
                <code>{task.id}</code> {task.title}
            </div>
            <div className="task-card__meta">
                <Badge tone="accent">{s.team.tiers[task.tier as keyof typeof s.team.tiers] ?? task.tier}</Badge>
                <span>{task.category}</span>
                {task.attempts > 1 && <span>{format(s.team.attempts, { count: task.attempts })}</span>}
                {task.stage && <span>{format(s.team.stage, { count: task.stage })}</span>}
                {task.remaining && task.remaining.length > 0 && (
                    <span>{format(s.team.remaining, { count: task.remaining.length })}</span>
                )}
                {task.cost && <span>{formatMoney(task.cost)}</span>}
                {task.watch && (
                    <Badge tone="warn">
                        {s.team.watchName}：
                        {(s.team.watchRules as Record<string, string>)[task.watch.rule] ?? task.watch.rule}
                    </Badge>
                )}
            </div>
            {task.verdict && task.verdict.verdict !== 'pass' && (
                <div className="task-card__verdict">
                    {task.verdict.reasons.slice(0, 2).join('；')}
                    {task.verdict.outOfOwnership.length > 0 &&
                        ` · ${s.team.outOfOwnership}${task.verdict.outOfOwnership.join(', ')}`}
                </div>
            )}
            {task.guidance && (
                <div className="task-card__guidance">
                    {s.team.guidance}
                    {task.guidance}
                </div>
            )}
            {task.dependsOn.length > 0 && (
                <div className="task-card__deps">{format(s.team.dependsOn, { ids: task.dependsOn.join(', ') })}</div>
            )}
        </button>
    );
}

/** Messages between the user, the supervisor and the members, and a box to write to one of them (06 §7). */
function Conversation({ run }: { run: TeamRun }) {
    const s = useStrings();
    const open = !['done', 'failed', 'cancelled'].includes(run.status);
    const targets = [
        { value: 'supervisor', label: s.team.supervisorName },
        ...run.tasks
            .filter((task) => !['done', 'failed', 'cancelled'].includes(task.status))
            .map((task) => ({ value: task.id, label: `${task.id} ${task.title}` })),
    ];
    const [to, setTo] = useState('supervisor');
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const name = (who: string) =>
        who === 'user'
            ? s.team.user
            : who === 'supervisor'
              ? s.team.supervisorName
              : who === 'host'
                ? s.team.watchName
                : who;
    const send = async () => {
        setBusy(true);
        const updated = await attempt(() => host.call('team.message', { runId: run.id, to, text }));
        setBusy(false);
        if (updated) {
            setText('');
            useApp.setState((state) => ({ teamRuns: { ...state.teamRuns, [updated.id]: updated } }));
        }
    };
    const entries = run.conversation ?? [];
    return (
        <div className="team__conversation">
            {entries.length === 0 ? (
                <Empty>{s.team.noConversation}</Empty>
            ) : (
                <ol className="conversation">
                    {entries.map((entry) => (
                        <li
                            key={`${entry.ts}-${entry.from}-${entry.to}`}
                            className={`conversation__entry is-${entry.kind}`}
                        >
                            <div className="conversation__head">
                                <Badge
                                    tone={
                                        entry.kind === 'challenge'
                                            ? 'error'
                                            : entry.kind === 'watch'
                                              ? 'warn'
                                              : entry.kind === 'user'
                                                ? 'ok'
                                                : entry.kind === 'stage'
                                                  ? 'muted'
                                                  : 'accent'
                                    }
                                >
                                    {s.team.kinds[entry.kind]}
                                </Badge>
                                <span>
                                    {name(entry.from)} → {name(entry.to)}
                                </span>
                                <span className="conversation__time">{new Date(entry.ts).toLocaleTimeString()}</span>
                            </div>
                            <div className="conversation__text">{entry.text}</div>
                        </li>
                    ))}
                </ol>
            )}
            {open && (
                <div className="conversation__composer">
                    <Field label={s.team.to}>
                        <Select label={s.team.to} value={to} options={targets} onChange={setTo} />
                    </Field>
                    <textarea
                        className="textarea"
                        rows={3}
                        value={text}
                        placeholder={s.team.messagePlaceholder}
                        onChange={(event) => setText(event.target.value)}
                    />
                    <div className="row">
                        <button
                            type="button"
                            className="button button--primary"
                            disabled={busy || !text.trim()}
                            onClick={() => void send()}
                        >
                            {busy ? <Spinner /> : null} {s.team.send}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

const TEAM_TERMINAL = ['done', 'failed', 'cancelled'];
const EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const;
const PERMISSIONS = ['plan', 'ask', 'auto_edit', 'full'] as const;

/** The report of a run that is over (06 §22): the outcome, what was done and the next steps, written for the user. */
function TeamBrief({ run }: { run: TeamRun }) {
    const s = useStrings();
    const brief = run.brief;
    const rewrite = () =>
        void attempt(() => host.call('team.brief', { runId: run.id })).then(
            (updated) =>
                updated && useApp.setState((state) => ({ teamRuns: { ...state.teamRuns, [updated.id]: updated } })),
        );
    if (!brief) {
        // A run that ended before reports were written (06 §22) can have one written now.
        if (!['done', 'failed'].includes(run.status)) return null;
        return (
            <section className="overview-card wf-brief" aria-label={s.team.briefTitle}>
                <header className="wf-brief__head">
                    <h3>{s.team.briefTitle}</h3>
                </header>
                <div className="wf-brief__empty">
                    <p>{s.team.briefMissing}</p>
                    <button type="button" className="button button--small button--primary" onClick={rewrite}>
                        {s.team.briefWrite}
                    </button>
                </div>
            </section>
        );
    }
    return (
        <section className={`overview-card wf-brief is-${run.status}`} aria-label={s.team.briefTitle}>
            <header className="wf-brief__head">
                <h3>{s.team.briefTitle}</h3>
                {brief.status !== 'writing' && (
                    <button type="button" className="button button--small" onClick={rewrite}>
                        {s.team.briefRewrite}
                    </button>
                )}
            </header>
            {brief.status === 'writing' ? (
                <div className="wf-brief__writing" aria-busy="true">
                    <p className="overview-muted overview-pulse">{s.team.briefWriting}</p>
                    <span className="wf-skeleton" />
                    <span className="wf-skeleton" />
                    <span className="wf-skeleton is-short" />
                </div>
            ) : brief.status === 'failed' ? (
                <p className="wf-brief__failed">{format(s.team.briefFailed, { note: brief.note ?? '' })}</p>
            ) : (
                <BriefBody text={brief.text ?? ''} />
            )}
        </section>
    );
}

/** Who works a card and with what (06 §22): member · model · thinking · permissions. */
function staffLine(task: TeamTask, run: TeamRun, s: ReturnType<typeof useStrings>): string {
    const member = run.members?.find((item) => item.memberId === task.memberId)?.name ?? task.memberId ?? '';
    return [
        member,
        task.model ?? s.team.byTier,
        task.effort ? s.efforts[task.effort] : undefined,
        task.mode ? s.members.modes[task.mode] : undefined,
    ]
        .filter(Boolean)
        .join(' · ');
}

/** Sets who works a card that has not started, and with what (06 §22). */
function StaffEditor({ run, task, onClose }: { run: TeamRun; task: TeamTask; onClose: () => void }) {
    const s = useStrings();
    const members = useApp((state) => state.members).filter((member) => member.role !== 'supervisor');
    const connected = useApp((state) => state.models);
    const [memberId, setMemberId] = useState(task.memberId ?? '');
    const [model, setModel] = useState(task.preset ? (task.model ?? '') : '');
    const [effort, setEffort] = useState<string>(task.preset ? (task.effort ?? '') : '');
    const [mode, setMode] = useState<string>(task.preset ? (task.mode ?? '') : '');
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        const updated = await attempt(() =>
            host.call('team.presetTask', {
                runId: run.id,
                taskId: task.id,
                ...(memberId ? { memberId } : {}),
                model,
                effort: effort as (typeof EFFORTS)[number] | '',
                mode: mode as (typeof PERMISSIONS)[number] | '',
            }),
        );
        setBusy(false);
        if (updated) {
            useApp.setState((state) => ({ teamRuns: { ...state.teamRuns, [updated.id]: updated } }));
            onClose();
        }
    };
    return (
        <Modal title={format(s.team.staffTitle, { task: `${task.id} ${task.title}` })} onClose={onClose}>
            <div className="dialog">
                <p className="muted">{s.team.staffHint}</p>
                <Field label={s.team.staffMember}>
                    <Select
                        label={s.team.staffMember}
                        value={memberId}
                        options={members.map((member) => ({ value: member.id, label: member.name }))}
                        onChange={setMemberId}
                    />
                </Field>
                <div className="member-editor__row">
                    <Field label={s.members.model}>
                        <Select
                            label={s.members.model}
                            value={model}
                            options={[
                                { value: '', label: s.team.byMember },
                                ...[...new Set(connected.map((option) => option.model.id))].map((id) => ({
                                    value: id,
                                    label: id,
                                })),
                            ]}
                            onChange={setModel}
                        />
                    </Field>
                    <Field label={s.team.staffEffort}>
                        <Select
                            label={s.team.staffEffort}
                            value={effort}
                            options={[
                                { value: '', label: s.team.byMember },
                                ...EFFORTS.map((value) => ({ value, label: s.efforts[value] })),
                            ]}
                            onChange={setEffort}
                        />
                    </Field>
                    <Field label={s.members.mode}>
                        <Select
                            label={s.members.mode}
                            value={mode}
                            options={[
                                { value: '', label: s.team.byRun },
                                ...PERMISSIONS.map((value) => ({ value, label: s.members.modes[value] })),
                            ]}
                            onChange={setMode}
                        />
                    </Field>
                </div>
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !memberId}
                        onClick={() => void save()}
                    >
                        {busy ? <Spinner /> : null} {s.members.save}
                    </button>
                    <button type="button" className="button" onClick={onClose}>
                        {s.common.cancel}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

/** The project's team board (03): its team runs, running ones first, archived ones apart, and a new run. */
/** The team runs of one project or of all (`ALL_PROJECTS`), the ones under way first, and a new run. */
export function TeamBoard({ projectId }: { projectId: string }) {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const all = projectId === ALL_PROJECTS;
    const allRuns = useApp((state) => state.teamRuns);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [showArchived, setShowArchived] = useState(false);
    const load = () => {
        void host
            .call('team.list', all ? {} : { projectId })
            .then((runs) =>
                useApp.setState((state) => ({
                    teamRuns: { ...state.teamRuns, ...Object.fromEntries(runs.map((run) => [run.id, run])) },
                })),
            )
            .catch((error) => toast(errorMessage(error), 'error'));
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: `all` follows `projectId`
    useEffect(load, [projectId]);
    const runs = Object.values(allRuns)
        .filter((run) => all || run.projectId === projectId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? '';
    const running = runs.filter((run) => !TEAM_TERMINAL.includes(run.status));
    const finished = runs.filter((run) => TEAM_TERMINAL.includes(run.status) && !run.archived);
    const archived = runs.filter((run) => TEAM_TERMINAL.includes(run.status) && run.archived);
    const start = () =>
        useApp.setState({
            teamStartFor: all ? (selectedProjectId ?? projects[0]?.id) : projectId,
        });
    const row = (run: TeamRun) => {
        const done = run.tasks.filter((task) => task.status === 'done').length;
        const working = run.tasks.filter((task) =>
            ['assigned', 'in_progress', 'in_review'].includes(task.status),
        ).length;
        return (
            <div key={run.id} className="team-board__run">
                <button type="button" className="team-board__open" onClick={() => openRun('team', run.id)}>
                    <Badge tone={run.status === 'done' ? 'ok' : run.status === 'failed' ? 'error' : 'accent'}>
                        {s.team.statuses[run.status]}
                    </Badge>
                    <span className="team-board__goal" title={run.goal}>
                        {run.title ?? run.goal}
                    </span>
                    <span className="team-board__meta">
                        {all && projects.length > 1 ? `${projectName(run.projectId)} · ` : ''}
                        {run.tasks.length > 0 && format(s.team.progressCount, { done, total: run.tasks.length })}
                        {working > 0 && ` · ${format(s.team.membersWorking, { count: working })}`}
                        {` · ${relativeTime(run.updatedAt)}`}
                        {run.cost.amount > 0 ? ` · ${formatMoney(run.cost)}` : ''}
                    </span>
                </button>
                {TEAM_TERMINAL.includes(run.status) && (
                    <div className="row team-board__actions">
                        <RunActions kind="team" runId={run.id} archived={Boolean(run.archived)} />
                    </div>
                )}
            </div>
        );
    };
    return (
        <div className="wf-board team-board">
            <TeamTabs
                active="runs"
                actions={
                    <>
                        {projects.length > 1 && (
                            <Select
                                compact
                                label={s.sidebar.project}
                                value={projectId}
                                options={[
                                    { value: ALL_PROJECTS, label: s.sidebar.allProjects },
                                    ...projects.map((project) => ({ value: project.id, label: project.name })),
                                ]}
                                onChange={(value) => openTeamBoard(value)}
                            />
                        )}
                        <IconButton icon="refresh" label={s.common.refresh} onClick={load} />
                        <button type="button" className="button button--primary" onClick={start}>
                            <Icon name="plus" size={14} /> {s.team.newRun}
                        </button>
                    </>
                }
            />
            <div className="wf-board__body">
                <p className="wf-board__intro">{s.team.boardHint}</p>
                {runs.length === 0 ? (
                    <div className="wf-board__empty">
                        <Icon name="users" size={22} />
                        <p>{s.team.noRuns}</p>
                        <button type="button" className="button button--primary" onClick={start}>
                            <Icon name="plus" size={14} /> {s.team.newRun}
                        </button>
                    </div>
                ) : (
                    <>
                        {running.length > 0 && (
                            <>
                                <h3 className="wf-board__heading">{s.team.running}</h3>
                                <div className="team-board__runs">{running.map(row)}</div>
                            </>
                        )}
                        {finished.length > 0 && (
                            <>
                                <h3 className="wf-board__heading">{s.team.finished}</h3>
                                <div className="team-board__runs">{finished.map(row)}</div>
                            </>
                        )}
                        {archived.length > 0 && (
                            <button
                                type="button"
                                className="project__archived"
                                onClick={() => setShowArchived(!showArchived)}
                            >
                                {format(s.team.archivedRuns, { count: archived.length })}
                            </button>
                        )}
                        {showArchived && <div className="team-board__runs">{archived.map(row)}</div>}
                    </>
                )}
            </div>
        </div>
    );
}

export function TeamView({ runId }: { runId: string }) {
    const s = useStrings();
    const run = useApp((state) => state.teamRuns[runId]);
    const [tab, setTab] = useState<'overview' | 'board' | 'ledger' | 'conversation' | 'cost' | 'report'>('overview');
    const approvals = useApp((state) => state.approvals);
    // What the run waits on from the user, wherever in its threads it was asked: the plan, risky commands, the delivery.
    const runThreads = new Set(run ? [run.supervisorThreadId, ...run.tasks.map((task) => task.threadId)] : []);
    // The supervisor answers some for the user (06 §24): those are not the user's to see here.
    const pending = approvals.filter((approval) => runThreads.has(approval.threadId) && !approval.reviewer);
    const [budget, setBudget] = useState('');
    useEffect(() => {
        void host
            .call('team.get', { runId })
            .then((loaded) => useApp.setState((state) => ({ teamRuns: { ...state.teamRuns, [loaded.id]: loaded } })))
            .catch((error) => toast(errorMessage(error), 'error'));
    }, [runId]);
    if (!run)
        return (
            <Empty>
                <Spinner />
            </Empty>
        );
    const share = Math.round(run.supervisionShare * 100);
    // Until a member has spent anything the supervisor's share is all of it, which says nothing yet.
    const membersSpent = run.tasks.some((task) => (task.cost?.amount ?? 0) > 0);
    // A run paused on its budget continues only with a larger one.
    const spent = run.status === 'paused' && run.budget !== null && run.cost.amount >= run.budget.amount;
    return (
        <div className="team">
            <header className="team__header">
                <div className="team__goal">
                    <h1 title={run.goal}>{run.goal}</h1>
                    <div className="team__meta">
                        <Badge tone={run.status === 'done' ? 'ok' : run.status === 'failed' ? 'error' : 'accent'}>
                            {s.team.statuses[run.status]}
                        </Badge>
                        <span>
                            {s.team.autonomy}
                            {run.autonomy}
                        </span>
                        {run.mode === 'hypotheses' && <Badge tone="accent">{s.team.hypothesesBadge}</Badge>}
                        <span>
                            {s.thread.cost} {formatMoney(run.cost)}
                            {run.budget ? ` / ${formatMoney(run.budget)}` : ''}
                        </span>
                        {membersSpent && (
                            <span className={share > 25 ? 'team__share is-high' : 'team__share'}>
                                {format(s.team.supervision, { share })}
                            </span>
                        )}
                    </div>
                    {run.note && <div className="team__note">{run.note}</div>}
                    {run.warnings?.map((warning) => (
                        <div key={warning} className="team__warning">
                            {warning}
                        </div>
                    ))}
                </div>
                <div className="row">
                    {run.supervisorThreadId && (
                        <button
                            type="button"
                            className="button button--small"
                            onClick={() =>
                                run.supervisorThreadId &&
                                void selectThread(run.supervisorThreadId).then(() =>
                                    useApp.setState({ teamRunId: undefined }),
                                )
                            }
                        >
                            {s.team.openSupervisor}
                        </button>
                    )}
                    {spent && (
                        <input
                            className="input team__budget"
                            type="number"
                            min={0}
                            step={1}
                            value={budget}
                            placeholder={s.team.newBudget}
                            aria-label={s.team.newBudget}
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
                                    host.call('team.resume', {
                                        runId,
                                        ...(Number(budget) > 0 ? { budget: Number(budget) } : {}),
                                    }),
                                )
                            }
                        >
                            {s.team.resume}
                        </button>
                    )}
                    {!TEAM_TERMINAL.includes(run.status) && (
                        <Popover
                            label={`${s.team.permission}：${s.team.permissions[run.permission ?? 'default']}`}
                            placement="down"
                            align="end"
                            className="picker"
                            triggerClassName={`picker__trigger mode-chip is-${run.permission ?? 'default'}`}
                            trigger={
                                <>
                                    <Icon name={RUN_MODE_ICONS[run.permission ?? 'default']} size={13} />
                                    {s.team.permissions[run.permission ?? 'default']}
                                    <Icon name="chevronDown" size={12} className="picker__chevron" />
                                </>
                            }
                        >
                            {(close) => (
                                <>
                                    <div className="popover__title">{s.team.permission}</div>
                                    <Choices
                                        value={run.permission ?? 'default'}
                                        options={(['full', 'auto_edit', 'default'] as const).map((value) => ({
                                            value,
                                            label: s.team.permissions[value],
                                            hint: s.team.permissionHints[value],
                                            icon: RUN_MODE_ICONS[value],
                                            ...(value === 'full' ? { tone: 'warn' as const } : {}),
                                        }))}
                                        onPick={(permission) => {
                                            close();
                                            void attempt(() =>
                                                host.call('team.setPermission', { runId, permission }),
                                            ).then(
                                                (updated) =>
                                                    updated &&
                                                    useApp.setState((state) => ({
                                                        teamRuns: { ...state.teamRuns, [updated.id]: updated },
                                                    })),
                                            );
                                        }}
                                    />
                                </>
                            )}
                        </Popover>
                    )}
                    {!TEAM_TERMINAL.includes(run.status) && (
                        <button
                            type="button"
                            className="button button--small button--danger"
                            onClick={() => void attempt(() => host.call('team.stop', { runId }))}
                        >
                            {s.team.stop}
                        </button>
                    )}
                    {TEAM_TERMINAL.includes(run.status) && (
                        <RunActions kind="team" runId={runId} archived={Boolean(run.archived)} />
                    )}
                </div>
            </header>
            {pending.length > 0 && (
                <section
                    className="team__approvals"
                    aria-label={format(s.team.pendingApprovals, { count: pending.length })}
                >
                    <h3>{format(s.team.pendingApprovals, { count: pending.length })}</h3>
                    {pending.map((approval) => (
                        <div key={approval.id} className="approval approval--pending">
                            <PendingApproval approval={approval} />
                            <button type="button" className="link" onClick={() => selectThread(approval.threadId)}>
                                {s.team.openThread}
                            </button>
                        </div>
                    ))}
                </section>
            )}
            <div className="segmented team__tabs">
                {(['overview', 'board', 'ledger', 'conversation', 'cost', 'report'] as const).map((key) => (
                    <button
                        key={key}
                        type="button"
                        className={tab === key ? 'is-active' : ''}
                        onClick={() => setTab(key)}
                    >
                        {s.team.tabs[key]}
                    </button>
                ))}
            </div>
            {tab === 'overview' && <TaskOverview run={run} onReport={() => setTab('report')} />}
            {tab === 'board' &&
                (run.tasks.length === 0 ? (
                    <Empty>{s.team.noTasks}</Empty>
                ) : (
                    <div className="board">
                        {COLUMNS.map((column) => {
                            const tasks = run.tasks.filter((task) => column.statuses.includes(task.status));
                            return (
                                <div key={column.key} className="board__column">
                                    <div className="board__title">
                                        {s.team.columns[column.key as keyof typeof s.team.columns]}{' '}
                                        <span>{tasks.length}</span>
                                    </div>
                                    {tasks.map((task) => (
                                        <TaskCard key={task.id} task={task} />
                                    ))}
                                </div>
                            );
                        })}
                    </div>
                ))}
            {tab === 'ledger' && (
                <div className="team__ledger">
                    <h3>{s.team.taskLedger}</h3>
                    <LedgerView ledger={run.ledger} />
                    <h3>{s.team.progressLedger}</h3>
                    <ol className="progress-list">
                        {run.progress.map((entry, index) => {
                            const value = entry as {
                                ts?: number;
                                reason?: string;
                                complete?: boolean;
                                progressing?: boolean;
                                looping?: boolean;
                            };
                            return (
                                // biome-ignore lint/suspicious/noArrayIndexKey: ledger entries are append-only
                                <li key={index}>
                                    {value.ts ? new Date(value.ts).toLocaleTimeString() : ''}{' '}
                                    {value.complete ? '✓' : value.progressing ? '→' : value.looping ? '↻' : '…'}{' '}
                                    {value.reason ?? ''}
                                </li>
                            );
                        })}
                    </ol>
                </div>
            )}
            {tab === 'conversation' && <Conversation run={run} />}
            {tab === 'cost' && (
                <table className="table">
                    <tbody>
                        {Object.entries(run.costByTier).map(([tier, amount]) => (
                            <tr key={tier}>
                                <td>{s.team.tiers[tier as keyof typeof s.team.tiers] ?? tier}</td>
                                <td>{formatMoney({ amount, currency: run.cost.currency })}</td>
                            </tr>
                        ))}
                        <tr>
                            <td>
                                <strong>{s.usage.total}</strong>
                            </td>
                            <td>
                                <strong>{formatMoney(run.cost)}</strong>
                            </td>
                        </tr>
                    </tbody>
                </table>
            )}
            {tab === 'report' &&
                (run.report || run.brief ? (
                    <div className="team-report">
                        <TeamBrief run={run} />
                        {run.report && (
                            <details className="team-report__details">
                                <summary>{s.team.reportDetails}</summary>
                                <Markdown text={run.report} />
                            </details>
                        )}
                    </div>
                ) : (
                    <Empty>{s.team.noReport}</Empty>
                ))}
        </div>
    );
}

export function TeamStartDialog({ projectId: initial }: { projectId: string }) {
    const s = useStrings();
    // Opened from the board of every project, it starts where the user picks.
    const projects = useApp((state) => state.projects);
    const [projectId, setProjectId] = useState(initial);
    // 06 §24: the group it goes to: its lead supervises, its members work.
    const groups = useApp((state) => state.org?.groups ?? []);
    const startGroup = useApp((state) => state.teamStartGroup);
    const [groupId, setGroupId] = useState(startGroup ?? groups[0]?.id ?? '');
    const firstGroup = groups[0]?.id;
    // The chart may arrive after the dialog opens: it then starts with the first group.
    useEffect(() => {
        if (!groupId && firstGroup) setGroupId(startGroup ?? firstGroup);
    }, [groupId, firstGroup, startGroup]);
    const group = groups.find((item) => item.id === groupId);
    // Starts from what the user chose last time (the host remembers it on each start).
    const last = useApp((state) => state.settings?.lastChoices);
    const [goal, setGoal] = useState('');
    const [autonomy, setAutonomy] = useState<'L0' | 'L1' | 'L2' | 'L3'>(last?.teamAutonomy ?? 'L1');
    const [mode, setMode] = useState<'standard' | 'hypotheses'>(last?.teamMode ?? 'standard');
    const [budget, setBudget] = useState(last?.teamBudget ? String(last.teamBudget) : '');
    const quiet = useApp((state) => (state.settings?.approvals.reviewer ?? 'supervisor') === 'supervisor');
    const currency = useApp((state) => state.settings?.currency ?? 'CNY');
    // 06 §21: members act without asking unless the user picks otherwise; high-risk actions always ask.
    const [permission, setPermission] = useState<'default' | 'auto_edit' | 'full'>(last?.teamPermission ?? 'full');
    const defaultParallel = useApp((state) => state.settings?.team.maxParallel ?? 3);
    const [parallel, setParallel] = useState(String(defaultParallel));
    // 06 §22: the supervisor picks the members, or the user does, each with its model, thinking and permissions.
    const members = useApp((state) => state.members).filter(
        (member) => member.role !== 'supervisor' && (!group || group.memberIds.includes(member.id)),
    );
    const connected = useApp((state) => state.models);
    const [staffMode, setStaffMode] = useState<'auto' | 'manual'>('auto');
    const [staff, setStaff] = useState<Record<string, { model: string; effort: string; mode: string }>>({});
    // The members of the project the run starts in: project members differ between projects.
    useEffect(() => {
        void loadMembers(projectId);
    }, [projectId]);
    const chosen = Object.entries(staff);
    const toggle = (memberId: string) =>
        setStaff((current) => {
            const { [memberId]: present, ...rest } = current;
            return present ? rest : { ...current, [memberId]: { model: '', effort: '', mode: '' } };
        });
    const setField = (memberId: string, field: 'model' | 'effort' | 'mode', value: string) =>
        setStaff((current) => ({
            ...current,
            [memberId]: { ...(current[memberId] ?? { model: '', effort: '', mode: '' }), [field]: value },
        }));
    const [busy, setBusy] = useState(false);
    const close = () => useApp.setState({ teamStartFor: undefined, teamStartGroup: undefined });
    const start = async () => {
        setBusy(true);
        const run = await attempt(() =>
            host.call(
                'team.start',
                {
                    projectId,
                    goal,
                    ...(groupId ? { groupId } : {}),
                    autonomy,
                    mode,
                    permission,
                    parallel: Number(parallel),
                    ...(staffMode === 'manual' && chosen.length > 0
                        ? {
                              members: chosen.map(([memberId, preset]) => ({
                                  memberId,
                                  ...(preset.model ? { model: preset.model } : {}),
                                  ...(preset.effort ? { effort: preset.effort as (typeof EFFORTS)[number] } : {}),
                                  ...(preset.mode ? { mode: preset.mode as (typeof PERMISSIONS)[number] } : {}),
                              })),
                          }
                        : {}),
                    ...(Number(budget) > 0 ? { budget: Number(budget) } : {}),
                },
                { timeoutMs: 120_000 },
            ),
        );
        setBusy(false);
        if (run) {
            useApp.setState((state) => ({
                teamRuns: { ...state.teamRuns, [run.id]: run },
                teamRunId: run.id,
                teamStartFor: undefined,
                teamStartGroup: undefined,
            }));
        }
    };
    return (
        <Modal title={s.team.start} onClose={close}>
            <div className="dialog">
                {projects.length > 1 && (
                    <Field label={s.sidebar.project}>
                        <Select
                            label={s.sidebar.project}
                            value={projectId}
                            options={projects.map((project) => ({ value: project.id, label: project.name }))}
                            onChange={(value) => {
                                setProjectId(value);
                                setStaff({});
                            }}
                        />
                    </Field>
                )}
                {groups.length > 0 && (
                    <Field label={s.org.handToGroup} hint={s.org.handToGroupHint}>
                        <Select
                            label={s.org.handToGroup}
                            value={groupId}
                            options={groups.map((item) => ({ value: item.id, label: item.name }))}
                            onChange={(value) => {
                                setGroupId(value);
                                setStaff({});
                            }}
                        />
                    </Field>
                )}
                <Field label={s.team.goal} hint={s.team.goalHint}>
                    <textarea
                        className="textarea"
                        rows={5}
                        value={goal}
                        onChange={(event) => setGoal(event.target.value)}
                    />
                </Field>
                <Field label={s.team.mode}>
                    <Select
                        label={s.team.mode}
                        value={mode}
                        options={(['standard', 'hypotheses'] as const).map((value) => ({
                            value,
                            label: s.team.modes[value],
                        }))}
                        onChange={setMode}
                    />
                </Field>
                <Field label={s.team.autonomy}>
                    <Select
                        label={s.team.autonomy}
                        value={autonomy}
                        options={(['L0', 'L1', 'L2', 'L3'] as const).map((level) => ({
                            value: level,
                            // 06 §24: with the supervisor answering approvals, L2 is hands-off.
                            label: `${level}：${(quiet ? s.team.levelsQuiet : s.team.levels)[level]}`,
                        }))}
                        onChange={(level) => {
                            setAutonomy(level);
                            // Nobody watches L3: it needs a spending cap, suggested here.
                            if (level === 'L3' && !(Number(budget) > 0)) setBudget(currency === 'USD' ? '3' : '20');
                        }}
                    />
                </Field>
                <Field
                    label={s.team.permission}
                    hint={
                        autonomy === 'L3' && permission === 'full'
                            ? s.team.permissionL3
                            : s.team.permissionHints[permission]
                    }
                >
                    <Select
                        label={s.team.permission}
                        value={permission}
                        options={(['full', 'auto_edit', 'default'] as const).map((value) => ({
                            value,
                            label: s.team.permissions[value],
                        }))}
                        onChange={setPermission}
                    />
                </Field>
                <Field
                    label={s.team.staffChoose}
                    hint={staffMode === 'auto' ? s.team.staffAutoHint : s.team.staffManualHint}
                >
                    <div className="segmented">
                        {(['auto', 'manual'] as const).map((value) => (
                            <button
                                key={value}
                                type="button"
                                className={staffMode === value ? 'is-active' : ''}
                                onClick={() => setStaffMode(value)}
                            >
                                {value === 'auto' ? s.team.staffAuto : s.team.staffManual}
                            </button>
                        ))}
                    </div>
                </Field>
                {staffMode === 'manual' && (
                    <div className="team-staff">
                        {members.map((member) => {
                            const preset = staff[member.id];
                            return (
                                <div key={member.id} className={`team-staff__row${preset ? ' is-on' : ''}`}>
                                    <label className="team-staff__who">
                                        <input
                                            type="checkbox"
                                            checked={Boolean(preset)}
                                            onChange={() => toggle(member.id)}
                                        />
                                        <span>{member.name}</span>
                                        <span className="muted">{member.description ?? member.role}</span>
                                    </label>
                                    {preset && (
                                        <div className="team-staff__settings">
                                            <Select
                                                label={s.members.model}
                                                value={preset.model}
                                                options={[
                                                    { value: '', label: member.model ?? s.team.byTier },
                                                    ...[...new Set(connected.map((option) => option.model.id))].map(
                                                        (id) => ({ value: id, label: id }),
                                                    ),
                                                ]}
                                                onChange={(value) => setField(member.id, 'model', value)}
                                            />
                                            <Select
                                                label={s.team.staffEffort}
                                                value={preset.effort}
                                                options={[
                                                    { value: '', label: `${s.team.staffEffort}：${s.team.byMember}` },
                                                    ...EFFORTS.map((value) => ({ value, label: s.efforts[value] })),
                                                ]}
                                                onChange={(value) => setField(member.id, 'effort', value)}
                                            />
                                            <Select
                                                label={s.members.mode}
                                                value={preset.mode}
                                                options={[
                                                    { value: '', label: s.team.byRun },
                                                    ...PERMISSIONS.map((value) => ({
                                                        value,
                                                        label: s.members.modes[value],
                                                    })),
                                                ]}
                                                onChange={(value) => setField(member.id, 'mode', value)}
                                            />
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {chosen.length === 0 && <p className="muted">{s.team.staffNone}</p>}
                    </div>
                )}
                <Field label={s.team.parallel} hint={s.team.parallelHint}>
                    <Select
                        label={s.team.parallel}
                        value={parallel}
                        options={['1', '2', '3', '4', '5', '6', '7', '8'].map((value) => ({ value, label: value }))}
                        onChange={setParallel}
                    />
                </Field>
                <Field label={s.goal.budget}>
                    <input
                        className="input"
                        type="number"
                        min={0}
                        step={1}
                        value={budget}
                        placeholder={autonomy === 'L3' ? s.team.budgetRequired : s.settings.noLimit}
                        onChange={(event) => setBudget(event.target.value)}
                    />
                </Field>
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={
                            busy ||
                            !goal.trim() ||
                            (autonomy === 'L3' && !(Number(budget) > 0)) ||
                            (staffMode === 'manual' && chosen.length === 0)
                        }
                        onClick={() => void start()}
                    >
                        {busy ? <Spinner /> : null} {s.team.go}
                    </button>
                    <button type="button" className="button" onClick={close}>
                        {s.common.cancel}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

/** The task ledger as sections: the approach, then facts, assumptions, decisions and risks. */
function LedgerView({ ledger }: { ledger: unknown }) {
    const s = useStrings();
    const content = (ledger ?? undefined) as
        | Partial<{
              plan: string;
              facts: string[];
              assumptions: string[];
              decisions: string[];
              risks: string[];
              version: number;
          }>
        | undefined;
    if (!content || typeof content !== 'object') {
        return <p className="muted">—</p>;
    }
    const list = (title: string, items: readonly string[] | undefined) =>
        items && items.length > 0 ? (
            <section className="ledger__section">
                <h4>{title}</h4>
                <ul>
                    {items.map((item) => (
                        <li key={item}>{item}</li>
                    ))}
                </ul>
            </section>
        ) : null;
    return (
        <div className="ledger">
            {content.plan && (
                <section className="ledger__section">
                    <h4>{s.team.ledgerPlan}</h4>
                    <p>{content.plan}</p>
                </section>
            )}
            {list(s.team.ledgerFacts, content.facts)}
            {list(s.team.ledgerAssumptions, content.assumptions)}
            {list(s.team.ledgerDecisions, content.decisions)}
            {list(s.team.ledgerRisks, content.risks)}
            {content.version !== undefined && (
                <div className="muted">{format(s.team.ledgerVersion, { version: content.version })}</div>
            )}
        </div>
    );
}

/** The steps a run goes through; paused, failed and stopped runs show how far they got. */
const PHASES = ['planning', 'approval', 'running', 'integrating', 'done'] as const;

function reachedPhase(run: TeamRun): number {
    if (run.status === 'done') return 4;
    if (run.status === 'integrating' || run.report) return 3;
    if (run.tasks.some((task) => !['pending', 'ready'].includes(task.status))) return 2;
    if (run.status === 'awaiting_plan_approval' || run.tasks.length > 0) return 1;
    return 0;
}

interface Deliverable {
    readonly summary?: string;
    readonly changes?: ReadonlyArray<{ readonly file: string }>;
}

function useElapsed(run: TeamRun): string {
    const s = useStrings();
    const live = !['done', 'failed', 'cancelled'].includes(run.status);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!live) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [live]);
    const seconds = Math.max(0, Math.round(((live ? now : run.updatedAt) - run.createdAt) / 1000));
    return seconds >= 60
        ? format(s.team.minutes, { m: Math.floor(seconds / 60), s: seconds % 60 })
        : format(s.team.seconds, { s: seconds });
}

/**
 * The run as its supervisor reports it (the default tab): how far it got, what the supervisor last said, what each
 * member concluded, the progress record, and a box to write to the supervisor or, once it ended, to go on with it.
 */
function TaskOverview({ run, onReport }: { run: TeamRun; onReport: () => void }) {
    const s = useStrings();
    const live = !['done', 'failed', 'cancelled'].includes(run.status);
    const reached = reachedPhase(run);
    const done = run.tasks.filter((task) => task.status === 'done').length;
    const elapsed = useElapsed(run);
    const feedback = run.feedback ?? [];
    const latest = feedback.at(-1);
    const earlier = feedback.slice(0, -1).reverse();
    const [showEarlier, setShowEarlier] = useState(false);
    const progress = [...run.progress].reverse() as Array<{ ts?: number; reason?: string; complete?: boolean }>;
    const [showAll, setShowAll] = useState(false);
    const [staffing, setStaffing] = useState<TeamTask | undefined>();
    const counts = COLUMNS.map((column) => ({
        key: column.key,
        count: run.tasks.filter((task) => column.statuses.includes(task.status)).length,
    }));
    return (
        <div className="task-overview">
            <TeamBrief run={run} />
            <section className="overview-card overview-progress" aria-label={s.team.progressTitle}>
                <ol className="stepper">
                    {PHASES.map((phase, index) => (
                        <li
                            key={phase}
                            className={`stepper__step${index < reached || run.status === 'done' ? ' is-done' : ''}${
                                index === reached && live ? ' is-active' : ''
                            }`}
                        >
                            <span className="stepper__dot" aria-hidden="true" />
                            <span>{s.team.phases[phase]}</span>
                        </li>
                    ))}
                </ol>
                <div className="overview-progress__row">
                    <span>{format(s.team.tasksDone, { done, total: run.tasks.length })}</span>
                    <span>{format(s.team.elapsed, { time: elapsed })}</span>
                    <span>
                        {s.thread.cost} {formatMoney(run.cost)}
                        {run.budget ? ` / ${formatMoney(run.budget)}` : ''}
                    </span>
                    {run.continues && <span className="overview-progress__continued">{s.team.continuedFrom}</span>}
                </div>
                <div className="progress-bar" aria-hidden="true">
                    <div
                        className="progress-bar__fill"
                        style={{ width: `${run.tasks.length > 0 ? Math.round((done / run.tasks.length) * 100) : 0}%` }}
                    />
                </div>
            </section>

            <section className="overview-card feedback-card" aria-label={s.team.feedbackTitle}>
                <h3>
                    <span className="feedback-card__avatar" aria-hidden="true">
                        {s.team.supervisorName.slice(0, 1)}
                    </span>
                    {s.team.feedbackTitle}
                    {latest && <time>{new Date(latest.ts).toLocaleTimeString()}</time>}
                </h3>
                {latest ? (
                    <div className="feedback-card__latest">
                        <Markdown text={latest.text} />
                    </div>
                ) : (
                    <p className="overview-muted overview-pulse">{s.team.feedbackEmpty}</p>
                )}
                {earlier.length > 0 && (
                    <>
                        <button type="button" className="link" onClick={() => setShowEarlier(!showEarlier)}>
                            {format(s.team.earlierFeedback, { count: earlier.length })}
                        </button>
                        {showEarlier &&
                            earlier.map((entry) => (
                                <div key={entry.ts} className="feedback-card__earlier">
                                    <time>{new Date(entry.ts).toLocaleTimeString()}</time>
                                    <Markdown text={entry.text} />
                                </div>
                            ))}
                    </>
                )}
            </section>

            <section className="overview-section" aria-label={s.team.conclusionsTitle}>
                <h3>{s.team.conclusionsTitle}</h3>
                {run.tasks.length === 0 ? (
                    <p className="overview-muted">{s.team.conclusionsEmpty}</p>
                ) : (
                    <div className="conclusion-grid">
                        {run.tasks.map((task) => {
                            const deliverable = task.deliverable as Deliverable | undefined;
                            const files = deliverable?.changes?.map((change) => change.file) ?? [];
                            const working = ['assigned', 'in_progress', 'in_review'].includes(task.status);
                            return (
                                <article key={task.id} className={`conclusion-card status--${task.status}`}>
                                    <header>
                                        <span className="conclusion-card__title">{task.title}</span>
                                        <span className={`status-pill status--${task.status}`}>
                                            {(s.team.taskStatuses as Record<string, string>)[task.status] ??
                                                task.status}
                                        </span>
                                    </header>
                                    <div className="conclusion-card__meta">
                                        <code>{task.id}</code>
                                        {task.assignee && <span>{task.assignee}</span>}
                                        <span>{s.team.tiers[task.tier as keyof typeof s.team.tiers] ?? task.tier}</span>
                                        {task.stage && <span>{format(s.team.stage, { count: task.stage })}</span>}
                                        {task.remaining && task.remaining.length > 0 && (
                                            <span>{format(s.team.remaining, { count: task.remaining.length })}</span>
                                        )}
                                        {task.cost && <span>{formatMoney(task.cost)}</span>}
                                        {task.watch && (
                                            <Badge tone="warn">
                                                {s.team.watchName}：
                                                {(s.team.watchRules as Record<string, string>)[task.watch.rule] ??
                                                    task.watch.rule}
                                            </Badge>
                                        )}
                                    </div>
                                    <div className="conclusion-card__body">
                                        {deliverable?.summary ? (
                                            <Markdown text={deliverable.summary} />
                                        ) : (
                                            <p className={`overview-muted${working ? ' overview-pulse' : ''}`}>
                                                {working ? s.team.working : s.team.waiting}
                                            </p>
                                        )}
                                    </div>
                                    {task.memberId && (
                                        <div className="conclusion-card__staff">
                                            <span>{staffLine(task, run, s)}</span>
                                            {live &&
                                                ['pending', 'ready', 'blocked', 'failed'].includes(task.status) && (
                                                    <button
                                                        type="button"
                                                        className="link"
                                                        onClick={() => setStaffing(task)}
                                                    >
                                                        {s.team.staffEdit}
                                                    </button>
                                                )}
                                        </div>
                                    )}
                                    {files.length > 0 && (
                                        <div className="conclusion-card__files">
                                            {format(s.team.changedFiles, { files: files.slice(0, 6).join('、') })}
                                        </div>
                                    )}
                                    {working && task.remaining && task.remaining.length > 0 && (
                                        <ul className="conclusion-card__remaining">
                                            {task.remaining.slice(0, 4).map((item) => (
                                                <li key={item}>{item}</li>
                                            ))}
                                        </ul>
                                    )}
                                    {task.guidance && (
                                        <div className="conclusion-card__guidance">
                                            {s.team.guidance}
                                            {task.guidance}
                                        </div>
                                    )}
                                    <footer>
                                        {task.verdict && (
                                            <span
                                                className={
                                                    task.verdict.verdict === 'pass'
                                                        ? 'verdict is-pass'
                                                        : 'verdict is-fail'
                                                }
                                            >
                                                {task.verdict.verdict === 'pass'
                                                    ? s.team.verdictPass
                                                    : s.team.verdictFail}
                                            </span>
                                        )}
                                        {task.threadId && (
                                            <button
                                                type="button"
                                                className="link"
                                                onClick={() =>
                                                    task.threadId &&
                                                    void selectThread(task.threadId).then(() =>
                                                        useApp.setState({ teamRunId: undefined }),
                                                    )
                                                }
                                            >
                                                {s.team.openThread}
                                            </button>
                                        )}
                                    </footer>
                                </article>
                            );
                        })}
                    </div>
                )}
            </section>

            <section className="overview-section" aria-label={s.team.reportTitle}>
                <h3>{s.team.reportTitle}</h3>
                <div className="status-counts">
                    {counts.map((item) => (
                        <span key={item.key} className={`status-count status-count--${item.key}`}>
                            {s.team.columns[item.key as keyof typeof s.team.columns]} <strong>{item.count}</strong>
                        </span>
                    ))}
                    {run.report && (
                        <button type="button" className="link" onClick={onReport}>
                            {s.team.openReport}
                        </button>
                    )}
                </div>
                {progress.length === 0 ? (
                    <p className="overview-muted">{s.team.timelineEmpty}</p>
                ) : (
                    <ol className="progress-timeline">
                        {(showAll ? progress : progress.slice(0, 8)).map((entry) => (
                            <li
                                key={`${entry.ts ?? ''}:${entry.reason ?? ''}`}
                                className={
                                    entry.complete ? 'progress-timeline__item is-complete' : 'progress-timeline__item'
                                }
                            >
                                <time>{entry.ts ? new Date(entry.ts).toLocaleTimeString() : ''}</time>
                                <span>{entry.reason ?? ''}</span>
                            </li>
                        ))}
                    </ol>
                )}
                {!showAll && progress.length > 8 && (
                    <button type="button" className="link" onClick={() => setShowAll(true)}>
                        {format(s.team.showAll, { count: progress.length })}
                    </button>
                )}
            </section>

            <OverviewComposer run={run} />
            {staffing && <StaffEditor run={run} task={staffing} onClose={() => setStaffing(undefined)} />}
        </div>
    );
}

/** Writes to the supervisor while the run goes on; once it ended, starts a run that continues it. */
function OverviewComposer({ run }: { run: TeamRun }) {
    const s = useStrings();
    const live = !['done', 'failed', 'cancelled'].includes(run.status);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const send = async () => {
        const value = text.trim();
        if (!value) return;
        setBusy(true);
        try {
            if (live) {
                const updated = await host.call('team.message', { runId: run.id, to: 'supervisor', text: value });
                useApp.setState((state) => ({ teamRuns: { ...state.teamRuns, [updated.id]: updated } }));
            } else {
                const next = await host.call('team.start', {
                    projectId: run.projectId,
                    goal: value,
                    autonomy: run.autonomy,
                    ...(run.budget ? { budget: run.budget.amount } : {}),
                    continues: run.id,
                });
                useApp.setState((state) => ({ teamRuns: { ...state.teamRuns, [next.id]: next }, teamRunId: next.id }));
            }
            setText('');
        } catch (error) {
            toast(errorMessage(error), 'error');
        }
        setBusy(false);
    };
    return (
        <section
            className="overview-card overview-composer"
            aria-label={live ? s.team.feedbackTitle : s.team.continueTitle}
        >
            {!live && <h3>{s.team.continueTitle}</h3>}
            <textarea
                className="textarea"
                rows={3}
                value={text}
                placeholder={live ? s.team.messageSupervisor : s.team.continuePlaceholder}
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
                    {busy ? <Spinner /> : null} {live ? s.thread.send : s.team.continueButton}
                </button>
            </div>
        </section>
    );
}
