import type { Project, ThreadMeta } from '@xora/protocol';
import { useMemo, useState } from 'react';
import { host } from '../host.ts';
import { memberOf } from '../members.ts';
import {
    attempt,
    isChief,
    openChief,
    openMembers,
    openProject,
    openRun,
    openSettings,
    openTeamBoard,
    openWorkflowBoard,
    selectThread,
    useApp,
    useStrings,
} from '../store.ts';
import { Choices, Popover } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { MemberAvatar } from './MembersView.tsx';
import { AutoFocusInput, formatMoney, IconButton, relativeTime, Spinner } from './primitives.tsx';

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
    // A thread is selected only while it is what the main area shows, not under a run, a board or a page.
    const selectedThreadId = useApp((state) =>
        state.teamRunId ||
        state.workflowRunId ||
        state.teamsFor ||
        state.workflowsFor ||
        state.membersOpen ||
        state.chiefOpen
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
            !isChief(thread) &&
            !(thread.parent && threadMap[thread.parent.threadId]),
    );
    const archived = threads.filter((thread) => thread.archived && !isChief(thread));
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
                                {
                                    value: 'workflow',
                                    label: s.sidebar.createWorkflow,
                                    hint: s.sidebar.createWorkflowHint,
                                    icon: 'bolt',
                                },
                            ]}
                            onPick={(kind) => {
                                close();
                                useApp.setState(
                                    kind === 'thread'
                                        ? { newThreadFor: project.id }
                                        : kind === 'team'
                                          ? { teamStartFor: project.id }
                                          : { workflowDraftFor: project.id },
                                );
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
const WORKFLOW_ENDED = ['completed', 'failed', 'cancelled'];
/** Runs under way listed under their entry; the board has the rest. */
const NAV_RUNS = 5;

/** The chief assistant (06 §23): the one place to say what you need. A dot: news from work it handed on. */
function ChiefNav() {
    const s = useStrings();
    const selected = useApp(
        (state) =>
            state.chiefOpen ||
            (!state.teamRunId &&
                !state.workflowRunId &&
                !state.teamsFor &&
                !state.workflowsFor &&
                !state.membersOpen &&
                isChief(state.selectedThreadId ? state.threads[state.selectedThreadId] : undefined)),
    );
    const news = useApp((state) =>
        Object.values(state.threads).some((thread) => isChief(thread) && !thread.archived && thread.unread),
    );
    return (
        <button
            type="button"
            className={`sidebar__nav sidebar__nav--chief${selected ? ' is-selected' : ''}`}
            onClick={() => openChief()}
        >
            <Icon name="sparkle" size={14} /> {s.sidebar.chief}
            {news && <span className="dot-badge" />}
        </button>
    );
}

/**
 * Teams and workflows of every project: one entry each (the board picks the project), with the runs under way
 * listed beneath it.
 */
function RunsNav({ kind }: { kind: 'team' | 'workflow' }) {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const boardOpen = useApp((state) => (kind === 'team' ? Boolean(state.teamsFor) : Boolean(state.workflowsFor)));
    const openRunId = useApp((state) => (kind === 'team' ? state.teamRunId : state.workflowRunId));
    const teamRuns = useApp((state) => state.teamRuns);
    const workflowRuns = useApp((state) => state.workflowRuns);
    const runs =
        kind === 'team'
            ? Object.values(teamRuns)
                  .filter((run) => !TEAM_ENDED.includes(run.status))
                  .map((run) => ({
                      id: run.id,
                      title: run.goal,
                      projectId: run.projectId,
                      status: s.team.statuses[run.status],
                      updatedAt: run.updatedAt,
                  }))
            : Object.values(workflowRuns)
                  // Sub-workflows are reached through their parent run.
                  .filter((run) => !WORKFLOW_ENDED.includes(run.status) && !run.parentRunId)
                  .map((run) => ({
                      id: run.id,
                      title: run.title,
                      projectId: run.projectId,
                      status: s.workflow.statuses[run.status],
                      updatedAt: run.updatedAt,
                  }));
    runs.sort((a, b) => b.updatedAt - a.updatedAt);
    const several = projects.length > 1;
    return (
        <>
            <button
                type="button"
                className={`sidebar__nav${boardOpen ? ' is-selected' : ''}`}
                onClick={() => (kind === 'team' ? openTeamBoard() : openWorkflowBoard())}
            >
                <Icon name={kind === 'team' ? 'users' : 'bolt'} size={14} />{' '}
                {kind === 'team' ? s.sidebar.teams : s.sidebar.workflows}
                {runs.length > 0 && <span className="sidebar__count">{runs.length}</span>}
            </button>
            {runs.slice(0, NAV_RUNS).map((run) => (
                <button
                    key={run.id}
                    type="button"
                    className={`run-row sidebar__run${openRunId === run.id ? ' is-selected' : ''}`}
                    onClick={() => openRun(kind, run.id)}
                >
                    <span className="thread-row__title">{run.title}</span>
                    <span className="thread-row__meta">
                        {several ? `${projects.find((project) => project.id === run.projectId)?.name ?? ''} · ` : ''}
                        {run.status}
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
    const membersOpen = useApp((state) => state.membersOpen);
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

    // A subagent's failure goes back to its parent's agent; its approvals still need the user.
    const inbox = Object.values(threadMap).filter(
        (thread) =>
            !thread.archived &&
            (thread.status === 'awaiting_approval' ||
                (!thread.parent && (thread.needsReview || thread.status === 'failed'))),
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
            <div className="sidebar__main">
                <ChiefNav />
                <RunsNav kind="team" />
                <RunsNav kind="workflow" />
                <button
                    type="button"
                    className={`sidebar__nav${membersOpen ? ' is-selected' : ''}`}
                    onClick={() => openMembers()}
                >
                    <Icon name="user" size={14} /> {s.sidebar.members}
                </button>
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
