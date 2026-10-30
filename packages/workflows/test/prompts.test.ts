import { describe, expect, it } from 'vitest';
import {
    type AgentSpec,
    buildAgentLayers,
    DEFAULT_ORG,
    findAgent,
    parseDeliverable,
    renderDeliverableRepair,
    renderRosterSummary,
    renderTaskCard,
    systemText,
} from '../src/index.ts';
import { card } from './helpers.ts';

function agent(id: string): AgentSpec {
    const found = findAgent(DEFAULT_ORG, id);
    if (!found) {
        throw new Error(`no agent ${id}`);
    }
    return found;
}

describe('buildAgentLayers', () => {
    it('puts organization and agent layers in the system prompt and the card in the first user message', () => {
        const layers = buildAgentLayers({ org: DEFAULT_ORG, agent: agent('coder'), card: card() });
        expect(layers.map((layer) => [layer.id, layer.placement, layer.source])).toEqual([
            ['org', 'system', 'org:default'],
            ['agent', 'system', 'agent:coder'],
            ['task', 'user', 'task:T1'],
        ]);
        expect(layers[0]?.text.startsWith('<org_instructions org="default">\n')).toBe(true);
        expect(layers[1]?.text.startsWith('<agent_instructions name="Coder" role="executor">\n')).toBe(true);
        expect(systemText(layers)).not.toContain('task_card');
    });

    it('gives the supervisor the roster and the team goal', () => {
        const layers = buildAgentLayers({
            org: DEFAULT_ORG,
            agent: agent('supervisor'),
            goal: { text: 'add sms login', autonomy: 'L1', budget: { limit: 20, currency: 'CNY' } },
        });
        expect(layers.map((layer) => layer.id)).toEqual(['org', 'roster', 'agent', 'task']);
        expect(layers.at(-1)?.text).toBe(
            [
                '<team_goal>',
                'Goal: add sms login',
                'Autonomy: L1; the user confirms the plan, high-risk actions, the final delivery.',
                'Budget: 20 CNY for this run.',
                '</team_goal>',
            ].join('\n'),
        );
    });

    it('is byte-stable: the same organization and agent give identical system layers', () => {
        const first = buildAgentLayers({
            org: DEFAULT_ORG,
            agent: agent('coder'),
            card: card({ id: 'T1', assignee: 'coder-1' }),
        });
        const second = buildAgentLayers({
            org: structuredClone(DEFAULT_ORG),
            agent: structuredClone(agent('coder')),
            card: card({ id: 'T7', assignee: 'coder-2', goal: 'something else' }),
        });
        expect(systemText(second)).toBe(systemText(first));
        expect(second.at(-1)?.text).not.toBe(first.at(-1)?.text);
        const tester = buildAgentLayers({ org: DEFAULT_ORG, agent: agent('tester') });
        expect(tester[0]?.text).toBe(first[0]?.text);
        expect(tester[1]?.text).not.toBe(first[1]?.text);
    });

    it('normalises line ends and trailing blanks so edits to whitespace do not break the cache', () => {
        const messy = { ...DEFAULT_ORG, prompt: `${DEFAULT_ORG.prompt.replaceAll('\n', '  \r\n')}\n\n` };
        const clean = buildAgentLayers({ org: DEFAULT_ORG, agent: agent('coder') });
        expect(buildAgentLayers({ org: messy, agent: agent('coder') })[0]?.text).toBe(clean[0]?.text);
    });
});

describe('renderTaskCard', () => {
    it('renders a compact, complete card', () => {
        const text = renderTaskCard(
            card({
                id: 'T3',
                title: '后端：短信验证码发送与校验接口',
                assignee: 'coder-1',
                dependsOn: ['T1'],
                context: { files: ['src/auth/**'], facts: ['短信封装在src/infra/sms.ts'], links: [] },
                ownership: ['src/auth/sms/**', 'src/routes/auth.ts'],
                constraints: ['不改公共接口的已有字段'],
                acceptance: [
                    { type: 'command', run: 'pnpm test src/auth' },
                    { type: 'command', run: 'pnpm test sms.repro', expect: 'fail' },
                    { type: 'review', by: 'reviewer' },
                ],
                deliverable: { kind: 'code-change', artifacts: ['diff', 'testReport'] },
            }),
            { handoff: ['economy tier found the race in queue.ts'] },
        );
        expect(text).toBe(
            [
                '<task_card id="T3">',
                'Title: 后端：短信验证码发送与校验接口',
                'Goal: Send and verify codes with expiry and replay protection',
                'Category: coding | Tier: economy | Workspace: worktree',
                'Assignee: coder-1',
                'Depends on: T1',
                'Context:',
                '- File: src/auth/**',
                '- Fact: 短信封装在src/infra/sms.ts',
                'Ownership (change only files matching these):',
                '- src/auth/sms/**',
                '- src/routes/auth.ts',
                'Constraints:',
                '- 不改公共接口的已有字段',
                'Acceptance:',
                '1. Command must pass: `pnpm test src/auth`',
                '2. Command must fail (reproduction): `pnpm test sms.repro`',
                '3. Review by reviewer',
                'Deliverable: code-change (diff, testReport)',
                'Budget: 3 CNY, at most 40 turns',
                'Handoff from the previous attempt:',
                '- economy tier found the race in queue.ts',
                '</task_card>',
            ].join('\n'),
        );
    });

    it('tells a read-only task to change nothing', () => {
        const text = renderTaskCard(card({ workspace: 'readonly', ownership: [], priority: 'high', tierReason: 'x' }));
        expect(text).toContain('Ownership: none; this task is read-only, change nothing.');
        expect(text).toContain('Category: coding | Tier: economy | Workspace: readonly | Priority: high');
        expect(text).toContain('Tier reason: x');
    });
});

describe('renderDeliverableRepair', () => {
    it('asks a reviewer to rewrite the message without adding facts', () => {
        const text = 'I changed src/a.ts and the tests pass.';
        const parsed = parseDeliverable(text, { taskId: 'T1' });
        if (parsed.ok) {
            throw new Error('expected a parse error');
        }
        const request = renderDeliverableRepair({ taskId: 'T1', text, error: parsed.error });
        expect(request).toContain('could not be read as a deliverable:\n- no deliverable JSON object found');
        expect(request).toContain('do not add evidence');
        expect(request).toContain('"status": "done" | "partial" | "blocked" | "escalate"');
        expect(request.endsWith(`<agent_message task="T1">\n${text}\n</agent_message>`)).toBe(true);
    });
});

describe('renderRosterSummary', () => {
    it('lists who does what at which tier, without the supervisor', () => {
        const summary = renderRosterSummary(DEFAULT_ORG);
        expect(summary).toContain('- coder: executor (coding), economy, edits its workspace. Implements one task card');
        expect(summary).toContain('- reviewer: reviewer, standard, read-only, cross-family.');
        expect(summary).toContain('- scout: scout, fast, read-only.');
        expect(summary).not.toContain('- supervisor:');
        expect(summary).toContain('Tiers, strongest first: flagship');
        const unnamed = { ...DEFAULT_ORG, roster: [{ ...agent('coder'), description: undefined }] };
        expect(renderRosterSummary(unnamed)).toContain(
            '- coder: executor (coding), economy, edits its workspace. You are a coding executor.',
        );
    });
});
