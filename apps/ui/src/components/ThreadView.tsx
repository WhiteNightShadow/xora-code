import type { Attachment, ThreadMeta } from '@xora/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { host } from '../host.ts';
import { ItemView } from '../items/ItemView.tsx';
import { memberOf } from '../members.ts';
import {
    attempt,
    isChief,
    openChief,
    openReview,
    openWorkflowBoard,
    selectThread,
    takeComposerInbox,
    toast,
    useApp,
    useStrings,
    watchThread,
} from '../store.ts';
import { format } from '../strings.ts';
import { type TurnView, visibleItems } from '../timeline.ts';
import { ConversationArt } from './Art.tsx';
import { ContextMeter, EffortPicker, ModelPicker, ModePicker, Popover } from './Controls.tsx';
import { GoalBanner, GoalDialog } from './GoalDialog.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { MemberChip } from './MembersView.tsx';
import { AutoFocusInput, formatMoney, formatTokens, Spinner, Toggle } from './primitives.tsx';

/** A subagent's thread links back to the thread whose agent started it. */
function ParentLink({ threadId }: { threadId: string }) {
    const s = useStrings();
    const parent = useApp((state) => state.threads[threadId]);
    if (!parent) return null;
    return (
        <button type="button" className="link thread-header__parent" onClick={() => void selectThread(threadId)}>
            <Icon name="chevronLeft" size={11} /> {format(s.subagent.parent, { title: parent.title })}
        </button>
    );
}

type PanelName =
    | 'changes'
    | 'worktree'
    | 'compare'
    | 'plan'
    | 'trajectory'
    | 'prompt'
    | 'terminal'
    | 'preview'
    | 'file';

/**
 * The thread's top bar: its title and where it works. The per-message choices (mode, model, thinking, context)
 * sit under the composer; panels and thread actions are in the ⋯ menu.
 */
