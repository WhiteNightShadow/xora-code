import type { Member, MemberRoutine, PermissionMode, Persona } from '@xora/protocol';
import { type CSSProperties, useEffect, useState } from 'react';
import { host } from '../host.ts';
import { avatarHue, choiceOf, cronOf, groupPath, initialOf, memberJob, type SchedulePreset } from '../members.ts';
import { attempt, loadMembers, openMarket, openMembers, selectThread, toast, useApp, useStrings } from '../store.ts';
import { format, type Strings } from '../strings.ts';
import { confirmDialog } from './Confirm.tsx';
import { Choices, Popover } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { Field, IconButton, Modal, relativeTime, Select, Spinner, Toggle } from './primitives.tsx';
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
export function roleLine(member: Member, s: Strings): string {
    const role =
        member.role === 'executor' && member.category
            ? ((s.members.categories as Record<string, string>)[member.category] ?? member.category)
            : ((s.members.roles as Record<string, string>)[member.role] ?? member.role);
    const tier = (s.team.tiers as Record<string, string>)[member.tier] ?? member.tier;
    return [role, member.model ?? format(s.members.tierLabel, { tier }), s.members.modes[member.mode]].join(' · ');
}

const descriptionOf = memberJob;

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

/** The user's memory text of a member, with an editor and a way to clear it. */
/**
 * Which part of a member's memory is shown (06 §21, 20 §4.6): `member`, `user` (the user's preferences, which every
 * member and conversation reads), `project:<id>` or `team:<id>`.
 */
type MemoryPart = string;

function partRequest(part: MemoryPart): { scope: 'member' | 'project' | 'team' | 'user'; projectId?: string } {
    const [scope, projectId] = part.split(':', 2) as ['member' | 'project' | 'team', string | undefined];
    if (part === 'user') return { scope: 'user' };
    return projectId ? { scope, projectId } : { scope: 'member' };
}

