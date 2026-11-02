import type { Member, MemberRoutine, PermissionMode, ThreadMeta } from '@xora/protocol';
import { type CSSProperties, useEffect, useState } from 'react';
import { host } from '../host.ts';
import {
    avatarHue,
    choiceOf,
    cronOf,
    initialOf,
    type SchedulePreset,
    sortMembers,
    type WorkKind,
    workKind,
} from '../members.ts';
import { attempt, loadMembers, openMembers, selectThread, toast, useApp, useStrings } from '../store.ts';
import { format, type Strings } from '../strings.ts';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { Badge, Empty, Field, IconButton, Modal, relativeTime, Select, Spinner, Toggle } from './primitives.tsx';
import '../members.css';
import '../task.css';

const MODES: PermissionMode[] = ['plan', 'ask', 'auto_edit', 'full'];
const TIERS = ['flagship', 'standard', 'economy', 'fast'] as const;
const PRESETS: SchedulePreset[] = ['daily', 'weekdays', 'weekly', 'hourly', 'custom'];

/** A member's face: the first character of its name on a color of its own. */
export function MemberAvatar({ member, size = 36 }: { member: Pick<Member, 'id' | 'name'>; size?: number }) {
    const style = {
        width: size,
        height: size,
        fontSize: Math.round(size * 0.44),
        '--member-hue': avatarHue(member.id),
    } as CSSProperties;
    return (
        <span className="member-avatar" style={style} aria-hidden="true">
            {initialOf(member.name)}
        </span>
    );
}

/** What a member is: its role (an executor by its kind of work), model tier and permissions. */
function roleLine(member: Member, s: Strings): string {
    const role =
        member.role === 'executor' && member.category
            ? ((s.members.categories as Record<string, string>)[member.category] ?? member.category)
            : ((s.members.roles as Record<string, string>)[member.role] ?? member.role);
    const tier = (s.team.tiers as Record<string, string>)[member.tier] ?? member.tier;
    return [role, member.model ?? format(s.members.tierLabel, { tier }), s.members.modes[member.mode]].join(' · ');
}

/** A built-in member's job in the UI language until the user writes another. */
function descriptionOf(member: Member, s: Strings): string | undefined {
    if (member.source === 'builtin' && !member.customized) {
        return (s.members.builtinJobs as Record<string, string>)[member.id] ?? member.description;
    }
    return member.description;
}

function SourceBadge({ member }: { member: Member }) {
    const s = useStrings();
    if (member.source === 'builtin') {
        return member.customized ? (
            <Badge tone="accent">{s.members.customized}</Badge>
        ) : (
            <Badge>{s.members.builtin}</Badge>
        );
    }
    return <Badge tone="ok">{member.source === 'project' ? s.members.project : s.members.mine}</Badge>;
}

/** When a routine runs, in words: every day at nine, on weekdays, every hour, or its cron. */
function scheduleText(schedule: string, s: Strings): string {
    const choice = choiceOf(schedule);
    switch (choice.preset) {
        case 'hourly':
            return s.members.presetText.hourly;
        case 'custom':
            return format(s.members.presetText.custom, { cron: choice.cron });
        default:
            return format(s.members.presetText[choice.preset], { time: choice.time });
    }
}

function MemberCard({ member }: { member: Member }) {
    const s = useStrings();
    const description = descriptionOf(member, s);
    return (
        <article className="member-card">
            <button type="button" className="member-card__main" onClick={() => openMembers(member.id)}>
                <MemberAvatar member={member} size={42} />
                <span className="member-card__text">
                    <span className="member-card__name">
                        {member.name}
                        <SourceBadge member={member} />
                    </span>
                    <span className="member-card__role">{roleLine(member, s)}</span>
                </span>
            </button>
            {description && <p className="member-card__desc">{description}</p>}
            <div className="member-card__stats">
                <span>
                    <Icon name="brain" size={12} />
                    {member.memory.chars > 0
                        ? format(s.members.memoryChars, { count: member.memory.chars })
                        : s.members.noMemory}
                </span>
                {member.routines.length > 0 && (
                    <span>
                        <Icon name="refresh" size={12} />
                        {format(s.members.routinesCount, { count: member.routines.length })}
                    </span>
                )}
            </div>
            <footer className="member-card__foot">
                <button
                    type="button"
                    className="button button--small button--primary"
                    onClick={() => useApp.setState({ dispatchTo: member.id })}
                >
                    {s.members.dispatch}
                </button>
                <button type="button" className="link" onClick={() => openMembers(member.id)}>
                    {s.members.details}
                </button>
            </footer>
        </article>
    );
}

