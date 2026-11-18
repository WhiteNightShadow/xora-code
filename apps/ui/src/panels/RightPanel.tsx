import type { FileChange, PromptLayer, ThreadMeta, UsageRequest, UsageTotals } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { confirmDialog } from '../components/Confirm.tsx';
import { DiffView } from '../components/DiffView.tsx';
import { Badge, Empty, formatMoney, formatTokens, IconButton, Spinner } from '../components/primitives.tsx';
import { errorMessage, host } from '../host.ts';
import { PlanList } from '../items/ItemView.tsx';
import { attempt, openFile, type RightPanel as Panel, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { latestPlanOf } from '../timeline.ts';
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
    const [compare, setCompare] = useState<'turn' | 'since'>('turn');
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
        host.call('review.turn', { threadId: thread.id, turnId, compare })
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
    }, [thread.id, turnId, compare, reverted]);

    useEffect(() => {
        setContent(undefined);
        if (!turnId || !selected) return;
        let cancelled = false;
        host.call('review.file', { threadId: thread.id, turnId, path: selected, compare })
            .then((result) => !cancelled && setContent(result))
            .catch((error) => !cancelled && toast(errorMessage(error), 'error'));
        return () => {
            cancelled = true;
        };
    }, [thread.id, turnId, selected, compare]);

    if (!turnId) return <Empty>{s.review.selectTurn}</Empty>;
    if (!available && files !== undefined) return <Empty>{s.review.unavailable}</Empty>;

    const revert = async (paths?: string[]) => {
        if (!(await confirmDialog(s.review.confirmRevert))) return;
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
    const canRevert = !busy && thread.status !== 'running' && compare === 'turn';
    return (
        <div className="changes">
            <div className="changes__scope">
                <div className="segmented" role="tablist">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={compare === 'turn'}
                        className={compare === 'turn' ? 'is-active' : ''}
                        onClick={() => setCompare('turn')}
                    >
                        {s.review.scopeTurn}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={compare === 'since'}
                        className={compare === 'since' ? 'is-active' : ''}
                        onClick={() => setCompare('since')}
                    >
                        {s.review.scopeSince}
                    </button>
                </div>
            </div>
            {!files ? (
                <Empty>
                    <Spinner />
                </Empty>
            ) : files.length === 0 ? (
                <Empty>{compare === 'since' ? s.review.emptySince : s.review.empty}</Empty>
            ) : (
                <>
                    <div className="changes__actions">
                        <span>{format(s.thread.changes, { files: files.length })}</span>
                        {reverted && <Badge tone="muted">{s.thread.reverted}</Badge>}
                        <button
                            type="button"
                            className="button button--small"
                            disabled={!canRevert}
                            title={compare === 'since' ? s.review.revertScopeHint : undefined}
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
                                    disabled={!canRevert}
                                    title={compare === 'since' ? s.review.revertScopeHint : undefined}
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
                </>
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

const PANEL_WIDTH_KEY = 'xora.rightPanelWidth';

function clampPanelWidth(width: number): number {
    const max = Math.max(280, Math.min(920, window.innerWidth - 460));
    return Math.round(Math.max(280, Math.min(width, max)));
}

function applyPanelWidth(width: number | undefined): void {
    const root = document.documentElement;
    if (width === undefined) {
        root.style.removeProperty('--xk-right-panel-width');
    } else {
        root.style.setProperty('--xk-right-panel-width', `${clampPanelWidth(width)}px`);
    }
}

export function RightPanel({ thread, panel }: { thread: ThreadMeta; panel: Panel }) {
    const s = useStrings();
    const view = useApp((state) => state.views[thread.id]);
    const [dragging, setDragging] = useState(false);
    useEffect(() => {
        const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
        if (Number.isFinite(stored) && stored >= 280) {
            applyPanelWidth(stored);
        }
        const onResize = () => {
            const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
            if (Number.isFinite(saved) && saved >= 280) {
                applyPanelWidth(saved);
            }
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    const startResize = (downEvent: React.PointerEvent<HTMLDivElement>) => {
        if (downEvent.button !== 0) return;
        downEvent.preventDefault();
        setDragging(true);
        document.body.classList.add('is-resizing');
        let latest = clampPanelWidth(window.innerWidth - downEvent.clientX);
        applyPanelWidth(latest);
        const onMove = (moveEvent: PointerEvent) => {
            latest = clampPanelWidth(window.innerWidth - moveEvent.clientX);
            applyPanelWidth(latest);
        };
        const onUp = () => {
            setDragging(false);
            document.body.classList.remove('is-resizing');
            try {
                localStorage.setItem(PANEL_WIDTH_KEY, String(latest));
            } catch {
                // Storage may be unavailable in restricted contexts.
            }
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    };
    const resetWidth = () => {
        applyPanelWidth(undefined);
        try {
            localStorage.removeItem(PANEL_WIDTH_KEY);
        } catch {
            // Ignore storage errors.
        }
    };
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
    const plan = view ? latestPlanOf(view.turns) : undefined;
    return (
        <aside className="right-panel" aria-label={titles[panel]}>
            <div
                className={`right-panel__resizer${dragging ? ' is-dragging' : ''}`}
                aria-hidden="true"
                title={s.panel.resize}
                onPointerDown={startResize}
                onDoubleClick={resetWidth}
            />
            <div className="right-panel__header">
                <h2>{titles[panel]}</h2>
                <IconButton icon="x" label={s.panel.close} onClick={() => useApp.setState({ rightPanel: undefined })} />
            </div>
            <div
                className={`right-panel__body${panel === 'terminal' || panel === 'preview' ? ' right-panel__body--flush' : ''}`}
            >
                {panel === 'changes' && <ChangesPanel thread={thread} />}
                {panel === 'plan' &&
                    (plan ? (
                        <PlanList entries={plan.plan.entries} live={plan.live} />
                    ) : (
                        <Empty>{s.panel.noPlan}</Empty>
                    ))}
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