function Header({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const rightPanel = useApp((state) => state.rightPanel);
    const project = useApp((state) => state.projects.find((item) => item.id === thread.projectId));
    const member = useApp((state) => memberOf(thread, state.members));
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(thread.title);
    useEffect(() => setTitle(thread.title), [thread.title]);
    const rename = (value: string) =>
        void attempt(() => host.call('thread.update', { threadId: thread.id, title: value }));
    const [goalOpen, setGoalOpen] = useState(false);
    const split = useApp((state) => state.split);
    const handoff = async (to: 'local' | 'worktree') => {
        const result = await attempt(() =>
            host.call('thread.handoff', { threadId: thread.id, to }, { timeoutMs: 120_000 }),
        );
        if (result)
            toast(
                result.result.status === 'conflicts'
                    ? `${s.compare.conflicts}${result.result.conflicts.map((conflict) => conflict.path).join(', ')}`
                    : s.location.moved,
                result.result.status === 'conflicts' ? 'error' : 'success',
            );
    };
    const panels: Array<{ panel: PanelName; icon: IconName; label: string }> = [
        { panel: 'changes', icon: 'diff', label: s.panel.changes },
        ...(project?.git.isRepo
            ? [{ panel: 'worktree' as const, icon: 'pencil' as const, label: s.panel.worktree }]
            : []),
        ...(thread.group ? [{ panel: 'compare' as const, icon: 'chart' as const, label: s.panel.compare }] : []),
        { panel: 'plan', icon: 'list', label: s.panel.plan },
        { panel: 'trajectory', icon: 'route', label: s.panel.trajectory },
        { panel: 'prompt', icon: 'brain', label: s.panel.prompt },
        { panel: 'terminal', icon: 'terminal', label: s.panel.terminal },
        { panel: 'preview', icon: 'globe', label: s.panel.preview },
        { panel: 'file', icon: 'file', label: s.panel.file },
    ];
    const distill = (kind: 'workflow' | 'skill') =>
        void attempt(() => host.call('thread.distill', { threadId: thread.id, kind })).then((created) => {
            if (!created) return;
            useApp.setState((state) => ({ threads: { ...state.threads, [created.id]: created } }));
            void selectThread(created.id);
        });
    return (
        <header className="thread-header">
            <div className="thread-header__title">
                {editing ? (
                    <AutoFocusInput
                        className="input"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                        onBlur={() => {
                            setEditing(false);
                            if (title.trim() && title.trim() !== thread.title) rename(title.trim());
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
                            if (event.key === 'Escape') {
                                setTitle(thread.title);
                                setEditing(false);
                            }
                        }}
                    />
                ) : (
                    <h1 onDoubleClick={() => setEditing(true)} title={s.thread.editTitle}>
                        {thread.title}
                    </h1>
                )}
                <span className="thread-header__project">
                    {project?.name}
                    {thread.location.kind === 'worktree'
                        ? ` · ${s.location.worktree}`
                        : project?.git.branch
                          ? ` · ${project.git.branch}`
                          : ''}
                </span>
                {member && <MemberChip member={member} />}
                {thread.parent && <ParentLink threadId={thread.parent.threadId} />}
            </div>
            <div className="thread-header__controls">
                {isChief(thread) && (
                    <button
                        type="button"
                        className="button button--small"
                        title={s.chief.newChatHint}
                        onClick={() => openChief(true)}
                    >
                        <Icon name="plus" size={13} /> {s.chief.newChat}
                    </button>
                )}
                <Popover
                    label={s.common.more}
                    placement="down"
                    align="end"
                    className="thread-header__menu"
                    triggerClassName="icon-button"
                    trigger={<Icon name="more" size={16} />}
                >
                    {(close) => (
                        <div className="menu-list">
                            <div className="popover__title">{s.thread.panels}</div>
                            {panels.map((item) => (
                                <button
                                    key={item.panel}
                                    type="button"
                                    role="menuitemcheckbox"
                                    aria-checked={rightPanel === item.panel}
                                    className={rightPanel === item.panel ? 'is-active' : ''}
                                    onClick={() => {
                                        close();
                                        useApp.setState({
                                            rightPanel: rightPanel === item.panel ? undefined : item.panel,
                                        });
                                    }}
                                >
                                    <Icon name={item.icon} size={14} /> {item.label}
                                    {rightPanel === item.panel && (
                                        <Icon name="check" size={14} className="menu-list__check" />
                                    )}
                                </button>
                            ))}
                            <div className="popover__title">{s.thread.actions}</div>
                            {project?.git.isRepo && thread.location.kind === 'local' && !thread.parent && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        close();
                                        void handoff('worktree');
                                    }}
                                >
                                    <Icon name="route" size={14} /> {s.location.toWorktree}
                                </button>
                            )}
                            {thread.location.kind === 'worktree' && !thread.parent && (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            close();
                                            void handoff('local');
                                        }}
                                    >
                                        <Icon name="route" size={14} /> {s.location.toLocal}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            close();
                                            void attempt(() =>
                                                host.call(
                                                    'worktree.apply',
                                                    { threadId: thread.id },
                                                    { timeoutMs: 120_000 },
                                                ),
                                            ).then(
                                                (result) =>
                                                    result &&
                                                    toast(
                                                        result.status === 'conflicts'
                                                            ? s.compare.conflicts
                                                            : s.location.moved,
                                                        result.status === 'conflicts' ? 'error' : 'success',
                                                    ),
                                            );
                                        }}
                                    >
                                        <Icon name="check" size={14} /> {s.location.applyToMain}
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                onClick={() => {
                                    close();
                                    setGoalOpen(true);
                                }}
                            >
                                <Icon name="pin" size={14} /> {s.goal.setGoal}
                            </button>
                            <button
                                type="button"
                                disabled={thread.turns === 0}
                                onClick={() => {
                                    close();
                                    distill('workflow');
                                }}
                            >
                                <Icon name="bolt" size={14} /> {s.thread.distillWorkflow}
                            </button>
                            <button
                                type="button"
                                disabled={thread.turns === 0}
                                onClick={() => {
                                    close();
                                    distill('skill');
                                }}
                            >
                                <Icon name="sparkle" size={14} /> {s.thread.distillSkill}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    close();
                                    useApp.setState({
                                        split: split.includes(thread.id)
                                            ? split.filter((id) => id !== thread.id)
                                            : [...split, thread.id].slice(-3),
                                    });
                                }}
                            >
                                <Icon name="panel" size={14} />{' '}
                                {split.includes(thread.id) ? s.location.unsplit : s.location.split}
                            </button>
                        </div>
                    )}
                </Popover>
            </div>
            {goalOpen && <GoalDialog thread={thread} onClose={() => setGoalOpen(false)} />}
        </header>
    );
}

