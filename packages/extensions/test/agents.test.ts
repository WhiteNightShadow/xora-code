import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverAgents } from '../src/index.ts';
import { ROOT_VAR, source, temporaryDir, writeTree } from './helpers.ts';

describe('discoverAgents', () => {
    it('lets project definitions override user ones by name, whatever the source order', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'user/agents/scout.md': '---\nname: scout\ndescription: User scout\n---\nUser prompt.\n',
            'user/agents/doc-writer.md': '---\nname: doc-writer\ndescription: Docs\n---\nWrite docs.\n',
            'project/.xora/agents/scout.md':
                '---\nname: scout\ndescription: Project scout\ntools: Read, Grep, Glob\nmodel: deepseek-flash\ntier: fast\nrole: scout\nmode: plan\ncanDelegate: false\n---\n\nRead code and report facts.\n',
            'project/.claude/agents/scout.md': '---\nname: scout\ndescription: Claude dir scout\n---\nSecond.\n',
        });
        const { agents, diagnostics } = await discoverAgents([
            source(path.join(root, 'user/agents'), 'user'),
            source(path.join(root, 'project/.xora/agents')),
            source(path.join(root, 'project/.claude/agents')),
        ]);
        expect(agents.map((agent) => [agent.name, agent.origin, agent.description])).toEqual([
            ['scout', 'project', 'Project scout'],
            ['doc-writer', 'user', 'Docs'],
        ]);
        expect(agents[0]).toMatchObject({
            prompt: 'Read code and report facts.',
            tools: ['Read', 'Grep', 'Glob'],
            model: 'deepseek-flash',
            tier: 'fast',
            role: 'scout',
            mode: 'plan',
            canDelegate: false,
        });
        expect(diagnostics.map((item) => item.message)).toEqual([
            `agent "scout" is overridden by ${path.join(root, 'project/.xora/agents/scout.md')}`,
            `agent "scout" is overridden by ${path.join(root, 'project/.xora/agents/scout.md')}`,
        ]);
    });

    it('reads tool lists in both forms and reports unknown values', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'agents/coder.md':
                '---\nname: coder\ndescription: Implements a task card\ntools:\n  - Read\n  - Edit\n  - Bash\ndisallowedTools: [WebFetch]\ntier: premium\nrole: executor\nmode: yolo\ncanDelegate: maybe\n---\nCode.\n',
        });
        const { agents, diagnostics } = await discoverAgents([source(path.join(root, 'agents'))]);
        expect(agents[0]).toMatchObject({
            tools: ['Read', 'Edit', 'Bash'],
            disallowedTools: ['WebFetch'],
            tier: 'premium',
            mode: 'yolo',
        });
        expect(agents[0]?.canDelegate).toBeUndefined();
        expect(diagnostics.map((item) => item.message)).toEqual([
            'unknown tier "premium"',
            'unknown mode "yolo"',
            'canDelegate must be true or false; ignored',
        ]);
    });

    it('skips files without a name or description and invalid names', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'agents/README.md': '# About these agents\n',
            'agents/nodesc.md': '---\nname: nodesc\n---\nx\n',
            'agents/colon.md': '---\nname: a:b\ndescription: Colon\n---\nx\n',
        });
        const { agents, diagnostics } = await discoverAgents([source(path.join(root, 'agents'))]);
        expect(agents).toEqual([]);
        expect(diagnostics.map((item) => [item.severity, item.message])).toEqual([
            ['info', 'no name in frontmatter; treated as documentation'],
            ['error', 'invalid agent name "a:b"'],
            ['error', 'agent "nodesc" has no description'],
        ]);
    });

    it('names plugin agents after the plugin and their subdirectories', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'agents/review/security.md': `---\ndescription: Security review\n---\nCheck ${ROOT_VAR}/rules.\n`,
            'agents/helper.md': '---\nname: helper\ndescription: Helps\n---\nHelp.\n',
        });
        const { agents } = await discoverAgents([
            source(path.join(root, 'agents'), 'plugin', { pluginName: 'my-plugin', pluginRoot: root }),
        ]);
        expect(agents.map((agent) => [agent.name, agent.prompt])).toEqual([
            ['my-plugin:helper', 'Help.'],
            ['my-plugin:review:security', `Check ${root}/rules.`],
        ]);
    });
});
