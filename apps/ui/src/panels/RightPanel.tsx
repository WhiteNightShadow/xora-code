import type { FileChange, PromptLayer, ThreadMeta, UsageRequest, UsageTotals } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { DiffView } from '../components/DiffView.tsx';
import { Badge, Empty, formatMoney, formatTokens, IconButton, Spinner } from '../components/primitives.tsx';
import { errorMessage, host } from '../host.ts';
import { PlanList } from '../items/ItemView.tsx';
import { attempt, openFile, type RightPanel as Panel, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { latestPlan } from '../timeline.ts';
import { ComparePanel } from './ComparePanel.tsx';
import { FilePanel } from './FilePanel.tsx';
import { PreviewPanel } from './PreviewPanel.tsx';
import { TerminalPanel } from './TerminalPanel.tsx';
import { WorkingTreePanel } from './WorkingTreePanel.tsx';

function ChangesPanel({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const view = useApp((state) => state.views[thread.id]);
    const selectedTurn = useApp((state) => state.reviewTurnId);
    const turnId = selectedTurn ?? [...(view?.turns ?? [])].reverse().find((turn) => turn.changes)?.turnId;
    const turn = view?.turns.find((candidate) => candidate.turnId === turnId);
    const [files, setFiles] = useState<FileChange[] | undefined>();
    const [available, setAvailable] = useState(true);
    const [selected, setSelected] = useState<string | undefined>();
    const [content, setContent] = useState<
        { oldText: string | null; newText: string | null; binary: boolean } | undefined
    >();
    const [busy, setBusy] = useState(false);
    const reverted = turn?.reverted;

    // biome-ignore lint/correctness/useExhaustiveDependencies: reload after a revert as well
    useEffect(() => {
        setFiles(undefined);
        setSelected(undefined);
        setContent(undefined);
        if (!turnId) return;
        let cancelled = false;
        host.call('review.turn', { threadId: thread.id, turnId })
            .then((result) => {
                if (cancelled) return;
                setFiles(result.files);
                setAvailable(result.available);
                setSelected(result.files[0]?.path);
            })
            .catch((error) => !cancelled && toast(errorMessage(error), 'error'));
        return () => {
            cancelled = true;
        };
    }, [thread.id, turnId, reverted]);

    useEffect(() => {
        setContent(undefined);
        if (!turnId || !selected) return;
        let cancelled = false;
        host.call('review.file', { threadId: thread.id, turnId, path: selected })
            .then((result) => !cancelled && setContent(result))
            .catch((error) => !cancelled && toast(errorMessage(error), 'error'));
        return () => {
            cancelled = true;
        };
    }, [thread.id, turnId, selected]);

    if (!turnId) return <Empty>{s.review.selectTurn}</Empty>;
    if (!files)
        return (
            <Empty>
                <Spinner />
            </Empty>
        );
    if (!available) return <Empty>{s.review.unavailable}</Empty>;
    if (files.length === 0) return <Empty>{s.review.empty}</Empty>;

    const revert = async (paths?: string[]) => {
        if (!window.confirm(s.review.confirmRevert)) return;
        setBusy(true);
        const result = await attempt(() =>
            host.call('review.revert', { threadId: thread.id, turnId, ...(paths ? { paths } : {}) }),
        );
        setBusy(false);
        if (!result) return;
        if (result.conflicts.length > 0) {
            toast(
                `${format(s.review.conflicts, { count: result.conflicts.length })} ${result.conflicts.map((conflict) => conflict.path).join(', ')}`,
                'error',
            );
        } else {
            toast(format(s.review.restored, { count: result.restored.length + result.deleted.length }), 'success');
        }
    };
    const statusLabel = (file: FileChange) =>
        file.status === 'added'
            ? s.review.added
            : file.status === 'deleted'
              ? s.review.deleted
              : file.status === 'renamed'
                ? s.review.renamed
                : s.review.modified;
    return (
        <div className="changes">
            <div className="changes__actions">
                <span>{format(s.thread.changes, { files: files.length })}</span>
                {reverted && <Badge tone="muted">{s.thread.reverted}</Badge>}
                <button
                    type="button"
                    className="button button--small"
                    disabled={busy || thread.status === 'running'}
                    onClick={() => void revert()}
                >
                    {s.review.revertTurn}
                </button>
            </div>
            <ul className="changes__files">
                {files.map((file) => (
                    <li key={file.path}>
                        <button
                            type="button"
                            className={`changes__file${selected === file.path ? ' is-selected' : ''}`}
                            onClick={() => setSelected(file.path)}
                        >
                            <span className={`changes__status changes__status--${file.status}`}>
                                {statusLabel(file)}
                            </span>
                            <span className="changes__path">{file.path}</span>
                            <span className="changes__stat">
                                <span className="add">+{file.additions}</span>{' '}
                                <span className="del">−{file.deletions}</span>
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
            {selected && (
                <div className="changes__diff">
                    <div className="changes__diff-header">
                        <button type="button" className="link" onClick={() => openFile(selected)}>
                            <code>{selected}</code>
                        </button>
                        <button
                            type="button"
                            className="link"
                            disabled={busy || thread.status === 'running'}
                            onClick={() => void revert([selected])}
                        >
                            {s.review.revertFile}
                        </button>
                    </div>
                    {!content ? (
                        <Spinner />
                    ) : content.binary ? (
                        <Empty>{s.review.binary}</Empty>
                    ) : (
                        <DiffView oldText={content.oldText} newText={content.newText} />
                    )}
                </div>
            )}
        </div>
    );
}

function TrajectoryPanel({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const version = useApp((state) => state.usageVersion);
    const [data, setData] = useState<{ totals: UsageTotals; requests: UsageRequest[] } | undefined>();
    // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when usage changes
    useEffect(() => {
        void host
            .call('usage.thread', { threadId: thread.id })
            .then(setData)
            .catch(() => undefined);
    }, [thread.id, version]);
    if (!data)
        return (
            <Empty>
                <Spinner />
            </Empty>
        );
    if (data.requests.length === 0) return <Empty>{s.panel.noRequests}</Empty>;
    return (
        <div className="trajectory">
            <div className="trajectory__totals">
                <strong>{formatMoney(data.totals.cost)}</strong>
                <span>{format(s.panel.requests, { count: data.totals.requests })}</span>
                <span>
                    {formatTokens(data.totals.inputTokens)} {s.panel.tokens} · {s.panel.cached}{' '}
                    {formatTokens(data.totals.cachedTokens)}
                </span>
                {!data.totals.complete && <Badge tone="warn">{s.usage.incomplete}</Badge>}
            </div>
            <ol className="trajectory__list">
                {data.requests.map((request) => (
                    <li key={request.id} className={`trajectory__item${request.status === 'error' ? ' is-error' : ''}`}>
                        <div className="trajectory__model">
                            {request.model}
                            {request.status === 'error' && <Badge tone="error">{request.errorClass ?? 'error'}</Badge>}
                            {request.period === 'offpeak' && <Badge tone="ok">空闲时段</Badge>}
                        </div>
                        <div className="trajectory__stats">
                            <span>
                                {formatTokens(request.inputTokens)}→{formatTokens(request.outputTokens)}
                            </span>
                            {request.cachedTokens > 0 && (
                                <span>
                                    {s.panel.cached}{' '}
                                    {Math.round((request.cachedTokens / Math.max(1, request.inputTokens)) * 100)}%
                                </span>
                            )}
                            <span>
                                {s.panel.latency} {(request.latencyMs / 1000).toFixed(1)}s
                            </span>
                            {request.ttftMs !== undefined && (
                                <span>
                                    {s.panel.ttft} {(request.ttftMs / 1000).toFixed(1)}s
                                </span>
                            )}
                            <span>{request.cost ? formatMoney(request.cost) : s.panel.unknownPrice}</span>
                        </div>
                    </li>
                ))}
            </ol>
        </div>
    );
}

function PromptPanel({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const [layers, setLayers] = useState<PromptLayer[] | undefined>();
    const [session, setSession] = useState<string | undefined>();
    const [open, setOpen] = useState<string | undefined>();
    useEffect(() => {
        void host
            .call('prompt.effective', { threadId: thread.id })
            .then(setLayers)
            .catch(() => undefined);
        void host
            .call('prompt.get', { scope: 'thread', threadId: thread.id })
            .then((result) => setSession(result.text))
            .catch(() => undefined);
    }, [thread.id]);
    const save = async () => {
        if (session === undefined) return;
        const result = await attempt(() =>
            host.call('prompt.set', { scope: 'thread', threadId: thread.id, text: session }),
        );
        if (result) {
            toast(s.settings.saved, 'success');
            setLayers(await host.call('prompt.effective', { threadId: thread.id }));
        }
    };
    return (
        <div className="prompt-panel">
            <h3>{s.thread.sessionPrompt}</h3>
            <textarea
                className="textarea"
                rows={5}
                value={session ?? ''}
                onChange={(event) => setSession(event.target.value)}
            />
            <button type="button" className="button button--small" onClick={() => void save()}>
                {s.settings.save}
            </button>
            <h3>{s.thread.effectivePrompt}</h3>
            {!layers ? (
                <Spinner />
            ) : (
                <ul className="layers">
                    {layers.map((layer) => (
                        <li key={layer.id} className="layer">
                            <button
                                type="button"
                                className="layer__header"
                                onClick={() => setOpen(open === layer.id ? undefined : layer.id)}
                            >
                                <strong>{layer.title}</strong>
                                <span className="layer__meta">
                                    {layer.chars}字 · 约{formatTokens(layer.tokens)} token
                                    {layer.truncated ? ' · 已截断' : ''}
                                </span>
                            </button>
                            <div className="layer__source">{layer.source}</div>
                            {open === layer.id && <pre className="layer__text">{layer.text}</pre>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function RightPanel({ thread, panel }: { thread: ThreadMeta; panel: Panel }) {
    const s = useStrings();
    const view = useApp((state) => state.views[thread.id]);
    const titles: Record<Panel, string> = {
        changes: s.panel.changes,
        plan: s.panel.plan,
        trajectory: s.panel.trajectory,
        prompt: s.panel.prompt,
        terminal: s.panel.terminal,
        worktree: s.panel.worktree,
        compare: s.panel.compare,
        preview: s.panel.preview,
        file: s.panel.file,
    };
    const plan = latestPlan(view);
    return (
        <aside className="right-panel" aria-label={titles[panel]}>
            <div className="right-panel__header">
                <h2>{titles[panel]}</h2>
                <IconButton icon="x" label={s.panel.close} onClick={() => useApp.setState({ rightPanel: undefined })} />
            </div>
            <div
                className={`right-panel__body${panel === 'terminal' || panel === 'preview' ? ' right-panel__body--flush' : ''}`}
            >
                {panel === 'changes' && <ChangesPanel thread={thread} />}
                {panel === 'plan' && (plan ? <PlanList entries={plan.entries} /> : <Empty>{s.panel.noPlan}</Empty>)}
                {panel === 'trajectory' && <TrajectoryPanel thread={thread} />}
                {panel === 'prompt' && <PromptPanel thread={thread} />}
                {panel === 'terminal' && <TerminalPanel thread={thread} />}
                {panel === 'worktree' && <WorkingTreePanel thread={thread} />}
                {panel === 'compare' && <ComparePanel thread={thread} />}
                {panel === 'preview' && <PreviewPanel thread={thread} />}
                {panel === 'file' && <FilePanel thread={thread} />}
            </div>
        </aside>
    );
}
