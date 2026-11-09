import type { Member, OrgChart, OrgGroup } from '@xora/protocol';
import { type ReactNode, useState } from 'react';
import { host } from '../host.ts';
import { groupChain, groupLead, groupSubtree, MAX_GROUP_DEPTH, memberJob, sortMembers } from '../members.ts';
import { attempt, loadMembers, openChief, openMembers, openSettings, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { confirmDialog } from './Confirm.tsx';
import { Popover } from './Controls.tsx';
import { Icon } from './Icon.tsx';
import { MemberAvatar } from './MembersView.tsx';
import { IconButton } from './primitives.tsx';

/** Groups the user folded, kept on this computer. */
const FOLDED_KEY = 'xora.org.folded';

function loadFolded(): Set<string> {
    try {
        const saved: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]');
        return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
    } catch {
        return new Set();
    }
}

export interface OrgTreeActions {
    /** The group whose panel is open. */
    readonly selectedGroup: string | undefined;
    openGroup(groupId: string): void;
    editGroup(group: OrgGroup): void;
    newGroup(parentId: string | undefined): void;
    /** A new member for a group; `null`: one that reports straight to the chief. */
    newMember(groupId: string | null): void;
    editRootPrompt(): void;
}

/**
 * The organization as a tree lying on its side (19 §11): the user and the chief on the far left, organizations to
 * the right of them, sub-organizations further right. A member is a row in its organization, so the tree stays as
 * narrow as the organizations are deep.
 */
export function OrgTree({
    org,
    members,
    actions,
}: {
    org: OrgChart;
    members: readonly Member[];
    actions: OrgTreeActions;
}) {
    const s = useStrings();
    const [folded, setFolded] = useState(loadFolded);
    const fold = (groupId: string) => {
        const next = new Set(folded);
        if (next.has(groupId)) next.delete(groupId);
        else next.add(groupId);
        setFolded(next);
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
    };
    const byId = new Map(members.map((member) => [member.id, member]));
    const placed = new Set(org.groups.flatMap((group) => [group.leaderId, ...group.memberIds]));
    const loose = sortMembers(members.filter((member) => !placed.has(member.id)));
    const branch = (group: OrgGroup): ReactNode => {
        const below = org.groups.filter((item) => item.parentId === group.id);
        return (
            <Branch
                key={group.id}
                node={
                    <GroupNode
                        group={group}
                        groups={org.groups}
                        byId={byId}
                        folded={folded.has(group.id)}
                        foldable={below.length > 0}
                        onFold={() => fold(group.id)}
                        actions={actions}
                    />
                }
            >
                {folded.has(group.id) ? [] : below.map(branch)}
            </Branch>
        );
    };
    const top = org.groups.filter((group) => group.parentId === undefined);
    return (
        <div className="otree">
            <Branch node={<RootNode actions={actions} />}>
                {[
                    ...top.map(branch),
                    ...(loose.length > 0
                        ? [
                              <Branch key="loose" node={<LooseNode members={loose} />}>
                                  {[]}
                              </Branch>,
                          ]
                        : []),
                ]}
            </Branch>
            {top.length === 0 && loose.length === 0 && <p className="org__empty">{s.org.noGroups}</p>}
        </div>
    );
}

