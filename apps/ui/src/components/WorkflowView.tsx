import type { WorkflowInfo, WorkflowRun, WorkflowStepRun } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { errorMessage, host } from '../host.ts';
import { attempt, selectThread, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { Markdown } from './Markdown.tsx';
import { Badge, Empty, Field, formatMoney, Modal, Spinner, Toggle } from './primitives.tsx';

type Tone = 'ok' | 'error' | 'accent';

function runTone(status: WorkflowRun['status']): Tone {
    return status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'accent';
}

function stepTone(status: WorkflowStepRun['status']): Tone {
    return status === 'succeeded' ? 'ok' : status === 'failed' ? 'error' : 'accent';
}

/** Opens a thread of a run in the main area. */
function openThread(threadId: string): void {
    void selectThread(threadId).then(() => useApp.setState({ workflowRunId: undefined, teamRunId: undefined }));
}

function StepRow({ step }: { step: WorkflowStepRun }) {
    const s = useStrings();
    const thread = step.threadIds.at(-1);
    // Tool calls of a step are approved in its thread, where the card shows the diff or the command.
    const asking = useApp((state) => state.approvals.some((approval) => step.threadIds.includes(approval.threadId)));
    return (
        <li className={`workflow-step is-${step.status}`}>
            <div className="workflow-step__head">
                <Badge tone={stepTone(step.status)}>{s.workflow.stepStatuses[step.status]}</Badge>
                <strong>{step.title}</strong>
                <span className="workflow-step__meta">
                    {s.workflow.types[step.type as keyof typeof s.workflow.types] ?? step.type}
                    {step.agent ? ` · ${step.agent}` : ''}
                    {step.tier ? ` · ${s.team.tiers[step.tier as keyof typeof s.team.tiers] ?? step.tier}` : ''}
                    {step.attempts > 1 ? ` · ${format(s.workflow.attempts, { count: step.attempts })}` : ''}
                    {step.cost ? ` · ${formatMoney(step.cost)}` : ''}
                </span>
                {asking && <Badge tone="accent">{s.workflow.stepAsking}</Badge>}
                <span className="workflow-step__actions">
                    {step.teamRunId ? (
                        <button
                            type="button"
                            className="button button--small"
                            onClick={() => useApp.setState({ teamRunId: step.teamRunId, workflowRunId: undefined })}
                        >
                            {s.workflow.openTeam}
                        </button>
                    ) : step.childRunId ? (
                        <button
                            type="button"
                            className="button button--small"
                            onClick={() => useApp.setState({ workflowRunId: step.childRunId })}
                        >
                            {s.workflow.openChild}
                        </button>
                    ) : (
                        thread && (
                            <button type="button" className="button button--small" onClick={() => openThread(thread)}>
                                {s.workflow.openStep}
                            </button>
                        )
                    )}
                </span>
            </div>
            {step.needs.length > 0 && (
                <div className="workflow-step__deps">{format(s.team.dependsOn, { ids: step.needs.join(', ') })}</div>
            )}
            {step.note && <div className="workflow-step__note">{step.note}</div>}
            {Object.keys(step.outputs).length > 0 && (
                <div className="workflow-step__outputs">
                    {s.workflow.outputs}：
                    {Object.entries(step.outputs).map(([name, value]) => (
                        <code key={name}>
                            {name}={value}
                        </code>
                    ))}
                </div>
            )}
            {step.summary && step.status === 'succeeded' && (
                <div className="workflow-step__summary">
                    <Markdown text={step.summary} />
                </div>
            )}
        </li>
    );
}

export function WorkflowRunView({ runId }: { runId: string }) {
    const s = useStrings();
    const run = useApp((state) => state.workflowRuns[runId]);
    const approvals = useApp((state) => state.approvals);
    const [budget, setBudget] = useState('');
    useEffect(() => {
        void host
            .call('workflow.get', { runId })
            .then((loaded) =>
                useApp.setState((state) => ({ workflowRuns: { ...state.workflowRuns, [loaded.id]: loaded } })),
            )
            .catch((error) => toast(errorMessage(error), 'error'));
    }, [runId]);
    if (!run)
        return (
            <Empty>
                <Spinner />
            </Empty>
        );
    const pending = approvals.filter((approval) => approval.threadId === run.threadId);
    // A run paused on its budget continues only with a larger one.
    const spent = run.status === 'paused' && run.budget !== null && run.cost.amount >= run.budget.amount;
    const over = ['completed', 'failed', 'cancelled'].includes(run.status);
    return (
        <div className="team workflow">
            <header className="team__header">
                <div className="team__goal">
                    <h1>{run.title}</h1>
                    <div className="team__meta">
                        <Badge tone={runTone(run.status)}>{s.workflow.statuses[run.status]}</Badge>
                        <span>{s.workflow.reasons[run.reason]}</span>
                        <span>
                            {s.thread.cost} {formatMoney(run.cost)}
                            {run.budget ? ` / ${formatMoney(run.budget)}` : ''}
                        </span>
                        {run.startsAt !== undefined && (
                            <span>
                                {format(s.workflow.startsAt, {
                                    time: new Date(run.startsAt).toLocaleString(undefined, { hour12: false }),
                                })}
                            </span>
                        )}
                    </div>
                    {Object.keys(run.inputs).length > 0 && (
                        <div className="workflow__inputs">
                            {Object.entries(run.inputs).map(([name, value]) => (
                                <code key={name}>
                                    {name}={String(value)}
                                </code>
                            ))}
                        </div>
                    )}
                    {run.note && <div className="team__note">{run.note}</div>}
                    {run.warnings.map((warning) => (
                        <div key={warning} className="team__warning">
                            {warning}
                        </div>
                    ))}
                </div>
                <div className="row">
                    <button type="button" className="button button--small" onClick={() => openThread(run.threadId)}>
                        {s.workflow.openThread}
                    </button>
                    {spent && (
                        <input
                            className="input team__budget"
                            type="number"
                            min={0}
                            step={1}
                            value={budget}
                            placeholder={s.workflow.newBudget}
                            aria-label={s.workflow.newBudget}
                            onChange={(event) => setBudget(event.target.value)}
                        />
                    )}
                    {run.status === 'paused' && (
                        <button
                            type="button"
                            className="button button--small button--primary"
                            disabled={spent && !(Number(budget) > (run.budget?.amount ?? 0))}
                            onClick={() =>
                                void attempt(() =>
                                    host.call('workflow.resume', {
                                        runId,
                                        ...(Number(budget) > 0 ? { budget: Number(budget) } : {}),
                                    }),
                                )
                            }
                        >
                            {s.workflow.resume}
                        </button>
                    )}
                    {!over && (
                        <button
                            type="button"
                            className="button button--small button--danger"
                            onClick={() => void attempt(() => host.call('workflow.stop', { runId }))}
                        >
                            {s.workflow.stop}
                        </button>
                    )}
                </div>
            </header>
            {pending.length > 0 && (
                <div className="workflow__approvals">
                    <h3>{s.workflow.pending}</h3>
                    {pending.map((approval) => (
                        <div key={approval.id} className="workflow__approval">
                            <div className="workflow__approval-title">{approval.title}</div>
                            <pre className="workflow__approval-summary">{approval.summary}</pre>
                            <div className="row">
                                <button
                                    type="button"
                                    className="button button--small button--primary"
                                    onClick={() =>
                                        void attempt(() =>
                                            host.call('approval.respond', {
                                                approvalId: approval.id,
                                                decision: 'allow_once',
                                            }),
                                        )
                                    }
                                >
                                    {s.workflow.approve}
                                </button>
                                <button
                                    type="button"
                                    className="button button--small"
                                    onClick={() =>
                                        void attempt(() =>
                                            host.call('approval.respond', {
                                                approvalId: approval.id,
                                                decision: 'deny',
                                            }),
                                        )
                                    }
                                >
                                    {s.workflow.deny}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
            <h3 className="workflow__heading">{s.workflow.steps}</h3>
            <ol className="workflow-steps">
                {run.steps.map((step) => (
                    <StepRow key={step.id} step={step} />
                ))}
            </ol>
        </div>
    );
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
    info,
    onChanged,
}: {
    projectId: string;
    info: WorkflowInfo;
    onChanged: () => void;
}) {
    const s = useStrings();
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
    return (
        <div className="workflow-card">
            <div className="workflow-card__head">
                <button type="button" className="workflow-card__title" onClick={() => setOpen(!open)}>
                    <strong>{info.title}</strong> <code>{info.name}</code>
                    <Badge tone="accent">{s.workflow.source[info.source]}</Badge>
                    {info.issues.length > 0 && <Badge tone="error">{s.workflow.issues}</Badge>}
                </button>
                <button
                    type="button"
                    className="button button--small button--primary"
                    disabled={info.issues.length > 0}
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
            {open && info.issues.length === 0 && (
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
                    <Field label={s.workflow.offPeak} hint={s.workflow.offPeakHint}>
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
            {info.source === 'project' && automatic && info.issues.length === 0 && (
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

export function WorkflowsDialog({ projectId }: { projectId: string }) {
    const s = useStrings();
    const [list, setList] = useState<WorkflowInfo[] | undefined>();
    const load = () => {
        void host
            .call('workflow.list', { projectId })
            .then(setList)
            .catch((error) => toast(errorMessage(error), 'error'));
    };
    useEffect(load, [projectId]);
    const close = () => useApp.setState({ workflowsFor: undefined });
    return (
        <Modal title={s.workflow.title} onClose={close} wide>
            {!list ? (
                <Empty>
                    <Spinner />
                </Empty>
            ) : list.length === 0 ? (
                <Empty>{s.workflow.none}</Empty>
            ) : (
                <div className="workflow-list">
                    {list.map((info) => (
                        <WorkflowCard key={info.key} projectId={projectId} info={info} onChanged={load} />
                    ))}
                </div>
            )}
        </Modal>
    );
}