/** A thread that writes a workflow says what comes next: running it from the workflow board. */
function DraftBanner({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    if (thread.role !== 'distill') return null;
    return (
        <div className="draft-banner">
            <Icon name="bolt" size={14} />
            <span>{s.thread.draftBanner}</span>
            <button
                type="button"
                className="button button--small button--primary"
                onClick={() => openWorkflowBoard(thread.projectId)}
            >
                {s.thread.openBoard}
            </button>
        </div>
    );
}

/**
 * Go back to before a turn, or fork the thread from it (M3-3); only the xora engine keeps turn markers. Shown when the
 * turn is hovered; the last turn has no fork, which would only copy the whole thread.
 */
function TurnHistory({ thread, turn, isLast }: { thread: ThreadMeta; turn: TurnView; isLast: boolean }) {
    const s = useStrings();
    const [confirming, setConfirming] = useState(false);
    const [files, setFiles] = useState(true);
    const busy = thread.status === 'running' || thread.status === 'awaiting_approval';
    if (thread.engine !== 'xora' || busy) return null;
    const rewind = async () => {
        const result = await attempt(() =>
            host.call('thread.rewind', { threadId: thread.id, turnId: turn.turnId, files }),
        );
        setConfirming(false);
        if (!result) return;
        if (result.conflicts.length > 0) {
            toast(format(s.thread.rewindConflicts, { count: result.conflicts.length }), 'error');
        } else {
            toast(s.thread.rewindDone, 'success');
        }
    };
    const fork = async () => {
        const forked = await attempt(() => host.call('thread.fork', { threadId: thread.id, afterTurnId: turn.turnId }));
        if (forked) {
            toast(s.thread.forked, 'success');
            await selectThread(forked.id);
        }
    };
    return (
        <>
            <span className={`turn__history${confirming ? ' is-open' : ''}`}>
                <button type="button" className="link" onClick={() => setConfirming(!confirming)}>
                    {s.thread.rewind}
                </button>
                {!isLast && (
                    <button type="button" className="link" onClick={() => void fork()}>
                        {s.thread.fork}
                    </button>
                )}
            </span>
            {confirming && (
                <div className="turn__confirm">
                    <span>{s.thread.rewindHint}</span>
                    <Toggle label={s.thread.rewindFiles} checked={files} onChange={setFiles} />
                    <div className="row">
                        <button
                            type="button"
                            className="button button--small button--danger"
                            onClick={() => void rewind()}
                        >
                            {s.common.confirm}
                        </button>
                        <button type="button" className="button button--small" onClick={() => setConfirming(false)}>
                            {s.common.cancel}
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}

const COMPACT_COMMAND = /^\/compact(?:\s+([\s\S]*))?$/;

function TurnBlock({ turn, isLast, thread }: { turn: TurnView; isLast: boolean; thread: ThreadMeta }) {
    const s = useStrings();
    const running = turn.status === 'running';
    const items = visibleItems(turn.items);
    const lastItem = items.at(-1);
    const compact = COMPACT_COMMAND.exec(turn.input.text.trim());
    // `/compact` changes this thread's context in place: its turn reads as a divider in the conversation, with no
    // message bubble and nothing to rewind to or fork from. A turn that ended without a compaction shows as usual.
    if (compact && (items.length > 0 ? items.every((item) => item.type === 'compaction') : running)) {
        const focus = compact[1]?.trim();
        return (
            <section className="turn turn--compaction">
                {items.length === 0 ? (
                    <div className="turn__working">
                        <Spinner /> {s.context.compacting}
                    </div>
                ) : (
                    items.map((item) => <ItemView key={item.id} item={item} live={false} turnRunning={running} />)
                )}
                {focus && <div className="compaction__focus">{format(s.context.focus, { focus })}</div>}
            </section>
        );
    }
    if (turn.rewound) {
        return (
            <section className="turn turn--rewound">
                <div className="user-message">
                    <div className="user-message__text">{turn.input.text}</div>
                </div>
                <div className="turn__footer">
                    <span className="turn__reverted">{s.thread.rewound}</span>
                </div>
            </section>
        );
    }
    return (
        <section className="turn">
            <div className="user-message">
                <div className="user-message__text">{turn.input.text}</div>
                {turn.input.attachments.length > 0 && (
                    <div className="user-message__attachments">
                        {turn.input.attachments.map((attachment) => (
                            <span key={attachment.name} className="chip">
                                <Icon name="clip" size={11} /> {attachment.name}
                            </span>
                        ))}
                    </div>
                )}
            </div>
            <div className="turn__items">
                {items.map((item) => (
                    <ItemView key={item.id} item={item} live={running && item === lastItem} turnRunning={running} />
                ))}
                {running &&
                    isLast &&
                    (!lastItem || lastItem.type === 'tool_call' || lastItem.type === 'file_changes') && (
                        <div className="turn__working">
                            <Spinner /> {s.thread.working}
                        </div>
                    )}
            </div>
            {!running && (
                <div className="turn__footer">
                    {turn.status === 'cancelled' && <span>{s.thread.turnCancelled}</span>}
                    {turn.durationMs !== undefined && (
                        <span>{format(s.thread.duration, { seconds: Math.round(turn.durationMs / 1000) })}</span>
                    )}
                    {turn.usage?.cost && <span>{formatMoney(turn.usage.cost)}</span>}
                    {turn.usage && turn.usage.inputTokens > 0 && (
                        <span>
                            {formatTokens(turn.usage.inputTokens)}→{formatTokens(turn.usage.outputTokens)}
                        </span>
                    )}
                    {turn.reverted && <span className="turn__reverted">{s.thread.reverted}</span>}
                    {turn.changes && !turn.items.some((item) => item.type === 'file_changes') && (
                        <button type="button" className="link" onClick={() => openReview(turn.turnId)}>
                            {s.thread.review}
                        </button>
                    )}
                    <TurnHistory thread={thread} turn={turn} isLast={isLast} />
                </div>
            )}
        </section>
    );
}

async function readAttachment(file: File): Promise<Attachment> {
    if (file.type.startsWith('image/')) {
        const buffer = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let index = 0; index < buffer.length; index += 0x8000) {
            binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
        }
        return {
            kind: 'image',
            name: file.name || 'image.png',
            mimeType: file.type,
            data: btoa(binary),
            size: file.size,
        };
    }
    return {
        kind: 'text',
        name: file.name,
        mimeType: file.type || 'text/plain',
        data: await file.text(),
        size: file.size,
    };
}

/** A suggestion of the composer: a file to mention, a slash command, or an agent to hand the message to. */
interface Suggestion {
    readonly kind: 'file' | 'command' | 'agent';
    /** File path, command name or agent name. */
    readonly value: string;
    readonly hint?: string;
}

function Composer({ thread, turns }: { thread: ThreadMeta; turns: readonly TurnView[] }) {
    const s = useStrings();
    const [text, setText] = useState('');
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [sending, setSending] = useState(false);
    const area = useRef<HTMLTextAreaElement>(null);
    const running = thread.status === 'running' || thread.status === 'awaiting_approval';
    // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
    useLayoutEffect(() => {
        const element = area.current;
        if (element) {
            element.style.height = 'auto';
            element.style.height = `${Math.min(element.scrollHeight, 320)}px`;
        }
    }, [text]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: focus again when switching threads
    useEffect(() => {
        area.current?.focus();
    }, [thread.id]);
    const inbox = useApp((state) => state.composerInbox[thread.id]);
    useEffect(() => {
        if (inbox && inbox.length > 0) {
            const items = takeComposerInbox(thread.id);
            setAttachments((current) => [...current, ...items]);
            area.current?.focus();
        }
    }, [inbox, thread.id]);
    const [mention, setMention] = useState<
        | {
              kind: 'file' | 'command';
              query: string;
              start: number;
              items: Suggestion[];
              index: number;
          }
        | undefined
    >();
    // Command files and agent definitions are read again after a short while, so a newly added file shows up
    // without a restart.
    const extensions = useRef<
        { projectId: string; at: number; commands: Suggestion[]; agents: Suggestion[] } | undefined
    >(undefined);
    const cachedExtensions = () =>
        extensions.current?.projectId === thread.projectId ? extensions.current : undefined;
    const refreshExtensions = (then: (loaded: { commands: Suggestion[]; agents: Suggestion[] }) => void) => {
        const cached = cachedExtensions();
        if (cached && Date.now() - cached.at < 15_000) return;
        void host
            .call('extension.list', { projectId: thread.projectId })
            .then((snapshot) => {
                const loaded = {
                    projectId: thread.projectId,
                    at: Date.now(),
                    commands: snapshot.commands.map(
                        (command): Suggestion => ({
                            kind: 'command',
                            value: command.name,
                            hint: [command.argumentHint, command.description].filter(Boolean).join(' · '),
                        }),
                    ),
                    agents: snapshot.agents.map(
                        (agent): Suggestion => ({ kind: 'agent', value: agent.name, hint: agent.description }),
                    ),
                };
                extensions.current = loaded;
                then(loaded);
            })
            .catch(() => undefined);
    };
    const updateCommands = (value: string, caret: number): boolean => {
        const slash = /^\/([^\s/]*)$/.exec(value.slice(0, caret));
        if (!slash) return false;
        const query = slash[1] ?? '';
        const builtin: Suggestion = { kind: 'command', value: 'compact', hint: s.thread.compactCommand };
        const matching = (commands: readonly Suggestion[]) =>
            [builtin, ...commands].filter((item) => item.value.startsWith(query)).slice(0, 12);
        setMention({ kind: 'command', query, start: 0, items: matching(cachedExtensions()?.commands ?? []), index: 0 });
        refreshExtensions((loaded) =>
            setMention((current) =>
                current?.kind === 'command' && current.query === query
                    ? { ...current, items: matching(loaded.commands) }
                    : current,
            ),
        );
        return true;
    };
    // `@name` of a defined agent hands the message to it (03 §4); only threads that may start subagents can.
    const delegates = thread.engine === 'xora' && !thread.parent && !thread.teamRunId && !thread.workflowRunId;
    const updateMention = (value: string, caret: number) => {
        if (updateCommands(value, caret)) return;
        const match = /(^|[^A-Za-z0-9_@])@([^\s@]*)$/.exec(value.slice(0, caret));
        if (!match) {
            setMention(undefined);
            return;
        }
        const query = match[2] ?? '';
        const start = caret - query.length - 1;
        const agentsFor = (agents: readonly Suggestion[]) =>
            delegates
                ? agents.filter((agent) => agent.value.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
                : [];
        const files = (items: readonly Suggestion[]) => items.filter((item) => item.kind === 'file');
        setMention((current) => ({
            kind: 'file',
            query,
            start,
            items: [
                ...agentsFor(cachedExtensions()?.agents ?? []),
                ...(current?.kind === 'file' ? files(current.items) : []),
            ],
            index: 0,
        }));
        const same = (current: typeof mention) => current?.kind === 'file' && current.query === query;
        if (delegates) {
            refreshExtensions((loaded) =>
                setMention((current) =>
                    current && same(current)
                        ? { ...current, items: [...agentsFor(loaded.agents), ...files(current.items)] }
                        : current,
                ),
            );
        }
        void host
            .call('fs.find', { threadId: thread.id, query })
            .then((found) =>
                setMention((current) =>
                    current && same(current)
                        ? {
                              ...current,
                              items: [
                                  ...current.items.filter((item) => item.kind === 'agent'),
                                  ...found.map((file): Suggestion => ({ kind: 'file', value: file })),
                              ],
                              index: 0,
                          }
                        : current,
                ),
            )
            .catch(() => undefined);
    };
    const pickMention = (item: Suggestion) => {
        if (!mention) return;
        if (item.kind === 'command') {
            setText(`/${item.value} ${text.slice(mention.query.length + 1).trimStart()}`);
            setMention(undefined);
            area.current?.focus();
            return;
        }
        const before = text.slice(0, mention.start);
        const after = text.slice(mention.start + mention.query.length + 1);
        setText(`${before}@${item.value} ${after}`);
        const file = item.value;
        if (item.kind === 'file') {
            setAttachments((current) =>
                current.some((attachment) => attachment.path === file)
                    ? current
                    : [
                          ...current,
                          { kind: 'file', name: file.split('/').pop() ?? file, mimeType: 'text/plain', path: file },
                      ],
            );
        }
        setMention(undefined);
        area.current?.focus();
    };
    const send = async () => {
        if (running || sending || (!text.trim() && attachments.length === 0)) return;
        setSending(true);
        const compact = COMPACT_COMMAND.exec(text.trim());
        const result = compact
            ? await attempt(() =>
                  host.call('turn.compact', {
                      threadId: thread.id,
                      ...(compact[1]?.trim() ? { focus: compact[1].trim() } : {}),
                  }),
              )
            : await attempt(() => host.call('turn.start', { threadId: thread.id, text, attachments }));
        setSending(false);
        if (result) {
            setText('');
            setAttachments([]);
        }
    };
    const addFiles = async (files: FileList | File[]) => {
        const next = await Promise.all([...files].slice(0, 10).map(readAttachment));
        setAttachments((current) => [...current, ...next]);
    };
    return (
        <div className="composer">
            {/* The box is not positioned, so the suggestion list still hangs off the composer above it. */}
            <div className="composer__box">
                {attachments.length > 0 && (
                    <div className="composer__attachments">
                        {attachments.map((attachment, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: two attachments may share a name
                            <span key={`${attachment.name}-${index}`} className="chip">
                                <Icon name="clip" size={11} /> {attachment.name}
                                <button
                                    type="button"
                                    aria-label={s.common.close}
                                    onClick={() => setAttachments(attachments.filter((_, other) => other !== index))}
                                >
                                    <Icon name="x" size={10} />
                                </button>
                            </span>
                        ))}
                    </div>
                )}
                {mention && mention.items.length > 0 && (
                    <div
                        className="mention"
                        role="listbox"
                        aria-label={
                            mention.kind === 'command'
                                ? s.thread.commandList
                                : mention.items.some((item) => item.kind === 'agent')
                                  ? s.thread.mention
                                  : s.thread.mentionFiles
                        }
                    >
                        {mention.items.map((item, index) => (
                            <button
                                key={`${item.kind}:${item.value}`}
                                type="button"
                                role="option"
                                aria-selected={index === mention.index}
                                className={index === mention.index ? 'is-active' : ''}
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    pickMention(item);
                                }}
                            >
                                {item.kind === 'command'
                                    ? `/${item.value}`
                                    : item.kind === 'agent'
                                      ? `@${item.value}`
                                      : item.value}
                                {item.hint && <span className="mention__hint">{item.hint}</span>}
                            </button>
                        ))}
                    </div>
                )}
                <textarea
                    ref={area}
                    className="composer__input"
                    value={text}
                    rows={2}
                    placeholder={s.thread.placeholder}
                    onChange={(event) => {
                        setText(event.target.value);
                        updateMention(event.target.value, event.target.selectionStart);
                    }}
                    onKeyDown={(event) => {
                        if (mention && mention.items.length > 0) {
                            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                event.preventDefault();
                                const step = event.key === 'ArrowDown' ? 1 : -1;
                                setMention({
                                    ...mention,
                                    index: (mention.index + step + mention.items.length) % mention.items.length,
                                });
                                return;
                            }
                            if (event.key === 'Enter' || event.key === 'Tab') {
                                event.preventDefault();
                                const item = mention.items[mention.index];
                                if (item) pickMention(item);
                                return;
                            }
                        }
                        if (event.key === 'Escape' && mention) {
                            setMention(undefined);
                            return;
                        }
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            void send();
                        }
                    }}
                    onPaste={(event) => {
                        const files = [...event.clipboardData.files];
                        if (files.length > 0) {
                            event.preventDefault();
                            void addFiles(files);
                        }
                    }}
                    onDrop={(event) => {
                        if (event.dataTransfer.files.length > 0) {
                            event.preventDefault();
                            void addFiles(event.dataTransfer.files);
                        }
                    }}
                />
                <div className="composer__bar">
                    <label className="icon-button" title={s.thread.attach}>
                        <Icon name="clip" size={15} />
                        <input
                            type="file"
                            multiple
                            hidden
                            onChange={(event) => event.target.files && void addFiles(event.target.files)}
                        />
                    </label>
                    <ModePicker thread={thread} />
                    {/* Other engines pick their own model and thinking. */}
                    {thread.engine === 'xora' && <ModelPicker thread={thread} />}
                    {thread.engine === 'xora' && <EffortPicker thread={thread} />}
                    <span className="composer__spacer" />
                    <ContextMeter thread={thread} turns={turns} />
                    {running ? (
                        <button
                            type="button"
                            className="button button--danger"
                            onClick={() => void attempt(() => host.call('turn.cancel', { threadId: thread.id }))}
                        >
                            <Icon name="stop" size={13} /> {s.thread.stop}
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="button button--primary"
                            disabled={sending || (!text.trim() && attachments.length === 0)}
                            onClick={() => void send()}
                        >
                            {sending ? <Spinner /> : <Icon name="send" size={13} />} {s.thread.send}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

export function ThreadView({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const view = useApp((state) => state.views[thread.id]);
    const scroller = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    const turns = view?.turns ?? [];
    useEffect(() => watchThread(thread.id), [thread.id]);
    const signature = useMemo(() => {
        const last = turns.at(-1);
        const lastItem = last?.items.at(-1);
        return `${turns.length}:${last?.items.length}:${lastItem && 'text' in lastItem ? lastItem.text.length : 0}:${last?.status}`;
    }, [turns]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the visible content grows
    useLayoutEffect(() => {
        const element = scroller.current;
        if (element && stick.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [signature]);
    // biome-ignore lint/correctness/useExhaustiveDependencies: only when entering a thread, not on every update
    useEffect(() => {
        stick.current = true;
        if (thread.needsReview) {
            const last = [...turns].reverse().find((turn) => turn.changes);
            if (last) openReview(last.turnId);
            void host.call('thread.markReviewed', { threadId: thread.id }).catch(() => undefined);
        }
    }, [thread.id]);
    return (
        <div className="thread">
            <Header thread={thread} />
            <DraftBanner thread={thread} />
            <GoalBanner thread={thread} />
            <div
                className="timeline"
                ref={scroller}
                onScroll={(event) => {
                    const element = event.currentTarget;
                    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                }}
            >
                {!view && (
                    <div className="timeline__loading">
                        <Spinner /> {s.common.loading}
                    </div>
                )}
                {view && turns.length === 0 && (
                    <div className="timeline__empty">
                        <ConversationArt className="timeline__art" />
                        <span>{s.thread.noMessages}</span>
                    </div>
                )}
                {turns.map((turn, index) => (
                    <TurnBlock key={turn.turnId} turn={turn} isLast={index === turns.length - 1} thread={thread} />
                ))}
            </div>
            {/* A workflow run's own thread is its log: notices and approval cards, nobody to talk to. */}
            {thread.role !== 'workflow' && <Composer thread={thread} turns={turns} />}
        </div>
    );
}
