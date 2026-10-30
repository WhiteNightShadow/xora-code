import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    diffPermissions,
    matchHooks,
    PLUGIN_ROOT_PLACEHOLDER,
    type PluginPermissions,
    permissionsGrew,
    permissionsOf,
    readMarketplace,
    readPlugin,
    resolveHookCommand,
} from '../src/index.ts';
import { DATA_VAR, isWindows, ROOT_VAR, temporaryDir, writeTree } from './helpers.ts';

const skill = (name: string): string => `---\nname: ${name}\ndescription: The ${name} skill.\n---\nDo ${name}.\n`;

/** A plugin that uses every default location. */
async function defaultPlugin(root: string): Promise<string> {
    const dir = path.join(root, 'deploy tools');
    await writeTree(dir, {
        '.claude-plugin/plugin.json': JSON.stringify({
            name: 'deploy-tools',
            version: '1.2.0',
            description: 'Deployment helpers',
            author: 'Example Team',
            repository: { type: 'git', url: 'https://example.com/deploy-tools.git' },
            keywords: ['deploy'],
            xora: { scenario: 'ops' },
        }),
        'commands/status.md': `---\ndescription: Show status\n---\nRun ${ROOT_VAR}/bin/status $1\n`,
        'commands/db/migrate.md': 'Migrate the database.\n',
        'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews deploys\ntools: Read, Grep\n---\nReview.\n',
        'skills/rollout/SKILL.md': skill('rollout'),
        'skills/rollout/scripts/rollout.sh': '#!/bin/sh\necho rollout\n',
        'skills/rollout/references/guide.md': '# guide\n',
        'skills/notes/SKILL.md': skill('notes'),
        'hooks/hooks.json': JSON.stringify({
            description: 'checks',
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Bash',
                        hooks: [{ type: 'command', command: `"${ROOT_VAR}"/hooks/check.sh` }],
                    },
                ],
                SessionStart: [{ hooks: [{ type: 'http', url: 'https://hooks.example.com/start' }] }],
            },
        }),
        '.mcp.json': JSON.stringify({
            mcpServers: {
                db: {
                    command: `${ROOT_VAR}/servers/db`,
                    args: ['--config', `${ROOT_VAR}/db.json`],
                    env: { DATA: `${DATA_VAR}/db` },
                },
                remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
            },
        }),
    });
    return dir;
}

