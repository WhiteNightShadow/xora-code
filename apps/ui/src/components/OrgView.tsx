import type { Member, OrgGroup, TeamRun } from '@xora/protocol';
import { type ReactNode, useEffect, useState } from 'react';
import { host } from '../host.ts';
import { memberJob, sortMembers } from '../members.ts';
import {
    attempt,
    loadMembers,
    openMembers,
    openRun,
    openSettings,
    openTeamBoard,
    toast,
    useApp,
    useStrings,
} from '../store.ts';
import { format } from '../strings.ts';
import { Popover } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { AssistantDialog, type Editing, MemberAvatar, MemberEditor, roleLine } from './MembersView.tsx';
import { Badge, Empty, Field, IconButton, Modal, Select, Spinner, Toggle } from './primitives.tsx';
import '../org.css';

const TEAM_ENDED = ['done', 'failed', 'cancelled'];

/**
 * The team's one entry (06 §24): the organization chart and the team's work are two tabs of the same page, the
 * way a company's teams and what they do belong together.
 */
export function TeamTabs({ active, actions }: { active: 'org' | 'runs'; actions?: ReactNode }) {
    const s = useStrings();
    return (
        <header className="team-page__header">
            <div className="team-page__title">
                <h1>{s.sidebar.teams}</h1>
                <div className="team-page__tabs" role="tablist" aria-label={s.sidebar.teams}>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={active === 'org'}
                        className={active === 'org' ? 'is-active' : ''}
                        onClick={() => openMembers()}
                    >
                        <Icon name="user" size={13} /> {s.org.chart}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={active === 'runs'}
                        className={active === 'runs' ? 'is-active' : ''}
                        onClick={() => openTeamBoard()}
                    >
                        <Icon name="users" size={13} /> {s.org.runs}
                    </button>
                </div>
            </div>
            {actions && <div className="row">{actions}</div>}
        </header>
    );
}

