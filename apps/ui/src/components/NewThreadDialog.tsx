import type { ModelRef, PermissionMode } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { host } from '../host.ts';
import { attempt, selectThread, useApp, useStrings } from '../store.ts';
import { Field, Modal, Select } from './primitives.tsx';

const MODES: PermissionMode[] = ['ask', 'auto_edit', 'plan', 'full'];

function key(ref: ModelRef): string {
    return `${ref.connectionId}::${ref.model}`;
}

function parse(value: string): ModelRef | undefined {
    const [connectionId, model] = value.split('::');
    return connectionId && model ? { connectionId, model } : undefined;
}

/** New thread: local or worktree, or the same task on several models at once (best-of-n, 04 §1). */
export function NewThreadDialog({ projectId }: { projectId: string }) {
    const s = useStrings();
    const project = useApp((state) => state.projects.find((item) => item.id === projectId));
    const models = useApp((state) => state.models);
    const settings = useApp((state) => state.settings);
    const [tab, setTab] = useState<'single' | 'best'>('single');
    const [location, setLocation] = useState<'local' | 'worktree'>('local');
    const [model, setModel] = useState(settings?.defaultModel ? key(settings.defaultModel) : '');
    const [mode, setMode] = useState<PermissionMode>(settings?.defaultMode ?? 'ask');
    const [text, setText] = useState('');
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

    const create = async () => {
        setBusy(true);
        const ref = parse(model);
        const thread = await attempt(() =>
            host.call(
                'thread.create',
                { projectId, location, mode, engine, ...(ref && engine === 'xora' ? { model: ref } : {}) },
                { timeoutMs: 120_000 },
            ),
        );
        if (thread) {
            useApp.setState((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
            await selectThread(thread.id);
            if (text.trim()) {
                await attempt(() => host.call('turn.start', { threadId: thread.id, text }));
            }
            close();
        }
        setBusy(false);
    };

    const best = async () => {
        setBusy(true);
        const refs = picked.map(parse).filter((ref): ref is ModelRef => ref !== undefined);
        const result = await attempt(() =>
            host.call('thread.bestOfN', { projectId, text, models: refs, mode }, { timeoutMs: 300_000 }),
        );
        if (result) {
            useApp.setState((state) => ({
                threads: {
                    ...state.threads,
                    ...Object.fromEntries(result.threads.map((thread) => [thread.id, thread])),
                },
                split: result.threads.map((thread) => thread.id).slice(0, 3),
            }));
            const first = result.threads[0];
            if (first) await selectThread(first.id);
            close();
        }
        setBusy(false);
    };

    return (
        <Modal title={`${s.sidebar.newThread} · ${project?.name ?? ''}`} onClose={close}>
            <div className="dialog">
                <div className="segmented">
                    <button
                        type="button"
                        className={tab === 'single' ? 'is-active' : ''}
                        onClick={() => setTab('single')}
                    >
                        {s.newThread.single}
                    </button>
                    <button
                        type="button"
                        className={tab === 'best' ? 'is-active' : ''}
                        disabled={!isRepo}
                        onClick={() => setTab('best')}
                        title={isRepo ? '' : s.newThread.needsRepo}
                    >
                        {s.newThread.bestOfN}
                    </button>
                </div>
                {tab === 'single' ? (
                    <>
                        <Field label={s.newThread.location}>
                            <Select
                                label={s.newThread.location}
                                value={location}
                                options={[
                                    { value: 'local', label: s.newThread.local },
                                    ...(isRepo ? [{ value: 'worktree' as const, label: s.newThread.worktree }] : []),
                                ]}
                                onChange={setLocation}
                            />
                        </Field>
                        <Field label={s.newThread.engine} hint={engines.find((item) => item.id === engine)?.note}>
                            <Select
                                label={s.newThread.engine}
                                value={engine}
                                options={engines.map((item) => ({
                                    value: item.id,
                                    label: item.available ? item.name : `${item.name}（${s.newThread.notInstalled}）`,
                                    ...(item.command ? { hint: item.command } : {}),
                                }))}
                                onChange={setEngine}
                            />
                        </Field>
                        {engine === 'xora' && (
                            <Field label={s.thread.model}>
                                <Select label={s.thread.model} value={model} options={options} onChange={setModel} />
                            </Field>
                        )}
                    </>
                ) : (
                    <Field label={s.newThread.models} hint={s.newThread.bestHint}>
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
                    </Field>
                )}
                <Field label={s.thread.mode}>
                    <Select
                        label={s.thread.mode}
                        value={mode}
                        options={MODES.map((value) => ({ value, label: s.modes[value], hint: s.modeHints[value] }))}
                        onChange={setMode}
                    />
                </Field>
                <Field label={s.newThread.task}>
                    <textarea
                        className="textarea"
                        rows={4}
                        value={text}
                        placeholder={s.thread.placeholder}
                        onChange={(event) => setText(event.target.value)}
                    />
                </Field>
                <div className="row">
                    {tab === 'single' ? (
                        <button
                            type="button"
                            className="button button--primary"
                            disabled={busy}
                            onClick={() => void create()}
                        >
                            {s.newThread.create}
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="button button--primary"
                            disabled={busy || picked.length < 2 || !text.trim()}
                            onClick={() => void best()}
                        >
                            {s.newThread.startBest}
                        </button>
                    )}
                    <button type="button" className="button" onClick={close}>
                        {s.common.cancel}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
