import type { WorkflowInfo, WorkflowRun, WorkflowRunMode } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { errorMessage, host } from '../host.ts';
import { attempt, selectThread, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Badge, Empty, Field, formatMoney, IconButton, Modal, relativeTime, Spinner, Toggle } from './primitives.tsx';

const RUN_MODES: WorkflowRunMode[] = ['default', 'auto_edit', 'full'];
export const RUN_MODE_ICONS: Record<WorkflowRunMode, IconName> = {
    default: 'shield',
    auto_edit: 'pencil',
    full: 'bolt',
};

export function runModeChoices(s: ReturnType<typeof useStrings>) {
    return RUN_MODES.map((mode) => ({
        value: mode,
        label: s.workflow.modes[mode],
        hint: s.workflow.modeHints[mode],
        icon: RUN_MODE_ICONS[mode],
        ...(mode === 'full' ? { tone: 'warn' as const } : {}),
    }));
}

type Tone = 'ok' | 'error' | 'accent';

export function runTone(status: WorkflowRun['status']): Tone {
    return status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'accent';
}

function TriggerSummary({ info }: { info: WorkflowInfo }) {
    const s = useStrings();
    const parts: string[] = [];
    if (info.trigger.schedule.length > 0) {
        parts.push(
            `${s.workflow.schedule} ${info.trigger.schedule.join('、')}${info.trigger.timezone ? `（${info.trigger.timezone}）` : ''}`,
        );
    }
    if (info.trigger.files.length > 0) parts.push(`${s.workflow.files} ${info.trigger.files.join('、')}`);
    if (info.trigger.git.length > 0) parts.push(`${s.workflow.git} ${info.trigger.git.join('、')}`);
    if (info.trigger.webhook) parts.push(s.workflow.webhook);
    return <span>{parts.length > 0 ? parts.join('；') : s.workflow.noTrigger}</span>;
}