/** The organization chart: the user on top, then each group with its lead and members, then whoever is in none. */
export function TeamOrgPage() {
    const s = useStrings();
    const members = useApp((state) => state.members);
    const org = useApp((state) => state.org);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const reviewer = useApp((state) => state.settings?.approvals.reviewer ?? 'supervisor');
    const [editing, setEditing] = useState<Editing | undefined>();
    // The group a member made in a conversation joins (06 §26); absent: the dialog is closed.
    const [assisting, setAssisting] = useState<{ groupId?: string } | undefined>();
    const [group, setGroup] = useState<OrgGroup | 'new' | undefined>();
    const [templating, setTemplating] = useState(false);
    const [showRemoved, setShowRemoved] = useState(false);
    useEffect(() => {
        void loadMembers(selectedProjectId);
    }, [selectedProjectId]);
    const byId = new Map(members.map((member) => [member.id, member]));
    const placed = new Set<string>();
    for (const item of org?.groups ?? []) {
        placed.add(item.leaderId);
        for (const id of item.memberIds) placed.add(id);
    }
    const loose = sortMembers(members.filter((member) => !placed.has(member.id)));
    const restore = (memberId: string) =>
        void attempt(() => host.call('member.reset', { memberId })).then(async (done) => {
            if (done) await loadMembers(selectedProjectId);
        });
    return (
        <div className="members team-page">
            <TeamTabs
                active="org"
                actions={
                    <>
                        <button type="button" className="button" onClick={() => setTemplating(true)}>
                            <Icon name="sparkle" size={14} /> {s.org.template}
                        </button>
                        <button type="button" className="button" onClick={() => setGroup('new')}>
                            <Icon name="plus" size={14} /> {s.org.newGroup}
                        </button>
                        <button type="button" className="button" onClick={() => setEditing({})}>
                            <Icon name="plus" size={14} /> {s.members.create}
                        </button>
                        <button type="button" className="button button--primary" onClick={() => setAssisting({})}>
                            <Icon name="message" size={14} /> {s.members.assistant}
                        </button>
                    </>
                }
            />
            {!org || members.length === 0 ? (
                <Empty>
                    <Spinner />
                </Empty>
            ) : (
                <div className="org">
                    <div className="org__boss">
                        <span className="org__boss-mark">
                            <Icon name="sparkle" size={16} />
                        </span>
                        <div className="org__boss-text">
                            <strong>{s.org.you}</strong>
                            <span>{reviewer === 'supervisor' ? s.org.youQuiet : s.org.youAsks}</span>
                        </div>
                        <button type="button" className="link" onClick={() => openSettings('permissions')}>
                            {s.org.approvalSettings}
                        </button>
                    </div>
                    <div className="org__groups">
                        {org.groups.map((item) => (
                            <GroupCard
                                key={item.id}
                                group={item}
                                byId={byId}
                                onEdit={() => setGroup(item)}
                                onAdd={(how) =>
                                    how === 'form'
                                        ? setEditing({ groupId: item.id })
                                        : setAssisting({ groupId: item.id })
                                }
                            />
                        ))}
                        {org.groups.length === 0 && <p className="org__empty">{s.org.noGroups}</p>}
                    </div>
                    {loose.length > 0 && (
                        <section className="org-group org-group--loose">
                            <header className="org-group__head">
                                <div className="org-group__title">
                                    <h2>{s.org.loose}</h2>
                                    <p>{s.org.looseHint}</p>
                                </div>
                            </header>
                            <div className="org__members">
                                {loose.map((member) => (
                                    <OrgMember key={member.id} member={member} />
                                ))}
                            </div>
                        </section>
                    )}
                    {org.removed.length > 0 && (
                        <section className="org__removed">
                            <button
                                type="button"
                                className="project__archived"
                                onClick={() => setShowRemoved(!showRemoved)}
                            >
                                {format(s.org.removed, { count: org.removed.length })}
                            </button>
                            {showRemoved && (
                                <ul>
                                    {org.removed.map((item) => (
                                        <li key={item.id}>
                                            <span>{item.name}</span>
                                            <button type="button" className="link" onClick={() => restore(item.id)}>
                                                {s.org.restore}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    )}
                </div>
            )}
            {editing && <MemberEditor editing={editing} onClose={() => setEditing(undefined)} />}
            {assisting && (
                <AssistantDialog
                    onClose={() => setAssisting(undefined)}
                    {...(assisting.groupId ? { groupId: assisting.groupId } : {})}
                />
            )}
            {group && <GroupEditor group={group === 'new' ? undefined : group} onClose={() => setGroup(undefined)} />}
            {templating && <TemplateDialog onClose={() => setTemplating(false)} />}
        </div>
    );
}

function GroupCard({
    group,
    byId,
    onEdit,
    onAdd,
}: {
    group: OrgGroup;
    byId: Map<string, Member>;
    onEdit: () => void;
    /** A new member for this group: from the form, or in a conversation with the chief. */
    onAdd: (how: 'form' | 'chat') => void;
}) {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const teamRuns = useApp((state) => state.teamRuns);
    const lead = byId.get(group.leaderId);
    const members = sortMembers(group.memberIds.flatMap((id) => byId.get(id) ?? []));
    const active = Object.values(teamRuns).filter(
        (run: TeamRun) => run.group?.id === group.id && !TEAM_ENDED.includes(run.status),
    );
    const remove = () => {
        if (!window.confirm(format(s.org.confirmDeleteGroup, { name: group.name }))) return;
        void attempt(() => host.call('org.deleteGroup', { groupId: group.id })).then(
            (done) => done && void loadMembers(selectedProjectId),
        );
    };
    return (
        <section className="org-group">
            <header className="org-group__head">
                <div className="org-group__title">
                    <h2>
                        {group.name}
                        <span className="org-group__count">{format(s.org.people, { count: members.length + 1 })}</span>
                    </h2>
                    {group.description && <p>{group.description}</p>}
                </div>
                <div className="row">
                    <button
                        type="button"
                        className="button button--small button--primary"
                        disabled={projects.length === 0}
                        onClick={() =>
                            useApp.setState({
                                teamStartFor: selectedProjectId ?? projects[0]?.id,
                                teamStartGroup: group.id,
                            })
                        }
                    >
                        <Icon name="send" size={12} /> {s.org.handTo}
                    </button>
                    <Popover
                        label={s.org.addMember}
                        placement="down"
                        align="end"
                        triggerClassName="button button--small"
                        trigger={
                            <>
                                <Icon name="plus" size={12} /> {s.org.addMember}
                            </>
                        }
                    >
                        {(close) => (
                            <div className="menu-list">
                                <button
                                    type="button"
                                    onClick={() => {
                                        close();
                                        onAdd('chat');
                                    }}
                                >
                                    <Icon name="message" size={13} /> {s.members.assistant}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        close();
                                        onAdd('form');
                                    }}
                                >
                                    <Icon name="pencil" size={13} /> {s.members.create}
                                </button>
                            </div>
                        )}
                    </Popover>
                    <button type="button" className="button button--small" onClick={onEdit}>
                        {s.org.editGroup}
                    </button>
                    <IconButton icon="trash" label={s.org.deleteGroup} size={14} onClick={remove} />
                </div>
            </header>
            <div className="org-group__lead">
                {lead ? <OrgMember member={lead} lead /> : <p className="org__empty">{s.org.noLead}</p>}
            </div>
            <div className="org__members">
                {members.map((member) => (
                    <OrgMember key={member.id} member={member} />
                ))}
                {members.length === 0 && <p className="org__empty">{s.org.noMembers}</p>}
            </div>
            {active.length > 0 && (
                <div className="org-group__runs">
                    {active.map((run) => (
                        <button
                            key={run.id}
                            type="button"
                            className="chief-home__row"
                            onClick={() => openRun('team', run.id)}
                        >
                            <Icon name="users" size={13} />
                            <span className="chief-home__row-title">{run.title ?? run.goal}</span>
                            <span className="chief-home__row-meta">{s.team.statuses[run.status]}</span>
                        </button>
                    ))}
                </div>
            )}
        </section>
    );
}

/** A member on the chart: who it is and what it does; hand it work, move it, or let it go. */
function OrgMember({ member, lead }: { member: Member; lead?: boolean }) {
    const s = useStrings();
    const groups = useApp((state) => state.org?.groups ?? []);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const move = (groupId: string | null) =>
        void attempt(() =>
            host.call('org.moveMember', {
                ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
                memberId: member.id,
                groupId,
            }),
        ).then((org) => org && useApp.setState({ org }));
    const remove = () => {
        const question = member.source === 'builtin' ? s.org.confirmDeleteBuiltin : s.members.confirmDelete;
        if (!window.confirm(format(question, { name: member.name }))) return;
        void attempt(() =>
            host.call('member.delete', {
                ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
                memberId: member.id,
            }),
        ).then((done) => {
            if (!done) return;
            toast(format(s.org.deleted, { name: member.name }), 'success');
            void loadMembers(selectedProjectId);
        });
    };
    return (
        <div className={`org-member${lead ? ' is-lead' : ''}`}>
            <button type="button" className="org-member__main" onClick={() => openMembers(member.id)}>
                <MemberAvatar member={member} size={lead ? 34 : 30} />
                <span className="org-member__text">
                    <span className="org-member__name">
                        {member.name}
                        {lead && <Badge tone="accent">{s.org.lead}</Badge>}
                    </span>
                    <span className="org-member__role">{memberJob(member, s) ?? roleLine(member, s)}</span>
                </span>
            </button>
            <div className="org-member__actions">
                <IconButton
                    icon="send"
                    label={s.members.dispatch}
                    size={13}
                    onClick={() => useApp.setState({ dispatchTo: member.id })}
                />
                <Popover
                    label={s.common.more}
                    placement="down"
                    align="end"
                    triggerClassName="icon-button"
                    trigger={<Icon name="more" size={13} />}
                >
                    {(close) => (
                        <div className="menu-list">
                            {!lead && groups.length > 0 && (
                                <>
                                    <div className="popover__title">{s.org.moveTo}</div>
                                    {groups.map((item) => (
                                        <button
                                            key={item.id}
                                            type="button"
                                            disabled={item.memberIds.includes(member.id)}
                                            onClick={() => {
                                                close();
                                                move(item.id);
                                            }}
                                        >
                                            {item.name}
                                        </button>
                                    ))}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            close();
                                            move(null);
                                        }}
                                    >
                                        {s.org.noGroup}
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                className="is-danger"
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
        </div>
    );
}

/** Creates or changes a group: its name and job, its lead (a supervisor), and who works in it. */
function GroupEditor({ group, onClose }: { group: OrgGroup | undefined; onClose: () => void }) {
    const s = useStrings();
    const members = useApp((state) => state.members);
    const groups = useApp((state) => state.org?.groups ?? []);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const leads = members.filter((member) => member.role === 'supervisor');
    const workers = sortMembers(members.filter((member) => member.role !== 'supervisor'));
    const [name, setName] = useState(group?.name ?? '');
    const [description, setDescription] = useState(group?.description ?? '');
    const [leaderId, setLeaderId] = useState(group?.leaderId ?? leads[0]?.id ?? '');
    const [chosen, setChosen] = useState<Set<string>>(new Set(group?.memberIds ?? []));
    const [busy, setBusy] = useState(false);
    const groupOf = (memberId: string) =>
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
                ...(description.trim() ? { description: description.trim() } : {}),
                leaderId,
                memberIds: [...chosen],
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
                <Field label={s.org.groupJob}>
                    <input
                        className="input"
                        value={description}
                        maxLength={300}
                        placeholder={s.org.groupJobPlaceholder}
                        onChange={(event) => setDescription(event.target.value)}
                    />
                </Field>
                <Field label={s.org.lead} hint={s.org.leadHint}>
                    <Select
                        label={s.org.lead}
                        value={leaderId}
                        options={leads.map((member) => ({ value: member.id, label: member.name }))}
                        onChange={setLeaderId}
                    />
                </Field>
                <Field label={s.org.members} hint={s.org.membersHint}>
                    <div className="group-editor__members">
                        {workers.map((member) => {
                            const elsewhere = groupOf(member.id);
                            return (
                                <label key={member.id} className="group-editor__member">
                                    <input
                                        type="checkbox"
                                        checked={chosen.has(member.id)}
                                        onChange={() => toggle(member.id)}
                                    />
                                    <MemberAvatar member={member} size={22} />
                                    <span className="group-editor__name">{member.name}</span>
                                    {elsewhere && !chosen.has(member.id) && (
                                        <span className="group-editor__elsewhere">{elsewhere.name}</span>
                                    )}
                                </label>
                            );
                        })}
                    </div>
                </Field>
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !name.trim() || !leaderId}
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

/** A regular software team in one step (06 §24), optionally in place of the members and groups there are. */
function TemplateDialog({ onClose }: { onClose: () => void }) {
    const s = useStrings();
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [replace, setReplace] = useState(false);
    const [busy, setBusy] = useState(false);
    const apply = async () => {
        setBusy(true);
        const org = await attempt(() =>
            host.call('org.applyTemplate', { template: 'dev-team', replace }, { timeoutMs: 60_000 }),
        );
        setBusy(false);
        if (org) {
            useApp.setState({ org });
            await loadMembers(selectedProjectId);
            toast(s.org.templateDone, 'success');
            onClose();
        }
    };
    return (
        <Modal title={s.org.templateTitle} onClose={onClose}>
            <div className="dialog">
                <p className="org-template__intro">{s.org.templateIntro}</p>
                <ul className="org-template__list">
                    {s.org.templateMembers.map((line) => (
                        <li key={line}>{line}</li>
                    ))}
                </ul>
                <div className="org-template__replace">
                    <Toggle checked={replace} onChange={setReplace} label={s.org.templateReplace} />
                    <p>{s.org.templateReplaceHint}</p>
                </div>
                <div className="row">
                    <button
                        type="button"
                        className="button button--primary"
                        disabled={busy}
                        onClick={() => void apply()}
                    >
                        {busy ? <Spinner /> : null} {s.org.templateApply}
                    </button>
                    <button type="button" className="button" onClick={onClose}>
                        {s.common.cancel}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
