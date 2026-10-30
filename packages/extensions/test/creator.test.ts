import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CreatorError,
    discoverSkills,
    loadAgentFile,
    loadCommandFile,
    planAgent,
    planCommand,
    planPlugin,
    planSkill,
    readPlugin,
    writePlan,
} from '../src/index.ts';
import { ROOT_VAR, source, temporaryDir } from './helpers.ts';

describe('creator templates', () => {
    it('writes a skill that discovery reads back', async () => {
        const root = await temporaryDir();
        const plan = planSkill({
            name: 'release-notes',
            description: 'Write release notes: group changes by type. Use before tagging a release.',
            allowedTools: ['Bash(git log:*)', 'Read'],
            metadata: { author: 'xora', version: '1.0' },
            resources: { 'references/style.md': '# Style\n', 'scripts/collect.sh': 'git log\n' },
        });
        expect(plan.files.map((file) => file.path)).toEqual([
            'release-notes/SKILL.md',
            'release-notes/references/style.md',
            'release-notes/scripts/collect.sh',
        ]);
        expect(await writePlan(root, plan)).toEqual(plan.files.map((file) => path.join(root, ...file.path.split('/'))));
        const { skills, diagnostics } = await discoverSkills([source(root)]);
        expect(diagnostics).toEqual([]);
        expect(skills[0]).toMatchObject({
            name: 'release-notes',
            description: 'Write release notes: group changes by type. Use before tagging a release.',
            allowedTools: ['Bash(git log:*)', 'Read'],
            metadata: { author: 'xora', version: '1.0' },
        });
    });

    it('writes namespaced commands and agents that the loaders read back', async () => {
        const root = await temporaryDir();
        const command = planCommand({
            name: '/frontend:build',
            description: 'Build the frontend',
            argumentHint: '[target]',
            allowedTools: ['Bash(pnpm build:*)'],
            body: 'Build $1.',
        });
        expect(command.files.map((file) => file.path)).toEqual(['frontend/build.md']);
        const [commandFile] = await writePlan(root, command);
        const loaded = await loadCommandFile(commandFile ?? '', source(root), 'frontend:build');
        expect(loaded.command).toMatchObject({
            name: 'frontend:build',
            description: 'Build the frontend',
            argumentHint: '[target]',
            allowedTools: ['Bash(pnpm build:*)'],
            body: 'Build $1.\n',
        });
        expect(planCommand({ name: 'plain', body: 'Just text' }).files[0]?.content).toBe('Just text\n');

        const agent = planAgent({
            name: 'coder',
            description: 'Implements one task card in its worktree',
            prompt: 'You implement exactly one task card.',
            tools: ['Read', 'Edit', 'Bash'],
            tier: 'economy',
            role: 'executor',
            mode: 'auto-edit',
            canDelegate: false,
        });
        const [agentFile] = await writePlan(root, agent);
        const read = await loadAgentFile(agentFile ?? '', source(root));
        expect(read.diagnostics).toEqual([]);
        expect(read.agent).toMatchObject({
            name: 'coder',
            prompt: 'You implement exactly one task card.',
            tools: ['Read', 'Edit', 'Bash'],
            tier: 'economy',
            role: 'executor',
            mode: 'auto-edit',
            canDelegate: false,
        });
    });

    it('writes a plugin skeleton that readPlugin understands', async () => {
        const root = await temporaryDir();
        const plan = planPlugin({
            name: 'team-kit',
            description: 'Team conventions',
            author: { name: 'Team' },
            skills: [{ name: 'conventions', description: 'Team coding conventions.' }],
            commands: [{ name: 'check', body: 'Run the checks.' }],
            agents: [{ name: 'reviewer', description: 'Reviews', prompt: 'Review it.' }],
            hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'pnpm format' }] }] },
            mcpServers: { docs: { command: 'node', args: [`${ROOT_VAR}/docs.js`] } },
            xora: { scenarios: ['review'] },
        });
        await writePlan(root, plan);
        const plugin = await readPlugin(path.join(root, 'team-kit'));
        expect(plugin.diagnostics).toEqual([]);
        expect(plugin.manifest).toMatchObject({ name: 'team-kit', version: '0.1.0', xora: { scenarios: ['review'] } });
        expect(plugin.components.skills.map((skill) => skill.id)).toEqual(['team-kit:conventions']);
        expect(plugin.components.commands.map((command) => command.name)).toEqual(['team-kit:check']);
        expect(plugin.components.agents.map((agent) => agent.name)).toEqual(['team-kit:reviewer']);
        expect(plugin.components.hooks[0]?.groups[0]?.event).toBe('PostToolUse');
        expect(plugin.components.mcpServers.docs?.args).toEqual([`${plugin.root}/docs.js`]);
    });

    it('validates names and input', () => {
        const invalid = (run: () => unknown): void => {
            expect(run).toThrow(CreatorError);
        };
        invalid(() => planSkill({ name: 'Bad Name', description: 'x' }));
        invalid(() => planSkill({ name: 'ok', description: '  ' }));
        invalid(() => planSkill({ name: 'ok', description: 'x'.repeat(1025) }));
        invalid(() => planSkill({ name: 'ok', description: 'x', resources: { '../escape.txt': '' } }));
        invalid(() => planSkill({ name: 'ok', description: 'x', resources: { 'SKILL.md': '' } }));
        invalid(() => planCommand({ name: 'has space', body: 'x' }));
        invalid(() => planCommand({ name: 'ok', body: '' }));
        invalid(() => planAgent({ name: 'a:b', description: 'x', prompt: 'y' }));
        invalid(() => planAgent({ name: 'a/b', description: 'x', prompt: 'y' }));
        invalid(() => planPlugin({ name: 'bad@name' }));
        invalid(() => planPlugin({ name: 'ok', version: '../1' }));
        invalid(() => planPlugin({ name: 'ok', mcpServers: { broken: {} } }));
        invalid(() =>
            planPlugin({
                name: 'ok',
                skills: [
                    { name: 'same', description: 'x' },
                    { name: 'same', description: 'y' },
                ],
            }),
        );
    });

    it('refuses to overwrite existing files and writes nothing then', async () => {
        const root = await temporaryDir();
        const plan = planSkill({ name: 'notes', description: 'Notes.', resources: { 'extra.md': 'extra' } });
        await writePlan(root, plan);
        await writeFile(path.join(root, 'notes', 'SKILL.md'), 'edited by the user');
        const error = await writePlan(root, plan).catch((caught) => caught);
        expect(error).toBeInstanceOf(CreatorError);
        expect((error as CreatorError).code).toBe('exists');
        expect(await readFile(path.join(root, 'notes', 'SKILL.md'), 'utf8')).toBe('edited by the user');

        const other = await temporaryDir();
        await writeFile(path.join(other, 'blocker.md'), 'keep');
        const command = planCommand({ name: 'blocker', body: 'x' });
        await expect(writePlan(other, command)).rejects.toThrow(/already exists/);
        expect(await readFile(path.join(other, 'blocker.md'), 'utf8')).toBe('keep');
    });
});