/** The user's memory text of a member, with an editor and a way to clear it. */
/** Which part of a member's memory is shown (06 §21): `member`, `project:<id>` or `team:<id>`. */
type MemoryPart = string;

function partRequest(part: MemoryPart): { scope: 'member' | 'project' | 'team'; projectId?: string } {
    const [scope, projectId] = part.split(':', 2) as ['member' | 'project' | 'team', string | undefined];
    return projectId ? { scope, projectId } : { scope: 'member' };
}

function MemorySection({ member }: { member: Member }) {
    const s = useStrings();
    const current = useApp((state) => state.projects.find((item) => item.id === state.selectedProjectId));
    const [part, setPart] = useState<MemoryPart>(current ? `project:${current.id}` : 'member');
    const [memory, setMemory] = useState<
        { text: string; updatedAt?: number; projects?: Array<{ projectId: string; name: string }> } | undefined
    >();
    const [editing, setEditing] = useState<string | undefined>();
    // Reloads whenever the member reports a change (it remembered something, the user edited it).
    // biome-ignore lint/correctness/useExhaustiveDependencies: the memory's size and time say it changed
    useEffect(() => {
        let live = true;
        host.call('member.memory', { memberId: member.id, ...partRequest(part) })
            .then((value) => live && setMemory(value))
            .catch(() => live && setMemory({ text: '' }));
        return () => {
            live = false;
        };
    }, [member.id, member.memory.chars, member.memory.updatedAt, part]);
    const parts = [
        ...(current
            ? [{ value: `project:${current.id}`, label: format(s.members.memoryProject, { project: current.name }) }]
            : []),
        { value: 'member', label: s.members.memoryGeneral },
        ...(current
            ? [{ value: `team:${current.id}`, label: format(s.members.memoryTeam, { project: current.name }) }]
            : []),
        ...(memory?.projects ?? [])
            .filter((project) => project.projectId !== current?.id)
            .map((project) => ({
                value: `project:${project.projectId}`,
                label: format(s.members.memoryProject, { project: project.name }),
            })),
    ];
    const save = async (text: string) => {
        const done = await attempt(() =>
            host.call('member.setMemory', { memberId: member.id, text, ...partRequest(part) }),
        );
        if (done) {
            setMemory({ text, updatedAt: Date.now() });
            setEditing(undefined);
        }
    };
    const text = memory?.text.trim() ?? '';
    return (
        <section className="overview-card member-section" aria-label={s.members.memory}>
            <h3>
                <Icon name="brain" size={15} />
                {s.members.memory}
                <span className="wf-hint">{s.members.memoryHint}</span>
            </h3>
            <div className="member-memory__parts">
                <Select label={s.members.memory} value={part} options={parts} onChange={setPart} />
            </div>
            {memory === undefined ? (
                <Spinner />
            ) : text ? (
                <div className="member-memory">
                    <Markdown text={text} />
                </div>
            ) : (
                <p className="overview-muted">{s.members.memoryEmpty}</p>
            )}
            <div className="member-section__actions">
                <button type="button" className="button button--small" onClick={() => setEditing(memory?.text ?? '')}>
                    {s.members.memoryEdit}
                </button>
                {text && (
                    <button
                        type="button"
                        className="button button--small"
                        onClick={() => {
                            if (window.confirm(format(s.members.memoryConfirmClear, { name: member.name }))) {
                                void save('');
                            }
                        }}
                    >
                        {s.members.memoryClear}
                    </button>
                )}
                {memory?.updatedAt !== undefined && (
                    <span className="member-muted">
                        {format(s.members.memoryUpdated, { time: relativeTime(memory.updatedAt) })}
                    </span>
                )}
            </div>
            {editing !== undefined && (
                <Modal
                    title={format(s.members.memoryEditTitle, { name: member.name })}
                    onClose={() => setEditing(undefined)}
                >
                    <div className="dialog">
                        <Field label={s.members.memory} hint={s.members.memoryEditHint}>
                            <textarea
                                className="textarea member-memory__editor"
                                rows={14}
                                value={editing}
                                onChange={(event) => setEditing(event.target.value)}
                            />
                        </Field>
                        <div className="row">
                            <button type="button" className="button button--primary" onClick={() => void save(editing)}>
                                {s.members.save}
                            </button>
                            <button type="button" className="button" onClick={() => setEditing(undefined)}>
                                {s.common.cancel}
                            </button>
                        </div>
                    </div>
                </Modal>
            )}
        </section>
    );
}

