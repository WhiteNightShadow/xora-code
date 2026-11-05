import type { Member, MemberStats, OrgGroup } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { host } from '../host.ts';
import {
    groupChain,
    groupHeight,
    groupLead,
    groupOfMember,
    groupPath,
    groupSubtree,
    MAX_GROUP_DEPTH,
    memberJob,
    sortMembers,
} from '../members.ts';
import { attempt, loadMembers, openMembers, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { Popover } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { MemberAvatar, MemorySection, RoutinesSection } from './MembersView.tsx';
import {
    Badge,
    Field,
    formatMoney,
    formatTokens,
    IconButton,
    Modal,
    relativeTime,
    Select,
    Spinner,
} from './primitives.tsx';

const PROMPT_LIMIT = 3000;

/** The fields of `member.save` for a member as it is. */
function memberInput(member: Member, prompt: string) {
    return {
        id: member.id,
        name: member.name,
        role: member.role,
        ...(member.category ? { category: member.category } : {}),
        tier: member.tier,
        ...(member.model ? { model: member.model } : {}),
        mode: member.mode,
        ...(member.description ? { description: member.description } : {}),
        prompt,
        ...(member.tools ? { tools: [...member.tools] } : {}),
        ...(member.skills ? { skills: [...member.skills] } : {}),
        ...(member.mcp ? { mcp: [...member.mcp] } : {}),
    };
}

/** What a click on a member shows, and nothing else (19 §11): its name, prompt, projects, score and tokens. */
export function MemberPanel({
    member,
    onEdit,
    onClose,
}: {
    member: Member;
    onEdit: (member: Member) => void;
    onClose: () => void;
}) {
    const s = useStrings();
    const groups = useApp((state) => state.org?.groups ?? []);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [stats, setStats] = useState<MemberStats | undefined>();
    const [draft, setDraft] = useState<string | undefined>();
    const [extra, setExtra] = useState<'memory' | 'routines' | undefined>();
    useEffect(() => {
        let live = true;
        setStats(undefined);
        setDraft(undefined);
        void attempt(() => host.call('member.stats', { memberId: member.id })).then((next) => {
            if (live && next) setStats(next);
        });
        return () => {
            live = false;
        };
    }, [member.id]);
    const group = groupOfMember(groups, member.id);
    const led = groups.filter((item) => item.leaderId === member.id);
    const where = (led.length > 0 ? led : group ? [group] : [])
        .map((item) => groupPath(groups, item.id))
        .join(s.workflow.listSep);
    const job = memberJob(member, s);
    const savePrompt = () =>
        void attempt(async () => {
            await host.call('member.save', {
                ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
                scope: member.source === 'project' ? 'project' : 'user',
                member: memberInput(member, draft ?? ''),
            });
            await loadMembers(selectedProjectId);
            setDraft(undefined);
            toast(s.members.saved, 'success');
        });
    const remove = () => {
        const question = member.source === 'builtin' ? s.org.confirmDeleteBuiltin : s.members.confirmDelete;
        if (!window.confirm(format(question, { name: member.name }))) return;
        void attempt(() =>
            host.call('member.delete', {
                ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
                memberId: member.id,
            }),
        ).then(async (done) => {
            if (!done) return;
            await loadMembers(selectedProjectId);
            onClose();
        });
    };
    const reset = () => {
        if (!window.confirm(format(s.members.confirmReset, { name: member.name }))) return;
        void attempt(() => host.call('member.reset', { memberId: member.id })).then(async (done) => {
            if (done) await loadMembers(selectedProjectId);
        });
    };
    const openDir = () => stats && void attempt(() => host.call('system.open', { kind: 'path', target: stats.dir }));
    return (
        <aside className="org-panel" aria-label={member.name}>
            <header className="org-panel__head">
                <MemberAvatar member={member} size={44} />
                <div className="org-panel__title">
                    <h2>{member.name}</h2>
                    <p>{[where || s.org.loose, job].filter(Boolean).join(' · ')}</p>
                </div>
                <IconButton icon="x" label={s.org.close} onClick={onClose} />
            </header>
            <div className="row org-panel__actions">
                <button
                    type="button"
                    className="button button--small button--primary"
                    onClick={() => useApp.setState({ dispatchTo: member.id })}
                >
                    <Icon name="send" size={12} /> {s.members.dispatch}
                </button>
                <button type="button" className="button button--small" onClick={() => onEdit(member)}>
                    {s.members.edit}
                </button>
                <Popover
                    label={s.common.more}
                    placement="down"
                    align="end"
                    triggerClassName="button button--small"
                    trigger={<Icon name="more" size={14} />}
                >
                    {(close) => (
                        <div className="menu-list">
                            <button
                                type="button"
                                onClick={() => {
                                    close();
                                    setExtra('memory');
                                }}
                            >
                                <Icon name="file" size={13} /> {s.org.memory}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    close();
                                    setExtra('routines');
                                }}
                            >
                                <Icon name="clock" size={13} /> {s.org.routines}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    close();
                                    openDir();
                                }}
                            >
                                <Icon name="folder" size={13} /> {s.org.openDir}
                            </button>
                            {member.customized && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        close();
                                        reset();
                                    }}
                                >
                                    <Icon name="undo" size={13} /> {s.members.reset}
                                </button>
                            )}
                            <button
                                type="button"
                                className="menu-list__danger"
                                onClick={() => {
                                    close();
                                    remove();
                                }}
                            >
                                <Icon name="trash" size={13} /> {s.members.delete}
                            </button>
                        </div>
                    )}
                </Popover>
            </div>
            <section className="org-panel__block" data-block="prompt">
                <div className="org-panel__block-head">
                    <h3>{s.org.prompt}</h3>
                    {draft === undefined && (
                        <button type="button" className="link" onClick={() => setDraft(member.prompt)}>
                            {s.org.promptEdit}
                        </button>
                    )}
                </div>
                {draft === undefined ? (
                    <div className="org-panel__prompt">
                        {member.prompt ? (
                            <Markdown text={member.prompt} />
                        ) : (
                            <p className="muted">{s.org.promptEmpty}</p>
                        )}
                    </div>
                ) : (
                    <>
                        <textarea
                            className="textarea"
                            rows={10}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                        />
                        <div className="row">
                            <button type="button" className="button button--small button--primary" onClick={savePrompt}>
                                {s.common.save}
                            </button>
                            <button type="button" className="button button--small" onClick={() => setDraft(undefined)}>
                                {s.common.cancel}
                            </button>
                        </div>
                    </>
                )}
            </section>
            {!stats ? (
                <Spinner />
            ) : (
                <>
                    <section className="org-panel__block" data-block="projects">
                        <h3>{s.org.projects}</h3>
                        {stats.projects.length === 0 ? (
                            <p className="muted">{s.org.noProjects}</p>
                        ) : (
                            <ul className="org-panel__list">
                                {stats.projects.map((project) => (
                                    <li key={project.projectId}>
                                        <span>{project.name}</span>
                                        <span className="muted">
                                            {format(s.org.projectLine, {
                                                when: relativeTime(project.lastAt),
                                                works: project.works,
                                            })}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                    <section className="org-panel__block" data-block="score">
                        <h3>{s.org.score}</h3>
                        <ScoreBlock score={stats.score} />
                    </section>
                    <section className="org-panel__block" data-block="tokens">
                        <h3>{s.org.tokens}</h3>
                        <TokenLine label={s.org.last30} totals={stats.usage.recent} />
                        <TokenLine label={s.org.allTime} totals={stats.usage.all} />
                        {!stats.usage.all.complete && <Badge tone="warn">{s.usage.incomplete}</Badge>}
                    </section>
                </>
            )}
            {extra && (
                <Modal
                    title={`${member.name} · ${extra === 'memory' ? s.org.memory : s.org.routines}`}
                    onClose={() => setExtra(undefined)}
                    wide
                >
                    {extra === 'memory' ? <MemorySection member={member} /> : <RoutinesSection member={member} />}
                </Modal>
            )}
        </aside>
    );
}

function ScoreBlock({ score }: { score: MemberStats['score'] }) {
    const s = useStrings();
    if (score.count === 0) return <p className="muted">{s.org.noScore}</p>;
    return (
        <>
            {score.average === undefined ? (
                <p className="muted">{format(s.org.scoreFew, { count: score.count })}</p>
            ) : (
                <div className="org-panel__score">
                    <strong>{score.average}</strong>
                    <span>{s.org.scoreOutOf}</span>
                    <span className="muted">{format(s.org.scoreCount, { count: Math.min(score.count, 10) })}</span>
                    {score.trend === 'up' && <Badge tone="ok">{s.org.scoreUp}</Badge>}
                    {score.trend === 'down' && <Badge tone="warn">{s.org.scoreDown}</Badge>}
                </div>
            )}
            <ul className="org-panel__list">
                {score.recent.map((item) => (
                    <li key={`${item.at}:${item.title}`}>
                        <span>
                            <strong>{item.score}</strong> {item.title}
                        </span>
                        <span className="muted">
                            {item.project} · {item.by} · {relativeTime(item.at)}
                        </span>
                        <span className="org-panel__reason">{item.reason}</span>
                    </li>
                ))}
            </ul>
        </>
    );
}

function TokenLine({ label, totals }: { label: string; totals: MemberStats['usage']['all'] }) {
    const s = useStrings();
    // 19 §10: every request sends the history again, so cache hits are nearly all the input of long work. They stay
    // beside the headline, not in it, or it would say next to nothing about what the work took.
    const fresh = Math.max(0, totals.inputTokens - totals.cachedTokens);
    // Nothing priced is a cost not known, not a cost of zero.
    const cost = totals.complete || totals.cost.amount > 0 ? totals.cost : null;
    return (
        <div className="org-panel__tokens">
            <span>{label}</span>
            <strong>{formatTokens(fresh + totals.outputTokens)}</strong>
            <strong className="org-panel__cost">{formatMoney(cost)}</strong>
            <span className="muted">
                {s.org.tokenInput} {formatTokens(fresh)} · {s.org.tokenOutput} {formatTokens(totals.outputTokens)} ·{' '}
                {s.org.tokenCached} {formatTokens(totals.cachedTokens)}
            </span>
        </div>
    );
}

/** An organization's own panel: where it sits, who leads it, its prompt and who is in it. */
export function GroupPanel({
    group,
    onEdit,
    onClose,
}: {
    group: OrgGroup;
    onEdit: (group: OrgGroup) => void;
    onClose: () => void;
}) {
    const s = useStrings();
    const groups = useApp((state) => state.org?.groups ?? []);
    const members = useApp((state) => state.members);
    const [prompt, setPrompt] = useState<string | undefined>();
    useEffect(() => {
        let live = true;
        setPrompt(undefined);
        void attempt(() => host.call('org.readGroup', { groupId: group.id })).then((read) => {
            if (live && read) setPrompt(read.prompt);
        });
        return () => {
            live = false;
        };
    }, [group.id]);
    const nameOf = (id: string | undefined) => members.find((member) => member.id === id)?.name;
    const below = groups.filter((item) => item.parentId === group.id);
    const people = sortMembers(members.filter((member) => group.memberIds.includes(member.id)));
    const lead = nameOf(group.leaderId);
    const acting = nameOf(groupLead(groups, group.id));
    const save = () =>
        void attempt(async () => {
            await host.call('org.saveGroup', { id: group.id, name: group.name, prompt: prompt ?? '' });
            toast(s.members.saved, 'success');
        });
    return (
        <aside className="org-panel" aria-label={group.name}>
            <header className="org-panel__head">
                <div className="org-panel__title">
                    <h2>{group.name}</h2>
                    <p>{groupPath(groups, group.id)}</p>
                </div>
                <IconButton icon="x" label={s.org.close} onClick={onClose} />
            </header>
            <div className="row org-panel__actions">
                <button type="button" className="button button--small" onClick={() => onEdit(group)}>
                    {s.org.editGroup}
                </button>
            </div>
            {group.description && <p className="org-panel__desc">{group.description}</p>}
            <section className="org-panel__block">
                <h3>{s.org.lead}</h3>
                <p>{lead ?? (acting ? format(s.org.inheritedLead, { name: acting }) : s.org.noLead)}</p>
            </section>
            <section className="org-panel__block">
                <h3>{s.org.groupPrompt}</h3>
                <textarea
                    className="textarea"
                    rows={10}
                    maxLength={PROMPT_LIMIT}
                    value={prompt ?? ''}
                    disabled={prompt === undefined}
                    onChange={(event) => setPrompt(event.target.value)}
                />
                <div className="row org-panel__prompt-foot">
                    <button
                        type="button"
                        className="button button--small"
                        disabled={prompt === undefined}
                        onClick={save}
                    >
                        {s.common.save}
                    </button>
                    <span className="muted">{format(s.org.promptChars, { count: prompt?.length ?? 0 })}</span>
                </div>
                <p className="org-panel__hint">{s.org.groupPromptHint}</p>
            </section>
            {below.length > 0 && (
                <section className="org-panel__block">
                    <h3>{s.org.subGroups}</h3>
                    <ul className="org-panel__list">
                        {below.map((item) => (
                            <li key={item.id}>{item.name}</li>
                        ))}
                    </ul>
                </section>
            )}
            <section className="org-panel__block">
                <h3>{s.org.members}</h3>
                {people.length === 0 ? (
                    <p className="muted">{s.org.noMembers}</p>
                ) : (
                    <ul className="org-panel__list">
                        {people.map((member) => (
                            <li key={member.id}>
                                <button type="button" className="link" onClick={() => openMembers(member.id)}>
                                    {member.name}
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </aside>
    );
}

/** Creates or changes an organization in a dialog, right where the user is (19 §11). */
export function GroupDialog({
    group,
    parentId: initialParent,
    onClose,
}: {
    /** Absent: a new one. */
    group: OrgGroup | undefined;
    /** Where a new one goes. */
    parentId: string | undefined;
    onClose: () => void;
}) {
    const s = useStrings();
    const members = useApp((state) => state.members);
    const groups = useApp((state) => state.org?.groups ?? []);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [name, setName] = useState(group?.name ?? '');
    const [description, setDescription] = useState(group?.description ?? '');
    const [parentId, setParentId] = useState(group ? (group.parentId ?? '') : (initialParent ?? ''));
    const [leaderId, setLeaderId] = useState(group?.leaderId ?? '');
    // Unknown until it is read: saving before that must not wipe what is there.
    const [prompt, setPrompt] = useState<string | undefined>(group ? undefined : '');
    const [chosen, setChosen] = useState<Set<string>>(new Set(group?.memberIds ?? []));
    const [picking, setPicking] = useState(false);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!group) return;
        void host
            .call('org.readGroup', { groupId: group.id })
            .then((read) => setPrompt(read.prompt))
            .catch(() => undefined);
    }, [group]);
    // Under anything that keeps the tree a tree: not itself or what is under it, and three levels at most (19 §4).
    const inside = new Set(group ? groupSubtree(groups, group.id).map((item) => item.id) : []);
    const levels = group ? groupHeight(groups, group.id) : 1;
    const parents = groups.filter(
        (item) => !inside.has(item.id) && groupChain(groups, item.id).length + levels <= MAX_GROUP_DEPTH,
    );
    // One lead can take several organizations (19 §4).
    const leads = members.filter((member) => member.role === 'supervisor');
    const workers = sortMembers(members.filter((member) => member.role !== 'supervisor'));
    const elsewhere = (memberId: string) =>
        groups.find((item) => item.id !== group?.id && item.memberIds.includes(memberId));
    const toggle = (memberId: string) =>
        setChosen((current) => {
            const next = new Set(current);
            if (next.has(memberId)) next.delete(memberId);
            else next.add(memberId);
            return next;
        });
    const save = async () => {
        setBusy(true);
        const saved = await attempt(() =>
            host.call('org.saveGroup', {
                ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
                ...(group ? { id: group.id } : {}),
                name: name.trim(),
                description: description.trim(),
                parentId: parentId || null,
                leaderId,
                memberIds: [...chosen],
                ...(prompt !== undefined ? { prompt } : {}),
            }),
        );
        setBusy(false);
        if (saved) {
            await loadMembers(selectedProjectId);
            onClose();
        }
    };
    return (
        <Modal title={group ? format(s.org.editGroupTitle, { name: group.name }) : s.org.newGroup} onClose={onClose}>
            <div className="dialog group-editor">
                <Field label={s.org.groupName}>
                    <input
                        className="input"
                        value={name}
                        maxLength={60}
                        placeholder={s.org.groupNamePlaceholder}
                        onChange={(event) => setName(event.target.value)}
                    />
                </Field>
                <Field label={s.org.parent}>
                    <Select
                        label={s.org.parent}
                        value={parentId}
                        options={[
                            { value: '', label: s.org.parentRoot },
                            ...parents.map((item) => ({ value: item.id, label: groupPath(groups, item.id) })),
                        ]}
                        onChange={setParentId}
                    />
                </Field>
                <Field label={s.org.groupJob}>
                    <input
                        className="input"
                        value={description}
                        maxLength={300}
                        placeholder={s.org.groupJobPlaceholder}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </Field>
                <Field label={s.org.groupPrompt} hint={s.org.groupPromptHint}>
                    <textarea
                        className="textarea"
                        rows={6}
                        maxLength={PROMPT_LIMIT}
                        value={prompt ?? ''}
                        disabled={prompt === undefined}
                        onChange={(event) => setPrompt(event.target.value)}
                    />
                </Field>
                <Field label={s.org.lead} hint={s.org.leadHint}>
                    <Select
                        label={s.org.lead}
                        value={leaderId}
                        options={[
                            { value: '', label: s.org.leadLater },
                            ...leads.map((member) => ({ value: member.id, label: member.name })),
                        ]}
                        onChange={setLeaderId}
                    />
                </Field>
                <button
                    type="button"
                    className="wf-process__toggle"
                    aria-expanded={picking}
                    onClick={() => setPicking(!picking)}
                >
                    <Icon name="chevronRight" size={14} className="wf-process__chevron" />
                    <span className="wf-process__title">{s.org.pickMembers}</span>
                    <span className="wf-process__summary">{chosen.size > 0 ? chosen.size : ''}</span>
                </button>
                {picking && (
                    <Field label={s.org.members} hint={s.org.membersHint}>
                        <div className="group-editor__members">
                            {workers.map((member) => {
                                const other = elsewhere(member.id);
                                return (
                                    <label key={member.id} className="group-editor__member">
                                        <input
                                            type="checkbox"
                                            checked={chosen.has(member.id)}
                                            onChange={() => toggle(member.id)}
                                        />
                                        <MemberAvatar member={member} size={22} />
                                        <span className="group-editor__name">{member.name}</span>
                                        {other && !chosen.has(member.id) && (
                                            <span className="group-editor__elsewhere">{other.name}</span>
                                        )}
                                    </label>
                                );
                            })}
                        </div>
                    </Field>
                )}
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !name.trim() || prompt === undefined}
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

/** The prompt of everyone in the organization (19 §6). */
export function RootPromptDialog({ onClose }: { onClose: () => void }) {
    const s = useStrings();
    const [prompt, setPrompt] = useState<string | undefined>();
    const [dir, setDir] = useState<string | undefined>();
    useEffect(() => {
        void attempt(() => host.call('org.root', {})).then((read) => {
            if (!read) return;
            setPrompt(read.prompt);
            setDir(read.dir);
        });
    }, []);
    const save = () =>
        void attempt(async () => {
            await host.call('org.saveRoot', { prompt: prompt ?? '' });
            toast(s.members.saved, 'success');
            onClose();
        });
    return (
        <Modal title={s.org.rootPrompt} onClose={onClose}>
            <div className="dialog">
                <Field label={s.org.rootPrompt} hint={s.org.rootPromptHint}>
                    <textarea
                        className="textarea"
                        rows={12}
                        maxLength={12_000}
                        value={prompt ?? ''}
                        disabled={prompt === undefined}
                        onChange={(event) => setPrompt(event.target.value)}
                    />
                </Field>
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={prompt === undefined}
                        onClick={save}
                    >
                        {s.common.save}
                    </button>
                    <button type="button" className="button" onClick={onClose}>
                        {s.common.cancel}
                    </button>
                    {dir && (
                        <button
                            type="button"
                            className="link"
                            onClick={() => void attempt(() => host.call('system.open', { kind: 'path', target: dir }))}
                        >
                            {s.org.openDir}
                        </button>
                    )}
                </div>
            </div>
        </Modal>
    );
}
