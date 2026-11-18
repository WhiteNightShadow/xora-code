import type { Effort, ItemOf, ModelRef } from '@xora/protocol';
import { useLayoutEffect, useRef, useState } from 'react';
import { host } from '../host.ts';
import { attempt, loadMembers, openRun, selectThread, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { startingEffort } from '../thinking.ts';
import { EffortChooser, ModelChooser } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { AgentRolePicker } from './MembersView.tsx';
import { MemberMentionList, useMemberMention } from './Mentions.tsx';
import { Badge, formatMoney, Spinner } from './primitives.tsx';
import '../chief.css';

const TEAM_ENDED = ['done', 'failed', 'cancelled'];
const WORKFLOW_ENDED = ['completed', 'failed', 'cancelled'];

/**
 * Codex-style standalone default chat: clean open canvas with the composer docked at the bottom, bound to no project
 * by default, with direct Agent role selection & creation right inside the composer bar.
 */
export function ChiefHome() {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const models = useApp((state) => state.models);
    const settings = useApp((state) => state.settings);
    const [text, setText] = useState('');
    const [agentId, setAgentId] = useState('');
    const [busy, setBusy] = useState(false);
    const areaRef = useRef<HTMLTextAreaElement>(null);
    const mention = useMemberMention(text, setText);
    const threads = useApp((state) => state.threads);
    const teamRuns = useApp((state) => state.teamRuns);
    const workflowRuns = useApp((state) => state.workflowRuns);
    const [picked, setPicked] = useState<ModelRef | undefined>();
    const [effort, setEffort] = useState<Effort | ''>('');

    // biome-ignore lint/correctness/useExhaustiveDependencies: auto-grow textarea as text changes
    useLayoutEffect(() => {
        const element = areaRef.current;
        if (element) {
            element.style.height = 'auto';
            element.style.height = `${Math.min(element.scrollHeight, 260)}px`;
        }
    }, [text]);

    const connected = (ref: ModelRef | null | undefined) =>
        ref && models.some((option) => option.connectionId === ref.connectionId && option.model.id === ref.model)
            ? ref
            : undefined;
    const model = connected(picked) ?? connected(settings?.defaultModel);
    const reasoning = models.find(
        (option) => model && option.connectionId === model.connectionId && option.model.id === model.model,
    )?.model.reasoning;
    const effortValue = startingEffort(reasoning, settings?.defaultEffort, effort);
    const approvals = useApp((state) => state.approvals).filter((approval) => !approval.reviewer);
    const open = projects.filter((project) => !project.missing);
    const latest = Object.values(threads)
        .filter(
            (thread) =>
                thread.role !== 'chief' &&
                !thread.teamRunId &&
                !thread.workflowRunId &&
                !thread.parent &&
                !thread.archived &&
                open.some((project) => project.id === thread.projectId),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const example = open.find((project) => project.id === latest?.projectId) ?? open[0];
    const underway = [
        ...Object.values(teamRuns)
            .filter((run) => !TEAM_ENDED.includes(run.status))
            .map((run) => ({
                kind: 'team' as const,
                id: run.id,
                title: run.title ?? run.goal,
                status: s.team.statuses[run.status],
                updatedAt: run.updatedAt,
            })),
        ...Object.values(workflowRuns)
            .filter((run) => !WORKFLOW_ENDED.includes(run.status) && !run.parentRunId)
            .map((run) => ({
                kind: 'workflow' as const,
                id: run.id,
                title: run.title,
                status: s.workflow.statuses[run.status],
                updatedAt: run.updatedAt,
            })),
    ]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4);

    const promptSuggestions = example ? s.chief.projectExamples : s.chief.examples;

    const send = async () => {
        const value = text.trim();
        if (!value || busy) return;
        setBusy(true);
        const thread = await attempt(() =>
            agentId
                ? host.call(
                      'member.chat',
                      {
                          memberId: agentId,
                          text: value,
                          ...(model ? { model: model.model } : {}),
                          ...(effortValue ? { effort: effortValue } : {}),
                      },
                      { timeoutMs: 120_000 },
                  )
                : host.call(
                      'chief.start',
                      {
                          text: value,
                          ...(model ? { model } : {}),
                          ...(effortValue ? { effort: effortValue } : {}),
                      },
                      { timeoutMs: 120_000 },
                  ),
        );
        setBusy(false);
        if (thread) {
            useApp.setState((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
            void loadMembers(useApp.getState().selectedProjectId);
            setText('');
            await selectThread(thread.id);
        }
    };

    return (
        <div className="thread chief-home">
            <header className="thread-header chief-home__header">
                <div className="thread-header__title">
                    {approvals.length > 0 && (
                        <button
                            type="button"
                            className="chief-home__pill is-needs"
                            onClick={() => approvals[0] && void selectThread(approvals[0].threadId)}
                        >
                            <Icon name="inbox" size={12} /> {format(s.chief.approvals, { count: approvals.length })}
                        </button>
                    )}
                    {underway.map((run) => (
                        <button
                            key={run.id}
                            type="button"
                            className="chief-home__pill"
                            onClick={() => openRun(run.kind, run.id)}
                        >
                            <Spinner size={10} />
                            <span>{run.title}</span>
                            <span className="muted">· {run.status}</span>
                        </button>
                    ))}
                </div>
            </header>
            <div className="chief-home__grid chief-home__stage">
                {!text.trim() && (
                    <div className="chief-home__examples">
                        {promptSuggestions.map((line) => {
                            const shown = format(line, { project: example?.name ?? '' });
                            return (
                                <button
                                    key={line}
                                    type="button"
                                    className="chief-home__example"
                                    onClick={() => {
                                        setText(shown);
                                        areaRef.current?.focus();
                                    }}
                                >
                                    {shown}
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
            <div className="composer chief-home__dock">
                <div className="composer__box chief-home__composer">
                    <MemberMentionList mention={mention} />
                    <textarea
                        ref={areaRef}
                        className="composer__input"
                        value={text}
                        rows={2}
                        placeholder={s.chief.placeholder}
                        aria-label={s.chief.title}
                        onChange={(event) => {
                            setText(event.target.value);
                            mention.update(event.target.value, event.target.selectionStart);
                        }}
                        onKeyDown={(event) => {
                            if (mention.keyDown(event)) return;
                            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                    />
                    <div className="composer__bar chief-home__bar">
                        <AgentRolePicker value={agentId} onChange={setAgentId} placement="up" />
                        <ModelChooser placement="up" value={model} onChange={setPicked} empty={s.chief.autoModel} />
                        <EffortChooser placement="up" model={model} value={effortValue} onChange={setEffort} />
                        <span className="composer__spacer chief-home__spacer" />
                        <button
                            type="button"
                            className="button button--primary"
                            disabled={busy || !text.trim()}
                            onClick={() => void send()}
                        >
                            {busy ? <Spinner /> : <Icon name="send" size={13} />} {s.chief.send}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

/** A card of work the chief handed on: who does it, where it stands, and the way to it. */
export function DelegationCard({ item }: { item: ItemOf<'delegation'> }) {
    const s = useStrings();
    const project = useApp((state) => state.projects.find((entry) => entry.id === item.projectId));
    const several = useApp((state) => state.projects.length > 1);
    const open = () => (item.kind === 'member' ? void selectThread(item.refId) : openRun(item.kind, item.refId));
    const tone =
        item.status === 'done'
            ? 'ok'
            : item.status === 'waiting'
              ? 'warn'
              : item.status === 'failed'
                ? 'error'
                : item.status === 'cancelled'
                  ? 'muted'
                  : 'accent';
    return (
        <div className={`delegation delegation--${item.status}${item.report ? ' is-report' : ''}`}>
            <div className="delegation__head">
                <span className="delegation__icon">
                    <Icon
                        name={item.kind === 'team' ? 'users' : item.kind === 'workflow' ? 'bolt' : 'user'}
                        size={14}
                    />
                </span>
                <span className="delegation__kind">
                    {item.report ? `${s.chief.report} · ` : ''}
                    {item.kind === 'member' && item.who ? item.who : s.chief.kinds[item.kind]}
                    {several && project ? ` · ${project.name}` : ''}
                </span>
                <span className="delegation__title">{item.title}</span>
                {item.status === 'running' && <Spinner size={10} />}
                <Badge tone={tone}>{s.chief.statuses[item.status]}</Badge>
                {item.cost && item.cost.amount > 0 && (
                    <span className="delegation__cost">{formatMoney(item.cost)}</span>
                )}
                <button type="button" className="link delegation__open" onClick={open}>
                    {s.chief.open}
                </button>
            </div>
            {item.summary && (
                <div className="delegation__summary">
                    <Markdown text={item.summary} />
                </div>
            )}
        </div>
    );
}
