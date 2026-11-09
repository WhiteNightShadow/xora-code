import type { Effort, ModelRef, PermissionMode } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { host } from '../host.ts';
import { attempt, selectThread, useApp, useStrings } from '../store.ts';
import { effortsOf, startingEffort } from '../thinking.ts';
import { ConversationArt } from './Art.tsx';
import { Popover } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { MemberMentionList, useMemberMention } from './Mentions.tsx';
import { AutoFocusTextarea, IconButton, Select, Spinner } from './primitives.tsx';

const MODES: PermissionMode[] = ['ask', 'auto_edit', 'plan', 'full'];

function key(ref: ModelRef): string {
    return `${ref.connectionId}::${ref.model}`;
}

function parse(value: string): ModelRef | undefined {
    const [connectionId, model] = value.split('::');
    return connectionId && model ? { connectionId, model } : undefined;
}

/**
 * A new conversation, right in the main area (03): an empty conversation whose composer starts it. Its permissions,
 * model and place (the project folder or a worktree) sit under the composer; the engine and "the same task on
 * several models" (best-of-n, 04 §1) are under "More". Nothing is created until the first message.
 */
export function NewThreadPage({ projectId }: { projectId: string }) {
    const s = useStrings();
    const project = useApp((state) => state.projects.find((item) => item.id === projectId));
    const models = useApp((state) => state.models);
    const settings = useApp((state) => state.settings);
    const [location, setLocation] = useState<'local' | 'worktree'>('local');
    const [model, setModel] = useState(settings?.defaultModel ? key(settings.defaultModel) : '');
    const [mode, setMode] = useState<PermissionMode>(settings?.defaultMode ?? 'ask');
    // The thinking level (thinking.ts): what is picked here, else the user's default, else the model's; only what
    // the model offers.
    const [effort, setEffort] = useState<Effort | ''>('');
    const chosen = models.find(
        (option) => key({ connectionId: option.connectionId, model: option.model.id }) === model,
    );
    const efforts = effortsOf(chosen?.model.reasoning);
    const effortValue = startingEffort(chosen?.model.reasoning, settings?.defaultEffort, effort);
    const [text, setText] = useState('');
    // `@member` hands the first message to a member (06 §19); only Xora's own engine hands work on.
    const mention = useMemberMention(text, setText);
    // Best-of-n: the same task on several models, each in a worktree.
    const [picked, setPicked] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [engines, setEngines] = useState<
        Array<{ id: string; name: string; available: boolean; note?: string; command?: string }>
    >([]);
    const [engine, setEngine] = useState('xora');
    useEffect(() => {
        void host
            .call('engine.list', {})
            .then(setEngines)
            .catch(() => undefined);
    }, []);
    const close = () => useApp.setState({ newThreadFor: undefined });
    const options = models.map((option) => ({
        value: key({ connectionId: option.connectionId, model: option.model.id }),
        label: `${option.model.name} · ${option.connectionName}`,
    }));
    const isRepo = project?.git.isRepo ?? false;
    const best = picked.length >= 2;

    const start = async () => {
        if (busy || !text.trim()) return;
        setBusy(true);
        if (best) {
            const refs = picked.map(parse).filter((ref): ref is ModelRef => ref !== undefined);
            const result = await attempt(() =>
                host.call('thread.bestOfN', { projectId, text, models: refs, mode }, { timeoutMs: 300_000 }),
            );
            setBusy(false);
            if (!result) return;
            useApp.setState((state) => ({
                threads: {
                    ...state.threads,
                    ...Object.fromEntries(result.threads.map((thread) => [thread.id, thread])),
                },
                split: result.threads.map((thread) => thread.id).slice(0, 3),
                newThreadFor: undefined,
            }));
            const first = result.threads[0];
            if (first) await selectThread(first.id);
            return;
        }
        const ref = parse(model);
        const thread = await attempt(() =>
            host.call(
                'thread.create',
                {
                    projectId,
                    location,
                    mode,
                    engine,
                    ...(ref && engine === 'xora' ? { model: ref } : {}),
                    ...(ref && engine === 'xora' && effortValue ? { effort: effortValue } : {}),
                },
                { timeoutMs: 120_000 },
            ),
        );
        if (!thread) {
            setBusy(false);
            return;
        }
        useApp.setState((state) => ({ threads: { ...state.threads, [thread.id]: thread }, newThreadFor: undefined }));
        await selectThread(thread.id);
        await attempt(() => host.call('turn.start', { threadId: thread.id, text }));
        setBusy(false);
    };

    return (
        <div className="thread new-thread">
            <header className="thread-header">
                <div className="thread-header__title">
                    <h1>{s.newThread.title}</h1>
                    <span className="thread-header__project">
                        {project?.name}
                        {project?.git.branch ? ` · ${project.git.branch}` : ''}
                    </span>
                </div>
                <div className="thread-header__controls">
                    <IconButton icon="x" label={s.common.cancel} onClick={close} />
                </div>
            </header>
            <div className="new-thread__body">
                <ConversationArt className="new-thread__art" />
                <p>{s.newThread.hint}</p>
            </div>
            <div className="new-thread__composer">
                {engine === 'xora' && <MemberMentionList mention={mention} />}
                <AutoFocusTextarea
                    className="new-thread__input"
                    rows={3}
                    value={text}
                    placeholder={s.thread.placeholder}
                    aria-label={s.newThread.title}
                    onChange={(event) => {
                        setText(event.target.value);
                        if (engine === 'xora') mention.update(event.target.value, event.target.selectionStart);
                    }}
                    onKeyDown={(event) => {
                        if (engine === 'xora' && mention.keyDown(event)) return;
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            void start();
                        }
                    }}
                />
                <div className="new-thread__bar">
                    <Select
                        compact
                        label={s.thread.mode}
                        value={mode}
                        options={MODES.map((value) => ({ value, label: s.modes[value], hint: s.modeHints[value] }))}
                        onChange={setMode}
                    />
                    {engine === 'xora' && !best && options.length > 0 && (
                        <Select compact label={s.thread.model} value={model} options={options} onChange={setModel} />
                    )}
                    {engine === 'xora' && !best && efforts.length > 1 && (
                        <Select
                            compact
                            label={s.composer.effortTitle}
                            value={effortValue ?? ''}
                            options={efforts.map((item) => ({ value: item, label: s.efforts[item] }))}
                            onChange={setEffort}
                        />
                    )}
                    {isRepo && !best && (
                        <Select
                            compact
                            label={s.newThread.location}
                            value={location}
                            options={[
                                { value: 'local', label: s.newThread.local },
                                { value: 'worktree' as const, label: s.newThread.worktree },
                            ]}
                            onChange={setLocation}
                        />
                    )}
                    <Popover
                        label={s.newThread.more}
                        placement="up"
                        triggerClassName="button button--small"
                        trigger={
                            <>
                                {s.newThread.more}
                                {best ? ` · ${s.newThread.bestOn}` : ''}
                            </>
                        }
                    >
                        {() => (
                            <div className="new-thread__more">
                                <div className="new-thread__field">
                                    <span>{s.newThread.engine}</span>
                                    <Select
                                        compact
                                        label={s.newThread.engine}
                                        value={engine}
                                        options={engines.map((item) => ({
                                            value: item.id,
                                            label: item.available
                                                ? item.name
                                                : `${item.name}（${s.newThread.notInstalled}）`,
                                            ...(item.command ? { hint: item.command } : {}),
                                        }))}
                                        onChange={setEngine}
                                    />
                                </div>
                                {isRepo && engine === 'xora' && (
                                    <div className="new-thread__field">
                                        <span>{s.newThread.models}</span>
                                        <p className="new-thread__hint">{s.newThread.bestHint}</p>
                                        <div className="checklist">
                                            {options.map((option) => (
                                                <label key={option.value} className="toggle">
                                                    <input
                                                        type="checkbox"
                                                        checked={picked.includes(option.value)}
                                                        disabled={!picked.includes(option.value) && picked.length >= 4}
                                                        onChange={(event) =>
                                                            setPicked(
                                                                event.target.checked
                                                                    ? [...picked, option.value]
                                                                    : picked.filter((value) => value !== option.value),
                                                            )
                                                        }
                                                    />
                                                    <span>{option.label}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </Popover>
                    <button
                        type="button"
                        className="button button--primary new-thread__send"
                        disabled={busy || !text.trim()}
                        onClick={() => void start()}
                    >
                        {busy ? <Spinner /> : <Icon name="send" size={14} />}{' '}
                        {best ? s.newThread.startBest : s.newThread.send}
                    </button>
                </div>
            </div>
        </div>
    );
}
