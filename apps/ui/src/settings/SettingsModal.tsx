import type { Connection, PresetSummary, PromptLibrary, Rule, Settings } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { LogoMark } from '../components/Art.tsx';
import { confirmDialog } from '../components/Confirm.tsx';
import { Badge, Field, Modal, type Option, Select, Spinner, Toggle } from '../components/primitives.tsx';
import { errorMessage, host } from '../host.ts';
import { attempt, refreshConnections, type SettingsSection, toast, uiLanguage, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { ExtensionsSection } from './ExtensionsSection.tsx';

function useSettings(): [Settings | undefined, (patch: Partial<Settings>) => void] {
    const settings = useApp((state) => state.settings);
    const update = (patch: Partial<Settings>) =>
        void attempt(async () => {
            const next = await host.call('settings.update', { patch });
            useApp.setState({ settings: next });
        });
    return [settings, update];
}

/** Each language by its own name. */
const LANGUAGE_NAMES = { 'zh-CN': '简体中文', en: 'English' } as const;

/** Choices for the team concurrency setting (protocol: 1–8). */
const TEAM_PARALLEL = ['1', '2', '3', '4', '5', '6', '7', '8'];

function General() {
    const s = useStrings();
    const [settings, update] = useSettings();
    if (!settings) return <Spinner />;
    return (
        <div className="settings-section">
            <Field label={s.settings.language}>
                <Select
                    label={s.settings.language}
                    value={settings.language}
                    options={[
                        {
                            value: 'system',
                            label: format(s.settings.languageSystem, {
                                language: LANGUAGE_NAMES[uiLanguage('system')],
                            }),
                        },
                        { value: 'zh-CN', label: LANGUAGE_NAMES['zh-CN'] },
                        { value: 'en', label: LANGUAGE_NAMES.en },
                    ]}
                    onChange={(language) => update({ language })}
                />
            </Field>
            <Field label={s.settings.theme}>
                <Select
                    label={s.settings.theme}
                    value={settings.theme}
                    options={[
                        { value: 'system', label: s.settings.themeSystem },
                        { value: 'light', label: s.settings.themeLight },
                        { value: 'dark', label: s.settings.themeDark },
                    ]}
                    onChange={(theme) => update({ theme })}
                />
            </Field>
            <Field label={s.settings.density}>
                <Select
                    label={s.settings.density}
                    value={settings.density}
                    options={[
                        { value: 'comfortable', label: s.settings.comfortable },
                        { value: 'compact', label: s.settings.compact },
                    ]}
                    onChange={(density) => update({ density })}
                />
            </Field>
            <Field label={s.settings.notifications}>
                <Toggle
                    checked={settings.notifications.onComplete}
                    label={s.settings.notifyComplete}
                    onChange={(onComplete) => update({ notifications: { ...settings.notifications, onComplete } })}
                />
                <Toggle
                    checked={settings.notifications.onApproval}
                    label={s.settings.notifyApproval}
                    onChange={(onApproval) => update({ notifications: { ...settings.notifications, onApproval } })}
                />
                <Toggle
                    checked={settings.notifications.onFailure}
                    label={s.settings.notifyFailure}
                    onChange={(onFailure) => update({ notifications: { ...settings.notifications, onFailure } })}
                />
            </Field>
            <Field label="">
                <Toggle
                    checked={settings.preventSleep}
                    label={s.settings.preventSleep}
                    onChange={(preventSleep) => update({ preventSleep })}
                />
            </Field>
            <Field label={s.settings.teamParallel} hint={s.settings.teamParallelHint}>
                <Select
                    label={s.settings.teamParallel}
                    value={String(settings.team.maxParallel)}
                    options={TEAM_PARALLEL.map((count) => ({ value: count, label: count }))}
                    onChange={(count) => update({ team: { ...settings.team, maxParallel: Number(count) } })}
                />
            </Field>
            {/* 06 §25: the model members run on. */}
            <Field label={s.settings.teamModels} hint={s.settings.teamModelsHints[settings.team.models ?? 'default']}>
                <Select
                    label={s.settings.teamModels}
                    value={settings.team.models ?? 'default'}
                    options={[
                        { value: 'default', label: s.settings.teamModelChoices.default },
                        { value: 'tiers', label: s.settings.teamModelChoices.tiers },
                    ]}
                    onChange={(models) => update({ team: { ...settings.team, models } })}
                />
            </Field>
            {/* 19 §9: each card of a finished run costs part of one short request. */}
            <Field label={s.settings.teamScoring} hint={s.settings.teamScoringHint}>
                <Toggle
                    checked={settings.team.scoring !== false}
                    label={s.settings.teamScoringOn}
                    onChange={(scoring) => update({ team: { ...settings.team, scoring } })}
                />
            </Field>
        </div>
    );
}

function channelLabel(preset: PresetSummary, s: ReturnType<typeof useStrings>): string {
    if (preset.channel === 'local') return s.settings.local;
    if (preset.channel === 'custom') return s.settings.custom;
    if (preset.channel === 'subscription_key') return s.settings.subscription;
    return s.settings.api;
}

function ConnectionEditor({ connection, onDone }: { connection?: Connection; onDone: () => void }) {
    const s = useStrings();
    const presets = useApp((state) => state.presets);
    const [presetId, setPresetId] = useState(connection?.presetId ?? presets[0]?.id ?? '');
    const [name, setName] = useState(connection?.name ?? '');
    const [apiKey, setApiKey] = useState('');
    const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
    const [busy, setBusy] = useState(false);
    const preset = presets.find((item) => item.id === presetId);
    const options: Option<string>[] = presets.map((item) => ({
        value: item.id,
        label: `${item.name}（${channelLabel(item, s)}${item.region === 'cn' ? '·国内' : item.region === 'global' ? '·海外' : ''}）`,
    }));
    const save = async () => {
        setBusy(true);
        const saved = await attempt(() =>
            host.call('provider.save', {
                ...(connection ? { connectionId: connection.id } : {}),
                presetId,
                ...(name.trim() ? { name: name.trim() } : {}),
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                ...(baseUrl.trim() || connection?.baseUrl ? { baseUrl: baseUrl.trim() } : {}),
            }),
        );
        setBusy(false);
        if (saved) {
            await refreshConnections();
            onDone();
        }
    };
    return (
        <div className="connection-editor">
            {!connection && (
                <Field label={s.settings.preset}>
                    <Select label={s.settings.preset} value={presetId} options={options} onChange={setPresetId} />
                </Field>
            )}
            {preset?.compliance && (
                <div className={`callout${preset.compliance.allowed === false ? ' callout--error' : ''}`}>
                    <strong>{s.settings.compliance}：</strong>
                    {preset.compliance.allowed === false
                        ? s.settings.notAllowed
                        : preset.compliance.interactiveOnly
                          ? s.settings.interactiveOnly
                          : ''}
                    {preset.compliance.note && <div>{preset.compliance.note}</div>}
                </div>
            )}
            <Field label={s.settings.name}>
                <input
                    className="input"
                    value={name}
                    placeholder={preset?.name}
                    onChange={(event) => setName(event.target.value)}
                />
            </Field>
            {preset?.needsKey !== false && (
                <Field label={s.settings.apiKey} hint={s.settings.keysStored}>
                    <input
                        className="input"
                        type="password"
                        autoComplete="off"
                        value={apiKey}
                        placeholder={connection?.hasKey ? s.settings.apiKeyKeep : 'sk-…'}
                        onChange={(event) => setApiKey(event.target.value)}
                    />
                    {preset?.links?.keys && (
                        <button
                            type="button"
                            className="link"
                            onClick={() =>
                                void host.call('system.open', { kind: 'external', target: preset.links?.keys ?? '' })
                            }
                        >
                            获取key
                        </button>
                    )}
                </Field>
            )}
            <Field label={s.settings.baseUrl}>
                <input
                    className="input"
                    value={baseUrl}
                    placeholder={preset?.baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                />
            </Field>
            <div className="row">
                <button
                    type="button"
                    className="button button--primary"
                    disabled={busy || preset?.compliance?.allowed === false}
                    onClick={() => void save()}
                >
                    {busy ? <Spinner /> : null} {s.settings.save}
                </button>
                <button type="button" className="button" onClick={onDone}>
                    {s.settings.cancel}
                </button>
            </div>
        </div>
    );
}

/**
 * Every model of the connection with a switch: the ones switched on are what model pickers, defaults and team tiers
 * offer. The list comes from the last "refresh models"; nothing refreshes it on its own.
 */
function ModelPicker({ connection, onClose }: { connection: Connection; onClose: () => void }) {
    const s = useStrings();
    const available = connection.available ?? connection.models;
    const selected = new Set(connection.models.map((model) => model.id));
    const toggle = (id: string, on: boolean) =>
        void attempt(async () => {
            const next = available
                .map((model) => model.id)
                .filter((modelId) => (modelId === id ? on : selected.has(modelId)));
            await host.call('provider.selectModels', { connectionId: connection.id, models: next });
            await refreshConnections();
        });
    return (
        <div className="connection__picker">
            <div className="field__hint">{s.settings.pickModelsHint}</div>
            {available.map((model) => (
                <Toggle
                    key={model.id}
                    checked={selected.has(model.id)}
                    label={model.name}
                    text={`${model.name}${model.name === model.id ? '' : ` · ${model.id}`}${
                        model.verified ? '' : `（${s.settings.unverified}）`
                    }`}
                    onChange={(on) => toggle(model.id, on)}
                />
            ))}
            <div className="row">
                <button type="button" className="button button--small" onClick={onClose}>
                    {s.common.close}
                </button>
            </div>
        </div>
    );
}

function ConnectionCard({ connection }: { connection: Connection }) {
    const s = useStrings();
    const presets = useApp((state) => state.presets);
    const preset = presets.find((item) => item.id === connection.presetId);
    const [editing, setEditing] = useState(false);
    const [testing, setTesting] = useState(false);
    const [picking, setPicking] = useState(false);
    const [model, setModel] = useState(connection.models[0]?.id ?? '');
    const test = async () => {
        setTesting(true);
        try {
            const result = await host.call(
                'provider.test',
                { connectionId: connection.id, ...(model ? { model } : {}) },
                { timeoutMs: 120_000 },
            );
            toast(
                result.ok
                    ? format(s.settings.testOk, { ms: result.latencyMs ?? 0 })
                    : `${result.errorClass ?? ''} ${result.message ?? ''}`,
                result.ok ? 'success' : 'error',
            );
        } catch (error) {
            toast(errorMessage(error), 'error');
        }
        setTesting(false);
    };
    if (editing) return <ConnectionEditor connection={connection} onDone={() => setEditing(false)} />;
    return (
        <div className="connection">
            <div className="connection__header">
                <strong>{connection.name}</strong>
                <span className="connection__preset">{preset?.name ?? connection.presetId}</span>
                {connection.status && (
                    <Badge tone={connection.status.ok ? 'ok' : 'error'}>
                        {connection.status.ok
                            ? s.settings.statusOk
                            : (connection.status.errorClass ?? s.settings.statusError)}
                    </Badge>
                )}
                {!connection.hasKey && preset?.needsKey !== false && <Badge tone="warn">{s.settings.noKey}</Badge>}
            </div>
            <div className="connection__models">
                {connection.models.length} {s.settings.models_}
                {connection.models.length > 0 && (
                    <Select
                        compact
                        label={s.thread.model}
                        value={model}
                        options={connection.models.map((item) => ({
                            value: item.id,
                            label: `${item.name}${item.verified ? '' : `（${s.settings.unverified}）`}`,
                        }))}
                        onChange={setModel}
                    />
                )}
            </div>
            <div className="row">
                <button type="button" className="button button--small" disabled={testing} onClick={() => void test()}>
                    {testing ? s.settings.testing : s.settings.test}
                </button>
                <button
                    type="button"
                    className="button button--small"
                    onClick={() =>
                        void attempt(async () => {
                            await host.call(
                                'provider.refreshModels',
                                { connectionId: connection.id },
                                { timeoutMs: 60_000 },
                            );
                            await refreshConnections();
                            // A fresh list is for picking from.
                            setPicking(true);
                        })
                    }
                >
                    {s.settings.refreshModels}
                </button>
                <button type="button" className="button button--small" onClick={() => setPicking(!picking)}>
                    {format(s.settings.pickModels, {
                        picked: connection.models.length,
                        all: (connection.available ?? connection.models).length,
                    })}
                </button>
                <button type="button" className="button button--small" onClick={() => setEditing(true)}>
                    {s.sidebar.rename}/key
                </button>
                <button
                    type="button"
                    className="button button--small button--danger"
                    onClick={async () => {
                        if (await confirmDialog(`${s.settings.remove}：${connection.name}？`)) {
                            void attempt(async () => {
                                await host.call('provider.remove', { connectionId: connection.id });
                                await refreshConnections();
                            });
                        }
                    }}
                >
                    {s.settings.remove}
                </button>
            </div>
            {picking && <ModelPicker connection={connection} onClose={() => setPicking(false)} />}
        </div>
    );
}

function Models() {
    const s = useStrings();
    const connections = useApp((state) => state.connections);
    const models = useApp((state) => state.models);
    const [settings, update] = useSettings();
    const [adding, setAdding] = useState(connections.length === 0);
    const [detecting, setDetecting] = useState(false);
    const [local, setLocal] = useState<
        Array<{ presetId: string; name: string; baseUrl: string; models: string[] }> | undefined
    >();
    const detect = async () => {
        setDetecting(true);
        setLocal((await attempt(() => host.call('provider.detectLocal', {}))) ?? []);
        setDetecting(false);
    };
    if (!settings) return <Spinner />;
    const modelOptions: Option<string>[] = models.map((option) => ({
        value: `${option.connectionId}::${option.model.id}`,
        label: `${option.model.name} · ${option.connectionName}`,
    }));
    const parse = (value: string) => {
        const [connectionId, model] = value.split('::');
        return connectionId && model ? { connectionId, model } : null;
    };
    return (
        <div className="settings-section">
            <h3>{s.settings.connections}</h3>
            {connections.map((connection) => (
                <ConnectionCard key={connection.id} connection={connection} />
            ))}
            {adding ? (
                <ConnectionEditor onDone={() => setAdding(false)} />
            ) : (
                <div className="row">
                    <button type="button" className="button" onClick={() => setAdding(true)}>
                        + {s.settings.addConnection}
                    </button>
                    <button type="button" className="button" disabled={detecting} onClick={() => void detect()}>
                        {detecting ? <Spinner /> : null} {s.settings.detectLocal}
                    </button>
                </div>
            )}
            {local && local.length === 0 && <p className="muted">{s.settings.noLocal}</p>}
            {local?.map((server) => (
                <div key={server.baseUrl} className="connection">
                    <div className="connection__header">
                        <strong>{server.name}</strong>
                        <code>{server.baseUrl}</code>
                    </div>
                    <div className="connection__models">{server.models.slice(0, 8).join('、') || '—'}</div>
                    <button
                        type="button"
                        className="button button--small"
                        onClick={() =>
                            void attempt(async () => {
                                const connection = await host.call('provider.save', {
                                    presetId: server.presetId,
                                    name: server.name,
                                    baseUrl: server.baseUrl,
                                });
                                await host.call(
                                    'provider.refreshModels',
                                    { connectionId: connection.id },
                                    { timeoutMs: 30_000 },
                                );
                                await refreshConnections();
                                setLocal(local.filter((item) => item.baseUrl !== server.baseUrl));
                            })
                        }
                    >
                        {s.settings.addLocal}
                    </button>
                </div>
            ))}
            <h3>{s.settings.defaultModel}</h3>
            <Field label={s.settings.defaultModel}>
                <Select
                    label={s.settings.defaultModel}
                    value={
                        settings.defaultModel
                            ? `${settings.defaultModel.connectionId}::${settings.defaultModel.model}`
                            : ''
                    }
                    options={modelOptions}
                    onChange={(value) => update({ defaultModel: parse(value) })}
                />
            </Field>
            <Field label={s.settings.fastModel}>
                <Select
                    label={s.settings.fastModel}
                    value={
                        settings.fastModel ? `${settings.fastModel.connectionId}::${settings.fastModel.model}` : 'none'
                    }
                    options={[{ value: 'none', label: s.settings.none }, ...modelOptions]}
                    onChange={(value) => update({ fastModel: value === 'none' ? null : parse(value) })}
                />
            </Field>
            <Field label={s.settings.fallbackModels} hint={s.settings.fallbackModelsHint}>
                {[0, 1, 2].map((index) => {
                    const chain = settings.fallbackModels;
                    const current = chain[index];
                    // A slot opens once the one before it is set, so the chain has no gaps.
                    if (index > chain.length) return null;
                    return (
                        <Select
                            key={index}
                            label={format(s.settings.fallbackModel, { n: index + 1 })}
                            value={current ? `${current.connectionId}::${current.model}` : 'none'}
                            options={[{ value: 'none', label: s.settings.none }, ...modelOptions]}
                            onChange={(value) => {
                                const ref = parse(value);
                                const next = [...chain];
                                if (ref) next[index] = ref;
                                else next.splice(index);
                                update({ fallbackModels: next });
                            }}
                        />
                    );
                })}
            </Field>
            <Field label={s.settings.defaultMode}>
                <Select
                    label={s.settings.defaultMode}
                    value={settings.defaultMode}
                    options={(['ask', 'auto_edit', 'plan', 'full'] as const).map((mode) => ({
                        value: mode,
                        label: s.modes[mode],
                        hint: s.modeHints[mode],
                    }))}
                    onChange={(defaultMode) => update({ defaultMode })}
                />
            </Field>
            <Field label={s.settings.defaultEffort}>
                <Select
                    label={s.settings.defaultEffort}
                    value={settings.defaultEffort}
                    options={(['off', 'low', 'medium', 'high', 'max'] as const).map((effort) => ({
                        value: effort,
                        label: s.efforts[effort],
                    }))}
                    onChange={(defaultEffort) => update({ defaultEffort })}
                />
            </Field>
            <Field label={s.settings.softWindow} hint={s.settings.softWindowHint}>
                <input
                    className="input"
                    type="number"
                    min={16000}
                    step={1000}
                    defaultValue={settings.softContextWindow}
                    onBlur={(event) => {
                        const value = Number(event.target.value);
                        if (Number.isFinite(value) && value >= 16000) update({ softContextWindow: Math.round(value) });
                    }}
                />
            </Field>
            <Field label="" hint={s.settings.lspDiagnosticsHint}>
                <Toggle
                    checked={settings.lspDiagnostics}
                    label={s.settings.lspDiagnostics}
                    onChange={(lspDiagnostics) => update({ lspDiagnostics })}
                />
            </Field>
        </div>
    );
}

/** A prompt being written: a new one without `previous`. */
interface PromptDraft {
    readonly previous?: string;
    readonly name: string;
    readonly text: string;
}

/** The prompt directory (08 §1.4): every .md file in it is a global prompt; one of them, or none, is in use. */
function GlobalPrompts() {
    const s = useStrings();
    const [library, setLibrary] = useState<PromptLibrary | undefined>();
    const [draft, setDraft] = useState<PromptDraft | undefined>();
    const [useIt, setUseIt] = useState(false);
    const load = () => void attempt(async () => setLibrary(await host.call('prompt.list', {})));
    useEffect(load, []);
    if (!library) return <Spinner />;
    const { selected, items } = library;
    const missing = selected !== null && !items.some((item) => item.name === selected);
    const select = (name: string | null) =>
        void attempt(async () => {
            await host.call('prompt.select', { name });
            setLibrary(await host.call('prompt.list', {}));
        });
    const edit = (name: string) =>
        void attempt(async () => {
            const { text } = await host.call('prompt.read', { name });
            setDraft({ previous: name, name, text });
            setUseIt(false);
        });
    const create = () => {
        setDraft({ name: '', text: '' });
        // A first prompt is meant to be used.
        setUseIt(selected === null || missing);
    };
    const save = () =>
        void attempt(async () => {
            if (!draft) return;
            const saved = await host.call('prompt.save', {
                name: draft.name,
                text: draft.text,
                ...(draft.previous ? { previous: draft.previous } : {}),
            });
            if (useIt) await host.call('prompt.select', { name: saved.name });
            setDraft(undefined);
            setLibrary(await host.call('prompt.list', {}));
            toast(s.settings.saved, 'success');
        });
    const remove = async (name: string) => {
        if (!(await confirmDialog(format(s.settings.promptConfirmDelete, { name })))) return;
        void attempt(async () => {
            await host.call('prompt.remove', { name });
            setDraft(undefined);
            setLibrary(await host.call('prompt.list', {}));
        });
    };
    return (
        <div className="prompt-library">
            <div className="prompt-library__dir">
                <span>{s.settings.promptDir}</span>
                <code title={library.dir}>{library.dir}</code>
                <button
                    type="button"
                    className="link"
                    onClick={() => void attempt(() => host.call('system.open', { kind: 'path', target: library.dir }))}
                >
                    {s.settings.openPromptDir}
                </button>
                <button type="button" className="link" onClick={load}>
                    {s.common.refresh}
                </button>
            </div>
            {missing && (
                <p className="prompt-library__missing">{format(s.settings.promptMissing, { name: selected })}</p>
            )}
            <ul className="prompt-library__list" aria-label={s.settings.globalPrompt}>
                <li className={`prompt-item${selected === null ? ' is-active' : ''}`}>
                    <label className="prompt-item__pick">
                        <input
                            type="radio"
                            name="global-prompt"
                            checked={selected === null}
                            onChange={() => select(null)}
                        />
                        <span>{s.settings.promptNone}</span>
                    </label>
                </li>
                {items.map((item) => (
                    <li key={item.name} className={`prompt-item${item.name === selected ? ' is-active' : ''}`}>
                        <label className="prompt-item__pick">
                            <input
                                type="radio"
                                name="global-prompt"
                                checked={item.name === selected}
                                onChange={() => select(item.name)}
                            />
                            <span className="prompt-item__name">{item.name}</span>
                        </label>
                        {item.name === selected && <Badge tone="ok">{s.settings.promptInUse}</Badge>}
                        <span className="prompt-item__meta">
                            {format(s.settings.promptChars, { chars: item.chars })}
                        </span>
                        <button type="button" className="link" onClick={() => edit(item.name)}>
                            {s.settings.promptEdit}
                        </button>
                    </li>
                ))}
            </ul>
            {items.length === 0 && <p className="muted">{s.settings.promptEmpty}</p>}
            {draft ? (
                <div className="connection-editor prompt-editor">
                    <label className="prompt-editor__field">
                        <span>{s.settings.promptName}</span>
                        <input
                            className="input"
                            value={draft.name}
                            placeholder={s.settings.promptNamePlaceholder}
                            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                        />
                    </label>
                    <label className="prompt-editor__field">
                        <span>{s.settings.promptText}</span>
                        <textarea
                            className="textarea"
                            rows={14}
                            value={draft.text}
                            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
                        />
                    </label>
                    {draft.previous === undefined || draft.previous !== selected ? (
                        <Toggle checked={useIt} label={s.settings.promptUseAfterSave} onChange={setUseIt} />
                    ) : null}
                    <div className="row">
                        <button
                            type="button"
                            className="button button--small button--primary"
                            disabled={!draft.name.trim()}
                            onClick={save}
                        >
                            {s.settings.save}
                        </button>
                        <button type="button" className="button button--small" onClick={() => setDraft(undefined)}>
                            {s.common.cancel}
                        </button>
                        {draft.previous !== undefined && (
                            <button
                                type="button"
                                className="button button--small button--danger"
                                onClick={() => draft.previous !== undefined && remove(draft.previous)}
                            >
                                {s.settings.promptDelete}
                            </button>
                        )}
                    </div>
                </div>
            ) : (
                <button type="button" className="button button--small" onClick={create}>
                    + {s.settings.promptNew}
                </button>
            )}
        </div>
    );
}

function Prompts() {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    // Any project's own prompt, the selected one first (it was the only one before).
    const [projectId, setProjectId] = useState<string | undefined>(
        projects.some((project) => project.id === selectedProjectId) ? selectedProjectId : projects[0]?.id,
    );
    const [projectText, setProjectText] = useState<string | undefined>();
    useEffect(() => {
        setProjectText(undefined);
        if (!projectId) return;
        let current = true;
        void host.call('prompt.get', { scope: 'project', projectId }).then((result) => {
            if (current) setProjectText(result.text);
        });
        return () => {
            current = false;
        };
    }, [projectId]);
    const save = async (text: string) => {
        if (!projectId) return;
        const done = await attempt(() => host.call('prompt.set', { scope: 'project', text, projectId }));
        if (done) toast(s.settings.saved, 'success');
    };
    return (
        <div className="settings-section">
            <Field label={s.settings.globalPrompt} hint={s.settings.globalPromptHint}>
                <GlobalPrompts />
            </Field>
            {projectId && (
                <Field label={s.settings.projectPrompt} hint={s.settings.projectPromptHint}>
                    <Select
                        label={s.settings.projectPromptPick}
                        value={projectId}
                        options={projects.map((project) => ({ value: project.id, label: project.name }))}
                        onChange={setProjectId}
                    />
                    <textarea
                        className="textarea"
                        rows={6}
                        value={projectText ?? ''}
                        disabled={projectText === undefined}
                        onChange={(event) => setProjectText(event.target.value)}
                    />
                    <button
                        type="button"
                        className="button button--small"
                        disabled={projectText === undefined}
                        onClick={() => void save(projectText ?? '')}
                    >
                        {s.settings.save}
                    </button>
                </Field>
            )}
        </div>
    );
}

function Permissions() {
    const s = useStrings();
    const [settings, update] = useSettings();
    const [rules, setRules] = useState<Rule[] | undefined>();
    const load = () => void host.call('rules.list', {}).then(setRules);
    useEffect(load, []);
    return (
        <div className="settings-section">
            {/* 06 §24: who answers approval cards. */}
            {settings && (
                <Field label={s.settings.reviewer} hint={s.settings.reviewerHints[settings.approvals.reviewer]}>
                    <Select
                        label={s.settings.reviewer}
                        value={settings.approvals.reviewer}
                        options={[
                            { value: 'supervisor', label: s.settings.reviewers.supervisor },
                            { value: 'user', label: s.settings.reviewers.user },
                        ]}
                        onChange={(reviewer) => update({ approvals: { reviewer } })}
                    />
                </Field>
            )}
            <h3>{s.settings.rules}</h3>
            {!rules ? (
                <Spinner />
            ) : rules.length === 0 ? (
                <p className="muted">{s.settings.noRules}</p>
            ) : (
                <table className="table">
                    <tbody>
                        {rules.map((rule) => (
                            <tr key={rule.id}>
                                <td>
                                    <Badge
                                        tone={
                                            rule.decision === 'deny'
                                                ? 'error'
                                                : rule.decision === 'allow'
                                                  ? 'ok'
                                                  : 'warn'
                                        }
                                    >
                                        {rule.decision}
                                    </Badge>
                                </td>
                                <td>{rule.tool}</td>
                                <td>
                                    <code>{rule.pattern}</code>
                                </td>
                                <td>{rule.scope === 'global' ? '全局' : '项目'}</td>
                                <td>
                                    <button
                                        type="button"
                                        className="link"
                                        onClick={() =>
                                            void attempt(async () => {
                                                await host.call('rules.remove', { ruleId: rule.id });
                                                load();
                                            })
                                        }
                                    >
                                        {s.settings.remove}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

function Budgets() {
    const s = useStrings();
    const [settings, update] = useSettings();
    if (!settings) return <Spinner />;
    const limitInput = (value: number | null, onChange: (value: number | null) => void) => (
        <input
            className="input"
            type="number"
            min={0}
            step={1}
            placeholder={s.settings.noLimit}
            defaultValue={value ?? ''}
            onBlur={(event) => {
                const text = event.target.value.trim();
                onChange(text === '' ? null : Math.max(0, Number(text)));
            }}
        />
    );
    return (
        <div className="settings-section">
            <Field label={s.settings.currency}>
                <Select
                    label={s.settings.currency}
                    value={settings.currency}
                    options={[
                        { value: 'CNY', label: '人民币 ¥' },
                        { value: 'USD', label: '美元 $' },
                    ]}
                    onChange={(currency) => update({ currency })}
                />
            </Field>
            <Field label={s.settings.usdToCny}>
                <input
                    className="input"
                    type="number"
                    min={0.1}
                    step={0.01}
                    defaultValue={settings.usdToCny}
                    onBlur={(event) => {
                        const value = Number(event.target.value);
                        if (value > 0) update({ usdToCny: value });
                    }}
                />
            </Field>
            <Field label={s.settings.dailyLimit}>
                {limitInput(settings.budgets.dailyLimit, (dailyLimit) =>
                    update({ budgets: { ...settings.budgets, dailyLimit } }),
                )}
            </Field>
            <Field label={s.settings.monthlyLimit}>
                {limitInput(settings.budgets.monthlyLimit, (monthlyLimit) =>
                    update({ budgets: { ...settings.budgets, monthlyLimit } }),
                )}
            </Field>
        </div>
    );
}

function Updates() {
    const s = useStrings();
    const [settings, update] = useSettings();
    const status = useApp((state) => state.update);
    const [checking, setChecking] = useState(false);
    if (!settings) return <Spinner />;
    return (
        <div className="settings-section">
            <Field label={s.settings.bundleVersion}>
                <code>{status?.bundleVersion}</code>
            </Field>
            <Field label={s.settings.shellVersion}>
                <code>{status?.shellVersion}</code>
            </Field>
            <Field label={s.settings.channel}>
                <Select
                    label={s.settings.channel}
                    value={settings.update.channel}
                    options={(['stable', 'beta', 'nightly', 'dev'] as const).map((channel) => ({
                        value: channel,
                        label: channel,
                    }))}
                    onChange={(channel) => update({ update: { ...settings.update, channel } })}
                />
            </Field>
            <Field label={s.settings.feedUrl}>
                <input
                    className="input"
                    defaultValue={settings.update.feedUrl}
                    onBlur={(event) => update({ update: { ...settings.update, feedUrl: event.target.value.trim() } })}
                />
            </Field>
            <Field label="">
                <Toggle
                    checked={settings.update.autoCheck}
                    label={s.settings.autoCheck}
                    onChange={(autoCheck) => update({ update: { ...settings.update, autoCheck } })}
                />
            </Field>
            <div className="row">
                <button
                    type="button"
                    className="button"
                    disabled={checking}
                    onClick={async () => {
                        setChecking(true);
                        await attempt(() => host.call('update.check', {}, { timeoutMs: 600_000 }));
                        setChecking(false);
                    }}
                >
                    {checking ? <Spinner /> : null} {s.settings.checkNow}
                </button>
                {status?.state === 'ready' && status.staged && (
                    <button
                        type="button"
                        className="button button--primary"
                        onClick={() => void attempt(() => host.call('update.apply', {}))}
                    >
                        {format(s.settings.restartToUpdate, { version: status.staged })}
                    </button>
                )}
                {status?.state === 'up_to_date' && <Badge tone="ok">{s.settings.upToDate}</Badge>}
                {status?.state === 'error' && <Badge tone="error">{status.error}</Badge>}
                {status?.state === 'downloading' && <Badge tone="accent">下载中 {status.available?.version}</Badge>}
            </div>
        </div>
    );
}

function About() {
    const s = useStrings();
    const info = useApp((state) => state.info);
    return (
        <div className="settings-section">
            <div className="about__brand">
                <LogoMark size={48} />
                <div>
                    <strong>Xora Code</strong>
                    <span>{s.settings.creator}</span>
                </div>
            </div>
            <Field label={s.settings.bundleVersion}>
                <code>{info?.bundleVersion}</code>
            </Field>
            <Field label={s.settings.shellVersion}>
                <code>{info?.shellVersion}</code>
            </Field>
            <Field label="electron / node">
                <code>
                    {info?.versions.electron} / {info?.versions.node}
                </code>
            </Field>
            <Field label={s.settings.dataDir}>
                <code>{info?.dataDir}</code>{' '}
                <button
                    type="button"
                    className="link"
                    onClick={() => info && void host.call('system.open', { kind: 'path', target: info.dataDir })}
                >
                    {s.settings.openDataDir}
                </button>
            </Field>
            <button type="button" className="button" onClick={() => window.xoraShell?.restartToSafeMode()}>
                {s.app.restartSafeMode}
            </button>
        </div>
    );
}

export function SettingsModal({ section }: { section: SettingsSection }) {
    const s = useStrings();
    const sections: Array<[SettingsSection, string]> = [
        ['general', s.settings.general],
        ['models', s.settings.models],
        ['prompts', s.settings.prompts],
        ['permissions', s.settings.permissions],
        ['extensions', s.settings.extensions],
        ['usage', s.settings.usage],
        ['updates', s.settings.updates],
        ['about', s.settings.about],
    ];
    return (
        <Modal title={s.settings.title} wide onClose={() => useApp.setState({ settingsOpen: undefined })}>
            <div className="settings">
                <nav className="settings__nav">
                    {sections.map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            className={id === section ? 'is-active' : ''}
                            onClick={() => useApp.setState({ settingsOpen: id })}
                        >
                            {label}
                        </button>
                    ))}
                </nav>
                <div className="settings__content">
                    {section === 'general' && <General />}
                    {section === 'models' && <Models />}
                    {section === 'prompts' && <Prompts />}
                    {section === 'permissions' && <Permissions />}
                    {section === 'extensions' && <ExtensionsSection />}
                    {section === 'usage' && <Budgets />}
                    {section === 'updates' && <Updates />}
                    {section === 'about' && <About />}
                </div>
            </div>
        </Modal>
    );
}