export function MemorySection({ member }: { member: Member }) {
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
        { value: 'user', label: s.members.memoryUser },
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
                        onClick={async () => {
                            const question =
                                part === 'user'
                                    ? s.members.memoryConfirmClearUser
                                    : format(s.members.memoryConfirmClear, { name: member.name });
                            if (await confirmDialog(question)) {
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
    const remove = async () => {
        if (!(await confirmDialog(format(s.members.routineConfirmDelete, { title: routine.title })))) return;
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

export function RoutinesSection({ member }: { member: Member }) {
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

export interface Editing {
    /** The member being changed; a new one when absent. */
    readonly member?: Member;
    /** The group a new member joins (06 §24); the first one when absent. */
    readonly groupId?: string | null;
    /** A persona from the talent market (19 §15) to make the new member from. */
    readonly template?: Persona;
    /** The name a new member starts with. */
    readonly name?: string;
}

const CUSTOM_TEMPLATE_ID = '__custom__';
const ROLE_TYPES = ['executor', 'scout', 'planner', 'reviewer', 'specialist'] as const;
const PRESET_ORDER = [
    'opc-pm',
    'opc-fullstack',
    'opc-designer',
    'opc-growth',
    'opc-researcher',
    'opc-automation',
    'content-writer',
    'opc-qa',
    'frontend',
    'coder',
    'architect',
    'tester',
    'reviewer',
    'scout',
    'specialist',
];

/** What a position of the editor is made from: a built-in member, a persona of the talent market, or custom blank. */
type Position = Pick<Member, 'id' | 'name' | 'role' | 'category' | 'tier' | 'mode' | 'prompt' | 'tools'> & {
    readonly description?: string;
    readonly personaState?: Persona['state'];
};

/**
 * Direct Agent role selector & creator for chat composers: pick the default chat, any active Agent role in the
 * organization, or create/browse OPC & custom Agent roles without leaving the composer.
 */
export function AgentRolePicker({
    value,
    onChange,
    placement = 'up',
}: {
    value: string;
    onChange: (memberId: string) => void;
    placement?: 'up' | 'down';
}) {
    const s = useStrings();
    const members = useApp((state) => state.members);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [query, setQuery] = useState('');
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        if (useApp.getState().members.length === 0) {
            void loadMembers(selectedProjectId);
        }
    }, [selectedProjectId]);

    const selected = value ? members.find((member) => member.id === value) : undefined;
    const needle = query.trim().toLowerCase();
    const filtered = needle
        ? members.filter(
              (member) =>
                  member.name.toLowerCase().includes(needle) ||
                  (memberJob(member, s) ?? '').toLowerCase().includes(needle) ||
                  member.id.toLowerCase().includes(needle),
          )
        : members;

    return (
        <>
            <Popover
                label={s.chief.pickAgent}
                className="picker"
                triggerClassName={`picker__trigger${selected ? ' is-agent-picked' : ''}`}
                placement={placement}
                trigger={
                    <>
                        <Icon name={selected ? 'user' : 'message'} size={13} />
                        <span className="picker__value">{selected?.name ?? s.chief.defaultAgent}</span>
                        <Icon name="chevronDown" size={12} className="picker__chevron" />
                    </>
                }
            >
                {(close) => (
                    <>
                        <div className="popover__title">{s.chief.pickAgent}</div>
                        {members.length > 6 && (
                            <div className="picker__search-wrap">
                                <input
                                    className="input picker__search"
                                    value={query}
                                    placeholder={s.chief.searchAgents}
                                    onChange={(event) => setQuery(event.target.value)}
                                />
                            </div>
                        )}
                        <div className="popover__scroll">
                            <Choices
                                value={selected ? selected.id : ''}
                                options={[
                                    ...(!needle
                                        ? [
                                              {
                                                  value: '',
                                                  label: s.chief.defaultAgent,
                                                  hint: s.chief.defaultAgentHint,
                                                  icon: 'message' as const,
                                              },
                                          ]
                                        : []),
                                    ...filtered.map((member) => {
                                        const hint = memberJob(member, s);
                                        return {
                                            value: member.id,
                                            label: member.name,
                                            ...(hint ? { hint } : {}),
                                            icon: 'user' as const,
                                        };
                                    }),
                                ]}
                                onPick={(picked) => {
                                    close();
                                    setQuery('');
                                    onChange(picked);
                                }}
                            />
                        </div>
                        <button
                            type="button"
                            className="popover__footer"
                            onClick={() => {
                                close();
                                setCreating(true);
                            }}
                        >
                            <Icon name="plus" size={13} /> {s.chief.createAgent}
                        </button>
                        <button
                            type="button"
                            className="popover__footer"
                            onClick={() => {
                                close();
                                openMarket();
                            }}
                        >
                            <Icon name="sparkle" size={13} /> {s.chief.browseAgents}
                        </button>
                    </>
                )}
            </Popover>
            {creating && (
                <MemberEditor
                    editing={{ groupId: null }}
                    onCreated={(saved) => onChange(saved.id)}
                    onClose={() => setCreating(false)}
                />
            )}
        </>
    );
}

/**
 * Creates a member from an OPC/engineering preset or blank custom role, or changes an existing member (19 §11).
 */
export function MemberEditor({
    editing,
    onClose,
    onCreated,
}: {
    editing: Editing;
    onClose: () => void;
    onCreated?: (member: Member) => void;
}) {
    const s = useStrings();
    const members = useApp((state) => state.members);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const groups = useApp((state) => state.org?.groups ?? []);
    const existing = editing.member;
    const currentGroup = existing
        ? (groups.find((group) => group.memberIds.includes(existing.id))?.id ?? '')
        : editing.groupId === null
          ? ''
          : (editing.groupId ?? groups[0]?.id ?? '');
    const [groupId, setGroupId] = useState(currentGroup);
    // 19 §4: a supervisor leads, so its position is there only for a group that has no lead yet.
    const openLead = groups.find((group) => group.id === groupId)?.leaderId === '';
    const [catalog, setCatalog] = useState<Persona[]>([]);

    useEffect(() => {
        if (existing) return;
        let live = true;
        void host
            .call('member.catalog', selectedProjectId ? { projectId: selectedProjectId } : {})
            .then((read) => {
                if (live) setCatalog([...read.personas]);
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [existing, selectedProjectId]);

    const presetMap = new Map<string, Position>();
    const persona = editing.template;
    if (persona) {
        presetMap.set(persona.id, {
            id: persona.id,
            name: persona.name,
            role: persona.role,
            ...(persona.category ? { category: persona.category } : {}),
            ...(persona.description ? { description: persona.description } : {}),
            tier: persona.tier,
            mode: persona.mode,
            prompt: persona.prompt,
            personaState: persona.state,
        });
    }
    for (const item of catalog) {
        if ((item.role === 'supervisor' && !openLead) || presetMap.has(item.id)) continue;
        presetMap.set(item.id, {
            id: item.id,
            name: item.name,
            role: item.role,
            ...(item.category ? { category: item.category } : {}),
            ...(item.description ? { description: item.description } : {}),
            tier: item.tier,
            mode: item.mode,
            prompt: item.prompt,
            personaState: item.state,
        });
    }
    for (const member of members) {
        if (member.source !== 'builtin' || (member.role === 'supervisor' && !openLead) || presetMap.has(member.id)) {
            continue;
        }
        const job = descriptionOf(member, s);
        presetMap.set(member.id, {
            id: member.id,
            name: member.name,
            role: member.role,
            ...(member.category ? { category: member.category } : {}),
            ...(job ? { description: job } : {}),
            tier: member.tier,
            mode: member.mode,
            prompt: member.prompt,
            ...(member.tools ? { tools: member.tools } : {}),
        });
    }

    const orderedPresets = [...presetMap.values()].sort((a, b) => {
        if (persona) {
            if (a.id === persona.id) return -1;
            if (b.id === persona.id) return 1;
        }
        const ai = PRESET_ORDER.indexOf(a.id);
        const bi = PRESET_ORDER.indexOf(b.id);
        if (ai !== -1 || bi !== -1) {
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        }
        return 0;
    });

    const [customRole, setCustomRole] = useState<string>('executor');
    const customPosition: Position = {
        id: CUSTOM_TEMPLATE_ID,
        name: s.org.customBlank,
        role: customRole,
        tier: 'standard',
        mode: 'ask',
        prompt: '',
    };
    const templates: Position[] = [customPosition, ...orderedPresets];

    // 06 §27: the MCP servers it works with, from the ones configured in settings.
    const [mcp, setMcp] = useState<string[]>([...(existing?.mcp ?? [])]);
    const [servers, setServers] = useState<string[]>([]);
    useEffect(() => {
        void host
            .call('extension.list', selectedProjectId ? { projectId: selectedProjectId } : {})
            .then((snapshot) => setServers(snapshot.mcpServers.map((server) => server.name)))
            .catch(() => undefined);
    }, [selectedProjectId]);
    const toggleMcp = (server: string) =>
        setMcp((current) =>
            current.includes(server) ? current.filter((item) => item !== server) : [...current, server],
        );

    const start: Position =
        existing ?? (persona ? orderedPresets.find((member) => member.id === persona.id) : undefined) ?? customPosition;
    const [template, setTemplate] = useState(start.id);
    const [name, setName] = useState(existing?.name ?? editing.name ?? (persona ? persona.name : ''));
    const [description, setDescription] = useState(
        existing ? (descriptionOf(existing, s) ?? '') : (persona?.description ?? ''),
    );
    const [prompt, setPrompt] = useState(start.prompt);
    const [tier, setTier] = useState(start.tier);
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
    const [mode, setMode] = useState<PermissionMode>(start.mode);
    // 06 §26: a member belongs to the organization and works in every project; one a project defined stays there.
    const scope: 'user' | 'project' = existing?.source === 'project' ? 'project' : 'user';
    const [busy, setBusy] = useState(false);
    const [more, setMore] = useState(false);

    const jobForPreset = (item: Position | undefined): string => {
        if (!item || item.id === CUSTOM_TEMPLATE_ID) return '';
        return (s.members.builtinJobs as Record<string, string | undefined>)[item.id] ?? item.description ?? '';
    };

    const pick = (id: string) => {
        const previous = templates.find((member) => member.id === template);
        const prevName = previous && previous.id !== CUSTOM_TEMPLATE_ID ? previous.name : '';
        const prevJob = jobForPreset(previous);
        const prevPrompt = previous?.prompt ?? '';
        const next = templates.find((member) => member.id === id);
        setTemplate(id);
        if (!next) return;
        if (id === CUSTOM_TEMPLATE_ID) {
            if (name === prevName) setName('');
            if (description === prevJob) setDescription('');
            if (prompt === prevPrompt) setPrompt('');
            return;
        }
        if (!name.trim() || name === prevName) {
            setName(next.personaState === 'hired' ? `${next.name}2` : next.name);
        }
        const nextJob = jobForPreset(next);
        if (!description.trim() || description === prevJob) {
            setDescription(nextJob);
        }
        setPrompt(next.prompt);
        setTier(next.tier);
        setMode(next.mode);
    };

    const base: Position = existing ?? templates.find((member) => member.id === template) ?? customPosition;
    const isCustom = !existing && base.id === CUSTOM_TEMPLATE_ID;
    const effectiveRole = isCustom ? customRole : base.role;
    const leads = effectiveRole === 'supervisor';
    const adoptPersonaId =
        !existing &&
        !isCustom &&
        base.personaState !== undefined &&
        base.personaState !== 'hired' &&
        !members.some((member) => member.id === base.id);

    const save = async () => {
        setBusy(true);
        const saved = await attempt(() =>
            host.call('member.save', {
                ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
                scope,
                member: {
                    ...(existing ? { id: existing.id } : {}),
                    ...(adoptPersonaId ? { id: base.id } : {}),
                    name: name.trim(),
                    role: effectiveRole,
                    ...(!isCustom && base.category ? { category: base.category } : {}),
                    tier,
                    ...(model ? { model } : {}),
                    mode,
                    ...(description.trim() ? { description: description.trim() } : {}),
                    prompt,
                    ...(!isCustom && base.tools ? { tools: [...base.tools] } : {}),
                    // The form does not edit skills: a member keeps the ones it has (06 §21).
                    ...(existing?.skills ? { skills: [...existing.skills] } : {}),
                    ...(mcp.length > 0 ? { mcp } : {}),
                },
                ...(adoptPersonaId ? { allowNewId: true } : {}),
                // A new lead takes the group it is made in; the leads there are change in the group's dialog.
                ...(leads
                    ? !existing && groupId
                        ? { groupId }
                        : {}
                    : !existing || groupId !== currentGroup
                      ? { groupId: groupId || null }
                      : {}),
            }),
        );
        setBusy(false);
        if (saved) {
            await loadMembers(selectedProjectId);
            toast(existing ? s.members.saved : format(s.members.created, { name: saved.name }), 'success');
            if (onCreated) {
                onCreated(saved);
                onClose();
            } else {
                onClose();
                openMembers(saved.id);
            }
        }
    };

    const roleChoices = [...ROLE_TYPES, ...(openLead ? (['supervisor'] as const) : [])];
    const quickChips = templates.slice(0, 11);

    return (
        <Modal
            title={existing ? format(s.members.editTitle, { name: existing.name }) : s.members.create}
            onClose={onClose}
        >
            <div className="dialog member-editor">
                {!existing && (
                    <Field label={s.org.position} hint={s.org.positionHint}>
                        <div className="role-preset-list">
                            {quickChips.map((item) => (
                                <button
                                    key={item.id}
                                    type="button"
                                    className={`role-preset-chip${base.id === item.id ? ' is-active' : ''}`}
                                    onClick={() => pick(item.id)}
                                >
                                    {item.id === CUSTOM_TEMPLATE_ID ? `+ ${item.name}` : item.name}
                                </button>
                            ))}
                        </div>
                        {templates.length > quickChips.length && (
                            <Select
                                label={s.org.position}
                                value={base.id}
                                options={templates.map((member) => ({
                                    value: member.id,
                                    label: member.name,
                                    ...(jobForPreset(member) ? { hint: jobForPreset(member) } : {}),
                                }))}
                                onChange={pick}
                            />
                        )}
                    </Field>
                )}
                <div className="member-editor__row">
                    <Field label={s.members.name}>
                        <input
                            className="input"
                            value={name}
                            placeholder={s.members.namePlaceholder}
                            maxLength={60}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </Field>
                    {isCustom && (
                        <Field
                            label={s.org.customRoleType}
                            hint={(s.org.roleTypeHints as Record<string, string | undefined>)[customRole]}
                        >
                            <Select
                                label={s.org.customRoleType}
                                value={customRole}
                                options={roleChoices.map((role) => ({
                                    value: role,
                                    label: (s.members.roles as Record<string, string | undefined>)[role] ?? role,
                                    hint: (s.org.roleTypeHints as Record<string, string | undefined>)[role],
                                }))}
                                onChange={setCustomRole}
                            />
                        </Field>
                    )}
                </div>
                <Field label={s.members.job} hint={s.members.jobHint}>
                    <input
                        className="input"
                        value={description}
                        placeholder={s.members.jobPlaceholder}
                        maxLength={500}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </Field>
                {!(existing && leads) && groups.length > 0 && (
                    <Field label={s.org.group} hint={s.org.groupHint}>
                        <Select
                            label={s.org.group}
                            value={groupId}
                            options={[
                                ...groups.map((group) => ({ value: group.id, label: groupPath(groups, group.id) })),
                                { value: '', label: s.org.noGroup },
                            ]}
                            onChange={setGroupId}
                        />
                    </Field>
                )}
                <Field label={s.members.prompt} hint={s.members.promptHint}>
                    <textarea
                        className="textarea"
                        rows={6}
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                    />
                </Field>
                <button
                    type="button"
                    className="wf-process__toggle"
                    aria-expanded={more}
                    onClick={() => setMore(!more)}
                >
                    <Icon name="chevronRight" size={14} className="wf-process__chevron" />
                    <span className="wf-process__title">{s.org.moreSettings}</span>
                </button>
                {more && (
                    <>
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
                                <Select
                                    label={s.members.model}
                                    value={model}
                                    options={modelChoices}
                                    onChange={setModel}
                                />
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
                        {[...new Set([...servers, ...mcp])].length > 0 && (
                            <Field label={s.members.mcp} hint={s.members.mcpHint}>
                                <div className="member-editor__mcp">
                                    {[...new Set([...servers, ...mcp])].map((server) => (
                                        <label key={server} className="group-editor__member">
                                            <input
                                                type="checkbox"
                                                checked={mcp.includes(server)}
                                                onChange={() => toggleMcp(server)}
                                            />
                                            <span className="group-editor__name">
                                                {server}
                                                {!servers.includes(server) ? `（${s.members.mcpMissing}）` : ''}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </Field>
                        )}
                    </>
                )}
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !name.trim()}
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

/** Hands a member work: a new thread in the chosen project (or standalone workspace) where it works as itself. */
export function DispatchDialog({ memberId }: { memberId: string }) {
    const s = useStrings();
    const member = useApp((state) => state.members.find((item) => item.id === memberId));
    const projects = useApp((state) => state.projects);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [projectId, setProjectId] = useState(selectedProjectId ?? '');
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    // 06 §22: what it works with on this job, set here; left as it is, the member's own.
    const connected = useApp((state) => state.models);
    const [model, setModel] = useState('');
    const [effort, setEffort] = useState('');
    const [mode, setMode] = useState('');
    const close = () => useApp.setState({ dispatchTo: undefined });
    const send = async () => {
        if (!text.trim() || busy) return;
        setBusy(true);
        const thread = await attempt(() =>
            host.call(
                'member.chat',
                {
                    ...(projectId ? { projectId } : {}),
                    memberId,
                    text: text.trim(),
                    ...(model ? { model } : {}),
                    ...(effort ? { effort: effort as 'off' | 'low' | 'medium' | 'high' | 'max' } : {}),
                    ...(mode ? { mode: mode as PermissionMode } : {}),
                },
                { timeoutMs: 120_000 },
            ),
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
                        options={[
                            { value: '', label: s.members.noProjectChat },
                            ...projects.map((project) => ({ value: project.id, label: project.name })),
                        ]}
                        onChange={setProjectId}
                    />
                </Field>
                <div className="member-editor__row">
                    <Field label={s.members.model}>
                        <Select
                            label={s.members.model}
                            value={model}
                            options={[
                                { value: '', label: member.model ?? s.members.modelByTier },
                                ...[...new Set(connected.map((option) => option.model.id))].map((id) => ({
                                    value: id,
                                    label: id,
                                })),
                            ]}
                            onChange={setModel}
                        />
                    </Field>
                    <Field label={s.team.staffEffort}>
                        <Select
                            label={s.team.staffEffort}
                            value={effort}
                            options={[
                                { value: '', label: s.team.byMember },
                                ...(['off', 'low', 'medium', 'high', 'max'] as const).map((value) => ({
                                    value,
                                    label: s.efforts[value],
                                })),
                            ]}
                            onChange={setEffort}
                        />
                    </Field>
                    <Field label={s.members.mode}>
                        <Select
                            label={s.members.mode}
                            value={mode}
                            options={[
                                { value: '', label: s.members.modes[member.mode] },
                                ...MODES.map((value) => ({ value, label: s.members.modes[value] })),
                            ]}
                            onChange={setMode}
                        />
                    </Field>
                </div>
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !text.trim()}
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
