import type { Approval, ApprovalDecision, Item, ItemOf, ToolDisplay } from '@xora/protocol';
import { useState } from 'react';
import { DelegationCard } from '../components/ChiefView.tsx';
import { DiffView } from '../components/DiffView.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { AutoFocusInput, Badge, formatMoney, formatTokens, Spinner } from '../components/primitives.tsx';
import { host } from '../host.ts';
import { attempt, openReview, selectThread, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';

const KIND_ICON: Record<string, IconName> = {
    read: 'file',
    edit: 'pencil',
    delete: 'x',
    move: 'route',
    search: 'search',
    execute: 'terminal',
    think: 'brain',
    fetch: 'globe',
    switch_mode: 'route',
    other: 'list',
};

function ToolDisplayView({ display }: { display: ToolDisplay }) {
    const s = useStrings();
    switch (display.kind) {
        case 'diff':
            return (
                <div className="tool__diffs">
                    {display.diffs.map((diff) => (
                        <div key={diff.path} className="tool__diff">
                            <div className="tool__diff-path">{diff.path}</div>
                            <DiffView oldText={diff.oldText} newText={diff.newText} context={2} />
                        </div>
                    ))}
                </div>
            );
        case 'command':
            return (
                <div className="tool__command">
                    <pre className="tool__output">{display.output || ' '}</pre>
                    <div className="tool__footnote">
                        {display.exitCode !== null && format(s.tool.exitCode, { code: display.exitCode })}
                        {display.truncated &&
                            display.artifactPath &&
                            ` · ${format(s.tool.truncated, { path: display.artifactPath })}`}
                    </div>
                </div>
            );
        case 'read':
            return (
                <div className="tool__footnote">
                    {display.path} ·{' '}
                    {format(s.tool.lines, {
                        start: display.startLine,
                        end: display.endLine,
                        total: display.totalLines,
                    })}
                </div>
            );
        case 'files':
            return (
                <div className="tool__files">
                    <div className="tool__footnote">{format(s.tool.files, { count: display.paths.length })}</div>
                    <pre className="tool__output">{display.paths.slice(0, 200).join('\n')}</pre>
                </div>
            );
        case 'matches':
            return (
                <div className="tool__footnote">
                    {format(s.tool.matches, { count: display.count, files: display.files })}
                </div>
            );
        case 'todo':
            return <PlanList entries={display.items} />;
        case 'text':
            return <pre className="tool__output">{display.text}</pre>;
    }
}

function commandOf(item: ItemOf<'tool_call'>): string | undefined {
    const input = item.input as { command?: unknown } | undefined;
    return typeof input?.command === 'string' ? input.command : undefined;
}

function ToolCallView({ item }: { item: ItemOf<'tool_call'> }) {
    const s = useStrings();
    const command = commandOf(item);
    const autoOpen = item.status === 'in_progress' && item.kind === 'execute';
    const [open, setOpen] = useState(false);
    const expanded = open || autoOpen;
    const running = item.status === 'pending' || item.status === 'in_progress';
    const failed = item.status === 'failed' || item.status === 'denied';
    return (
        <div className={`tool tool--${item.status}`}>
            <button type="button" className="tool__header" onClick={() => setOpen(!open)} aria-expanded={expanded}>
                <span className="tool__icon">
                    <Icon name={KIND_ICON[item.kind] ?? 'list'} size={14} />
                </span>
                <span className="tool__title">{command ? <code>{command}</code> : item.title}</span>
                {running ? (
                    <Spinner size={10} />
                ) : failed ? (
                    <Badge tone="error">{s.tool[item.status]}</Badge>
                ) : item.status === 'cancelled' ? (
                    <Badge tone="muted">{s.tool.cancelled}</Badge>
                ) : null}
                {item.durationMs !== undefined && !running && (
                    <span className="tool__time">{(item.durationMs / 1000).toFixed(1)}s</span>
                )}
                <Icon name="chevronRight" size={12} className={`tool__chevron${expanded ? ' is-open' : ''}`} />
            </button>
            {expanded && (
                <div className="tool__body">
                    {item.display ? (
                        <ToolDisplayView display={item.display} />
                    ) : item.output ? (
                        <pre className="tool__output">{item.output}</pre>
                    ) : null}
                    {!item.display && !item.output && item.input !== undefined && (
                        <pre className="tool__output">{JSON.stringify(item.input, null, 2)}</pre>
                    )}
                    {item.display && item.output && item.display.kind !== 'command' && item.status === 'failed' && (
                        <pre className="tool__output">{item.output}</pre>
                    )}
                    {/* Language server problems the edit introduced, as the model saw them. */}
                    {item.display?.kind === 'diff' && item.output && item.status !== 'failed' && (
                        <pre className="tool__output tool__diagnostics">{item.output}</pre>
                    )}
                </div>
            )}
        </div>
    );
}

export function PlanList({ entries }: { entries: ItemOf<'plan'>['entries'] }) {
    return (
        <ul className="plan">
            {entries.map((entry, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: plan entries have no ids and may repeat
                <li key={`${index}-${entry.content}`} className={`plan__entry plan__entry--${entry.status}`}>
                    <span className="plan__box">
                        {entry.status === 'completed' ? (
                            <Icon name="check" size={11} />
                        ) : entry.status === 'in_progress' ? (
                            <Spinner size={8} />
                        ) : null}
                    </span>
                    <span>{entry.content}</span>
                </li>
            ))}
        </ul>
    );
}

/** A pending approval's details and answers; the thread's approval card and the team view both show it. */
export function PendingApproval({ approval }: { approval: Approval }) {
    const s = useStrings();
    const [reason, setReason] = useState('');
    const [askReason, setAskReason] = useState(false);
    const respond = (decision: ApprovalDecision, scope?: 'project' | 'global') =>
        void attempt(() =>
            host.call('approval.respond', {
                approvalId: approval.id,
                decision,
                ...(scope ? { scope } : {}),
                ...(decision === 'deny' && reason.trim() ? { message: reason.trim() } : {}),
            }),
        );
    return (
        <>
            <div className="approval__title">{approval.title}</div>
            <pre className="approval__summary">{approval.summary}</pre>
            {approval.risks.length > 0 && (
                <div className="approval__risks">
                    {approval.risks.map((risk) => (
                        <Badge
                            key={risk}
                            tone={risk === 'outside_workspace' || risk === 'sensitive_file' ? 'error' : 'warn'}
                        >
                            {s.approval.risks[risk]}
                        </Badge>
                    ))}
                </div>
            )}
            {askReason && (
                <AutoFocusInput
                    className="input"
                    placeholder={s.approval.reasonPlaceholder}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    onKeyDown={(event) => event.key === 'Enter' && respond('deny')}
                />
            )}
            <div className="approval__actions">
                <button type="button" className="button button--primary" onClick={() => respond('allow_once')}>
                    {s.approval.allowOnce}
                </button>
                <button type="button" className="button" onClick={() => respond('allow_session')}>
                    {s.approval.allowSession}
                </button>
                {approval.alwaysScopes.includes('project') && (
                    <button type="button" className="button" onClick={() => respond('allow_always', 'project')}>
                        {s.approval.alwaysProject}
                    </button>
                )}
                <button
                    type="button"
                    className="button button--danger"
                    onClick={() => (askReason ? respond('deny') : setAskReason(true))}
                >
                    {askReason ? s.approval.deny : s.approval.denyWithReason}
                </button>
            </div>
        </>
    );
}

function ApprovalView({ item }: { item: ItemOf<'approval'> }) {
    const s = useStrings();
    const approval = useApp((state) => state.approvals.find((pending) => pending.id === item.approvalId));
    const pending = item.status === 'pending' && approval;
    // 06 §24: the supervisor answers it for the user, who may still take it over.
    const reviewing = pending && approval.reviewer === 'supervisor';
    const [takeOver, setTakeOver] = useState(false);
    const bySupervisor = item.decidedBy === 'supervisor' && (item.status === 'allowed' || item.status === 'denied');
    return (
        <section
            className={`approval approval--${item.status}${reviewing && !takeOver ? ' is-reviewing' : ''}${pending && approval.grave ? ' is-grave' : ''}`}
            aria-label={s.approval.title}
        >
            <div className="approval__header">
                <span className="approval__icon">
                    <Icon name="shield" size={14} />
                </span>
                <strong>{pending && !reviewing ? s.approval.title : item.title}</strong>
                {reviewing && !takeOver && (
                    <>
                        <Spinner size={10} />
                        <span className="approval__reviewing">{s.approval.reviewing}</span>
                        <button type="button" className="link" onClick={() => setTakeOver(true)}>
                            {s.approval.takeOver}
                        </button>
                    </>
                )}
                {pending && approval.grave && <Badge tone="error">{s.approval.grave[approval.grave]}</Badge>}
                {!pending && (
                    <Badge tone={item.status === 'allowed' ? 'ok' : 'muted'}>
                        {bySupervisor
                            ? s.approval.bySupervisor[item.status as 'allowed' | 'denied']
                            : s.approval[item.status === 'pending' ? 'cancelled' : item.status]}
                    </Badge>
                )}
            </div>
            {pending && approval.grave && <div className="approval__grave">{s.approval.graveHint}</div>}
            {pending && approval.note && <div className="approval__message">{approval.note}</div>}
            {pending && (!reviewing || takeOver) && <PendingApproval approval={approval} />}
            {!pending && item.message && <div className="approval__message">{item.message}</div>}
        </section>
    );
}

function ReasoningView({ item, live }: { item: ItemOf<'reasoning'>; live: boolean }) {
    const s = useStrings();
    const [open, setOpen] = useState(false);
    return (
        <div className={`reasoning${live ? ' is-live' : ''}`}>
            <button type="button" className="reasoning__toggle" onClick={() => setOpen(!open)}>
                <Icon name="brain" size={13} />{' '}
                <span className="reasoning__label">{live ? s.thread.thinking : s.thread.reasoning}</span>
                <Icon name="chevronRight" size={11} className={`reasoning__chevron${open ? ' is-open' : ''}`} />
            </button>
            {(open || live) && (
                <div className={`reasoning__text${live && !open ? ' is-clamped' : ''}`}>{item.text}</div>
            )}
        </div>
    );
}

/** Work handed to a subagent: its child thread's progress, until the answer is back in this turn. */
/** Where the context was compacted: a divider in the conversation, the summary a click away. */
function CompactionView({ item }: { item: ItemOf<'compaction'> }) {
    const s = useStrings();
    const [open, setOpen] = useState(false);
    const level = (s.context.levels as Record<number, string>)[item.level];
    return (
        <div className={`compaction is-${item.status}`}>
            <div className="compaction__line">
                {item.status === 'started' ? <Spinner size={11} /> : <Icon name="compress" size={13} />}
                <span className="compaction__text">
                    {item.status === 'started'
                        ? s.context.compacting
                        : item.status === 'failed'
                          ? s.context.compactFailed
                          : s.context.compactedItem}
                    {item.status === 'completed' && item.before && item.after
                        ? ` · ${formatTokens(item.before)} → ${formatTokens(item.after)} token`
                        : ''}
                    {item.status === 'completed' && level ? ` · ${level}` : ''}
                </span>
                {item.summary && (
                    <button type="button" className="link" onClick={() => setOpen(!open)}>
                        {open ? s.thread.showLess : s.context.showSummary}
                    </button>
                )}
            </div>
            {open && item.summary && (
                <div className="compaction__summary">
                    <Markdown text={item.summary} />
                </div>
            )}
        </div>
    );
}

function SubagentView({ item, turnRunning }: { item: ItemOf<'subagent'>; turnRunning: boolean }) {
    const s = useStrings();
    const child = useApp((state) => (item.threadId ? state.threads[item.threadId] : undefined));
    // A card still running in a turn that is over was left so by a crash.
    const status = item.status === 'running' && !turnRunning ? 'cancelled' : item.status;
    const cost = item.cost ?? child?.cost;
    return (
        <div className={`tool subagent subagent--${status}`}>
            <div className="tool__header subagent__header">
                <span className="tool__icon">
                    <Icon name="route" size={14} />
                </span>
                <span className="subagent__agent">{item.agent || s.subagent.general}</span>
                <span className="tool__title">{item.title}</span>
                {status === 'running' ? (
                    child?.status === 'awaiting_approval' ? (
                        <Badge tone="warn">{s.status.awaiting_approval}</Badge>
                    ) : (
                        <Spinner size={10} />
                    )
                ) : (
                    <Badge tone={status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'muted'}>
                        {s.subagent.statuses[status]}
                    </Badge>
                )}
                {cost && cost.amount > 0 && <span className="tool__time">{formatMoney(cost)}</span>}
                {item.threadId && child && (
                    <button
                        type="button"
                        className="link subagent__open"
                        title={s.subagent.openHint}
                        onClick={() => item.threadId && void selectThread(item.threadId)}
                    >
                        {s.subagent.open}
                    </button>
                )}
            </div>
            {item.summary && status !== 'running' && <div className="subagent__summary">{item.summary}</div>}
        </div>
    );
}

export function ItemView({ item, live, turnRunning = true }: { item: Item; live: boolean; turnRunning?: boolean }) {
    const s = useStrings();
    switch (item.type) {
        case 'user_message':
            return null;
        case 'agent_message':
            return <Markdown text={item.text} />;
        case 'reasoning':
            return <ReasoningView item={item} live={live} />;
        case 'tool_call':
            return <ToolCallView item={item} />;
        case 'plan':
            return (
                <div className="plan-card">
                    <PlanList entries={item.entries} />
                </div>
            );
        case 'approval':
            return <ApprovalView item={item} />;
        case 'file_changes':
            return (
                <button type="button" className="changes-card" onClick={() => openReview(item.turnId)}>
                    <span className="changes-card__icon">
                        <Icon name="diff" size={14} />
                    </span>
                    <span>{format(s.thread.changes, { files: item.files.length })}</span>
                    <span className="changes-card__stat">
                        <span className="add">+{item.additions}</span> <span className="del">−{item.deletions}</span>
                    </span>
                    <span className="changes-card__action">{s.thread.review}</span>
                </button>
            );
        case 'notice':
            return (
                <div className={`notice notice--${item.severity}`}>
                    <Icon name="alert" size={13} /> <span>{item.title}</span>
                    {item.description && <span className="notice__desc">{item.description}</span>}
                </div>
            );
        case 'error': {
            const hint = (s.errors.hints as Record<string, string>)[item.errorClass];
            return (
                <div className="error-card">
                    <div className="error-card__title">
                        <Icon name="alert" size={14} /> {s.errors[item.errorClass]}
                    </div>
                    <div className="error-card__message">{item.message}</div>
                    {hint && <div className="error-card__hint">{hint}</div>}
                </div>
            );
        }
        case 'compaction':
            return <CompactionView item={item} />;
        case 'subagent':
            return <SubagentView item={item} turnRunning={turnRunning} />;
        case 'delegation':
            return <DelegationCard item={item} />;
    }
}
