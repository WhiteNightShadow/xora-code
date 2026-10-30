import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    domPortTransport,
    type HostMethods,
    type HostNotifications,
    methods,
    notifications,
    RpcPeer,
} from '@xora/protocol';
import { XoraDatabase } from '@xora/storage';
import { openaiText, openaiToolCalls, startMockModelServer } from '@xora/test-kit';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Bus } from '../src/bus.ts';
import { HostCore } from '../src/core.ts';
import { ExtensionService } from '../src/extensions.ts';
import type { Logger } from '../src/log.ts';
import { ProjectService } from '../src/projects.ts';
import { MemoryShell } from '../src/shell.ts';

/** Extensions (09): discovery, trust, the skill tool, slash commands, hooks, MCP servers and plugins. */

const here = path.dirname(fileURLToPath(import.meta.url));
const quiet: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const isWindows = process.platform === 'win32';

function temp(prefix: string): string {
    return mkdtempSync(path.join(tmpdir(), prefix));
}

function write(file: string, text: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
}

function skill(dir: string, name: string, description: string, body: string): void {
    write(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

/** A minimal stdio MCP server with one `echo` tool, written as a script for `node`. */
function echoServer(dir: string): string {
    const script = path.join(dir, 'echo-server.cjs');
    write(
        script,
        `const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
rl.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
    } else if (message.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
    } else if (message.method === 'tools/call') {
        const secret = process.env.ECHO_SECRET ? ' (secret ' + process.env.ECHO_SECRET + ')' : '';
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo: ' + message.params.arguments.text + secret }] } });
    } else if (message.id !== undefined) {
        send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
});
`,
    );
    return script;
}

interface Unit {
    readonly service: ExtensionService;
    readonly projects: ProjectService;
    readonly shell: MemoryShell;
    readonly dir: string;
    readonly home: string;
    readonly repo: string;
    readonly projectId: string;
}

async function unit(): Promise<Unit> {
    const data = temp('xora-ext-data-');
    const home = temp('xora-ext-home-');
    const repo = temp('xora-ext-repo-');
    const db = new XoraDatabase(path.join(data, 'xora.db'));
    db.migrate();
    const bus = new Bus();
    const projects = new ProjectService(db, bus);
    const shell = new MemoryShell({ dataDir: data });
    const dir = path.join(data, 'extensions');
    const service = new ExtensionService({ dir, projects, shell, bus, log: quiet, home });
    const project = await projects.add(repo);
    return { service, projects, shell, dir, home, repo, projectId: project.id };
}

describe('extension discovery and trust', () => {
    it('finds user and project skills, gates project scripts on trust and honours switches', async () => {
        const u = await unit();
        skill(path.join(u.dir, 'skills'), 'release-notes', 'Write release notes', 'Use the changelog.');
        skill(path.join(u.repo, '.xora', 'skills'), 'repo-style', 'House style for this repo', 'Use tabs.');
        write(path.join(u.repo, '.xora', 'skills', 'repo-style', 'examples', 'one.md'), 'example one');

        let snapshot = await u.service.snapshot(u.projectId);
        expect(snapshot.projectTrusted).toBe(false);
        const byName = Object.fromEntries(snapshot.skills.map((item) => [item.name, item]));
        expect(byName['release-notes']).toMatchObject({ origin: 'user', trusted: true, enabled: true });
        expect(byName['repo-style']).toMatchObject({ origin: 'project', trusted: false, enabled: true });

        const project = await u.projects.get(u.projectId);
        let extras = await u.service.forSession(project);
        expect(extras.tools.map((tool) => tool.name)).toEqual(['skill']);
        expect(extras.layers[0]?.text).toContain('repo-style');
        expect(extras.layers[0]?.text).toContain('untrusted');

        const loaded = await u.service.handleTool(extras, 'skill', { name: 'repo-style' });
        expect(loaded.content).toContain('Use tabs.');
        expect(loaded.content).toContain('examples/one.md');
        expect(loaded.content).toContain('do not run its scripts');
        const file = await u.service.handleTool(extras, 'skill', { name: 'repo-style', file: 'examples/one.md' });
        expect(file.content).toContain('example one');
        const outside = await u.service.handleTool(extras, 'skill', { name: 'repo-style', file: '../../secret' });
        expect(outside.isError).toBe(true);

        await u.service.toggle({ kind: 'skill', name: 'release-notes', enabled: false });
        await u.service.trust(u.projectId, true);
        snapshot = await u.service.snapshot(u.projectId);
        expect(snapshot.projectTrusted).toBe(true);
        expect(snapshot.skills.find((item) => item.name === 'release-notes')?.enabled).toBe(false);
        extras = await u.service.forSession(await u.projects.get(u.projectId));
        expect(extras.skills.map((item) => item.id)).toEqual(['repo-style']);
        expect(extras.layers[0]?.text).not.toContain('untrusted');
    });

    it('expands slash commands from command files and leaves built-ins alone', async () => {
        const u = await unit();
        write(
            path.join(u.repo, '.xora', 'commands', 'greet.md'),
            '---\ndescription: Greets someone\nargument-hint: <name>\n---\nSay hello to $ARGUMENTS politely.\n',
        );
        const extras = await u.service.forSession(await u.projects.get(u.projectId));
        expect(u.service.expandSlash(extras, '/greet Bob')).toBe('Say hello to Bob politely.');
        expect(u.service.expandSlash(extras, '/compact focus on tests')).toBeUndefined();
        expect(u.service.expandSlash(extras, '/unknown thing')).toBeUndefined();
        expect(u.service.expandSlash(extras, 'not a command')).toBeUndefined();
        const snapshot = await u.service.snapshot(u.projectId);
        expect(snapshot.commands).toEqual([
            expect.objectContaining({ name: 'greet', description: 'Greets someone', origin: 'project' }),
        ]);
    });

    it.skipIf(isWindows)('runs project hooks only once the project is trusted', async () => {
        const u = await unit();
        write(
            path.join(u.repo, '.xora', 'hooks.json'),
            JSON.stringify({
                hooks: {
                    PreToolUse: [
                        {
                            matcher: 'Bash',
                            hooks: [
                                {
                                    type: 'command',
                                    command: `node -e "process.stderr.write('no shell here'); process.exit(2)"`,
                                },
                            ],
                        },
                    ],
                },
            }),
        );
        let extras = await u.service.forSession(await u.projects.get(u.projectId));
        expect(extras.hookEvents).toEqual([]);
        const snapshot = await u.service.snapshot(u.projectId);
        expect(snapshot.hooks).toEqual([
            expect.objectContaining({ event: 'PreToolUse', matcher: 'Bash', trusted: false }),
        ]);

        await u.service.trust(u.projectId, true);
        extras = await u.service.forSession(await u.projects.get(u.projectId));
        expect(extras.hookEvents).toEqual(['PreToolUse']);
        const context = { sessionId: 's', cwd: u.repo };
        const blocked = await u.service.runToolHook(
            extras,
            'PreToolUse',
            { tool_name: 'bash', tool_input: { command: 'ls' }, tool_use_id: 'c1' },
            context,
        );
        expect(blocked).toMatchObject({ blocked: true });
        expect(blocked.reason).toContain('no shell here');
        const other = await u.service.runToolHook(
            extras,
            'PreToolUse',
            { tool_name: 'read', tool_input: { path: 'a.txt' }, tool_use_id: 'c2' },
            context,
        );
        expect(other).toEqual({});
    });

    it('keeps MCP secrets out of the state file and fills them in for sessions', async () => {
        const u = await unit();
        await u.service.saveMcp({
            name: 'echo',
            scope: 'global',
            transport: 'stdio',
            command: process.execPath,
            args: [echoServer(u.home)],
            env: { ECHO_SECRET: 'sk-very-secret-value' },
        });
        const state = readFileSync(path.join(u.dir, 'state.json'), 'utf8');
        expect(state).toContain('ECHO_SECRET');
        expect(state).not.toContain('sk-very-secret-value');
        expect([...u.shell.secrets.values()].join()).toContain('sk-very-secret-value');

        const extras = await u.service.forSession(await u.projects.get(u.projectId));
        const servers = u.service.mcpServersFor(extras, {});
        expect(servers).toEqual([
            expect.objectContaining({
                name: 'echo',
                command: process.execPath,
                env: [{ name: 'ECHO_SECRET', value: 'sk-very-secret-value' }],
            }),
        ]);

        const tested = await u.service.testMcp('echo');
        expect(tested).toMatchObject({ ok: true, tools: ['echo'] });
        let snapshot = await u.service.snapshot();
        expect(snapshot.mcpServers).toEqual([expect.objectContaining({ name: 'echo', origin: 'global', tools: 1 })]);

        await u.service.toggle({ kind: 'mcp', name: 'echo', enabled: false });
        expect(u.service.mcpServersFor(await u.service.forSession(await u.projects.get(u.projectId)), {})).toEqual([]);
        await u.service.removeMcp({ name: 'echo', scope: 'global' });
        snapshot = await u.service.snapshot();
        expect(snapshot.mcpServers).toEqual([]);
        expect([...u.shell.secrets.values()].join()).not.toContain('sk-very-secret-value');
    }, 30_000);

    it('reads repository MCP servers but starts them only in trusted projects', async () => {
        const u = await unit();
        write(
            path.join(u.repo, '.mcp.json'),
            JSON.stringify({ mcpServers: { repoecho: { command: process.execPath, args: ['server.js'] } } }),
        );
        let extras = await u.service.forSession(await u.projects.get(u.projectId));
        expect(u.service.mcpServersFor(extras, {})).toEqual([]);
        const snapshot = await u.service.snapshot(u.projectId);
        expect(snapshot.mcpServers).toEqual([
            expect.objectContaining({ name: 'repoecho', origin: 'project', trusted: false }),
        ]);
        await u.service.trust(u.projectId, true);
        extras = await u.service.forSession(await u.projects.get(u.projectId));
        expect(u.service.mcpServersFor(extras, {}).map((server) => server.name)).toEqual(['repoecho']);
    });

    it('installs a plugin disabled, shows its permissions and enables it on confirmation', async () => {
        const u = await unit();
        const plugin = temp('xora-ext-plugin-');
        write(
            path.join(plugin, '.claude-plugin', 'plugin.json'),
            JSON.stringify({ name: 'helper', version: '1.2.0', description: 'Helps' }),
        );
        skill(path.join(plugin, 'skills'), 'tidy', 'Tidy things up', 'Sort imports.');
        write(
            path.join(plugin, 'hooks', 'hooks.json'),
            JSON.stringify({
                hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
            }),
        );
        const installed = await u.service.installPlugin({ kind: 'dir', path: plugin });
        expect(installed).toMatchObject({ name: 'helper', version: '1.2.0', permissionsGrew: false });
        expect(installed.permissions).toEqual(['hook命令：echo done']);

        let snapshot = await u.service.snapshot(u.projectId);
        expect(snapshot.plugins).toEqual([
            expect.objectContaining({
                name: 'helper',
                enabled: false,
                components: expect.objectContaining({ skills: 1 }),
            }),
        ]);
        expect(snapshot.skills.map((item) => item.name)).not.toContain('helper:tidy');

        await u.service.toggle({ kind: 'plugin', name: 'helper', enabled: true });
        snapshot = await u.service.snapshot(u.projectId);
        expect(snapshot.skills.map((item) => item.name)).toContain('helper:tidy');
        const extras = await u.service.forSession(await u.projects.get(u.projectId));
        expect(extras.skills.map((item) => item.id)).toContain('helper:tidy');

        await u.service.uninstallPlugin('helper');
        snapshot = await u.service.snapshot(u.projectId);
        expect(snapshot.plugins).toEqual([]);
    });

    it('lists MCP servers from other tools without their secrets and imports them', async () => {
        const u = await unit();
        write(
            path.join(u.home, '.cursor', 'mcp.json'),
            JSON.stringify({
                mcpServers: {
                    docs: { command: 'npx', args: ['-y', 'docs-mcp'], env: { DOCS_TOKEN: 'tok-123456789abcdef' } },
                },
            }),
        );
        const found = await u.service.discoverMcp();
        expect(found).toEqual([
            expect.objectContaining({
                name: 'docs',
                tool: 'cursor',
                transport: 'stdio',
                secretKeys: ['DOCS_TOKEN'],
            }),
        ]);
        const result = await u.service.importMcp(['docs']);
        expect(result.imported).toEqual(['docs']);
        const snapshot = await u.service.snapshot();
        expect(snapshot.mcpServers).toEqual([expect.objectContaining({ name: 'docs', origin: 'imported' })]);
        expect(readFileSync(path.join(u.dir, 'state.json'), 'utf8')).not.toContain('tok-123456789abcdef');
        expect([...u.shell.secrets.values()].join()).not.toContain('tok-123456789abcdef');
    });
});

// End to end: the real host and engine against a scripted model server --------------------------------------

const engineSource = path.resolve(here, '../../engine/src/main.ts');
const work = temp('xora-ext-e2e-');
const engineEntry = path.join(work, 'engine.cjs');
type Ui = RpcPeer<HostMethods, HostNotifications>;
type MockServer = Awaited<ReturnType<typeof startMockModelServer>>;
let server: MockServer;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
    await build({
        entryPoints: [engineSource],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        outfile: engineEntry,
        logLevel: 'silent',
    });
    server = await startMockModelServer();
}, 60_000);

afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
        await cleanup().catch(() => undefined);
    }
});

afterAll(async () => {
    await server?.close();
});

async function host(): Promise<{ ui: Ui; core: HostCore; home: string }> {
    const dataDir = temp('xora-ext-e2e-data-');
    const home = temp('xora-ext-e2e-home-');
    const core = await HostCore.create({
        dataDir,
        shell: new MemoryShell({ dataDir }),
        bundleVersion: '1.0.0-test',
        shellVersion: '1.0.0-test',
        engineEntry,
        skipShellEnv: true,
        log: quiet,
        home,
    });
    const channel = new MessageChannel();
    const hostSide = core.connectUi(domPortTransport(channel.port1));
    const ui: Ui = new RpcPeer(domPortTransport(channel.port2), { methods, notifications, timeoutMs: 60_000 });
    cleanups.push(async () => {
        ui.dispose();
        hostSide.dispose();
        channel.port1.close();
        channel.port2.close();
        await core.dispose();
    });
    const connection = await ui.request('provider.save', {
        presetId: 'custom-openai',
        name: 'mock',
        apiKey: 'test-key',
        baseUrl: server.url,
    });
    await ui.request('settings.update', {
        patch: { defaultModel: { connectionId: connection.id, model: 'mock-model' } },
    });
    return { ui, core, home };
}

