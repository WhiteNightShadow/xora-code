import type { TeamRun, TeamTask } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { errorMessage, host } from '../host.ts';
import { PendingApproval } from '../items/ItemView.tsx';
import { attempt, selectThread, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { Markdown } from './Markdown.tsx';
import { Badge, Empty, Field, formatMoney, Modal, Select, Spinner } from './primitives.tsx';

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
                {task.cost && <span>{formatMoney(task.cost)}</span>}
            </div>
            {task.verdict && task.verdict.verdict !== 'pass' && (
                <div className="task-card__verdict">
                    {task.verdict.reasons.slice(0, 2).join('；')}
                    {task.verdict.outOfOwnership.length > 0 &&
                        ` · ${s.team.outOfOwnership}${task.verdict.outOfOwnership.join(', ')}`}
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
    const name = (who: string) => (who === 'user' ? s.team.user : who === 'supervisor' ? s.team.supervisorName : who);
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
                                        entry.kind === 'challenge' ? 'error' : entry.kind === 'user' ? 'ok' : 'accent'
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

export function TeamView({ runId }: { runId: string }) {
    const s = useStrings();
    const run = useApp((state) => state.teamRuns[runId]);
    const [tab, setTab] = useState<'board' | 'ledger' | 'conversation' | 'cost' | 'report'>('board');
    const approvals = useApp((state) => state.approvals);
    // What the run waits on from the user, wherever in its threads it was asked: the plan, risky commands, the delivery.
    const runThreads = new Set(run ? [run.supervisorThreadId, ...run.tasks.map((task) => task.threadId)] : []);
    const pending = approvals.filter((approval) => runThreads.has(approval.threadId));
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
                    {!['done', 'failed', 'cancelled'].includes(run.status) && (
                        <button
                            type="button"
                            className="button button--small button--danger"
                            onClick={() => void attempt(() => host.call('team.stop', { runId }))}
                        >
                            {s.team.stop}
                        </button>
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
                {(['board', 'ledger', 'conversation', 'cost', 'report'] as const).map((key) => (
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
            {tab === 'report' && (run.report ? <Markdown text={run.report} /> : <Empty>{s.team.noReport}</Empty>)}
        </div>
    );
}

export function TeamStartDialog({ projectId }: { projectId: string }) {
    const s = useStrings();
    const [goal, setGoal] = useState('');
    const [autonomy, setAutonomy] = useState<'L0' | 'L1' | 'L2' | 'L3'>('L1');
    const [mode, setMode] = useState<'standard' | 'hypotheses'>('standard');
    const [budget, setBudget] = useState('');
    const [busy, setBusy] = useState(false);
    const close = () => useApp.setState({ teamStartFor: undefined });
    const start = async () => {
        setBusy(true);
        const run = await attempt(() =>
            host.call(
                'team.start',
                { projectId, goal, autonomy, mode, ...(Number(budget) > 0 ? { budget: Number(budget) } : {}) },
                { timeoutMs: 120_000 },
            ),
        );
        setBusy(false);
        if (run) {
            useApp.setState((state) => ({
                teamRuns: { ...state.teamRuns, [run.id]: run },
                teamRunId: run.id,
                teamStartFor: undefined,
            }));
        }
    };
    return (
        <Modal title={s.team.start} onClose={close}>
            <div className="dialog">
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
                            label: `${level}：${s.team.levels[level]}`,
                        }))}
                        onChange={setAutonomy}
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
                        disabled={busy || !goal.trim() || (autonomy === 'L3' && !(Number(budget) > 0))}
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