function WorkflowCard({
    projectId,
    projectPath,
    info,
    onChanged,
}: {
    projectId: string;
    projectPath: string;
    info: WorkflowInfo;
    onChanged: () => void;
}) {
    const s = useStrings();
    const remembered = useApp((state) => state.settings?.lastChoices.workflowMode ?? 'default');
    const [mode, setMode] = useState<WorkflowRunMode>(remembered);
    const [open, setOpen] = useState(false);
    const [inputs, setInputs] = useState<Record<string, string>>(() =>
        Object.fromEntries(
            info.inputs.map((input) => [input.name, input.default === undefined ? '' : String(input.default)]),
        ),
    );
    const [offPeak, setOffPeak] = useState(info.trigger.offPeakOnly);
    const [budget, setBudget] = useState('');
    const [busy, setBusy] = useState(false);
    const [webhook, setWebhook] = useState<{ url: string; token: string } | undefined>();
    const automatic =
        info.trigger.schedule.length > 0 ||
        info.trigger.files.length > 0 ||
        info.trigger.git.length > 0 ||
        info.trigger.webhook;
    const start = async () => {
        setBusy(true);
        const given: Record<string, string | number | boolean> = {};
        for (const input of info.inputs) {
            const raw = inputs[input.name] ?? '';
            if (raw === '') continue;
            given[input.name] = input.type === 'number' ? Number(raw) : input.type === 'boolean' ? raw === 'true' : raw;
        }
        const run = await attempt(() =>
            host.call(
                'workflow.start',
                {
                    projectId,
                    key: info.key,
                    inputs: given,
                    offPeak,
                    mode,
                    ...(Number(budget) > 0 ? { budget: Number(budget) } : {}),
                },
                { timeoutMs: 120_000 },
            ),
        );
        setBusy(false);
        if (run) {
            useApp.setState((state) => ({
                workflowRuns: { ...state.workflowRuns, [run.id]: run },
                workflowRunId: run.id,
                teamRunId: undefined,
                workflowsFor: undefined,
            }));
        }
    };
    const switchTriggers = async (enabled: boolean) => {
        const updated = await attempt(() => host.call('workflow.triggers', { projectId, key: info.key, enabled }));
        if (updated) onChanged();
    };
    const remove = async () => {
        const file =
            projectPath && info.path.startsWith(projectPath)
                ? info.path.slice(projectPath.length).replace(/^[\\/]/, '')
                : info.path;
        const question = info.source === 'user' ? s.workflow.confirmRemoveUser : s.workflow.confirmRemove;
        if (!window.confirm(format(question, { title: info.title, path: file }))) return;
        const removed = await attempt(() => host.call('workflow.delete', { projectId, key: info.key }));
        if (removed) {
            toast(s.workflow.removed, 'success');
            onChanged();
        }
    };
    const runnable = info.issues.length === 0 && !info.untrusted;
    return (
        <div className="workflow-card">
            <div className="workflow-card__head">
                <button type="button" className="workflow-card__title" onClick={() => setOpen(!open)}>
                    <strong>{info.title}</strong> <code>{info.name}</code>
                    <Badge tone="accent">{s.workflow.source[info.source]}</Badge>
                    {info.issues.length > 0 && <Badge tone="error">{s.workflow.issues}</Badge>}
                </button>
                <IconButton icon="trash" label={s.workflow.remove} onClick={() => void remove()} />
                <button
                    type="button"
                    className="button button--small button--primary"
                    disabled={!runnable}
                    title={info.untrusted ? s.workflow.needsTrust : undefined}
                    onClick={() => setOpen(true)}
                >
                    {s.workflow.run}
                </button>
            </div>
            {info.description && <div className="workflow-card__desc">{info.description}</div>}
            <div className="workflow-card__meta">
                {s.workflow.steps}：{info.steps.map((step) => step.title).join(' → ')}
            </div>
            <div className="workflow-card__meta">
                <TriggerSummary info={info} />
            </div>
            {info.issues.length > 0 && (
                <ul className="workflow-card__issues">
                    {info.issues.map((issue) => (
                        <li key={`${issue.path}:${issue.message}`}>
                            {issue.line !== undefined ? `L${issue.line} ` : ''}
                            {issue.path ? <code>{issue.path}</code> : null} {issue.message}
                        </li>
                    ))}
                </ul>
            )}
            {open && runnable && (
                <div className="dialog workflow-card__form">
                    {info.inputs.map((input) => (
                        <Field
                            key={input.name}
                            label={input.name}
                            {...(input.description ? { hint: input.description } : {})}
                        >
                            <input
                                className="input"
                                type={input.type === 'number' ? 'number' : 'text'}
                                value={inputs[input.name] ?? ''}
                                onChange={(event) => setInputs({ ...inputs, [input.name]: event.target.value })}
                            />
                        </Field>
                    ))}
                    <Field label={s.workflow.mode} hint={s.workflow.modeHints[mode]}>
                        <div className="segmented">
                            {RUN_MODES.map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    className={mode === value ? 'is-active' : ''}
                                    onClick={() => setMode(value)}
                                >
                                    {s.workflow.modes[value]}
                                </button>
                            ))}
                        </div>
                    </Field>
                    <Field label={s.workflow.budget}>
                        <input
                            className="input"
                            type="number"
                            min={0}
                            step={1}
                            value={budget}
                            placeholder={info.budget ? formatMoney(info.budget) : s.settings.noLimit}
                            onChange={(event) => setBudget(event.target.value)}
                        />
                    </Field>
                    <Field label={s.workflow.offPeakLabel} hint={s.workflow.offPeakHint}>
                        <Toggle checked={offPeak} onChange={setOffPeak} label={s.workflow.offPeak} />
                    </Field>
                    <div className="row">
                        <button
                            type="button"
                            className="button button--primary"
                            disabled={busy}
                            onClick={() => void start()}
                        >
                            {busy ? <Spinner /> : null} {s.workflow.runIt}
                        </button>
                    </div>
                </div>
            )}
            {info.source === 'project' && automatic && runnable && (
                <div className="workflow-card__triggers">
                    <Field
                        label={s.workflow.triggers}
                        hint={info.triggers.stale ? s.workflow.triggersStale : s.workflow.triggersHint}
                    >
                        <Toggle
                            checked={info.triggers.enabled && !info.triggers.stale}
                            onChange={(value) => void switchTriggers(value)}
                            label={s.workflow.triggers}
                        />
                    </Field>
                    {info.triggers.nextRunAt !== undefined && (
                        <div className="workflow-card__meta">
                            {format(s.workflow.nextRun, {
                                time: new Date(info.triggers.nextRunAt).toLocaleString(undefined, { hour12: false }),
                            })}
                        </div>
                    )}
                    {info.trigger.webhook && info.triggers.enabled && !info.triggers.stale && (
                        <div className="workflow-card__webhook">
                            {webhook ? (
                                <>
                                    <code>POST {webhook.url}</code>
                                    <code>{format(s.workflow.webhookToken, { token: webhook.token })}</code>
                                </>
                            ) : (
                                <button
                                    type="button"
                                    className="button button--small"
                                    onClick={() =>
                                        void attempt(() =>
                                            host.call('workflow.webhook', { projectId, key: info.key }),
                                        ).then((value) => value && setWebhook(value))
                                    }
                                >
                                    {s.workflow.showWebhook}
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/** A project's workflows in the main area: what they are, how to make one, each with its run form, and the runs. */
export function WorkflowBoard({ projectId }: { projectId: string }) {
    const s = useStrings();
    const project = useApp((state) => state.projects.find((item) => item.id === projectId));
    const allRuns = useApp((state) => state.workflowRuns);
    const [list, setList] = useState<WorkflowInfo[] | undefined>();
    const [trusting, setTrusting] = useState(false);
    const load = () => {
        void host
            .call('workflow.list', { projectId })
            .then(setList)
            .catch((error) => toast(errorMessage(error), 'error'));
        void host
            .call('workflow.runs', { projectId })
            .then((runs) =>
                useApp.setState((state) => ({
                    workflowRuns: { ...state.workflowRuns, ...Object.fromEntries(runs.map((run) => [run.id, run])) },
                })),
            )
            .catch(() => undefined);
    };
    // Trusting the project here or in settings changes what can run.
    // biome-ignore lint/correctness/useExhaustiveDependencies: reloads when the project's trust changes
    useEffect(load, [projectId, project?.trusted]);
    const trust = async () => {
        setTrusting(true);
        const done = await attempt(() => host.call('project.trust', { projectId, trusted: true }));
        setTrusting(false);
        if (done) load();
    };
    const [showArchived, setShowArchived] = useState(false);
    const projectRuns = Object.values(allRuns)
        .filter((run) => run.projectId === projectId && !run.parentRunId)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    const runs = projectRuns.filter((run) => !run.archived).slice(0, 20);
    const archivedRuns = projectRuns.filter((run) => run.archived);
    const create = () => useApp.setState({ workflowDraftFor: projectId });
    return (
        <div className="wf-board">
            <header className="wf-board__header">
                <div className="wf-board__title">
                    <h1>{s.workflow.title}</h1>
                    <span className="wf-board__project">{project?.name}</span>
                </div>
                <div className="row">
                    <IconButton icon="refresh" label={s.common.refresh} onClick={load} />
                    <button type="button" className="button button--primary" onClick={create}>
                        <Icon name="plus" size={14} /> {s.workflow.create}
                    </button>
                </div>
            </header>
            <div className="wf-board__body">
                <p className="wf-board__intro">{s.workflow.boardIntro}</p>
                {list?.some((info) => info.untrusted) && (
                    <div className="wf-board__trust">
                        <Icon name="shield" size={18} className="wf-board__trust-icon" />
                        <div className="wf-board__trust-text">
                            <strong>{s.workflow.untrustedTitle}</strong>
                            <span>{s.workflow.untrustedHint}</span>
                        </div>
                        <button
                            type="button"
                            className="button button--primary"
                            disabled={trusting}
                            onClick={() => void trust()}
                        >
                            {trusting ? <Spinner /> : null} {s.workflow.trust}
                        </button>
                    </div>
                )}
                {!list ? (
                    <Empty>
                        <Spinner />
                    </Empty>
                ) : list.length === 0 ? (
                    <div className="wf-board__empty">
                        <Icon name="bolt" size={22} />
                        <p>{s.workflow.howToCreate}</p>
                        <button type="button" className="button button--primary" onClick={create}>
                            <Icon name="plus" size={14} /> {s.workflow.create}
                        </button>
                    </div>
                ) : (
                    <div className="workflow-list">
                        {list.map((info) => (
                            <WorkflowCard
                                key={info.key}
                                projectId={projectId}
                                projectPath={project?.path ?? ''}
                                info={info}
                                onChanged={load}
                            />
                        ))}
                    </div>
                )}
                <h3 className="wf-board__heading">{s.workflow.runsTitle}</h3>
                {runs.length === 0 ? (
                    <p className="muted">{s.workflow.noRuns}</p>
                ) : (
                    <div className="wf-board__runs">
                        {runs.map((run) => (
                            <button
                                key={run.id}
                                type="button"
                                className="wf-board__run"
                                onClick={() => useApp.setState({ workflowRunId: run.id, workflowsFor: undefined })}
                            >
                                <Badge tone={runTone(run.status)}>{s.workflow.statuses[run.status]}</Badge>
                                <span className="wf-board__run-title">{run.title}</span>
                                <span className="wf-board__run-meta">
                                    {s.workflow.reasons[run.reason]} · {relativeTime(run.updatedAt)}
                                    {run.cost.amount > 0 ? ` · ${formatMoney(run.cost)}` : ''}
                                </span>
                            </button>
                        ))}
                    </div>
                )}
                {archivedRuns.length > 0 && (
                    <button type="button" className="project__archived" onClick={() => setShowArchived(!showArchived)}>
                        {format(s.workflow.archivedRuns, { count: archivedRuns.length })}
                    </button>
                )}
                {showArchived && (
                    <div className="wf-board__runs">
                        {archivedRuns.map((run) => (
                            <button
                                key={run.id}
                                type="button"
                                className="wf-board__run"
                                onClick={() => useApp.setState({ workflowRunId: run.id, workflowsFor: undefined })}
                            >
                                <Badge tone={runTone(run.status)}>{s.workflow.statuses[run.status]}</Badge>
                                <span className="wf-board__run-title">{run.title}</span>
                                <span className="wf-board__run-meta">{relativeTime(run.updatedAt)}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/** "New workflow": the user describes the process and an agent writes the workflow file in a new thread. */
export function WorkflowDraftDialog({ projectId }: { projectId: string }) {
    const s = useStrings();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const close = () => useApp.setState({ workflowDraftFor: undefined });
    const start = async () => {
        setBusy(true);
        const thread = await attempt(() =>
            host.call('workflow.draft', { projectId, description: text.trim() }, { timeoutMs: 120_000 }),
        );
        setBusy(false);
        if (thread) {
            useApp.setState((state) => ({
                threads: { ...state.threads, [thread.id]: thread },
                workflowDraftFor: undefined,
            }));
            await selectThread(thread.id);
        }
    };
    return (
        <Modal title={s.workflow.create} onClose={close}>
            <div className="dialog">
                <Field label={s.workflow.describe} hint={s.workflow.describeHint}>
                    <textarea
                        className="textarea"
                        rows={6}
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                    />
                </Field>
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !text.trim()}
                        onClick={() => void start()}
                    >
                        {busy ? <Spinner /> : null} {s.workflow.createStart}
                    </button>
                    <button type="button" className="button" onClick={close}>
                        {s.common.cancel}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