function gitRepo(): string {
    const dir = temp('xora-ext-e2e-repo-');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    return dir;
}

async function finished(ui: Ui, threadId: string, count = 1) {
    const started = Date.now();
    for (;;) {
        const read = await ui.request('thread.read', { threadId });
        if (read.events.filter((event) => event.kind === 'turn.completed').length >= count) {
            return read;
        }
        if (Date.now() - started > 30_000) throw new Error('turn did not finish');
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

type Body = { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };

function lastRole(body: unknown): string | undefined {
    return (body as Body).messages?.at(-1)?.role;
}

function text(content: unknown): string {
    return typeof content === 'string' ? content : JSON.stringify(content);
}

describe('extensions in a thread', () => {
    it.skipIf(isWindows)(
        'expands a command, loads a skill, blocks a shell call by hook and calls an MCP tool',
        async () => {
            const repo = gitRepo();
            const { ui, core, home } = await host();
            const extDir = core.paths.extensionsDir;
            skill(path.join(extDir, 'skills'), 'greeting', 'How to greet', 'Always greet in French.');
            write(path.join(extDir, 'commands', 'hi.md'), 'Greet $ARGUMENTS using the greeting skill.\n');
            write(
                path.join(extDir, 'hooks.json'),
                JSON.stringify({
                    hooks: {
                        PreToolUse: [
                            {
                                matcher: 'Bash',
                                hooks: [
                                    {
                                        type: 'command',
                                        command: `node -e "process.stderr.write('shell is off'); process.exit(2)"`,
                                    },
                                ],
                            },
                        ],
                    },
                }),
            );
            const project = await ui.request('project.add', { path: repo });
            await ui.request('mcp.save', {
                name: 'echo',
                scope: 'global',
                transport: 'stdio',
                command: process.execPath,
                args: [echoServer(home)],
                env: { ECHO_SECRET: 'xyz' },
            });
            const extensions = await ui.request('extension.list', { projectId: project.id });
            expect(extensions.skills.map((item) => item.name)).toEqual(['greeting']);
            expect(extensions.mcpServers.map((item) => item.name)).toEqual(['echo']);

            server.reset();
            let step = 0;
            server.respondWith((request) => {
                if (request.method !== 'POST') return undefined;
                if (lastRole(request.body) !== 'tool') step = 0;
                step++;
                if (step === 1)
                    return openaiToolCalls([{ name: 'skill', arguments: JSON.stringify({ name: 'greeting' }) }]);
                if (step === 2)
                    return openaiToolCalls([{ name: 'bash', arguments: JSON.stringify({ command: 'echo hi' }) }]);
                if (step === 3)
                    return openaiToolCalls([
                        { name: 'mcp__echo__echo', arguments: JSON.stringify({ text: 'bonjour' }) },
                    ]);
                return openaiText('Bonjour Bob!');
            });

            const thread = await ui.request('thread.create', { projectId: project.id, mode: 'full' });
            await ui.request('turn.start', { threadId: thread.id, text: '/hi Bob' });
            const read = await finished(ui, thread.id);

            const first = server.requests.find((request) => request.method === 'POST')?.body as Body;
            const user = first.messages?.find((message) => message.role === 'user');
            expect(text(user?.content)).toContain('Greet Bob using the greeting skill.');
            expect(first.tools?.map((tool) => tool.function.name)).toEqual(
                expect.arrayContaining(['skill', 'mcp__echo__echo']),
            );
            const system = first.messages?.find((message) => message.role === 'system');
            expect(text(system?.content)).toContain('greeting: How to greet');

            const last = server.requests.at(-1)?.body as Body;
            const results = (last.messages ?? [])
                .filter((message) => message.role === 'tool')
                .map((m) => text(m.content));
            expect(results[0]).toContain('Always greet in French.');
            expect(results[1]).toContain('shell is off');
            expect(results[2]).toContain('echo: bonjour (secret xyz)');
            expect(existsSync(path.join(repo, 'hi'))).toBe(false);

            // The timeline shows what the user typed, not the expanded command.
            const started = read.events.find((event) => event.kind === 'turn.started');
            expect(JSON.stringify(started)).toContain('/hi Bob');
        },
        60_000,
    );
});
