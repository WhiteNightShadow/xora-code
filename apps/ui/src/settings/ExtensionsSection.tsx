import type { ExtensionsSnapshot, McpServerInfo } from '@xora/protocol';
import { useEffect, useState } from 'react';
import { Badge, Field, Select, Spinner, Toggle } from '../components/primitives.tsx';
import { host } from '../host.ts';
import { attempt, toast, useApp, useStrings } from '../store.ts';
import { format } from '../strings.ts';

type Discovered = Array<{
    name: string;
    tool: string;
    file: string;
    transport: string;
    target: string;
    secretKeys: string[];
}>;

function lines(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

/** `KEY=value` (or `Name: value`) per line into a record; lines without the separator are ignored. */
function pairs(text: string, separator: '=' | ':'): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of lines(text)) {
        const at = line.indexOf(separator);
        if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return out;
}

function McpForm({ projectId, onSaved }: { projectId: string | undefined; onSaved: () => void }) {
    const s = useStrings();
    const [name, setName] = useState('');
    const [scope, setScope] = useState<'global' | 'project'>('global');
    const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
    const [command, setCommand] = useState('');
    const [args, setArgs] = useState('');
    const [env, setEnv] = useState('');
    const [url, setUrl] = useState('');
    const [headers, setHeaders] = useState('');
    const save = async () => {
        const done = await attempt(() =>
            host.call('mcp.save', {
                name: name.trim(),
                scope,
                ...(scope === 'project' && projectId ? { projectId } : {}),
                transport,
                ...(transport === 'stdio'
                    ? { command: command.trim(), args: lines(args), env: pairs(env, '=') }
                    : { url: url.trim(), headers: pairs(headers, ':') }),
            }),
        );
        if (done) {
            toast(s.settings.saved, 'success');
            setName('');
            setCommand('');
            setArgs('');
            setEnv('');
            setUrl('');
            setHeaders('');
            onSaved();
        }
    };
    return (
        <div className="extension-form">
            <div className="row">
                <Field label={s.settings.name}>
                    <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
                </Field>
                <Field label={s.extensions.scope}>
                    <Select
                        label={s.extensions.scope}
                        value={scope}
                        options={[
                            { value: 'global', label: s.extensions.scopeGlobal },
                            ...(projectId ? [{ value: 'project' as const, label: s.extensions.scopeProject }] : []),
                        ]}
                        onChange={setScope}
                    />
                </Field>
                <Field label={s.extensions.transport}>
                    <Select
                        label={s.extensions.transport}
                        value={transport}
                        options={[
                            { value: 'stdio', label: 'stdio' },
                            { value: 'http', label: 'http' },
                        ]}
                        onChange={setTransport}
                    />
                </Field>
            </div>
            {transport === 'stdio' ? (
                <>
                    <Field label={s.extensions.command}>
                        <input
                            className="input"
                            value={command}
                            placeholder="npx"
                            onChange={(event) => setCommand(event.target.value)}
                        />
                    </Field>
                    <Field label={s.extensions.args}>
                        <textarea
                            className="textarea"
                            rows={3}
                            value={args}
                            onChange={(event) => setArgs(event.target.value)}
                        />
                    </Field>
                    <Field label={s.extensions.env}>
                        <textarea
                            className="textarea"
                            rows={2}
                            value={env}
                            onChange={(event) => setEnv(event.target.value)}
                        />
                    </Field>
                </>
            ) : (
                <>
                    <Field label={s.extensions.url}>
                        <input
                            className="input"
                            value={url}
                            placeholder="https://"
                            onChange={(event) => setUrl(event.target.value)}
                        />
                    </Field>
                    <Field label={s.extensions.headers}>
                        <textarea
                            className="textarea"
                            rows={2}
                            value={headers}
                            onChange={(event) => setHeaders(event.target.value)}
                        />
                    </Field>
                </>
            )}
            <button
                type="button"
                className="button button--small button--primary"
                disabled={!name.trim() || (transport === 'stdio' ? !command.trim() : !url.trim())}
                onClick={() => void save()}
            >
                {s.extensions.save}
            </button>
        </div>
    );
}

