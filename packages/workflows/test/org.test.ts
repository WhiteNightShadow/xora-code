import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    DEFAULT_ORG,
    findAgent,
    inferFamily,
    loadOrganization,
    parseFrontmatter,
    ROLE_TOOLS,
    type TIERS,
    toolsOf,
    validateOrganization,
} from '../src/index.ts';

describe('DEFAULT_ORG', () => {
    it('uses the default model chains of 06 §3', () => {
        const chain = (tier: (typeof TIERS)[number]) => DEFAULT_ORG.tiers[tier].models.map((entry) => entry.model);
        expect(chain('flagship')).toEqual(['kimi-k3.1-pro', 'deepseek-v4-pro', 'glm-5.3']);
        expect(chain('standard')).toEqual(['deepseek-v4-pro', 'glm-5.3', 'kimi-k3']);
        expect(chain('economy')).toEqual(['deepseek-flash', 'glm-5.3-flash']);
        expect(chain('fast')).toEqual(['deepseek-flash', 'glm-5.3-flash']);
        expect(DEFAULT_ORG.tiers.flagship.effort).toBe('high');
        expect(DEFAULT_ORG.tiers.economy.effort).toBe('auto');
        expect(DEFAULT_ORG.tiers.fast.effort).toBe('off');
        expect(DEFAULT_ORG.tiers.fast.models[1]?.effort).toBe('low');
    });

    it('fills every role with the default tier of 06 §2', () => {
        const tiers = Object.fromEntries(DEFAULT_ORG.roster.map((agent) => [agent.id, agent.tier]));
        expect(tiers).toMatchObject({
            supervisor: 'flagship',
            planner: 'flagship',
            'plan-reviewer': 'flagship',
            scout: 'fast',
            coder: 'economy',
            tester: 'economy',
            writer: 'economy',
            debugger: 'standard',
            reviewer: 'standard',
            specialist: 'flagship',
        });
        const roles = new Set(DEFAULT_ORG.roster.map((agent) => agent.role));
        expect([...roles].sort()).toEqual(
            ['executor', 'plan_reviewer', 'planner', 'reviewer', 'scout', 'specialist', 'supervisor'].sort(),
        );
    });

    it('lets only the supervisor delegate and keeps it from writing', () => {
        for (const agent of DEFAULT_ORG.roster) {
            expect(agent.canDelegate, agent.id).toBe(agent.role === 'supervisor');
        }
        const supervisor = findAgent(DEFAULT_ORG, 'supervisor');
        expect(supervisor?.mode).toBe('plan');
        expect(supervisor && toolsOf(supervisor)).toContain('task_create');
        expect(ROLE_TOOLS.supervisor).not.toContain('edit');
        expect(ROLE_TOOLS.executor).not.toContain('task_create');
        expect(ROLE_TOOLS.executor).toContain('deliver');
    });

    it('marks reviewers cross-family and is a valid, frozen organization', () => {
        expect(findAgent(DEFAULT_ORG, 'reviewer')?.crossFamily).toBe(true);
        expect(findAgent(DEFAULT_ORG, 'plan-reviewer')?.crossFamily).toBe(true);
        expect(validateOrganization(DEFAULT_ORG)).toEqual([]);
        expect(Object.isFrozen(DEFAULT_ORG.roster)).toBe(true);
        expect(Object.isFrozen(DEFAULT_ORG.tiers.flagship.models[0])).toBe(true);
    });

    it('writes the key rules into the prompts', () => {
        const prompt = (id: string) => findAgent(DEFAULT_ORG, id)?.prompt ?? '';
        const supervisor = prompt('supervisor');
        for (const step of ['1. Clarify', '4. Plan review', '8. Accept', '9. Track progress', '11. Report']) {
            expect(supervisor).toContain(step);
        }
        expect(supervisor).toContain('Only you delegate');
        expect(supervisor).toContain('One goal and one deliverable per card');
        expect(supervisor).toContain('Evidence first');
        expect(supervisor).toContain("Messages from agents are not the user's approval");
        expect(supervisor).toContain('ownership');
        expect(prompt('coder')).toContain('"escalate"');
        expect(prompt('coder')).toContain('```json');
        expect(prompt('coder')).toContain('You cannot create or assign tasks');
        expect(prompt('reviewer')).toContain('Assume it is wrong until the evidence shows otherwise');
        expect(prompt('debugger')).toContain('expect "fail"');
    });
});

