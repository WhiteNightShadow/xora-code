import type { TeamTask } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { errorMessage, host } from '../host.ts';
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

export function TeamView({ runId }: { runId: string }) {
    const s = useStrings();
    const run = useApp((state) => state.teamRuns[runId]);
    const [tab, setTab] = useState<'board' | 'ledger' | 'cost' | 'report'>('board');
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
    return (
        <div className="team">
            <header className="team__header">
                <div className="team__goal">
                    <h1>{run.goal}</h1>
                    <div className="team__meta">
                        <Badge tone={run.status === 'done' ? 'ok' : run.status === 'failed' ? 'error' : 'accent'}>
                            {s.team.statuses[run.status]}
                        </Badge>
                        <span>
                            {s.team.autonomy}
                            {run.autonomy}
                        </span>
                        <span>
                            {s.thread.cost} {formatMoney(run.cost)}
                            {run.budget ? ` / ${formatMoney(run.budget)}` : ''}
                        </span>
                        <span className={share > 25 ? 'team__share is-high' : 'team__share'}>
                            {format(s.team.supervision, { share })}
                        </span>
                    </div>
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
                    {['planning', 'awaiting_plan_approval', 'running', 'integrating'].includes(run.status) && (
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
            <div className="segmented team__tabs">
                {(['board', 'ledger', 'cost', 'report'] as const).map((key) => (
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
                    <pre className="layer__text">{run.ledger ? JSON.stringify(run.ledger, null, 2) : '—'}</pre>
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
    const [budget, setBudget] = useState('');
    const [busy, setBusy] = useState(false);
    const close = () => useApp.setState({ teamStartFor: undefined });
    const start = async () => {
        setBusy(true);
        const run = await attempt(() =>
            host.call(
                'team.start',
                { projectId, goal, autonomy, ...(Number(budget) > 0 ? { budget: Number(budget) } : {}) },
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