describe('readPlugin', () => {
    it('reads the default component locations', async () => {
        const dir = await defaultPlugin(await temporaryDir());
        const plugin = await readPlugin(dir, { trusted: true, dataDir: '/data/deploy-tools' });
        expect(plugin.ok).toBe(true);
        expect(plugin.diagnostics).toEqual([]);
        expect(plugin.manifest).toMatchObject({
            name: 'deploy-tools',
            version: '1.2.0',
            author: { name: 'Example Team' },
            repository: 'https://example.com/deploy-tools.git',
            xora: { scenario: 'ops' },
        });
        const { commands, agents, skills, hooks, mcpServers } = plugin.components;
        expect(commands.map((command) => command.name)).toEqual(['deploy-tools:db:migrate', 'deploy-tools:status']);
        expect(commands[1]?.body).toBe(`Run ${dir}/bin/status $1\n`);
        expect(agents.map((agent) => [agent.name, agent.trusted])).toEqual([['deploy-tools:reviewer', true]]);
        expect(skills.map((item) => [item.id, item.origin, item.pluginRoot])).toEqual([
            ['deploy-tools:notes', 'plugin', dir],
            ['deploy-tools:rollout', 'plugin', dir],
        ]);
        expect(plugin.skillScripts).toEqual(['skills/rollout/scripts/rollout.sh']);
        // Hooks keep their placeholders until they run; MCP configs are filled in.
        expect(hooks).toHaveLength(1);
        expect(hooks[0]?.source).toMatchObject({
            origin: 'plugin',
            trusted: true,
            pluginRoot: dir,
            pluginName: 'deploy-tools',
        });
        expect(mcpServers).toEqual({
            db: {
                command: `${dir}/servers/db`,
                args: ['--config', `${dir}/db.json`],
                env: { DATA: '/data/deploy-tools/db' },
            },
            remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
        });
        const [hook] = matchHooks(hooks, 'PreToolUse', 'Bash');
        expect(hook?.handler).toEqual({ type: 'command', command: `"${ROOT_VAR}"/hooks/check.sh` });
        if (hook?.handler.type === 'command' && !isWindows) {
            expect(resolveHookCommand(hook.handler, { CLAUDE_PLUGIN_ROOT: dir }).args).toEqual([
                '-c',
                `"${dir}"/hooks/check.sh`,
            ]);
        }
    });

    it('follows manifest component paths and rejects paths outside the plugin', async () => {
        const root = await temporaryDir();
        const dir = path.join(root, 'custom');
        await writeTree(root, {
            'outside.md': 'Outside.\n',
            'custom/.claude-plugin/plugin.json': JSON.stringify({
                name: 'custom',
                commands: {
                    hello: { content: 'Say hello to $ARGUMENTS.', description: 'Greets', argumentHint: '[name]' },
                    status: { source: './extra/status.md', allowedTools: ['Bash(git status)'] },
                    both: { source: './extra/status.md', content: 'x' },
                },
                agents: ['./team/lead.md', '../outside.md', './missing.md'],
                skills: ['./more-skills/', 'extra-skill-dir'],
                hooks: ['./config/hooks.json', { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] }],
                mcpServers: [{ inline: { command: 'node', args: [`${ROOT_VAR}/server.js`] } }, './bundle.mcpb'],
            }),
            'custom/commands/ignored.md': 'Replaced by the manifest map.\n',
            'custom/extra/status.md': '---\ndescription: From file\n---\nStatus.\n',
            'custom/team/lead.md':
                '---\nname: lead\ndescription: Leads\nrole: supervisor\ncanDelegate: true\n---\nLead.\n',
            'custom/agents/ignored.md': '---\nname: ignored\ndescription: Replaced\n---\nx\n',
            'custom/skills/base/SKILL.md': skill('base'),
            'custom/more-skills/extra/SKILL.md': skill('extra'),
            'custom/extra-skill-dir/SKILL.md': skill('extra-skill-dir'),
            'custom/config/hooks.json': JSON.stringify({
                hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }] },
            }),
        });
        const plugin = await readPlugin(dir);
        expect(plugin.ok).toBe(true);
        const { commands, agents, skills, hooks, mcpServers } = plugin.components;
        expect(commands.map((command) => [command.name, command.description, command.trusted])).toEqual([
            ['custom:hello', 'Greets', false],
            ['custom:status', 'From file', false],
        ]);
        expect(commands[0]?.argumentHint).toBe('[name]');
        expect(commands[1]?.allowedTools).toEqual(['Bash(git status)']);
        expect(agents.map((agent) => [agent.name, agent.role, agent.canDelegate])).toEqual([
            ['custom:lead', 'supervisor', true],
        ]);
        expect(skills.map((item) => item.id)).toEqual(['custom:base', 'custom:extra', 'custom:extra-skill-dir']);
        expect(hooks.flatMap((config) => config.groups.map((group) => group.event))).toEqual(['PostToolUse', 'Stop']);
        expect(mcpServers).toEqual({ inline: { command: 'node', args: [`${dir}/server.js`] } });
        expect(plugin.diagnostics.map((item) => [item.severity, item.message])).toEqual([
            ['error', 'commands.both: set exactly one of source and content'],
            ['error', 'agents: path must stay inside the plugin: ../outside.md'],
            ['error', 'agents: path not found: ./missing.md'],
            ['warning', 'skills: paths should start with "./": extra-skill-dir'],
            ['warning', 'MCP bundles are not supported: ./bundle.mcpb'],
        ]);
    });

    it('works without a manifest and refuses unusable ones', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'bare/commands/hi.md': 'Hi.\n',
            'single-skill/SKILL.md': skill('single-skill'),
            'broken/.claude-plugin/plugin.json': '{ not json',
            'badname/.claude-plugin/plugin.json': JSON.stringify({ name: 'bad name' }),
            'noname/.claude-plugin/plugin.json': JSON.stringify({ version: '1.0.0' }),
        });
        const bare = await readPlugin(path.join(root, 'bare'));
        expect(bare.ok).toBe(true);
        expect(bare.manifest.name).toBe('bare');
        expect(bare.components.commands.map((command) => command.name)).toEqual(['bare:hi']);
        expect(bare.diagnostics.map((item) => item.severity)).toEqual(['info']);
        const single = await readPlugin(path.join(root, 'single-skill'));
        expect(single.components.skills.map((item) => item.id)).toEqual(['single-skill:single-skill']);
        for (const name of ['broken', 'badname', 'noname']) {
            const plugin = await readPlugin(path.join(root, name));
            expect(plugin.ok).toBe(false);
            expect(plugin.components.commands).toEqual([]);
            expect(plugin.diagnostics.some((item) => item.severity === 'error')).toBe(true);
        }
        await expect(readPlugin(path.join(root, 'missing'))).rejects.toThrow();
    });

    it('uses a marketplace entry as the manifest and loads only the skills it lists', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'skills/xlsx/SKILL.md': skill('xlsx'),
            'skills/docx/SKILL.md': skill('docx'),
            'skills/other/SKILL.md': skill('other'),
        });
        const plugin = await readPlugin(root, {
            entry: { name: 'document-skills', source: './', strict: false, skills: ['./skills/xlsx', './skills/docx'] },
        });
        expect(plugin.manifest.name).toBe('document-skills');
        expect(plugin.components.skills.map((item) => item.id)).toEqual([
            'document-skills:xlsx',
            'document-skills:docx',
        ]);
    });
});

