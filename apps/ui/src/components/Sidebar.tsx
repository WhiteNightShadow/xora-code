import type { Project, ThreadMeta } from '@xora/protocol';
import { useMemo, useState } from 'react';
import { host } from '../host.ts';
import { attempt, openProject, openSettings, selectThread, useApp, useStrings } from '../store.ts';
import { Icon } from './Icon.tsx';
import { formatMoney, IconButton, relativeTime, Spinner } from './primitives.tsx';

function StatusMark({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    if (thread.status === 'running') return <Spinner size={10} />;
    if (thread.status === 'awaiting_approval')
        return <span className="mark mark--approval" title={s.status.awaiting_approval} />;
    if (thread.status === 'failed') return <span className="mark mark--failed" title={s.status.failed} />;
    if (thread.needsReview) return <span className="mark mark--review" title={s.status.review} />;
    if (thread.unread) return <span className="mark mark--unread" />;
    return <span className="mark" />;
}

function ThreadRow({ thread, selected }: { thread: ThreadMeta; selected: boolean }) {
    const s = useStrings();
    const [menu, setMenu] = useState(false);
    const update = (patch: { pinned?: boolean; archived?: boolean; title?: string }) =>
        void attempt(() => host.call('thread.update', { threadId: thread.id, ...patch }));
    return (
        <div className={`thread-row${selected ? ' is-selected' : ''}${thread.archived ? ' is-archived' : ''}`}>
            <button type="button" className="thread-row__main" onClick={() => void selectThread(thread.id)}>
                <StatusMark thread={thread} />
                <span className="thread-row__title">
                    {thread.pinned && <Icon name="pin" size={11} className="thread-row__pin" />}
                    {thread.location.kind === 'worktree' && <Icon name="route" size={11} className="thread-row__pin" />}
                    {thread.title}
                </span>
                <span className="thread-row__meta">
                    {thread.cost && thread.cost.amount > 0 ? formatMoney(thread.cost) : relativeTime(thread.updatedAt)}
                </span>
            </button>
            <div className="thread-row__menu">
                <IconButton icon="more" label={s.common.more} size={14} onClick={() => setMenu(!menu)} />
                {menu && (
                    <div className="menu" role="menu" tabIndex={-1} onMouseLeave={() => setMenu(false)}>
                        <button
                            type="button"
                            onClick={() => {
                                setMenu(false);
                                const title = window.prompt(s.sidebar.rename, thread.title);
                                if (title?.trim()) update({ title: title.trim() });
                            }}
                        >
                            {s.sidebar.rename}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setMenu(false);
                                update({ pinned: !thread.pinned });
                            }}
                        >
                            {thread.pinned ? s.sidebar.unpin : s.sidebar.pin}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setMenu(false);
                                update({ archived: !thread.archived });
                            }}
                        >
                            {thread.archived ? s.sidebar.unarchive : s.sidebar.archive}
                        </button>
                        <button
                            type="button"
                            className="is-danger"
                            onClick={() => {
                                setMenu(false);
                                if (window.confirm(s.sidebar.confirmDelete)) {
                                    void attempt(() => host.call('thread.delete', { threadId: thread.id }));
                                }
                            }}
                        >
                            {s.sidebar.delete}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function ProjectGroup({
    project,
    threads,
    open,
    onToggle,
}: {
    project: Project;
    threads: ThreadMeta[];
    open: boolean;
    onToggle: () => void;
}) {
    const s = useStrings();
    const selectedThreadId = useApp((state) => state.selectedThreadId);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [showArchived, setShowArchived] = useState(false);
    const teamRunId = useApp((state) => state.teamRunId);
    const allRuns = useApp((state) => state.teamRuns);
    const runs = Object.values(allRuns)
        .filter((run) => run.projectId === project.id)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5);
    // Team members' threads are reached through the team view, not listed one by one.
    const active = threads.filter((thread) => !thread.archived && !thread.teamRunId);
    const archived = threads.filter((thread) => thread.archived);
    return (
        <div className={`project${selectedProjectId === project.id ? ' is-current' : ''}`}>
            <div className="project__header">
                <button type="button" className="project__toggle" onClick={onToggle} title={project.path}>
                    <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
                    <span className="project__name">{project.name}</span>
                    {project.git.branch && <span className="project__branch">{project.git.branch}</span>}
                    {project.missing && <span className="project__missing">!</span>}
                </button>
                <IconButton
                    icon="plus"
                    label={s.sidebar.newThread}
                    size={14}
                    onClick={() => useApp.setState({ newThreadFor: project.id })}
                />
            </div>
            {open && runs.length > 0 && (
                <div className="project__runs">
                    {runs.map((run) => (
                        <button
                            key={run.id}
                            type="button"
                            className={`run-row${teamRunId === run.id ? ' is-selected' : ''}`}
                            onClick={() => useApp.setState({ teamRunId: run.id })}
                        >
                            <Icon name="route" size={11} />
                            <span className="thread-row__title">{run.goal}</span>
                            <span className="thread-row__meta">{s.team.statuses[run.status]}</span>
                        </button>
                    ))}
                </div>
            )}
            {open && (
                <div className="project__threads">
                    {active.length === 0 && <div className="project__empty">{s.sidebar.noThreads}</div>}
                    {active.map((thread) => (
                        <ThreadRow key={thread.id} thread={thread} selected={thread.id === selectedThreadId} />
                    ))}
                    {archived.length > 0 && (
                        <button
                            type="button"
                            className="project__archived"
                            onClick={() => setShowArchived(!showArchived)}
                        >
                            {s.sidebar.archived} ({archived.length})
                        </button>
                    )}
                    {showArchived &&
                        archived.map((thread) => (
                            <ThreadRow key={thread.id} thread={thread} selected={thread.id === selectedThreadId} />
                        ))}
                </div>
            )}
        </div>
    );
}

