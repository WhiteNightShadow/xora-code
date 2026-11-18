import type { Project, ThreadMeta } from '@xora/protocol';
import { useMemo, useState } from 'react';
import { host } from '../host.ts';
import { memberOf } from '../members.ts';
import {
    attempt,
    isStandaloneChat,
    openChief,
    openMembers,
    openNewThread,
    openProject,
    openRun,
    openSettings,
    selectThread,
    useApp,
    useStrings,
} from '../store.ts';
import { confirmDialog } from './Confirm.tsx';
import { Choices, Popover } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { MemberAvatar } from './MembersView.tsx';
import { AutoFocusInput, IconButton, relativeTime, Spinner } from './primitives.tsx';

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

/** One conversation: its mark, title and cost or age, with rename, pin, archive and delete behind "⋯". */
function ThreadRow({ thread, selected }: { thread: ThreadMeta; selected: boolean }) {
    const s = useStrings();
    const member = useApp((state) => memberOf(thread, state.members));
    const [menu, setMenu] = useState(false);
    // Renamed in place: Electron has no window.prompt.
    const [renaming, setRenaming] = useState<string | undefined>();
    const update = (patch: { pinned?: boolean; archived?: boolean; title?: string }) =>
        void attempt(() => host.call('thread.update', { threadId: thread.id, ...patch }));
    if (renaming !== undefined) {
        const done = () => {
            const title = renaming.trim();
            setRenaming(undefined);
            if (title && title !== thread.title) update({ title });
        };
        return (
            <div className="thread-row is-renaming">
                <AutoFocusInput
                    className="input thread-row__rename"
                    value={renaming}
                    aria-label={s.sidebar.rename}
                    onChange={(event) => setRenaming(event.target.value)}
                    onBlur={done}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') done();
                        if (event.key === 'Escape') setRenaming(undefined);
                    }}
                />
            </div>
        );
    }
    return (
        <div className={`thread-row${selected ? ' is-selected' : ''}${thread.archived ? ' is-archived' : ''}`}>
            <button type="button" className="thread-row__main" onClick={() => void selectThread(thread.id)}>
                <StatusMark thread={thread} />
                <span className="thread-row__title">
                    {member && (
                        <span className="thread-row__member" title={member.name}>
                            <MemberAvatar member={member} size={15} />
                        </span>
                    )}
                    {thread.pinned && <Icon name="pin" size={11} className="thread-row__pin" />}
                    {thread.location.kind === 'worktree' && <Icon name="route" size={11} className="thread-row__pin" />}
                    {thread.title.replace(/^(?:总助手：|Chief:\s*)/, '')}
                </span>
                <span className="thread-row__meta">{relativeTime(thread.updatedAt)}</span>
            </button>
            <div className="thread-row__menu">
                <IconButton icon="more" label={s.common.more} size={14} onClick={() => setMenu(!menu)} />
                {menu && (
                    <div className="menu" role="menu" tabIndex={-1} onMouseLeave={() => setMenu(false)}>
                        <button
                            type="button"
                            onClick={() => {
                                setMenu(false);
                                setRenaming(thread.title);
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
                            onClick={async () => {
                                setMenu(false);
                                if (await confirmDialog(s.sidebar.confirmDelete)) {
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
    // A thread is selected only while it is what the main area shows, not under a run, a board or a page.
    const selectedThreadId = useApp((state) =>
        state.teamRunId || state.workflowRunId || state.teamsFor || state.membersOpen || state.chiefOpen
            ? undefined
            : state.selectedThreadId,
    );
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [showArchived, setShowArchived] = useState(false);
    // Team members' and workflow steps' threads are reached through their run, not listed one by one; subagents'
    // through the card in their parent's turn, unless that thread is gone; the chief's conversations through its
    // entry at the top (06 §23).
    const threadMap = useApp((state) => state.threads);
    const active = threads.filter(
        (thread) =>
            !thread.archived &&
            !thread.teamRunId &&
            !thread.workflowRunId &&
            !isStandaloneChat(thread) &&
            !(thread.parent && threadMap[thread.parent.threadId]),
    );
    const archived = threads.filter((thread) => thread.archived && !isStandaloneChat(thread));
    return (
        <div className={`project${selectedProjectId === project.id ? ' is-current' : ''}`}>
            <div className="project__header">
                <button type="button" className="project__toggle" onClick={onToggle} title={project.path}>
                    <Icon name="chevronRight" size={12} className={`project__chevron${open ? ' is-open' : ''}`} />
                    <span className="project__name">{project.name}</span>
                    {project.git.branch && <span className="project__branch">{project.git.branch}</span>}
                    {project.missing && <span className="project__missing">!</span>}
                </button>
                <Popover
                    label={s.sidebar.create}
                    placement="down"
                    align="end"
                    className="project__create"
                    triggerClassName="icon-button"
                    trigger={<Icon name="plus" size={14} />}
                >
                    {(close) => (
                        <Choices
                            value={undefined}
                            options={[
                                {
                                    value: 'thread',
                                    label: s.sidebar.createThread,
                                    hint: s.sidebar.createThreadHint,
                                    icon: 'message',
                                },
                                {
                                    value: 'team',
                                    label: s.sidebar.createTeam,
                                    hint: s.sidebar.createTeamHint,
                                    icon: 'users',
                                },
                            ]}
                            onPick={(kind) => {
                                close();
                                if (kind === 'thread') openNewThread(project.id);
                                else useApp.setState({ teamStartFor: project.id });
                            }}
                        />
                    )}
                </Popover>
            </div>
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

const TEAM_ENDED = ['done', 'failed', 'cancelled'];
/** Runs under way listed under their entry; the board has the rest. */
const NAV_RUNS = 5;
const COLLAPSED_KEY = 'xora.sidebar.collapsed';
const DEFAULT_CHAT_GROUP_KEY = '_default';

function loadCollapsed(): Record<string, boolean> {
    try {
        const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '{}');
        if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
            return saved as Record<string, boolean>;
        }
    } catch {
        // Ignore malformed local storage state.
    }
    return {};
}

/** Standalone default conversations (Codex style): collapsible group at the top of the sidebar, bound to no project. */
function ChiefNav({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    const s = useStrings();
    const chiefOpen = useApp((state) => state.chiefOpen);
    const standaloneSelected = useApp(
        (state) =>
            !state.chiefOpen &&
            !state.teamRunId &&
            !state.workflowRunId &&
            !state.teamsFor &&
            !state.membersOpen &&
            isStandaloneChat(state.selectedThreadId ? state.threads[state.selectedThreadId] : undefined),
    );
    const news = useApp((state) =>
        Object.values(state.threads).some((thread) => isStandaloneChat(thread) && !thread.archived && thread.unread),
    );
    const threads = useApp((state) => state.threads);
    const selectedThreadId = useApp((state) => (state.chiefOpen ? undefined : state.selectedThreadId));
    const [showArchived, setShowArchived] = useState(false);

    const standalone = Object.values(threads).filter(
        (thread) => isStandaloneChat(thread) && !thread.parent && !thread.teamRunId && !thread.workflowRunId,
    );
    const active = standalone
        .filter((thread) => !thread.archived)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    const archived = standalone.filter((thread) => thread.archived).sort((a, b) => b.updatedAt - a.updatedAt);
    const headerSelected = !open && (chiefOpen || standaloneSelected);

    return (
        <div className="sidebar__chief-group">
            <div className="sidebar__nav-row">
                <button
                    type="button"
                    aria-expanded={open}
                    className={`sidebar__nav sidebar__nav--chief${headerSelected ? ' is-selected' : ''}`}
                    onClick={onToggle}
                >
                    <Icon name="chevronRight" size={12} className={`sidebar__chevron${open ? ' is-open' : ''}`} />
                    <Icon name="message" size={14} className="sidebar__chief-icon" />
                    <span className="sidebar__nav-label">{s.sidebar.chief}</span>
                    {news && <span className="dot-badge" />}
                    {!open && active.length > 0 && <span className="sidebar__count">{active.length}</span>}
                </button>
                <IconButton icon="plus" label={s.chief.newChat} onClick={() => openChief(true)} />
            </div>
            {open && (
                <div className="sidebar__chief-threads">
                    {(chiefOpen || active.length === 0) && (
                        <div className={`thread-row${chiefOpen ? ' is-selected' : ''}`}>
                            <button type="button" className="thread-row__main" onClick={() => openChief(true)}>
                                <span className="mark" />
                                <span className="thread-row__title">
                                    {chiefOpen ? s.chief.newChat : s.sidebar.noThreads}
                                </span>
                            </button>
                        </div>
                    )}
                    {active.map((thread) => (
                        <ThreadRow key={thread.id} thread={thread} selected={selectedThreadId === thread.id} />
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
                            <ThreadRow key={thread.id} thread={thread} selected={selectedThreadId === thread.id} />
                        ))}
                </div>
            )}
        </div>
    );
}

/**
 * The team (06 §24): the organization chart and the team's work in every project, with the runs under way listed
 * beneath it.
 */
function TeamNav() {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const boardOpen = useApp((state) => Boolean(state.teamsFor) || state.membersOpen);
    const openRunId = useApp((state) => state.teamRunId);
    const teamRuns = useApp((state) => state.teamRuns);
    const runs = Object.values(teamRuns)
        .filter((run) => !TEAM_ENDED.includes(run.status))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    const several = projects.length > 1;
    return (
        <>
            <button
                type="button"
                className={`sidebar__nav${boardOpen ? ' is-selected' : ''}`}
                onClick={() => openMembers()}
            >
                <Icon name="users" size={14} /> {s.sidebar.teams}
                {runs.length > 0 && <span className="sidebar__count">{runs.length}</span>}
            </button>
            {runs.slice(0, NAV_RUNS).map((run) => (
                <button
                    key={run.id}
                    type="button"
                    className={`run-row sidebar__run${openRunId === run.id ? ' is-selected' : ''}`}
                    onClick={() => openRun('team', run.id)}
                >
                    <span className="thread-row__title">{run.title ?? run.goal}</span>
                    <span className="thread-row__meta">
                        {several ? `${projects.find((project) => project.id === run.projectId)?.name ?? ''} · ` : ''}
                        {s.team.statuses[run.status]}
                    </span>
                </button>
            ))}
        </>
    );
}

export function Sidebar() {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const threadMap = useApp((state) => state.threads);
    const update = useApp((state) => state.update);
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<Array<{ threadId: string; title: string; snippet: string }> | undefined>();

    const toggleCollapsed = (id: string) => {
        setCollapsed((current) => {
            const next = { ...current, [id]: !current[id] };
            try {
                localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
            } catch {
                // Ignore storage quota errors.
            }
            return next;
        });
    };

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

    // What waits on the user: a card to approve, or a failure. Work that finished with changes is not it (03 §4):
    // its row carries the review mark, and the member or chief who did it reports back. A subagent's failure goes
    // back to its parent's agent, a team member's or workflow step's to its run; their approvals still need the user.
    const inbox = Object.values(threadMap).filter(
        (thread) =>
            !thread.archived &&
            (thread.status === 'awaiting_approval' ||
                (thread.status === 'failed' && !thread.parent && !thread.teamRunId && !thread.workflowRunId)),
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
            {/* No title bar: this strip drags the window, and on macOS holds its buttons. */}
            <div className="sidebar__top">
                <IconButton icon="folderPlus" label={s.sidebar.openProject} onClick={() => void openProject()} />
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
            <div className="sidebar__main">
                <ChiefNav
                    open={!collapsed[DEFAULT_CHAT_GROUP_KEY]}
                    onToggle={() => toggleCollapsed(DEFAULT_CHAT_GROUP_KEY)}
                />
                <TeamNav />
            </div>
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
                        onToggle={() => toggleCollapsed(project.id)}
                    />
                ))}
            </div>
            <div className="sidebar__bottom">
                <button type="button" className="sidebar__link" onClick={() => openSettings('general')}>
                    <Icon name="gear" size={14} /> {s.sidebar.settings}
                    {update?.state === 'ready' && <span className="dot-badge" />}
                </button>
            </div>
        </nav>
    );
}