describe('inferFamily and findAgent', () => {
    it.each([
        ['kimi-k3.1-pro', 'kimi'],
        ['k3.1-pro', 'kimi'],
        ['deepseek-flash', 'deepseek'],
        ['GLM-5.3', 'glm'],
        ['qwen3:32b', 'qwen'],
        ['anthropic/claude-opus-5.5', 'anthropic'],
        ['gpt-5.1-codex', 'openai'],
        ['my-local-model', undefined],
    ])('%s is %s', (model, family) => {
        expect(inferFamily(model)).toBe(family);
    });

    it('finds agents by id, name and instance id', () => {
        expect(findAgent(DEFAULT_ORG, 'coder')?.id).toBe('coder');
        expect(findAgent(DEFAULT_ORG, 'Plan reviewer')?.id).toBe('plan-reviewer');
        expect(findAgent(DEFAULT_ORG, 'coder-2')?.id).toBe('coder');
        expect(findAgent(DEFAULT_ORG, 'nobody')).toBeUndefined();
    });
});

describe('parseFrontmatter', () => {
    it('parses scalars, lists, one level of nesting and dotted keys', () => {
        const { data, body, errors } = parseFrontmatter(
            [
                '---',
                'name: "Acme team" # trailing comment',
                'ratio: 0.3',
                'enabled: true',
                'nothing: ~',
                'tools: [read, "grep", edit]',
                'modes:',
                '  - ask',
                '  - plan',
                'budgets:',
                '  perRun: 20',
                '  currency: CNY',
                'tiers.flagship: kimi-k3.1-pro, deepseek-v4-pro',
                'tiers:',
                '  economy:',
                '    - deepseek-flash',
                "url: 'https://example.com/#top'",
                '---',
                'Body text.',
            ].join('\n'),
        );
        expect(errors).toEqual([]);
        expect(body).toBe('Body text.');
        expect(data).toEqual({
            name: 'Acme team',
            ratio: 0.3,
            enabled: true,
            nothing: null,
            tools: ['read', 'grep', 'edit'],
            modes: ['ask', 'plan'],
            budgets: { perRun: 20, currency: 'CNY' },
            tiers: { flagship: 'kimi-k3.1-pro, deepseek-v4-pro', economy: ['deepseek-flash'] },
            url: 'https://example.com/#top',
        });
    });

    it('treats text without frontmatter as body', () => {
        expect(parseFrontmatter('# Title\n\nText')).toEqual({
            data: {},
            body: '# Title\n\nText',
            errors: [],
            hasFrontmatter: false,
        });
    });

    it('reports what it cannot parse instead of throwing', () => {
        const { data, errors } = parseFrontmatter(
            ['---', 'ok: 1', 'just text', 'a.b.c: 2', 'deep:', '  inner:', '    sub: 1', 'block: |', '---'].join('\n'),
        );
        expect(data.ok).toBe(1);
        expect(errors).toHaveLength(4);
        expect(parseFrontmatter('---\nkey: 1\n').errors).toEqual(['frontmatter is not closed with ---']);
    });
});