export function Sidebar() {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const threadMap = useApp((state) => state.threads);
    const update = useApp((state) => state.update);
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<Array<{ threadId: string; title: string; snippet: string }> | undefined>();

    const byProject = useMemo(() => {
        const groups = new Map<string, ThreadMeta[]>();
        for (const thread of Object.values(threadMap)) {
            const list = groups.get(thread.projectId) ?? [];
            list.push(thread);
            groups.set(thread.projectId, list);
        }
        for (const list of groups.values()) {
            list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
        }
        return groups;
    }, [threadMap]);

    const inbox = Object.values(threadMap).filter(
        (thread) =>
            !thread.archived &&
            (thread.status === 'awaiting_approval' || thread.needsReview || thread.status === 'failed'),
    );

    const search = async (text: string) => {
        setQuery(text);
        if (text.trim().length < 2) {
            setResults(undefined);
            return;
        }
        setResults((await attempt(() => host.call('thread.search', { query: text.trim() }))) ?? []);
    };

    return (
        <nav className="sidebar" aria-label={s.sidebar.projects}>
            <div className="sidebar__top">
                <span className="sidebar__brand">Xora</span>
                <IconButton icon="folder" label={s.sidebar.openProject} onClick={() => void openProject()} />
            </div>
            <div className="sidebar__search">
                <Icon name="search" size={13} />
                <input
                    value={query}
                    placeholder={s.sidebar.search}
                    onChange={(event) => void search(event.target.value)}
                />
            </div>
            {results && (
                <div className="sidebar__results">
                    {results.length === 0 && <div className="project__empty">—</div>}
                    {results.map((result) => (
                        <button
                            key={result.threadId}
                            type="button"
                            className="result"
                            onClick={() => void selectThread(result.threadId)}
                        >
                            <span className="result__title">{result.title}</span>
                            <span className="result__snippet">{result.snippet}</span>
                        </button>
                    ))}
                </div>
            )}
            {inbox.length > 0 && (
                <div className="inbox">
                    <div className="inbox__title">
                        <Icon name="inbox" size={13} /> {s.sidebar.inbox}{' '}
                        <span className="inbox__count">{inbox.length}</span>
                    </div>
                    {inbox.map((thread) => (
                        <button
                            key={thread.id}
                            type="button"
                            className="inbox__item"
                            onClick={() => void selectThread(thread.id)}
                        >
                            <StatusMark thread={thread} />
                            <span>{thread.title}</span>
                        </button>
                    ))}
                </div>
            )}
            <div className="sidebar__projects">
                {projects.map((project) => (
                    <ProjectGroup
                        key={project.id}
                        project={project}
                        threads={byProject.get(project.id) ?? []}
                        open={!collapsed[project.id]}
                        onToggle={() => setCollapsed({ ...collapsed, [project.id]: !collapsed[project.id] })}
                    />
                ))}
            </div>
            <div className="sidebar__bottom">
                <button type="button" className="sidebar__link" onClick={() => openSettings('general')}>
                    <Icon name="gear" size={14} /> {s.sidebar.settings}
                    {update?.state === 'ready' && <span className="dot-badge" />}
                </button>
                <button type="button" className="sidebar__link" onClick={() => useApp.setState({ usageOpen: true })}>
                    <Icon name="chart" size={14} /> {s.sidebar.usage}
                </button>
            </div>
        </nav>
    );
}
