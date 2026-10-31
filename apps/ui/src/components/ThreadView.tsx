import type { Attachment, Effort, ModelOption, PermissionMode, ThreadMeta } from '@xora/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { host } from '../host.ts';
import { ItemView } from '../items/ItemView.tsx';
import {
    attempt,
    openReview,
    openSettings,
    selectThread,
    takeComposerInbox,
    toast,
    useApp,
    useStrings,
    watchThread,
} from '../store.ts';
import { format } from '../strings.ts';
import type { TurnView } from '../timeline.ts';
import { GoalBanner, GoalDialog } from './GoalDialog.tsx';
import { Icon } from './Icon.tsx';
import {
    AutoFocusInput,
    formatMoney,
    formatTokens,
    IconButton,
    type Option,
    Select,
    Spinner,
    Toggle,
} from './primitives.tsx';

const MODES: PermissionMode[] = ['ask', 'auto_edit', 'plan', 'full'];
const EFFORTS: Effort[] = ['off', 'low', 'medium', 'high', 'max'];

function modelKey(option: { connectionId: string; model: string }): string {
    return `${option.connectionId}::${option.model}`;
}

function Header({ thread }: { thread: ThreadMeta }) {
    const s = useStrings();
    const models = useApp((state) => state.models);
    const rightPanel = useApp((state) => state.rightPanel);
    const project = useApp((state) => state.projects.find((item) => item.id === thread.projectId));
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(thread.title);
    useEffect(() => setTitle(thread.title), [thread.title]);
    const update = (patch: {
        title?: string;
        mode?: PermissionMode;
        effort?: Effort;
        model?: { connectionId: string; model: string };
    }) => void attempt(() => host.call('thread.update', { threadId: thread.id, ...patch }));
    const modelOptions: Option<string>[] = models.map((option: ModelOption) => ({
        value: modelKey({ connectionId: option.connectionId, model: option.model.id }),
        label: `${option.model.name} · ${option.connectionName}`,
    }));
    const currentModel = models.find(
        (option) =>
            thread.model && option.connectionId === thread.model.connectionId && option.model.id === thread.model.model,
    );
    const efforts = currentModel
        ? EFFORTS.filter((effort) =>
              effort === 'off'
                  ? currentModel.model.reasoning.mode === 'toggle'
                  : currentModel.model.reasoning.efforts.includes(effort),
          )
        : EFFORTS;
    const [menu, setMenu] = useState(false);
    const [goalOpen, setGoalOpen] = useState(false);
    const split = useApp((state) => state.split);
    const handoff = async (to: 'local' | 'worktree') => {
        setMenu(false);
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
    const toggle = (
        panel: 'changes' | 'worktree' | 'compare' | 'plan' | 'trajectory' | 'prompt' | 'terminal' | 'preview' | 'file',
    ) => useApp.setState({ rightPanel: rightPanel === panel ? undefined : panel });
    const contextRatio = thread.context && thread.context.size > 0 ? thread.context.used / thread.context.size : 0;
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
                            if (title.trim() && title.trim() !== thread.title) update({ title: title.trim() });
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
            </div>
            <div className="thread-header__controls">
                {models.length === 0 ? (
                    <button type="button" className="button button--small" onClick={() => openSettings('models')}>
                        {s.welcome.connectModel}
                    </button>
                ) : (
                    <Select
                        compact
                        label={s.thread.model}
                        value={thread.model ? modelKey(thread.model) : ''}
                        options={modelOptions}
                        onChange={(value) => {
                            const [connectionId, model] = value.split('::');
                            if (connectionId && model) update({ model: { connectionId, model } });
                        }}
                    />
                )}
                <Select
                    compact
                    label={s.thread.mode}
                    value={thread.mode}
                    options={MODES.map((mode) => ({ value: mode, label: s.modes[mode], hint: s.modeHints[mode] }))}
                    onChange={(mode) => {
                        if (mode === 'full' && !window.confirm(`${s.modes.full}：${s.modeHints.full}`)) return;
                        update({ mode });
                    }}
                />
                {currentModel?.model.reasoning.mode !== 'none' && (
                    <Select
                        compact
                        label={s.thread.effort}
                        value={efforts.includes(thread.effort) ? thread.effort : ''}
                        options={efforts.map((effort) => ({
                            value: effort,
                            label: `${s.thread.effort}·${s.efforts[effort]}`,
                        }))}
                        onChange={(effort) => update({ effort })}
                    />
                )}
                {thread.context && (
                    <span
                        className={`meter${contextRatio > 0.8 ? ' is-high' : ''}`}
                        title={`${s.thread.context} ${formatTokens(thread.context.used)}/${formatTokens(thread.context.size)}`}
                    >
                        <span
                            className="meter__bar"
                            style={{ width: `${Math.min(100, Math.round(contextRatio * 100))}%` }}
                        />
                    </span>
                )}
                <span className="thread-header__cost" title={s.thread.cost}>
                    {formatMoney(thread.cost)}
                </span>
                <IconButton
                    icon="diff"
                    label={s.panel.changes}
                    active={rightPanel === 'changes'}
                    onClick={() => toggle('changes')}
                />
                {project?.git.isRepo && (
                    <IconButton
                        icon="pencil"
                        label={s.panel.worktree}
                        active={rightPanel === 'worktree'}
                        onClick={() => toggle('worktree')}
                    />
                )}
                {thread.group && (
                    <IconButton
                        icon="chart"
                        label={s.panel.compare}
                        active={rightPanel === 'compare'}
                        onClick={() => toggle('compare')}
                    />
                )}
                <IconButton
                    icon="list"
                    label={s.panel.plan}
                    active={rightPanel === 'plan'}
                    onClick={() => toggle('plan')}
                />
                <IconButton
                    icon="route"
                    label={s.panel.trajectory}
                    active={rightPanel === 'trajectory'}
                    onClick={() => toggle('trajectory')}
                />
                <IconButton
                    icon="brain"
                    label={s.panel.prompt}
                    active={rightPanel === 'prompt'}
                    onClick={() => toggle('prompt')}
                />
                <IconButton
                    icon="terminal"
                    label={s.panel.terminal}
                    active={rightPanel === 'terminal'}
                    onClick={() => toggle('terminal')}
                />
                <IconButton
                    icon="globe"
                    label={s.panel.preview}
                    active={rightPanel === 'preview'}
                    onClick={() => toggle('preview')}
                />
                <IconButton
                    icon="file"
                    label={s.panel.file}
                    active={rightPanel === 'file'}
                    onClick={() => toggle('file')}
                />
                <span className="thread-header__menu">
                    <IconButton icon="more" label={s.common.more} onClick={() => setMenu(!menu)} />
                    {menu && (
                        <div className="menu" role="menu" tabIndex={-1} onMouseLeave={() => setMenu(false)}>
                            {project?.git.isRepo && thread.location.kind === 'local' && (
                                <button type="button" onClick={() => void handoff('worktree')}>
                                    {s.location.toWorktree}
                                </button>
                            )}
                            {thread.location.kind === 'worktree' && (
                                <>
                                    <button type="button" onClick={() => void handoff('local')}>
                                        {s.location.toLocal}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setMenu(false);
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
                                        {s.location.applyToMain}
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                onClick={() => {
                                    setMenu(false);
                                    setGoalOpen(true);
                                }}
                            >
                                {s.goal.setGoal}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setMenu(false);
                                    useApp.setState({
                                        split: split.includes(thread.id)
                                            ? split.filter((id) => id !== thread.id)
                                            : [...split, thread.id].slice(-3),
                                    });
                                }}
                            >
                                {split.includes(thread.id) ? s.location.unsplit : s.location.split}
                            </button>
                        </div>
                    )}
                </span>
            </div>
            {goalOpen && <GoalDialog thread={thread} onClose={() => setGoalOpen(false)} />}
        </header>
    );
}

