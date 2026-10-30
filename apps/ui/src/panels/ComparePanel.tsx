import type { ThreadMeta } from '@xora/protocol';
import { Badge, formatMoney } from '../components/primitives.tsx';
import { host } from '../host.ts';
import { attempt, selectThread, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';

/** Best-of-n candidates side by side: status, cost and changed files; apply one to the project folder. */
export function ComparePanel({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const candidates = useApp((state) =>
        Object.values(state.threads).filter((item) => item.group && item.group === thread.group),
    );
    const views = useApp((state) => state.views);
    const apply = async (candidate: ThreadMeta) => {
        if (!window.confirm(format(s.compare.confirmApply, { title: candidate.title }))) return;
        const result = await attempt(() =>
            host.call('worktree.apply', { threadId: candidate.id }, { timeoutMs: 120_000 }),
        );
        if (!result) return;
        if (result.status === 'moved')
            toast(format(s.compare.applied, { count: result.tracked.length + result.untracked.length }), 'success');
        else if (result.status === 'nothing') toast(s.compare.nothing, 'info');
        else toast(`${s.compare.conflicts}${result.conflicts.map((conflict) => conflict.path).join(', ')}`, 'error');
    };
    const remove = async (candidate: ThreadMeta) => {
        if (!window.confirm(format(s.compare.confirmRemove, { title: candidate.title }))) return;
        await attempt(() => host.call('worktree.remove', { threadId: candidate.id, force: true }));
    };
    return (
        <div className="compare">
            {candidates.map((candidate) => {
                const turns = views[candidate.id]?.turns ?? [];
                const changes = [...turns].reverse().find((turn) => turn.changes)?.changes;
                return (
                    <div
                        key={candidate.id}
                        className={`compare__card${candidate.id === thread.id ? ' is-current' : ''}`}
                    >
                        <button
                            type="button"
                            className="compare__title"
                            onClick={() => void selectThread(candidate.id)}
                        >
                            {candidate.title}
                        </button>
                        <div className="compare__stats">
                            <Badge
                                tone={
                                    candidate.status === 'running'
                                        ? 'accent'
                                        : candidate.status === 'failed'
                                          ? 'error'
                                          : 'muted'
                                }
                            >
                                {s.status[candidate.status]}
                            </Badge>
                            <span>{formatMoney(candidate.cost)}</span>
                            {changes ? (
                                <span>
                                    {format(s.thread.changes, { files: changes.files.length })}{' '}
                                    <span className="add">+{changes.additions}</span>{' '}
                                    <span className="del">−{changes.deletions}</span>
                                </span>
                            ) : (
                                <span className="muted">{s.compare.noChanges}</span>
                            )}
                        </div>
                        <div className="row">
                            <button
                                type="button"
                                className="button button--small button--primary"
                                disabled={candidate.status === 'running' || candidate.archived}
                                onClick={() => void apply(candidate)}
                            >
                                {s.compare.apply}
                            </button>
                            <button
                                type="button"
                                className="button button--small"
                                disabled={candidate.status === 'running' || candidate.archived}
                                onClick={() => void remove(candidate)}
                            >
                                {s.compare.remove}
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