describe('plugin permissions', () => {
    it('summarises commands, urls, domains and scripts with the root as a placeholder', async () => {
        const root = await temporaryDir();
        const dir = await defaultPlugin(root);
        await writeTree(dir, { 'skills/notes/tool': 'binary' });
        if (!isWindows) {
            await chmod(path.join(dir, 'skills/notes/tool'), 0o755);
        }
        const permissions = permissionsOf(await readPlugin(dir));
        expect(permissions).toEqual({
            hookCommands: [`"${PLUGIN_ROOT_PLACEHOLDER}"/hooks/check.sh`],
            hookUrls: ['https://hooks.example.com/start'],
            mcpCommands: [`${PLUGIN_ROOT_PLACEHOLDER}/servers/db --config ${PLUGIN_ROOT_PLACEHOLDER}/db.json`],
            mcpUrls: ['https://mcp.example.com/mcp'],
            domains: ['hooks.example.com', 'mcp.example.com'],
            skillScripts: isWindows
                ? ['skills/rollout/scripts/rollout.sh']
                : ['skills/notes/tool', 'skills/rollout/scripts/rollout.sh'],
        });
    });

    it('detects growth', () => {
        const none: PluginPermissions = {
            hookCommands: [],
            hookUrls: [],
            mcpCommands: [],
            mcpUrls: [],
            domains: [],
            skillScripts: [],
        };
        const more = { ...none, hookCommands: ['a'], domains: ['x.dev'] };
        expect(permissionsGrew(none, more)).toBe(true);
        expect(permissionsGrew(more, none)).toBe(false);
        expect(permissionsGrew(more, more)).toBe(false);
        expect(diffPermissions(none, more)).toEqual(more);
    });
});

