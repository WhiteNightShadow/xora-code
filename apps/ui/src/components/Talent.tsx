import type { Persona } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { host } from '../host.ts';
import { groupPath } from '../members.ts';
import { attempt, loadMembers, openMembers, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';
import { Icon } from './Icon.tsx';
import { type Editing, MemberAvatar, MemberEditor } from './MembersView.tsx';
import { TeamTabs } from './OrgView.tsx';
import { Badge, Spinner } from './primitives.tsx';

/**
 * The talent market (19 §15): every built-in member there is, with its job and its prompt, to search through and
 * hire into an organization. A built-in the user deleted comes back from here too.
 */
export function TalentMarketPage() {
    const s = useStrings();
    const selectedProjectId = useApp((state) => state.selectedProjectId);
    const groups = useApp((state) => state.org?.groups ?? []);
    const [personas, setPersonas] = useState<Persona[] | undefined>();
    // Bumped after a hire or a restore, so the market reads the organization again.
    const [version, setVersion] = useState(0);
    const [query, setQuery] = useState('');
    const [role, setRole] = useState('');
    const [shown, setShown] = useState<string | undefined>();
    const [editing, setEditing] = useState<Editing | undefined>();
    useEffect(() => {
        let live = true;
        void version;
        void attempt(() => host.call('member.catalog', selectedProjectId ? { projectId: selectedProjectId } : {})).then(
            (read) => {
                if (live && read) setPersonas(read.personas);
            },
        );
        return () => {
            live = false;
        };
    }, [selectedProjectId, version]);
    const reload = () => setVersion((current) => current + 1);
    const jobOf = (persona: Persona) =>
        (s.members.builtinJobs as Record<string, string | undefined>)[persona.id] ?? persona.description ?? '';
    const roleOf = (persona: Persona) =>
        (s.members.roles as Record<string, string | undefined>)[persona.role.replace('-', '_')] ?? persona.role;
    const roles = [...new Set((personas ?? []).map((persona) => persona.role))];
    const needle = query.trim().toLowerCase();
    const listed = (personas ?? []).filter(
        (persona) =>
            (!role || persona.role === role) &&
            (!needle ||
                [persona.name, jobOf(persona), persona.prompt, persona.id].some((text) =>
                    text.toLowerCase().includes(needle),
                )),
    );
    const hire = (persona: Persona) =>
        setEditing({
            groupId: persona.groupId ?? groups[0]?.id ?? null,
            template: persona,
            name: persona.state === 'hired' ? `${persona.name}2` : persona.name,
        });
    const restore = (persona: Persona) =>
        void attempt(() => host.call('member.reset', { memberId: persona.id })).then(async (done) => {
            if (!done) return;
            await loadMembers(selectedProjectId);
            reload();
        });
    const standing = (persona: Persona) => {
        if (persona.state === 'hired') {
            return format(s.talent.hired, {
                group: persona.groupId ? groupPath(groups, persona.groupId) : s.org.loose,
            });
        }
        return persona.state === 'removed' ? s.talent.removed : s.talent.available;
    };
    return (
        <div className="members team-page talent-page">
            <TeamTabs active="market" />
            <div className="talent-page__body">
                <p className="muted talent-page__intro">{s.talent.intro}</p>
                <div className="talent-page__filters">
                    <input
                        className="input talent-page__search"
                        type="search"
                        placeholder={s.talent.search}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    <div className="talent-page__roles" role="tablist" aria-label={s.org.position}>
                        {['', ...roles].map((item) => (
                            <button
                                key={item || 'all'}
                                type="button"
                                role="tab"
                                aria-selected={role === item}
                                className={`chip${role === item ? ' is-active' : ''}`}
                                onClick={() => setRole(item)}
                            >
                                {item
                                    ? ((s.members.roles as Record<string, string | undefined>)[
                                          item.replace('-', '_')
                                      ] ?? item)
                                    : s.talent.all}
                            </button>
                        ))}
                    </div>
                    <span className="muted">{format(s.talent.count, { count: listed.length })}</span>
                </div>
                {!personas ? (
                    <Spinner />
                ) : listed.length === 0 ? (
                    <p className="muted">{s.talent.empty}</p>
                ) : (
                    <div className="talent-grid">
                        {listed.map((persona) => (
                            <article key={persona.id} className="talent" data-persona={persona.id}>
                                <header className="talent__head">
                                    <MemberAvatar member={persona} size={36} />
                                    <div className="talent__title">
                                        <strong>{persona.name}</strong>
                                        <span className="muted">
                                            {roleOf(persona)} ·{' '}
                                            {(s.team.tiers as Record<string, string | undefined>)[persona.tier] ??
                                                persona.tier}
                                        </span>
                                    </div>
                                    <Badge
                                        tone={
                                            persona.state === 'hired'
                                                ? 'ok'
                                                : persona.state === 'removed'
                                                  ? 'muted'
                                                  : 'accent'
                                        }
                                    >
                                        {standing(persona)}
                                    </Badge>
                                </header>
                                <p className="talent__job">{jobOf(persona)}</p>
                                <div className="talent__actions">
                                    {persona.state === 'removed' ? (
                                        <button
                                            type="button"
                                            className="button button--small button--primary"
                                            onClick={() => restore(persona)}
                                        >
                                            {s.talent.restore}
                                        </button>
                                    ) : (
                                        <button
                                            type="button"
                                            className={`button button--small${persona.state === 'hired' ? '' : ' button--primary'}`}
                                            onClick={() => hire(persona)}
                                        >
                                            <Icon name="plus" size={13} />{' '}
                                            {persona.state === 'hired' ? s.talent.hireAgain : s.talent.hire}
                                        </button>
                                    )}
                                    {persona.state === 'hired' && (
                                        <button
                                            type="button"
                                            className="button button--small"
                                            onClick={() => openMembers(persona.id)}
                                        >
                                            {s.talent.view}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className="link"
                                        onClick={() => setShown(shown === persona.id ? undefined : persona.id)}
                                    >
                                        {shown === persona.id ? s.talent.hidePrompt : s.talent.showPrompt}
                                    </button>
                                </div>
                                {shown === persona.id && <pre className="talent__prompt">{persona.prompt}</pre>}
                            </article>
                        ))}
                    </div>
                )}
            </div>
            {editing && (
                <MemberEditor
                    editing={editing}
                    onClose={() => {
                        setEditing(undefined);
                        reload();
                    }}
                />
            )}
        </div>
    );
}