/** Go back to before a turn, or fork the thread from it (M3-3); only the xora engine keeps turn markers. */
function TurnHistory({ thread, turn }: { thread: ThreadMeta; turn: TurnView }) {
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
            <button type="button" className="link" onClick={() => setConfirming(!confirming)}>
                {s.thread.rewind}
            </button>
            <button type="button" className="link" onClick={() => void fork()}>
                {s.thread.fork}
            </button>
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

function TurnBlock({ turn, isLast, thread }: { turn: TurnView; isLast: boolean; thread: ThreadMeta }) {
    const s = useStrings();
    const running = turn.status === 'running';
    const lastItem = turn.items.at(-1);
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
                {turn.items.map((item) => (
                    <ItemView key={item.id} item={item} live={running && item === lastItem} />
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
                    <TurnHistory thread={thread} turn={turn} />
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

function Composer({ thread }: { thread: ThreadMeta }) {
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
              items: string[];
              hints?: Record<string, string>;
              index: number;
          }
        | undefined
    >();
    // Command files are read again after a short while, so a newly added file shows up without a restart.
    const commands = useRef<
        { projectId: string; at: number; items: Array<{ name: string; hint: string }> } | undefined
    >(undefined);
    const updateCommands = (value: string, caret: number): boolean => {
        const slash = /^\/([^\s/]*)$/.exec(value.slice(0, caret));
        if (!slash) return false;
        const query = slash[1] ?? '';
        const show = (items: Array<{ name: string; hint: string }>) => {
            const matching = items.filter((item) => item.name.startsWith(query)).slice(0, 12);
            setMention({
                kind: 'command',
                query,
                start: 0,
                items: matching.map((item) => item.name),
                hints: Object.fromEntries(matching.map((item) => [item.name, item.hint])),
                index: 0,
            });
        };
        const builtin = [{ name: 'compact', hint: s.thread.compactCommand }];
        const cached = commands.current;
        if (cached && cached.projectId === thread.projectId && Date.now() - cached.at < 15_000) {
            show(cached.items);
            return true;
        }
        show(cached?.projectId === thread.projectId ? cached.items : builtin);
        void host
            .call('extension.list', { projectId: thread.projectId })
            .then((snapshot) => {
                const items = [
                    ...builtin,
                    ...snapshot.commands.map((command) => ({
                        name: command.name,
                        hint: [command.argumentHint, command.description].filter(Boolean).join(' · '),
                    })),
                ];
                commands.current = { projectId: thread.projectId, at: Date.now(), items };
                show(items);
            })
            .catch(() => undefined);
        return true;
    };
    const updateMention = (value: string, caret: number) => {
        if (updateCommands(value, caret)) return;
        const match = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
        if (!match) {
            setMention(undefined);
            return;
        }
        const query = match[2] ?? '';
        const start = caret - query.length - 1;
        setMention((current) => ({
            kind: 'file',
            query,
            start,
            items: current?.kind === 'file' ? current.items : [],
            index: 0,
        }));
        void host
            .call('fs.find', { threadId: thread.id, query })
            .then((items) =>
                setMention((current) =>
                    current && current.query === query ? { ...current, items, index: 0 } : current,
                ),
            )
            .catch(() => undefined);
    };
    const pickMention = (file: string) => {
        if (!mention) return;
        if (mention.kind === 'command') {
            setText(`/${file} ${text.slice(mention.query.length + 1).trimStart()}`);
            setMention(undefined);
            area.current?.focus();
            return;
        }
        const before = text.slice(0, mention.start);
        const after = text.slice(mention.start + mention.query.length + 1);
        setText(`${before}@${file} ${after}`);
        setAttachments((current) =>
            current.some((item) => item.path === file)
                ? current
                : [
                      ...current,
                      { kind: 'file', name: file.split('/').pop() ?? file, mimeType: 'text/plain', path: file },
                  ],
        );
        setMention(undefined);
        area.current?.focus();
    };
    const send = async () => {
        if (running || sending || (!text.trim() && attachments.length === 0)) return;
        setSending(true);
        const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
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
                    aria-label={mention.kind === 'command' ? s.thread.commandList : s.thread.mentionFiles}
                >
                    {mention.items.map((file, index) => (
                        <button
                            key={file}
                            type="button"
                            role="option"
                            aria-selected={index === mention.index}
                            className={index === mention.index ? 'is-active' : ''}
                            onMouseDown={(event) => {
                                event.preventDefault();
                                pickMention(file);
                            }}
                        >
                            {mention.kind === 'command' ? `/${file}` : file}
                            {mention.hints?.[file] && <span className="mention__hint">{mention.hints[file]}</span>}
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
                            const file = mention.items[mention.index];
                            if (file) pickMention(file);
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
                <span className="composer__hint">{s.modes[thread.mode]}</span>
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
                {view && turns.length === 0 && <div className="timeline__empty">{s.thread.noMessages}</div>}
                {turns.map((turn, index) => (
                    <TurnBlock key={turn.turnId} turn={turn} isLast={index === turns.length - 1} thread={thread} />
                ))}
            </div>
            {/* A workflow run's own thread is its log: notices and approval cards, nobody to talk to. */}
            {thread.role !== 'workflow' && <Composer thread={thread} />}
        </div>
    );
}