/** A node with the lines to its children on its right. */
function Branch({ node, children }: { node: ReactNode; children: ReactNode[] }) {
    return (
        <div className="otree__branch">
            {node}
            {children.length > 0 && (
                <div className="otree__children">
                    {children.map((child, index) => (
                        // The children come keyed by their ids: the position only tells the lines apart.
                        // biome-ignore lint/suspicious/noArrayIndexKey: see above
                        <div key={index} className="otree__child">
                            {child}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function RootNode({ actions }: { actions: OrgTreeActions }) {
    const s = useStrings();
    const reviewer = useApp((state) => state.settings?.approvals.reviewer ?? 'supervisor');
    return (
        <section className="onode onode--root">
            <header className="onode__head">
                <span className="onode__mark">
                    <Icon name="sparkle" size={14} />
                </span>
                <strong className="onode__title">{s.org.you}</strong>
                <AddMenu
                    onGroup={() => actions.newGroup(undefined)}
                    onMember={() => actions.newMember(null)}
                    groupLabel={s.org.newGroup}
                />
            </header>
            <p className="onode__note">{reviewer === 'supervisor' ? s.org.youQuiet : s.org.youAsks}</p>
            <div className="onode__links">
                <button type="button" className="link" onClick={() => openChief()}>
                    {s.org.askChief}
                </button>
                <button type="button" className="link" onClick={actions.editRootPrompt}>
                    {s.org.rootPrompt}
                </button>
                <button type="button" className="link" onClick={() => openSettings('permissions')}>
                    {s.org.approvalSettings}
                </button>
            </div>
        </section>
    );
}

function LooseNode({ members }: { members: readonly Member[] }) {
    const s = useStrings();
    return (
        <section className="onode onode--loose">
            <header className="onode__head">
                <strong className="onode__title" title={s.org.looseHint}>
                    {s.org.loose}
                </strong>
            </header>
            <div className="onode__members">
                {members.map((member) => (
                    <MemberRow key={member.id} member={member} />
                ))}
            </div>
        </section>
    );
}

function AddMenu({
    onGroup,
    onMember,
    groupLabel,
}: {
    /** Absent: this level cannot have groups under it. */
    onGroup: (() => void) | undefined;
    onMember: () => void;
    groupLabel: string;
}) {
    const s = useStrings();
    return (
        <Popover
            label={s.org.add}
            placement="down"
            align="end"
            triggerClassName="icon-button"
            trigger={<Icon name="plus" size={14} />}
        >
            {(close) => (
                <div className="menu-list">
                    {onGroup && (
                        <button
                            type="button"
                            onClick={() => {
                                close();
                                onGroup();
                            }}
                        >
                            <Icon name="users" size={13} /> {groupLabel}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={() => {
                            close();
                            onMember();
                        }}
                    >
                        <Icon name="plus" size={13} /> {s.members.create}
                    </button>
                </div>
            )}
        </Popover>
    );
}

function GroupNode({
    group,
    groups,
    byId,
    folded,
    foldable,
    onFold,
    actions,
}: {
    group: OrgGroup;
    groups: readonly OrgGroup[];
    byId: ReadonlyMap<string, Member>;
    folded: boolean;
    foldable: boolean;
    onFold: () => void;
    actions: OrgTreeActions;
}) {
    const s = useStrings();
    const projects = useApp((state) => state.projects);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const lead = byId.get(group.leaderId);
    const acting = lead ? undefined : byId.get(groupLead(groups, group.id) ?? '');
    const members = sortMembers(group.memberIds.flatMap((id) => byId.get(id) ?? []));
    const deep = groupChain(groups, group.id).length >= MAX_GROUP_DEPTH;
    // 19 §8: its work needs a lead, here or above, and someone below who can do it.
    const workers = groupSubtree(groups, group.id)
        .flatMap((item) => item.memberIds)
        .some((id) => byId.get(id) && byId.get(id)?.role !== 'supervisor');
    const blocked = !lead && !acting ? s.org.handToNoLead : workers ? undefined : s.org.handToNoWorkers;
    const hand = () =>
        useApp.setState({ teamStartFor: selectedProjectId ?? projects[0]?.id, teamStartGroup: group.id });
    const openDir = () =>
        void attempt(async () => {
            const { dir } = await host.call('org.readGroup', { groupId: group.id });
            await host.call('system.open', { kind: 'path', target: dir });
        });
    const remove = async () => {
        if (!(await confirmDialog(format(s.org.confirmDeleteGroup, { name: group.name })))) return;
        void attempt(() => host.call('org.deleteGroup', { groupId: group.id })).then((done) => {
            if (!done) return;
            toast(format(s.org.deleted, { name: group.name }), 'success');
            void loadMembers(selectedProjectId);
        });
    };
    return (
        <section className={`onode${actions.selectedGroup === group.id ? ' is-selected' : ''}`} data-group={group.id}>
            <header className="onode__head">
                {foldable && (
                    <button
                        type="button"
                        className={`onode__fold${folded ? ' is-folded' : ''}`}
                        aria-label={group.name}
                        aria-expanded={!folded}
                        onClick={onFold}
                    >
                        <Icon name="chevronRight" size={12} />
                    </button>
                )}
                <button type="button" className="onode__name" onClick={() => actions.openGroup(group.id)}>
                    <strong className="onode__title">{group.name}</strong>
                </button>
                <IconButton
                    icon="send"
                    size={13}
                    label={blocked ?? s.org.handTo}
                    disabled={blocked !== undefined || projects.length === 0}
                    onClick={hand}
                />
                <AddMenu
                    onGroup={deep ? undefined : () => actions.newGroup(group.id)}
                    onMember={() => actions.newMember(group.id)}
                    groupLabel={s.org.newSub}
                />
                <Popover
                    label={s.common.more}
                    placement="down"
                    align="end"
                    triggerClassName="icon-button"
                    trigger={<Icon name="more" size={14} />}
                >
                    {(close) => (
                        <div className="menu-list">
                            <button
                                type="button"
                                onClick={() => {
                                    close();
                                    actions.editGroup(group);
                                }}
                            >
                                <Icon name="pencil" size={13} /> {s.org.editGroup}
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
                            <button
                                type="button"
                                className="menu-list__danger"
                                onClick={() => {
                                    close();
                                    remove();
                                }}
                            >
                                <Icon name="trash" size={13} /> {s.org.deleteGroup}
                            </button>
                        </div>
                    )}
                </Popover>
            </header>
            {group.description && <p className="onode__note">{group.description}</p>}
            <div className="onode__members">
                {lead ? (
                    <MemberRow member={lead} lead />
                ) : (
                    <p className="onode__nolead">
                        {s.org.lead}：{acting ? format(s.org.inheritedLead, { name: acting.name }) : s.org.noLead}
                    </p>
                )}
                {members.map((member) => (
                    <MemberRow key={member.id} member={member} />
                ))}
            </div>
        </section>
    );
}

/** A member in its organization: who it is and what it does; its panel is a click away. */
function MemberRow({ member, lead }: { member: Member; lead?: boolean }) {
    const s = useStrings();
    const selected = useApp((state) => state.memberId === member.id);
    return (
        <button
            type="button"
            className={`omember${lead ? ' is-lead' : ''}${selected ? ' is-selected' : ''}`}
            onClick={() => openMembers(member.id)}
        >
            <MemberAvatar member={member} size={22} />
            <span className="omember__name">{member.name}</span>
            <span className="omember__job">{lead ? s.org.lead : memberJob(member, s)}</span>
            {member.score !== undefined && (
                <span className="omember__score" title={s.org.score}>
                    {member.score}
                </span>
            )}
        </button>
    );
}