interface RoutineDraft {
    readonly id?: string;
    readonly title: string;
    readonly preset: SchedulePreset;
    readonly time: string;
    readonly cron: string;
    readonly timezone?: string;
    readonly projectId: string;
    readonly instruction: string;
    readonly enabled: boolean;
}

function draftOf(routine: MemberRoutine): RoutineDraft {
    const choice = choiceOf(routine.schedule);
    return {
        id: routine.id,
        title: routine.title,
        preset: choice.preset,
        time: choice.time,
        cron: choice.cron,
        ...(routine.timezone ? { timezone: routine.timezone } : {}),
        projectId: routine.projectId,
        instruction: routine.instruction,
        enabled: routine.enabled,
    };
}

/** The routine as `member.saveRoutine` takes it. */
function routineInput(draft: RoutineDraft) {
    return {
        ...(draft.id ? { id: draft.id } : {}),
        title: draft.title.trim(),
        schedule: cronOf(draft),
        ...(draft.timezone ? { timezone: draft.timezone } : {}),
        projectId: draft.projectId,
        instruction: draft.instruction.trim(),
        enabled: draft.enabled,
    };
}

function RoutineForm({ member, initial, onDone }: { member: Member; initial: RoutineDraft; onDone: () => void }) {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const [draft, setDraft] = useState(initial);
    const [busy, setBusy] = useState(false);
    const change = (patch: Partial<RoutineDraft>) => setDraft({ ...draft, ...patch });
    const save = async () => {
        setBusy(true);
        const saved = await attempt(() =>
            host.call('member.saveRoutine', { memberId: member.id, routine: routineInput(draft) }),
        );
        setBusy(false);
        if (saved) {
            await loadMembers(useApp.getState().selectedProjectId);
            onDone();
        }
    };
    const timed = draft.preset === 'daily' || draft.preset === 'weekdays' || draft.preset === 'weekly';
    return (
        <div className="routine-form">
            <Field label={s.members.routineTitle}>
                <input
                    className="input"
                    value={draft.title}
                    placeholder={s.members.routineTitlePlaceholder}
                    onChange={(event) => change({ title: event.target.value })}
                />
            </Field>
            <Field label={s.members.routineWhen}>
                <div className="routine-form__when">
                    <Select
                        label={s.members.routineWhen}
                        value={draft.preset}
                        options={PRESETS.map((preset) => ({ value: preset, label: s.members.presets[preset] }))}
                        onChange={(preset) => change({ preset })}
                    />
                    {timed && (
                        <input
                            className="input routine-form__time"
                            type="time"
                            value={draft.time}
                            aria-label={s.members.routineAt}
                            onChange={(event) => change({ time: event.target.value })}
                        />
                    )}
                    {draft.preset === 'custom' && (
                        <input
                            className="input routine-form__cron"
                            value={draft.cron}
                            placeholder="0 9 * * 1-5"
                            aria-label={s.members.routineCron}
                            onChange={(event) => change({ cron: event.target.value })}
                        />
                    )}
                </div>
            </Field>
            <Field label={s.members.routineProject}>
                <Select
                    label={s.members.routineProject}
                    value={draft.projectId}
                    options={projects.map((project) => ({ value: project.id, label: project.name }))}
                    onChange={(projectId) => change({ projectId })}
                />
            </Field>
            <Field label={s.members.routineInstruction} hint={s.members.routineInstructionHint}>
                <textarea
                    className="textarea"
                    rows={4}
                    value={draft.instruction}
                    placeholder={s.members.routineInstructionPlaceholder}
                    onChange={(event) => change({ instruction: event.target.value })}
                />
            </Field>
            <div className="row">
                <button
                    type="button"
                    className="button button--primary"
                    disabled={
                        busy ||
                        !draft.title.trim() ||
                        !draft.instruction.trim() ||
                        !draft.projectId ||
                        (draft.preset === 'custom' && !draft.cron.trim())
                    }
                    onClick={() => void save()}
                >
                    {busy ? <Spinner /> : null} {s.members.save}
                </button>
                <button type="button" className="button" onClick={onDone}>
                    {s.common.cancel}
                </button>
            </div>
        </div>
    );
}

