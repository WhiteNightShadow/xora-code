import type { ApprovalDecision, Item, ItemOf, ToolDisplay } from '@xora/protocol';
import { useState } from 'react';
import { DiffView } from '../components/DiffView.tsx';
import { Icon, type IconName } from '../components/Icon.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { AutoFocusInput, Badge, Spinner } from '../components/primitives.tsx';
import { host } from '../host.ts';
import { attempt, openReview, useApp, useStrings } from '../store.ts';
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
                <Icon name={KIND_ICON[item.kind] ?? 'list'} size={14} />
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
                <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
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

function ApprovalView({ item }: { item: ItemOf<'approval'> }) {
    const s = useStrings();
    const approval = useApp((state) => state.approvals.find((pending) => pending.id === item.approvalId));
    const [reason, setReason] = useState('');
    const [askReason, setAskReason] = useState(false);
    const respond = (decision: ApprovalDecision, scope?: 'project' | 'global') =>
        void attempt(() =>
            host.call('approval.respond', {
                approvalId: item.approvalId,
                decision,
                ...(scope ? { scope } : {}),
                ...(decision === 'deny' && reason.trim() ? { message: reason.trim() } : {}),
            }),
        );
    const pending = item.status === 'pending' && approval;
    return (
        <section className={`approval approval--${item.status}`} aria-label={s.approval.title}>
            <div className="approval__header">
                <Icon name="shield" size={14} />
                <strong>{pending ? s.approval.title : item.title}</strong>
                {!pending && (
                    <Badge tone={item.status === 'allowed' ? 'ok' : 'muted'}>
                        {s.approval[item.status === 'pending' ? 'cancelled' : item.status]}
                    </Badge>
                )}
            </div>
            {pending && (
                <>
                    <div className="approval__title">{item.title}</div>
                    <pre className="approval__summary">{item.summary}</pre>
                    {item.risks.length > 0 && (
                        <div className="approval__risks">
                            {item.risks.map((risk) => (
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
            )}
            {!pending && item.message && <div className="approval__message">{item.message}</div>}
        </section>
    );
}

function ReasoningView({ item, live }: { item: ItemOf<'reasoning'>; live: boolean }) {
    const s = useStrings();
    const [open, setOpen] = useState(false);
    return (
        <div className="reasoning">
            <button type="button" className="reasoning__toggle" onClick={() => setOpen(!open)}>
                <Icon name="brain" size={13} /> {live ? s.thread.thinking : s.thread.reasoning}
                <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
            </button>
            {(open || live) && (
                <div className={`reasoning__text${live && !open ? ' is-clamped' : ''}`}>{item.text}</div>
            )}
        </div>
    );
}

export function ItemView({ item, live }: { item: Item; live: boolean }) {
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
                    <Icon name="diff" size={14} />
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
            return (
                <div className="notice notice--info">
                    <Icon name="list" size={13} />
                    <span>
                        {item.status === 'started'
                            ? '正在压缩上下文…'
                            : item.status === 'failed'
                              ? '上下文压缩失败'
                              : `已压缩上下文${item.before && item.after ? `（约${item.before}→${item.after} token）` : ''}`}
                    </span>
                </div>
            );
        case 'subagent':
            return (
                <div className="notice notice--info">
                    <Icon name="route" size={13} />{' '}
                    <span>
                        {item.agent}：{item.title}
                    </span>
                    {item.summary && <span className="notice__desc">{item.summary}</span>}
                </div>
            );
    }
}
