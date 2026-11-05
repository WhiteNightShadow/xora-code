import type { OrgGroup } from '@xora/protocol';
import { type ReactNode, useEffect, useState } from 'react';
import { host } from '../host.ts';
import { attempt, loadMembers, openMembers, openTeamBoard, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { Icon } from './Icon.tsx';
import { type Editing, MemberEditor } from './MembersView.tsx';
import { GroupDialog, GroupPanel, MemberPanel, RootPromptDialog } from './OrgPanels.tsx';
import { OrgTree, type OrgTreeActions } from './OrgTree.tsx';
import { Empty, Modal, Spinner, Toggle } from './primitives.tsx';
import '../org.css';

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
    const memberId = useApp((state) => state.memberId);
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const [editing, setEditing] = useState<Editing | undefined>();
    // The organization dialog: the one being changed, or where a new one goes.
    const [dialog, setDialog] = useState<{ group?: OrgGroup; parentId?: string } | undefined>();
    const [rootPrompt, setRootPrompt] = useState(false);
    const [templating, setTemplating] = useState(false);
    const [showRemoved, setShowRemoved] = useState(false);
    const [panelGroup, setPanelGroup] = useState<string | undefined>();
    useEffect(() => {
        void loadMembers(selectedProjectId);
    }, [selectedProjectId]);
    const restore = (id: string) =>
        void attempt(() => host.call('member.reset', { memberId: id })).then(async (done) => {
            if (done) await loadMembers(selectedProjectId);
        });
    const member = memberId ? members.find((item) => item.id === memberId) : undefined;
    const group = member ? undefined : org?.groups.find((item) => item.id === panelGroup);
    const actions: OrgTreeActions = {
        selectedGroup: group?.id,
        openGroup: (groupId) => {
            useApp.setState({ memberId: undefined });
            setPanelGroup(groupId);
        },
        editGroup: (item) => setDialog({ group: item }),
        newGroup: (parentId) => setDialog(parentId ? { parentId } : {}),
        newMember: (groupId) => setEditing({ groupId }),
        editRootPrompt: () => setRootPrompt(true),
    };
    return (
        <div className="members team-page">
            <TeamTabs
                active="org"
                actions={
                    <>
                        <button type="button" className="button" onClick={() => setTemplating(true)}>
                            <Icon name="sparkle" size={14} /> {s.org.template}
                        </button>
                        <button type="button" className="button" onClick={() => setDialog({})}>
                            <Icon name="plus" size={14} /> {s.org.newGroup}
                        </button>
                        <button type="button" className="button button--primary" onClick={() => setEditing({})}>
                            <Icon name="plus" size={14} /> {s.members.create}
                        </button>
                    </>
                }
            />
            {!org || members.length === 0 ? (
                <Empty>
                    <Spinner />
                </Empty>
            ) : (
                <div className="org-layout">
                    <div className="org-layout__tree">
                        <OrgTree org={org} members={members} actions={actions} />
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
                    {member ? (
                        <MemberPanel
                            key={member.id}
                            member={member}
                            onEdit={(item) => setEditing({ member: item })}
                            onClose={() => useApp.setState({ memberId: undefined })}
                        />
                    ) : (
                        group && (
                            <GroupPanel
                                key={group.id}
                                group={group}
                                onEdit={(item) => setDialog({ group: item })}
                                onClose={() => setPanelGroup(undefined)}
                            />
                        )
                    )}
                </div>
            )}
            {editing && <MemberEditor editing={editing} onClose={() => setEditing(undefined)} />}
            {dialog && (
                <GroupDialog group={dialog.group} parentId={dialog.parentId} onClose={() => setDialog(undefined)} />
            )}
            {rootPrompt && <RootPromptDialog onClose={() => setRootPrompt(false)} />}
            {templating && <TemplateDialog onClose={() => setTemplating(false)} />}
        </div>
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