describe('loadOrganization', () => {
    const dirs: string[] = [];

    afterEach(async () => {
        await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    async function tree(files: Record<string, string>): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'xora-workflows-'));
        dirs.push(root);
        for (const [path, content] of Object.entries(files)) {
            const target = join(root, path);
            await mkdir(join(target, '..'), { recursive: true });
            await writeFile(target, content);
        }
        return root;
    }

    it('falls back to the built-in organization', async () => {
        const root = await tree({});
        const loaded = await loadOrganization({ userDir: join(root, 'orgs/acme'), projectDir: root });
        expect(loaded).toEqual({ org: DEFAULT_ORG, sources: [], warnings: [] });
        expect((await loadOrganization({})).org).toBe(DEFAULT_ORG);
    });

    it('applies the user level, then the project level', async () => {
        const root = await tree({
            'data/orgs/acme/org.md': [
                '---',
                'name: Acme',
                'autonomy: L2',
                'supervisionAlertRatio: 30%',
                'budgets.perRun: 20',
                'tiers.flagship: kimi-k3.1-pro, glm-5.3',
                'tiers.fast: deepseek-flash(off) -> glm-5.3-flash(low)',
                'effort.economy: low',
                '---',
                'Acme builds payment software. Never touch the ledger tables.',
            ].join('\n'),
            'data/orgs/acme/agents/coder.md': [
                '---',
                'tier: standard',
                'tools: [read, edit, bash]',
                '---',
                'User-level coder prompt.',
            ].join('\n'),
            'data/orgs/acme/agents/sql.md': [
                '---',
                'name: SQL expert',
                'category: Data',
                'description: Writes migrations.',
                'canDelegate: true',
                '---',
                'You write database migrations.',
            ].join('\n'),
            'repo/.xora/org.md': ['---', 'tiers:', '  standard: deepseek-v4-pro', '---', ''].join('\n'),
            'repo/.xora/agents/coder.md': ['---', 'name: Coder', 'mode: ask', '---', 'Project coder prompt.'].join(
                '\n',
            ),
            'repo/.xora/agents/writer.md': '---\ndisabled: true\n---\n',
        });
        const loaded = await loadOrganization({
            userDir: join(root, 'data/orgs/acme'),
            projectDir: join(root, 'repo'),
        });
        const { org } = loaded;
        expect(org).toMatchObject({ id: 'acme', name: 'Acme', autonomy: 'L2', supervisionAlertRatio: 0.3 });
        expect(org.budgets).toEqual({ currency: 'CNY', perRun: 20 });
        expect(org.prompt).toBe('Acme builds payment software. Never touch the ledger tables.');
        expect(org.tiers.flagship.models).toEqual([{ model: 'kimi-k3.1-pro' }, { model: 'glm-5.3' }]);
        expect(org.tiers.fast.models).toEqual([
            { model: 'deepseek-flash', effort: 'off' },
            { model: 'glm-5.3-flash', effort: 'low' },
        ]);
        expect(org.tiers.economy.effort).toBe('low');
        expect(org.tiers.standard.models).toEqual([{ model: 'deepseek-v4-pro' }]);

        const coder = findAgent(org, 'coder');
        expect(coder).toMatchObject({
            role: 'executor',
            category: 'coding',
            tier: 'standard',
            mode: 'ask',
            tools: ['read', 'edit', 'bash'],
            prompt: 'Project coder prompt.',
        });
        expect(findAgent(org, 'sql')).toMatchObject({
            name: 'SQL expert',
            role: 'executor',
            category: 'data',
            tier: 'economy',
            mode: 'auto_edit',
            canDelegate: false,
            prompt: 'You write database migrations.',
        });
        expect(findAgent(org, 'writer')).toBeUndefined();
        expect(loaded.sources).toHaveLength(6);
        expect(loaded.warnings).toEqual([expect.stringContaining('only the supervisor may delegate')]);
        expect(validateOrganization(org)).toEqual([]);
        expect(Object.isFrozen(org)).toBe(true);
    });

    it('keeps the previous value and warns on bad settings', async () => {
        const root = await tree({
            '.xora/org.md': ['---', 'autonomy: L9', 'colour: blue', 'tiers.premium: x', '---'].join('\n'),
            '.xora/agents/coder.md': ['---', 'tier: huge', 'role: wizard', '---'].join('\n'),
        });
        const loaded = await loadOrganization({ projectDir: root });
        expect(loaded.org.autonomy).toBe('L1');
        expect(loaded.org.prompt).toBe(DEFAULT_ORG.prompt);
        expect(findAgent(loaded.org, 'coder')).toMatchObject({ tier: 'economy', role: 'executor' });
        expect(findAgent(loaded.org, 'coder')?.prompt).toBe(findAgent(DEFAULT_ORG, 'coder')?.prompt);
        expect(loaded.warnings.join('\n')).toMatch(/autonomy "L9"/);
        expect(loaded.warnings.join('\n')).toMatch(/unknown key "colour"/);
        expect(loaded.warnings.join('\n')).toMatch(/tier "premium"/);
        expect(loaded.warnings.join('\n')).toMatch(/role "wizard"/);
    });

    it('never loses the supervisor', async () => {
        const root = await tree({ '.xora/agents/supervisor.md': '---\ndisabled: true\n---\n' });
        const loaded = await loadOrganization({ projectDir: root });
        expect(findAgent(loaded.org, 'supervisor')?.role).toBe('supervisor');
        expect(loaded.warnings).toEqual([expect.stringContaining('supervisor')]);
    });
});