function RoutineRow({ member, routine, onEdit }: { member: Member; routine: MemberRoutine; onEdit: () => void }) {
    const s = useStrings();
    const project = useApp((state) => state.projects.find((item) => item.id === routine.projectId));
    const reload = () => loadMembers(useApp.getState().selectedProjectId);
    const toggle = (enabled: boolean) =>
        void attempt(() =>
            host.call('member.saveRoutine', {
                memberId: member.id,
                routine: routineInput({ ...draftOf(routine), enabled }),
            }),
        ).then((saved) => saved && reload());
    const runNow = async () => {
        const thread = await attempt(() =>
            host.call('member.runRoutine', { memberId: member.id, routineId: routine.id }, { timeoutMs: 120_000 }),
        );
        if (thread) {
            useApp.setState((state) => ({ threads: { ...state.threads, [thread.id]: thread } }));
            await selectThread(thread.id);
        }
    };
    const remove = () => {
        if (!window.confirm(format(s.members.routineConfirmDelete, { title: routine.title }))) return;
        void attempt(() => host.call('member.deleteRoutine', { memberId: member.id, routineId: routine.id })).then(
            (saved) => saved && reload(),
        );
    };
    const time = (at: number) => new Date(at).toLocaleString(undefined, { hour12: false });
    return (
        <li className={`routine${routine.enabled ? '' : ' is-off'}`}>
            <div className="routine__main">
                <span className="routine__title">{routine.title}</span>
                <span className="routine__when">
                    {scheduleText(routine.schedule, s)}
                    {project ? ` · ${project.name}` : ''}
                </span>
                {routine.problem && <span className="routine__problem">{routine.problem}</span>}
                <span className="routine__times">
                    {routine.enabled && routine.nextRunAt !== undefined && (
                        <span>{format(s.members.routineNext, { time: time(routine.nextRunAt) })}</span>
                    )}
                    {routine.lastRunAt !== undefined && (
                        <span>{format(s.members.routineLast, { time: time(routine.lastRunAt) })}</span>
                    )}
                    {routine.lastThreadId && (
                        <button
                            type="button"
                            className="link"
                            onClick={() => routine.lastThreadId && void selectThread(routine.lastThreadId)}
                        >
                            {s.members.routineOpenLast}
                        </button>
                    )}
                </span>
            </div>
            <div className="routine__actions">
                <Toggle checked={routine.enabled} onChange={toggle} label={s.members.routineEnabled} />
                <button type="button" className="button button--small" onClick={() => void runNow()}>
                    {s.members.routineRunNow}
                </button>
                <IconButton icon="pencil" label={s.members.edit} onClick={onEdit} />
                <IconButton icon="trash" label={s.members.routineDelete} onClick={remove} />
            </div>
        </li>
    );
}

function RoutinesSection({ member }: { member: Member }) {
    const s = useStrings();
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const projects = useApp((state) => state.projects);
    const [draft, setDraft] = useState<RoutineDraft | undefined>();
    const fresh = (): RoutineDraft => ({
        title: '',
        preset: 'weekdays',
        time: '09:00',
        cron: '',
        projectId: selectedProjectId ?? projects[0]?.id ?? '',
        instruction: '',
        enabled: true,
    });
    return (
        <section className="overview-card member-section" aria-label={s.members.routines}>
            <h3>
                <Icon name="refresh" size={15} />
                {s.members.routines}
                <span className="wf-hint">{s.members.routinesHint}</span>
            </h3>
            {member.routines.length === 0 && !draft && <p className="overview-muted">{s.members.routinesEmpty}</p>}
            {member.routines.length > 0 && (
                <ul className="routine-list">
                    {member.routines.map((routine) => (
                        <RoutineRow
                            key={routine.id}
                            member={member}
                            routine={routine}
                            onEdit={() => setDraft(draftOf(routine))}
                        />
                    ))}
                </ul>
            )}
            {draft ? (
                <RoutineForm
                    key={draft.id ?? 'new'}
                    member={member}
                    initial={draft}
                    onDone={() => setDraft(undefined)}
                />
            ) : (
                <div className="member-section__actions">
                    <button type="button" className="button button--small" onClick={() => setDraft(fresh())}>
                        <Icon name="plus" size={13} /> {s.members.routineAdd}
                    </button>
                </div>
            )}
        </section>
    );
}

