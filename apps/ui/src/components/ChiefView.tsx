import type { Effort, ItemOf, ModelRef } from '@xora/protocol';
import { useState } from 'react';
import { host } from '../host.ts';
import { attempt, isChief, openProject, openRun, selectThread, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { startingEffort } from '../thinking.ts';
import { LogoMark } from './Art.tsx';
import { EffortChooser, ModelChooser } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { MemberMentionList, useMemberMention } from './Mentions.tsx';
import { Badge, formatMoney, relativeTime, Spinner } from './primitives.tsx';
import '../chief.css';

const TEAM_ENDED = ['done', 'failed', 'cancelled'];
const WORKFLOW_ENDED = ['completed', 'failed', 'cancelled'];
const LISTED = 8;

/**
 * The chief assistant's home (06 §23): say what you need in one place; what is under way in every project and the
 * earlier conversations below. A conversation, once started, shows as a thread.
 */
export function ChiefHome() {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const models = useApp((state) => state.models);
    const settings = useApp((state) => state.settings);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    // `@member` hands the request to a member (06 §19).
    const mention = useMemberMention(text, setText);
    const threads = useApp((state) => state.threads);
    const teamRuns = useApp((state) => state.teamRuns);
    const workflowRuns = useApp((state) => state.workflowRuns);
    // A conversation with the chief belongs to no project: no project to pick. What it is picked is the model and
    // thinking level, the defaults for new conversations until the user picks others, as under a conversation.
    const [picked, setPicked] = useState<ModelRef | undefined>();
    const [effort, setEffort] = useState<Effort | ''>('');
    const connected = (ref: ModelRef | null | undefined) =>
        ref && models.some((option) => option.connectionId === ref.connectionId && option.model.id === ref.model)
            ? ref
            : undefined;
    const model = connected(picked) ?? connected(settings?.defaultModel);
    const reasoning = models.find(
        (option) => model && option.connectionId === model.connectionId && option.model.id === model.model,
    )?.model.reasoning;
    const effortValue = startingEffort(reasoning, settings?.defaultEffort, effort);
    // Only the user's: the supervisor answers the rest (06 §24).
    const approvals = useApp((state) => state.approvals).filter((approval) => !approval.reviewer);
    const history = Object.values(threads)
        .filter((thread) => isChief(thread) && !thread.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, LISTED);
    // Archived ones are only here: a project's list never holds the chief's conversations.
    const archived = Object.values(threads)
        .filter((thread) => isChief(thread) && thread.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    const [showArchived, setShowArchived] = useState(false);
    // The examples name the project a new conversation runs in: that of the user's latest conversation of their own,
    // as the host picks it (chief.ts `#home`).
    const open = projects.filter((project) => !project.missing);
    const latest = Object.values(threads)
        .filter(
            (thread) =>
                !isChief(thread) &&
                !thread.teamRunId &&
                !thread.workflowRunId &&
                !thread.parent &&
                !thread.archived &&
                open.some((project) => project.id === thread.projectId),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const example = open.find((project) => project.id === latest?.projectId) ?? open[0];
    const underway = [
        ...Object.values(teamRuns)
            .filter((run) => !TEAM_ENDED.includes(run.status))
            .map((run) => ({
                kind: 'team' as const,
                id: run.id,
                title: run.title ?? run.goal,
                projectId: run.projectId,
                status: s.team.statuses[run.status],
                updatedAt: run.updatedAt,
            })),
        ...Object.values(workflowRuns)
            .filter((run) => !WORKFLOW_ENDED.includes(run.status) && !run.parentRunId)
            .map((run) => ({
                kind: 'workflow' as const,
                id: run.id,
                title: run.title,
                projectId: run.projectId,
                status: s.workflow.statuses[run.status],
                updatedAt: run.updatedAt,
            })),
    ]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, LISTED);
    const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? '';

    const send = async () => {
        const value = text.trim();
        if (!value || busy) return;
        setBusy(true);
        const thread = await attempt(() =>
            host.call(
                'chief.start',
                {
                    text: value,
                    ...(model ? { model } : {}),
                    ...(effortValue ? { effort: effortValue } : {}),
                },
                { timeoutMs: 120_000 },
            ),
        );
        setBusy(false);
        if (thread) {
            useApp.setState((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
            setText('');
            await selectThread(thread.id);
        }
    };

    if (projects.length === 0) {
        return (
            <div className="chief-home">
                <div className="chief-home__hero">
                    <LogoMark size={52} className="chief-home__mark" />
                    <h1>{s.chief.title}</h1>
                    <p>{s.chief.noProject}</p>
                    <button type="button" className="button button--primary" onClick={() => void openProject()}>
                        <Icon name="folderPlus" size={14} /> {s.sidebar.openProject}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="chief-home">
            <div className="chief-home__hero">
                <LogoMark size={52} className="chief-home__mark" />
                <h1>{s.chief.title}</h1>
                <p>{s.chief.subtitle}</p>
            </div>
            <div className="chief-home__composer">
                <MemberMentionList mention={mention} />
                <textarea
                    className="chief-home__input"
                    value={text}
                    rows={4}
                    placeholder={s.chief.placeholder}
                    aria-label={s.chief.title}
                    onChange={(event) => {
                        setText(event.target.value);
                        mention.update(event.target.value, event.target.selectionStart);
                    }}
                    onKeyDown={(event) => {
                        if (mention.keyDown(event)) return;
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            void send();
                        }
                    }}
                />
                <div className="chief-home__bar">
                    <ModelChooser placement="down" value={model} onChange={setPicked} empty={s.chief.autoModel} />
                    <EffortChooser placement="down" model={model} value={effortValue} onChange={setEffort} />
                    <span className="chief-home__spacer" />
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !text.trim()}
                        onClick={() => void send()}
                    >
                        {busy ? <Spinner /> : <Icon name="send" size={14} />} {s.chief.send}
                    </button>
                </div>
            </div>
            <div className="chief-home__examples">
                {s.chief.examples.map((line) => {
                    const shown = format(line, { project: example?.name ?? '' });
                    return (
                        <button key={line} type="button" className="chief-home__example" onClick={() => setText(shown)}>
                            {shown}
                        </button>
                    );
                })}
            </div>
            <div className="chief-home__grid">
                <section className="chief-home__section">
                    <h3>{s.chief.underway}</h3>
                    {underway.length === 0 && approvals.length === 0 ? (
                        <p className="chief-home__empty">{s.chief.nothingUnderway}</p>
                    ) : (
                        underway.map((run) => (
                            <button
                                key={run.id}
                                type="button"
                                className="chief-home__row"
                                onClick={() => openRun(run.kind, run.id)}
                            >
                                <Icon name={run.kind === 'team' ? 'users' : 'bolt'} size={13} />
                                <span className="chief-home__row-title">{run.title}</span>
                                <span className="chief-home__row-meta">
                                    {projects.length > 1 ? `${projectName(run.projectId)} · ` : ''}
                                    {run.status}
                                </span>
                            </button>
                        ))
                    )}
                    {approvals.length > 0 && (
                        <button
                            type="button"
                            className="chief-home__row is-needs"
                            onClick={() => approvals[0] && void selectThread(approvals[0].threadId)}
                        >
                            <Icon name="inbox" size={13} />
                            <span className="chief-home__row-title">{s.chief.needsYou}</span>
                            <span className="chief-home__row-meta">
                                {format(s.chief.approvals, { count: approvals.length })}
                            </span>
                        </button>
                    )}
                </section>
                {(history.length > 0 || archived.length > 0) && (
                    <section className="chief-home__section">
                        <h3>{s.chief.history}</h3>
                        {history.map((thread) => (
                            <button
                                key={thread.id}
                                type="button"
                                className="chief-home__row"
                                onClick={() => void selectThread(thread.id)}
                            >
                                <Icon name="message" size={13} />
                                <span className="chief-home__row-title">{thread.title}</span>
                                <span className="chief-home__row-meta">{relativeTime(thread.updatedAt)}</span>
                                {thread.unread && <span className="chief-home__dot" />}
                            </button>
                        ))}
                        {archived.length > 0 && (
                            <button
                                type="button"
                                className="chief-home__archived"
                                aria-expanded={showArchived}
                                onClick={() => setShowArchived(!showArchived)}
                            >
                                {s.sidebar.archived} ({archived.length})
                            </button>
                        )}
                        {showArchived &&
                            archived.map((thread) => (
                                <button
                                    key={thread.id}
                                    type="button"
                                    className="chief-home__row is-archived"
                                    onClick={() => void selectThread(thread.id)}
                                >
                                    <Icon name="archive" size={13} />
                                    <span className="chief-home__row-title">{thread.title}</span>
                                    <span className="chief-home__row-meta">{relativeTime(thread.updatedAt)}</span>
                                </button>
                            ))}
                    </section>
                )}
            </div>
        </div>
    );
}

/** A card of work the chief handed on: who does it, where it stands, and the way to it. */
export function DelegationCard({ item }: { item: ItemOf<'delegation'> }) {
    const s = useStrings();
    const project = useApp((state) => state.projects.find((entry) => entry.id === item.projectId));
    const several = useApp((state) => state.projects.length > 1);
    const open = () => (item.kind === 'member' ? void selectThread(item.refId) : openRun(item.kind, item.refId));
    const tone =
        item.status === 'done'
            ? 'ok'
            : item.status === 'waiting'
              ? 'warn'
              : item.status === 'failed'
                ? 'error'
                : item.status === 'cancelled'
                  ? 'muted'
                  : 'accent';
    return (
        <div className={`delegation delegation--${item.status}${item.report ? ' is-report' : ''}`}>
            <div className="delegation__head">
                <span className="delegation__icon">
                    <Icon
                        name={item.kind === 'team' ? 'users' : item.kind === 'workflow' ? 'bolt' : 'user'}
                        size={14}
                    />
                </span>
                <span className="delegation__kind">
                    {item.report ? `${s.chief.report} · ` : ''}
                    {item.kind === 'member' && item.who ? item.who : s.chief.kinds[item.kind]}
                    {several && project ? ` · ${project.name}` : ''}
                </span>
                <span className="delegation__title">{item.title}</span>
                {item.status === 'running' && <Spinner size={10} />}
                <Badge tone={tone}>{s.chief.statuses[item.status]}</Badge>
                {item.cost && item.cost.amount > 0 && (
                    <span className="delegation__cost">{formatMoney(item.cost)}</span>
                )}
                <button type="button" className="link delegation__open" onClick={open}>
                    {s.chief.open}
                </button>
            </div>
            {item.summary && (
                <div className="delegation__summary">
                    <Markdown text={item.summary} />
                </div>
            )}
        </div>
    );
}