describe('readMarketplace', () => {
    it('resolves every supported source type', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            '.claude-plugin/marketplace.json': JSON.stringify({
                name: 'team-tools',
                owner: { name: 'Team', email: 'team@example.com' },
                metadata: { description: 'Our plugins', version: '2.0.0', pluginRoot: './plugins' },
                plugins: [
                    {
                        name: 'local',
                        source: './plugins/local',
                        description: 'Local one',
                        version: '1.0.0',
                        strict: false,
                    },
                    { name: 'bare', source: 'bare', tags: ['x'] },
                    { name: 'gh', source: { source: 'github', repo: 'org/gh-plugin', ref: 'v2' } },
                    {
                        name: 'byurl',
                        source: { source: 'url', url: 'https://git.example.com/a/b.git', sha: 'a'.repeat(40) },
                    },
                    { name: 'bygit', source: { source: 'git', url: 'git@example.com:a/b.git' } },
                    { name: 'mono', source: { source: 'git-subdir', url: 'org/monorepo', path: 'tools/mono' } },
                    { name: 'npm-one', source: { source: 'npm', package: '@org/x' } },
                    { name: 'escape', source: './../elsewhere' },
                    { name: 'bad name', source: './x' },
                    { name: 'local', source: './plugins/again' },
                    { name: 'ext', source: { source: 'url', url: 'ext::sh -c touch% /tmp/pwned' } },
                    'not an object',
                ],
            }),
        });
        const market = await readMarketplace(root);
        expect(market).toMatchObject({
            name: 'team-tools',
            owner: { name: 'Team', email: 'team@example.com' },
            description: 'Our plugins',
            version: '2.0.0',
            root,
            file: path.join(root, '.claude-plugin', 'marketplace.json'),
        });
        expect(market.plugins.map((entry) => [entry.name, entry.source])).toEqual([
            ['local', { kind: 'dir', path: path.join(root, 'plugins', 'local') }],
            ['bare', { kind: 'dir', path: path.join(root, 'plugins', 'bare') }],
            ['gh', { kind: 'git', url: 'https://github.com/org/gh-plugin.git', ref: 'v2' }],
            ['byurl', { kind: 'git', url: 'https://git.example.com/a/b.git', sha: 'a'.repeat(40) }],
            ['bygit', { kind: 'git', url: 'git@example.com:a/b.git' }],
            ['mono', { kind: 'git', url: 'https://github.com/org/monorepo.git', path: 'tools/mono' }],
            ['npm-one', { kind: 'unsupported', type: 'npm' }],
        ]);
        expect(market.plugins[0]).toMatchObject({ description: 'Local one', version: '1.0.0', strict: false });
        expect(market.plugins[1]).toMatchObject({ tags: ['x'], strict: true });
        expect(market.diagnostics.map((item) => [item.severity, item.message])).toEqual([
            ['warning', 'plugins[6].source: npm sources are not supported'],
            ['error', 'plugins[7].source: path must stay inside the marketplace: ./../elsewhere'],
            ['error', 'plugins[8]: invalid plugin name "bad name"'],
            ['error', 'plugins[9]: duplicate plugin name "local"'],
            ['error', 'plugins[10].source: url source needs a git url'],
            ['error', 'plugins[11]: needs a name'],
        ]);
        // The file itself can be given too.
        expect((await readMarketplace(market.file)).root).toBe(root);
    });

    it('rejects files that are not marketplaces', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'a/.claude-plugin/marketplace.json': JSON.stringify({ name: 'x' }),
            'b/.claude-plugin/marketplace.json': '{',
            'c/.claude-plugin/marketplace.json': JSON.stringify({ name: '../evil', plugins: [] }),
            'd/.claude-plugin/marketplace.json': JSON.stringify({ name: 'no-owner', plugins: [] }),
        });
        await expect(readMarketplace(path.join(root, 'a'))).rejects.toThrow(/not a marketplace/);
        await expect(readMarketplace(path.join(root, 'b'))).rejects.toThrow(/cannot read marketplace/);
        await expect(readMarketplace(path.join(root, 'c'))).rejects.toThrow(/invalid marketplace name/);
        await expect(readMarketplace(path.join(root, 'missing'))).rejects.toThrow();
        const noOwner = await readMarketplace(path.join(root, 'd'));
        expect(noOwner.diagnostics.map((item) => item.message)).toEqual(['owner with a name is missing']);
    });
});