function WorkSection({ member }: { member: Member }) {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const [threads, setThreads] = useState<ThreadMeta[] | undefined>();
    // A new conversation or routine run changes the member, which reloads the list.
    useEffect(() => {
        let live = true;
        host.call('member.threads', { memberId: member.id, limit: 30 })
            .then((value) => live && setThreads(value))
            .catch(() => live && setThreads([]));
        return () => {
            live = false;
        };
    }, [member]);
    return (
        <section className="member-section member-work" aria-label={s.members.work}>
            <h3>{s.members.work}</h3>
            {threads === undefined ? (
                <Spinner />
            ) : threads.length === 0 ? (
                <p className="overview-muted">{s.members.workEmpty}</p>
            ) : (
                <ul className="member-work__list">
                    {threads.map((thread) => {
                        const kind: WorkKind = workKind(thread);
                        return (
                            <li key={thread.id}>
                                <button
                                    type="button"
                                    className="member-work__row"
                                    onClick={() => void selectThread(thread.id)}
                                >
                                    <span className={`member-work__kind is-${kind}`}>{s.members.workKinds[kind]}</span>
                                    <span className="member-work__title">{thread.title}</span>
                                    <span className="member-work__meta">
                                        {projects.find((project) => project.id === thread.projectId)?.name} ·{' '}
                                        {relativeTime(thread.updatedAt)}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}

function MemberDetail({ member, onEdit }: { member: Member; onEdit: (member: Member) => void }) {
    const s = useStrings();
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [showPrompt, setShowPrompt] = useState(false);
    const description = descriptionOf(member, s);
    const removable = member.source !== 'builtin' || member.customized;
    const remove = () => {
        const question = member.source === 'builtin' ? s.members.confirmReset : s.members.confirmDelete;
        if (!window.confirm(format(question, { name: member.name }))) return;
        void attempt(() =>
            host.call('member.delete', {
                ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
                memberId: member.id,
            }),
        ).then(async (done) => {
            if (!done) return;
            await loadMembers(selectedProjectId);
            if (member.source !== 'builtin') openMembers();
        });
    };
    return (
        <div className="member-detail">
            <button type="button" className="link member-detail__back" onClick={() => openMembers()}>
                <Icon name="chevronLeft" size={13} /> {s.members.back}
            </button>
            <header className="member-detail__head">
                <MemberAvatar member={member} size={56} />
                <div className="member-detail__title">
                    <h1>
                        {member.name}
                        <SourceBadge member={member} />
                    </h1>
                    <div className="member-detail__meta">{roleLine(member, s)}</div>
                    {description && <p className="member-detail__desc">{description}</p>}
                </div>
                <div className="row member-detail__actions">
                    <button
                        type="button"
                        className="button button--primary"
                        onClick={() => useApp.setState({ dispatchTo: member.id })}
                    >
                        <Icon name="send" size={13} /> {s.members.dispatch}
                    </button>
                    <button type="button" className="button" onClick={() => onEdit(member)}>
                        {s.members.edit}
                    </button>
                    {removable && (
                        <button type="button" className="button button--danger" onClick={remove}>
                            {member.source === 'builtin' ? s.members.reset : s.members.delete}
                        </button>
                    )}
                </div>
            </header>
            <p className="member-detail__mention">{format(s.members.mentionHint, { name: member.name })}</p>
            <section className="member-section">
                <button
                    type="button"
                    className="wf-process__toggle"
                    aria-expanded={showPrompt}
                    onClick={() => setShowPrompt(!showPrompt)}
                >
                    <Icon name="chevronRight" size={14} className="wf-process__chevron" />
                    <span className="wf-process__title">{s.members.prompt}</span>
                    <span className="wf-process__summary">{s.members.promptHint}</span>
                </button>
                {showPrompt && (
                    <div className="overview-card member-prompt">
                        <Markdown text={member.prompt || '—'} />
                    </div>
                )}
            </section>
            <MemorySection member={member} />
            <RoutinesSection member={member} />
            <WorkSection member={member} />
        </div>
    );
}

interface Editing {
    /** The member being changed; a new one when absent. */
    readonly member?: Member;
}

/** Creates a member from a built-in one, or changes a member: name, job, instructions, tier, permissions. */
function MemberEditor({ editing, onClose }: { editing: Editing; onClose: () => void }) {
    const s = useStrings();
    const members = useApp((state) => state.members);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const project = useApp((state) => state.projects.find((item) => item.id === state.selectedProjectId));
    const templates = members.filter((member) => member.source === 'builtin' && member.role !== 'supervisor');
    const existing = editing.member;
    const start = existing ?? templates.find((member) => member.id === 'scout') ?? templates[0];
    const [template, setTemplate] = useState(start?.id ?? '');
    const [name, setName] = useState(existing?.name ?? '');
    const [description, setDescription] = useState(existing ? (descriptionOf(existing, s) ?? '') : '');
    const [prompt, setPrompt] = useState(start?.prompt ?? '');
    const [tier, setTier] = useState(start?.tier ?? 'standard');
    // 06 §21: a model of its own, tried before the tier's chain; '' leaves it to the tier.
    const [model, setModel] = useState(existing?.model ?? '');
    const connected = useApp((state) => state.models);
    const modelChoices = [
        { value: '', label: s.members.modelByTier },
        ...[...new Set(connected.map((option) => option.model.id))].map((id) => ({ value: id, label: id })),
        ...(model && !connected.some((option) => option.model.id === model)
            ? [{ value: model, label: `${model}（${s.members.modelMissing}）` }]
            : []),
    ];
    const [mode, setMode] = useState<PermissionMode>(start?.mode ?? 'ask');
    const [scope, setScope] = useState<'user' | 'project'>(existing?.source === 'project' ? 'project' : 'user');
    const [busy, setBusy] = useState(false);
    const pick = (id: string) => {
        const next = templates.find((member) => member.id === id);
        setTemplate(id);
        if (!next) return;
        setPrompt(next.prompt);
        setTier(next.tier);
        setMode(next.mode);
    };
    const base = existing ?? templates.find((member) => member.id === template);
    const save = async () => {
        if (!base) return;
        setBusy(true);
        const saved = await attempt(() =>
            host.call('member.save', {
                ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
                scope,
                member: {
                    ...(existing ? { id: existing.id } : {}),
                    name: name.trim(),
                    role: base.role,
                    ...(base.category ? { category: base.category } : {}),
                    tier,
                    ...(model ? { model } : {}),
                    mode,
                    ...(description.trim() ? { description: description.trim() } : {}),
                    prompt,
                    ...(base.tools ? { tools: [...base.tools] } : {}),
                },
            }),
        );
        setBusy(false);
        if (saved) {
            await loadMembers(selectedProjectId);
            toast(existing ? s.members.saved : format(s.members.created, { name: saved.name }), 'success');
            onClose();
            openMembers(saved.id);
        }
    };
    return (
        <Modal
            title={existing ? format(s.members.editTitle, { name: existing.name }) : s.members.create}
            onClose={onClose}
        >
            <div className="dialog member-editor">
                {!existing && (
                    <Field label={s.members.template} hint={s.members.templateHint}>
                        <Select
                            label={s.members.template}
                            value={template}
                            options={templates.map((member) => ({
                                value: member.id,
                                label: `${member.name}：${descriptionOf(member, s) ?? ''}`,
                            }))}
                            onChange={pick}
                        />
                    </Field>
                )}
                <Field label={s.members.name}>
                    <input
                        className="input"
                        value={name}
                        placeholder={s.members.namePlaceholder}
                        maxLength={60}
                        onChange={(event) => setName(event.target.value)}
                    />
                </Field>
                <Field label={s.members.job} hint={s.members.jobHint}>
                    <input
                        className="input"
                        value={description}
                        placeholder={s.members.jobPlaceholder}
                        maxLength={500}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </Field>
                <Field label={s.members.prompt} hint={s.members.promptHint}>
                    <textarea
                        className="textarea"
                        rows={7}
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                    />
                </Field>
                <div className="member-editor__row">
                    <Field label={s.members.tier} hint={s.members.tierHint}>
                        <Select
                            label={s.members.tier}
                            value={tier}
                            options={TIERS.map((value) => ({
                                value,
                                label: (s.team.tiers as Record<string, string>)[value] ?? value,
                            }))}
                            onChange={setTier}
                        />
                    </Field>
                    <Field label={s.members.model} hint={s.members.modelHint}>
                        <Select label={s.members.model} value={model} options={modelChoices} onChange={setModel} />
                    </Field>
                    <Field label={s.members.mode}>
                        <Select
                            label={s.members.mode}
                            value={mode}
                            options={MODES.map((value) => ({
                                value,
                                label: s.members.modes[value],
                                hint: s.members.modeHints[value],
                            }))}
                            onChange={setMode}
                        />
                    </Field>
                </div>
                {!existing && project && (
                    <Field label={s.members.scope}>
                        <Select
                            label={s.members.scope}
                            value={scope}
                            options={[
                                { value: 'user', label: s.members.scopeUser },
                                { value: 'project', label: format(s.members.scopeProject, { project: project.name }) },
                            ]}
                            onChange={setScope}
                        />
                    </Field>
                )}
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !name.trim() || !base}
                        onClick={() => void save()}
                    >
                        {busy ? <Spinner /> : null} {s.members.save}
                    </button>
                    <button type="button" className="button" onClick={onClose}>
                        {s.common.cancel}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

/** The members page in the main area (06 §19): every member as a card, or one member in full. */
export function MembersPage() {
    const s = useStrings();
    const members = useApp((state) => state.members);
    const memberId = useApp((state) => state.memberId);
    const [editing, setEditing] = useState<Editing | undefined>();
    const selected = memberId ? members.find((member) => member.id === memberId) : undefined;
    return (
        <div className="members">
            {selected ? (
                <MemberDetail member={selected} onEdit={(member) => setEditing({ member })} />
            ) : (
                <>
                    <header className="members__header">
                        <div>
                            <h1>{s.members.title}</h1>
                            <p className="members__intro">{s.members.intro}</p>
                        </div>
                        <button type="button" className="button button--primary" onClick={() => setEditing({})}>
                            <Icon name="plus" size={14} /> {s.members.create}
                        </button>
                    </header>
                    {members.length === 0 ? (
                        <Empty>
                            <Spinner />
                        </Empty>
                    ) : (
                        <div className="members__grid">
                            {sortMembers(members).map((member) => (
                                <MemberCard key={member.id} member={member} />
                            ))}
                        </div>
                    )}
                </>
            )}
            {editing && <MemberEditor editing={editing} onClose={() => setEditing(undefined)} />}
        </div>
    );
}

/** Hands a member work: a new thread in the chosen project where it works as itself. */
export function DispatchDialog({ memberId }: { memberId: string }) {
    const s = useStrings();
    const member = useApp((state) => state.members.find((item) => item.id === memberId));
    const projects = useApp((state) => state.projects);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [projectId, setProjectId] = useState(selectedProjectId ?? projects[0]?.id ?? '');
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const close = () => useApp.setState({ dispatchTo: undefined });
    const send = async () => {
        if (!text.trim() || !projectId || busy) return;
        setBusy(true);
        const thread = await attempt(() =>
            host.call('member.chat', { projectId, memberId, text: text.trim() }, { timeoutMs: 120_000 }),
        );
        setBusy(false);
        if (thread) {
            useApp.setState((state) => ({ threads: { ...state.threads, [thread.id]: thread }, dispatchTo: undefined }));
            await selectThread(thread.id);
        }
    };
    if (!member) return null;
    return (
        <Modal title={format(s.members.dispatchTitle, { name: member.name })} onClose={close}>
            <div className="dialog">
                <div className="dispatch__who">
                    <MemberAvatar member={member} size={32} />
                    <span>{roleLine(member, s)}</span>
                </div>
                <Field label={s.members.dispatchWhat}>
                    <textarea
                        className="textarea"
                        rows={5}
                        value={text}
                        placeholder={s.members.dispatchPlaceholder}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                    />
                </Field>
                <Field label={s.members.dispatchProject}>
                    <Select
                        label={s.members.dispatchProject}
                        value={projectId}
                        options={projects.map((project) => ({ value: project.id, label: project.name }))}
                        onChange={setProjectId}
                    />
                </Field>
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !text.trim() || !projectId}
                        onClick={() => void send()}
                    >
                        {busy ? <Spinner /> : null} {s.members.dispatchSend}
                    </button>
                    <button type="button" className="button" onClick={close}>
                        {s.common.cancel}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

/** A thread's member, shown next to its title: who works in it, a click away from its page. */
export function MemberChip({ member }: { member: Member }) {
    return (
        <button
            type="button"
            className="member-chip"
            title={member.name}
            onClick={(event) => {
                event.stopPropagation();
                openMembers(member.id);
            }}
        >
            <MemberAvatar member={member} size={16} />
            {member.name}
        </button>
    );
}