function McpImport({ projectId, onDone }: { projectId: string | undefined; onDone: () => void }) {
    const s = useStrings();
    const [found, setFound] = useState<Discovered | undefined>();
    const [picked, setPicked] = useState<string[]>([]);
    useEffect(() => {
        void attempt(() => host.call('mcp.discover', projectId ? { projectId } : {})).then(
            (result) => result && setFound(result),
        );
    }, [projectId]);
    if (!found) return <Spinner />;
    if (found.length === 0) return <p className="muted">{s.extensions.nothingFound}</p>;
    const run = async () => {
        const result = await attempt(() =>
            host.call('mcp.import', { names: picked, ...(projectId ? { projectId } : {}) }),
        );
        if (result) {
            toast(format(s.extensions.imported, { count: result.imported.length }), 'success');
            onDone();
        }
    };
    return (
        <div className="extension-form">
            <p className="muted">{s.extensions.discoverHint}</p>
            <table className="table">
                <tbody>
                    {found.map((server) => (
                        <tr key={`${server.tool}-${server.file}-${server.name}`}>
                            <td>
                                <Toggle
                                    label={server.name}
                                    checked={picked.includes(server.name)}
                                    onChange={(on) =>
                                        setPicked((current) =>
                                            on ? [...current, server.name] : current.filter((n) => n !== server.name),
                                        )
                                    }
                                />
                            </td>
                            <td>
                                <Badge tone="muted">{server.tool}</Badge>
                            </td>
                            <td>
                                <code className="extension-code">{server.target}</code>
                                {server.secretKeys.length > 0 && (
                                    <div className="muted">
                                        {format(s.extensions.needsSecrets, { keys: server.secretKeys.join(', ') })}
                                    </div>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <button
                type="button"
                className="button button--small button--primary"
                disabled={picked.length === 0}
                onClick={() => void run()}
            >
                {s.extensions.import}
            </button>
        </div>
    );
}

function McpRow({
    server,
    projectId,
    reload,
}: {
    server: McpServerInfo;
    projectId: string | undefined;
    reload: () => void;
}) {
    const s = useStrings();
    const [busy, setBusy] = useState(false);
    const scoped = projectId ? { projectId } : {};
    const test = async () => {
        setBusy(true);
        const result = await attempt(() =>
            host.call('mcp.test', { name: server.name, ...scoped }, { timeoutMs: 60_000 }),
        );
        setBusy(false);
        if (result) {
            toast(
                result.ok ? format(s.extensions.testOk, { count: result.tools.length }) : (result.error ?? ''),
                result.ok ? 'success' : 'error',
            );
        }
        reload();
    };
    const authorize = async () => {
        setBusy(true);
        const done = await attempt(() =>
            host.call('mcp.authorize', { name: server.name, ...scoped }, { timeoutMs: 310_000 }),
        );
        setBusy(false);
        if (done) toast(s.extensions.authorized, 'success');
        reload();
    };
    const editable = server.scope === 'global' || server.scope === 'project';
    return (
        <tr>
            <td>
                <strong>{server.name}</strong>
                <div className="muted">
                    {server.transport} · {s.extensions.origins[server.origin]}
                </div>
            </td>
            <td>
                <code className="extension-code">{server.target}</code>
                {!server.trusted && <div className="muted">{s.extensions.notRunning}</div>}
                {server.missingSecrets && (
                    <div className="muted">
                        {format(s.extensions.needsSecrets, { keys: server.missingSecrets.join(', ') })}
                    </div>
                )}
                {server.status === 'failed' && server.error && <div className="error-text">{server.error}</div>}
                {server.tools !== undefined && (
                    <div className="muted">{format(s.extensions.testOk, { count: server.tools })}</div>
                )}
            </td>
            <td>
                <Toggle
                    label={server.name}
                    checked={server.enabled}
                    onChange={(enabled) =>
                        void attempt(() =>
                            host.call('extension.toggle', { kind: 'mcp', name: server.name, enabled, ...scoped }),
                        ).then(reload)
                    }
                />
            </td>
            <td className="row">
                <button type="button" className="button button--small" disabled={busy} onClick={() => void test()}>
                    {busy ? <Spinner /> : null} {s.extensions.test}
                </button>
                {server.transport !== 'stdio' && (
                    <button
                        type="button"
                        className="button button--small"
                        disabled={busy}
                        onClick={() => void authorize()}
                    >
                        {server.needsAuth ? s.extensions.needsAuth : s.extensions.authorize}
                    </button>
                )}
                {editable && (
                    <button
                        type="button"
                        className="button button--small button--danger"
                        onClick={() =>
                            void attempt(() =>
                                host.call('mcp.remove', {
                                    name: server.name,
                                    scope: server.scope === 'project' ? 'project' : 'global',
                                    ...scoped,
                                }),
                            ).then(reload)
                        }
                    >
                        {s.extensions.remove}
                    </button>
                )}
            </td>
        </tr>
    );
}

function PluginInstall({ onInstalled }: { onInstalled: () => void }) {
    const s = useStrings();
    const [kind, setKind] = useState<'dir' | 'git'>('dir');
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const install = async () => {
        setBusy(true);
        const result = await attempt(() =>
            host.call(
                'plugin.install',
                { source: kind === 'dir' ? { kind, path: value.trim() } : { kind, url: value.trim() } },
                { timeoutMs: 180_000 },
            ),
        );
        setBusy(false);
        if (result) {
            toast(
                result.permissionsGrew
                    ? s.extensions.permissionsGrew
                    : format(s.extensions.installed, { name: result.name, version: result.version }),
                'success',
            );
            setValue('');
            onInstalled();
        }
    };
    return (
        <Field label={s.extensions.install} hint={s.extensions.installHint}>
            <div className="row">
                <Select
                    label={s.extensions.install}
                    value={kind}
                    options={[
                        { value: 'dir', label: s.extensions.sourceDir },
                        { value: 'git', label: s.extensions.sourceGit },
                    ]}
                    onChange={setKind}
                    compact
                />
                <input
                    className="input"
                    value={value}
                    placeholder={kind === 'dir' ? '/path/to/plugin' : 'https://github.com/owner/repo.git'}
                    onChange={(event) => setValue(event.target.value)}
                />
                <button
                    type="button"
                    className="button button--small button--primary"
                    disabled={busy || !value.trim()}
                    onClick={() => void install()}
                >
                    {busy ? <Spinner /> : null} {s.extensions.install}
                </button>
            </div>
        </Field>
    );
}

export function ExtensionsSection() {
    const s = useStrings();
    const projectId = useApp((state) => state.selectedProjectId);
    const project = useApp((state) => state.projects.find((item) => item.id === state.selectedProjectId));
    const [snapshot, setSnapshot] = useState<ExtensionsSnapshot | undefined>();
    const [adding, setAdding] = useState(false);
    const [importing, setImporting] = useState(false);
    const reload = () =>
        void attempt(() => host.call('extension.list', projectId ? { projectId } : {})).then(
            (next) => next && setSnapshot(next),
        );
    // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the project changes
    useEffect(() => {
        reload();
        return host.on('extension.changed', reload);
    }, [projectId]);
    if (!snapshot) return <Spinner />;
    const origin = (value: keyof typeof s.extensions.origins) => s.extensions.origins[value];
    const toggle = (kind: 'skill' | 'plugin', name: string, enabled: boolean) =>
        void attempt(() =>
            host.call('extension.toggle', { kind, name, enabled, ...(projectId ? { projectId } : {}) }),
        ).then(reload);
    return (
        <div className="settings-section">
            {projectId ? (
                <Field label={`${s.extensions.project}：${project?.name ?? ''}`} hint={s.extensions.trustHint}>
                    <Toggle
                        label={s.extensions.trust}
                        checked={snapshot.projectTrusted}
                        onChange={(trusted) =>
                            void attempt(() => host.call('project.trust', { projectId, trusted })).then(reload)
                        }
                    />
                </Field>
            ) : (
                <p className="muted">{s.extensions.noProject}</p>
            )}

            <h3>{s.extensions.skills}</h3>
            {snapshot.skills.length === 0 ? (
                <p className="muted">{s.extensions.noSkills}</p>
            ) : (
                <table className="table">
                    <tbody>
                        {snapshot.skills.map((skill) => (
                            <tr key={skill.name}>
                                <td>
                                    <strong>{skill.name}</strong>
                                    <div className="muted">{skill.description}</div>
                                </td>
                                <td>
                                    <Badge tone="muted">{origin(skill.origin)}</Badge>{' '}
                                    {!skill.trusted && <Badge tone="warn">{s.extensions.untrusted}</Badge>}
                                </td>
                                <td>
                                    <Toggle
                                        label={skill.name}
                                        checked={skill.enabled}
                                        onChange={(enabled) => toggle('skill', skill.name, enabled)}
                                    />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            <h3>{s.extensions.commands}</h3>
            {snapshot.commands.length === 0 ? (
                <p className="muted">{s.extensions.noCommands}</p>
            ) : (
                <table className="table">
                    <tbody>
                        {snapshot.commands.map((command) => (
                            <tr key={command.name}>
                                <td>
                                    <code>
                                        /{command.name}
                                        {command.argumentHint ? ` ${command.argumentHint}` : ''}
                                    </code>
                                </td>
                                <td>{command.description ?? ''}</td>
                                <td>
                                    <Badge tone="muted">{origin(command.origin)}</Badge>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            {snapshot.agents.length > 0 && (
                <>
                    <h3>{s.extensions.agents}</h3>
                    <table className="table">
                        <tbody>
                            {snapshot.agents.map((agent) => (
                                <tr key={agent.name}>
                                    <td>
                                        <strong>{agent.name}</strong>
                                        <div className="muted">{agent.description}</div>
                                    </td>
                                    <td>
                                        {[agent.role, agent.tier].filter(Boolean).join(' · ')}{' '}
                                        <Badge tone="muted">{origin(agent.origin)}</Badge>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </>
            )}

            <h3>{s.extensions.hooks}</h3>
            {snapshot.hooks.length === 0 ? (
                <p className="muted">{s.extensions.noHooks}</p>
            ) : (
                <table className="table">
                    <tbody>
                        {snapshot.hooks.map((hook, index) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: the same command may appear twice
                            <tr key={index}>
                                <td>
                                    <strong>{hook.event}</strong>
                                    {hook.matcher && <div className="muted">{hook.matcher}</div>}
                                </td>
                                <td>
                                    <code className="extension-code">{hook.command}</code>
                                    <div className="muted">{hook.source}</div>
                                </td>
                                <td>
                                    <Badge tone="muted">{origin(hook.origin)}</Badge>{' '}
                                    {!hook.trusted && <Badge tone="warn">{s.extensions.notRunning}</Badge>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            <h3>{s.extensions.mcp}</h3>
            {snapshot.mcpServers.length === 0 ? (
                <p className="muted">{s.extensions.noMcp}</p>
            ) : (
                <table className="table">
                    <tbody>
                        {snapshot.mcpServers.map((server) => (
                            <McpRow key={server.name} server={server} projectId={projectId} reload={reload} />
                        ))}
                    </tbody>
                </table>
            )}
            <div className="row">
                <button
                    type="button"
                    className={adding ? 'button button--small is-active' : 'button button--small'}
                    onClick={() => setAdding(!adding)}
                >
                    {s.extensions.add}
                </button>
                <button
                    type="button"
                    className={importing ? 'button button--small is-active' : 'button button--small'}
                    onClick={() => setImporting(!importing)}
                >
                    {s.extensions.discover}
                </button>
            </div>
            {adding && <McpForm projectId={projectId} onSaved={reload} />}
            {importing && (
                <McpImport
                    projectId={projectId}
                    onDone={() => {
                        setImporting(false);
                        reload();
                    }}
                />
            )}

            <h3>{s.extensions.plugins}</h3>
            {snapshot.plugins.length === 0 ? (
                <p className="muted">{s.extensions.noPlugins}</p>
            ) : (
                <table className="table">
                    <tbody>
                        {snapshot.plugins.map((plugin) => (
                            <tr key={plugin.name}>
                                <td>
                                    <strong>
                                        {plugin.name} {plugin.version}
                                    </strong>
                                    {plugin.description && <div className="muted">{plugin.description}</div>}
                                    <div className="muted">
                                        {format(s.extensions.components, {
                                            skills: plugin.components.skills,
                                            commands: plugin.components.commands,
                                            agents: plugin.components.agents,
                                            hooks: plugin.components.hooks,
                                            mcp: plugin.components.mcpServers,
                                        })}
                                    </div>
                                </td>
                                <td>
                                    <div className="muted">{s.extensions.permissions}</div>
                                    {plugin.permissions.length === 0 ? (
                                        <div>{s.extensions.noPermissions}</div>
                                    ) : (
                                        plugin.permissions.map((line) => (
                                            <div key={line}>
                                                <code className="extension-code">{line}</code>
                                            </div>
                                        ))
                                    )}
                                </td>
                                <td>
                                    <Toggle
                                        label={plugin.name}
                                        checked={plugin.enabled}
                                        onChange={(enabled) => {
                                            if (
                                                enabled &&
                                                plugin.permissions.length > 0 &&
                                                !window.confirm(
                                                    format(s.extensions.confirmEnable, {
                                                        name: plugin.name,
                                                        permissions: plugin.permissions.join('\n'),
                                                    }),
                                                )
                                            ) {
                                                return;
                                            }
                                            toggle('plugin', plugin.name, enabled);
                                        }}
                                    />
                                </td>
                                <td>
                                    <button
                                        type="button"
                                        className="button button--small button--danger"
                                        onClick={() =>
                                            void attempt(() =>
                                                host.call('plugin.uninstall', { name: plugin.name }),
                                            ).then(reload)
                                        }
                                    >
                                        {s.extensions.uninstall}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <PluginInstall onInstalled={reload} />

            {snapshot.diagnostics.length > 0 && (
                <>
                    <h3>{s.extensions.diagnostics}</h3>
                    <ul className="diagnostics">
                        {snapshot.diagnostics.map((line) => (
                            <li key={line}>{line}</li>
                        ))}
                    </ul>
                </>
            )}
        </div>
    );
}
