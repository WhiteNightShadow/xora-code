import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    discoverCommands,
    expandCommand,
    findCommand,
    parseSlashInput,
    type SlashCommand,
    splitArguments,
} from '../src/index.ts';
import { ROOT_VAR, source, temporaryDir, writeTree } from './helpers.ts';

describe('discoverCommands', () => {
    it('reads frontmatter, namespaces subdirectories and lets the first source win', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'project/commands/review.md':
                '---\ndescription: Review a PR\nargument-hint: <pr> [priority]\nmodel: deepseek-v4-pro\nallowed-tools: Bash(git diff:*), Read\n---\nReview PR #$1 with priority $2.\n',
            'project/commands/frontend/build.md': '# Build the frontend\n\nRun the build for $ARGUMENTS.\n',
            'project/commands/notes.txt': 'not a command',
            'user/commands/review.md': 'User review.\n',
            'user/commands/deploy.md': 'Deploy.\n',
        });
        const { commands, diagnostics } = await discoverCommands([
            source(path.join(root, 'project/commands')),
            source(path.join(root, 'user/commands'), 'user'),
        ]);
        expect(commands.map((command) => [command.name, command.origin])).toEqual([
            ['frontend:build', 'project'],
            ['review', 'project'],
            ['deploy', 'user'],
        ]);
        expect(commands[1]).toMatchObject({
            description: 'Review a PR',
            argumentHint: '<pr> [priority]',
            model: 'deepseek-v4-pro',
            allowedTools: ['Bash(git diff:*)', 'Read'],
            body: 'Review PR #$1 with priority $2.\n',
        });
        // Without frontmatter the first line describes the command.
        expect(commands[0]?.description).toBe('Build the frontend');
        expect(diagnostics.map((item) => item.message)).toEqual([
            `command "/review" is shadowed by ${path.join(root, 'project/commands/review.md')}`,
        ]);
    });

    it('prefixes plugin commands and fills in the plugin root', async () => {
        const root = await temporaryDir();
        await writeTree(root, { 'commands/status.md': `Run ${ROOT_VAR}/bin/status\n` });
        const { commands } = await discoverCommands([
            source(path.join(root, 'commands'), 'plugin', { pluginName: 'deploy-tools', pluginRoot: root }),
        ]);
        expect(commands.map((command) => [command.name, command.body])).toEqual([
            ['deploy-tools:status', `Run ${root}/bin/status\n`],
        ]);
    });
});

describe('arguments', () => {
    it('splits like a shell without expansions', () => {
        expect(splitArguments(`  456 "high priority"  'it''s' a\\ b "" "say \\"hi\\"" end`)).toEqual([
            '456',
            'high priority',
            'its',
            'a b',
            '',
            'say "hi"',
            'end',
        ]);
        expect(splitArguments('"unclosed quote runs')).toEqual(['unclosed quote runs']);
        expect(splitArguments('   ')).toEqual([]);
    });

    it('expands $ARGUMENTS, positional and indexed placeholders', () => {
        const command = { body: 'PR #$1 priority $2 owner $3.\nAll: $ARGUMENTS\nFirst: $ARGUMENTS[0]\n' };
        expect(expandCommand(command, '456 "very high"')).toBe(
            'PR #456 priority very high owner $3.\nAll: 456 "very high"\nFirst: 456\n',
        );
    });

    it('keeps escaped placeholders and argument text literal', () => {
        expect(expandCommand({ body: 'Costs \\$1.00, takes $1.' }, '"$ARGUMENTS and $2"')).toBe(
            'Costs $1.00, takes $ARGUMENTS and $2.',
        );
    });

    it('appends the arguments when no placeholder takes them', () => {
        expect(expandCommand({ body: 'Summarise the changes.\n\n' }, 'focus on tests')).toBe(
            'Summarise the changes.\n\nARGUMENTS: focus on tests',
        );
        expect(expandCommand({ body: 'Only $5 here.' }, 'one')).toBe('Only $5 here.\n\nARGUMENTS: one');
        expect(expandCommand({ body: 'Nothing: $ARGUMENTS.' }, '')).toBe('Nothing: .');
        expect(expandCommand({ body: 'Plain.' }, '   ')).toBe('Plain.');
    });
});

describe('slash input', () => {
    it('parses command names and arguments', () => {
        expect(parseSlashInput('/review 456 high')).toEqual({ name: 'review', args: '456 high' });
        expect(parseSlashInput('  /frontend:build')).toEqual({ name: 'frontend:build', args: '' });
        expect(parseSlashInput('/审查 第一段\n第二段 ')).toEqual({ name: '审查', args: '第一段\n第二段' });
    });

    it('ignores text that is not a command', () => {
        expect(parseSlashInput('hello /review')).toBeUndefined();
        expect(parseSlashInput('/')).toBeUndefined();
        expect(parseSlashInput('/usr/bin/env node')).toBeUndefined();
        expect(parseSlashInput('/bad:')).toBeUndefined();
    });

    it('finds plugin commands by their bare name when that is unambiguous', () => {
        const make = (name: string, pluginName?: string): SlashCommand => ({
            name,
            body: '',
            file: `${name}.md`,
            origin: pluginName ? 'plugin' : 'project',
            trusted: true,
            ...(pluginName ? { pluginName } : {}),
        });
        const commands = [
            make('review'),
            make('deploy-tools:status', 'deploy-tools'),
            make('a:lint', 'a'),
            make('b:lint', 'b'),
        ];
        expect(findCommand(commands, 'review')?.name).toBe('review');
        expect(findCommand(commands, 'status')?.name).toBe('deploy-tools:status');
        expect(findCommand(commands, 'deploy-tools:status')?.name).toBe('deploy-tools:status');
        expect(findCommand(commands, 'lint')).toBeUndefined();
        expect(findCommand(commands, 'missing')).toBeUndefined();
    });
});
