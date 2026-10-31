import type { PermissionMode, Rule } from '@xora/protocol';
import { describe, expect, it } from 'vitest';
import { type CallFacts, decide, highRiskOf, type PolicyContext, rulePattern, sessionKey } from '../src/policy.ts';

const root = '/work/project';

function facts(overrides: Partial<CallFacts>): CallFacts {
    return {
        toolName: 'read',
        kind: 'read',
        readOnly: true,
        paths: [`${root}/src/index.ts`],
        outside: [],
        sensitive: [],
        external: false,
        ...overrides,
    };
}

function context(mode: PermissionMode, rules: Rule[] = [], sessionAllows: string[] = []): PolicyContext {
    return {
        mode,
        projectRoot: root,
        projectId: 'p1',
        rules,
        sessionAllows: new Set(sessionAllows),
        language: 'zh-CN',
    };
}

const read = facts({});
const edit = facts({ toolName: 'edit', kind: 'edit', readOnly: false });
const readOnlyCommand = facts({
    toolName: 'bash',
    kind: 'execute',
    readOnly: false,
    command: 'git status',
    readOnlyCommand: true,
    paths: [],
});
const command = facts({
    toolName: 'bash',
    kind: 'execute',
    readOnly: false,
    command: 'pnpm test',
    readOnlyCommand: false,
    paths: [],
});
const fetchCall = facts({ toolName: 'web_fetch', kind: 'fetch', readOnly: true, paths: [] });

/**
 * Permission contract (10 §2): every mode × call category. "Ask" outcomes are the ones a user must see; a
 * regression that silently allows one of them is exactly the 0.2.x P0 this table exists to prevent.
 */
const TABLE: Array<[string, CallFacts, Record<PermissionMode, 'allow' | 'ask' | 'deny'>]> = [
    ['read in workspace', read, { ask: 'allow', auto_edit: 'allow', plan: 'allow', full: 'allow' }],
    ['edit in workspace', edit, { ask: 'ask', auto_edit: 'allow', plan: 'deny', full: 'allow' }],
    ['read-only command', readOnlyCommand, { ask: 'ask', auto_edit: 'allow', plan: 'allow', full: 'allow' }],
    ['other command', command, { ask: 'ask', auto_edit: 'ask', plan: 'deny', full: 'allow' }],
    ['network fetch', fetchCall, { ask: 'ask', auto_edit: 'ask', plan: 'ask', full: 'allow' }],
    [
        'read outside workspace',
        facts({ paths: ['/etc/hosts'], outside: ['/etc/hosts'] }),
        { ask: 'ask', auto_edit: 'ask', plan: 'ask', full: 'ask' },
    ],
    [
        'edit outside workspace',
        facts({ toolName: 'write', kind: 'edit', readOnly: false, paths: ['/tmp/x'], outside: ['/tmp/x'] }),
        { ask: 'ask', auto_edit: 'ask', plan: 'deny', full: 'ask' },
    ],
    [
        'read a secret',
        facts({ paths: [`${root}/.env`], sensitive: [`${root}/.env`] }),
        { ask: 'ask', auto_edit: 'ask', plan: 'ask', full: 'ask' },
    ],
    [
        'edit a secret',
        facts({
            toolName: 'edit',
            kind: 'edit',
            readOnly: false,
            paths: [`${root}/.env`],
            sensitive: [`${root}/.env`],
        }),
        { ask: 'ask', auto_edit: 'ask', plan: 'deny', full: 'ask' },
    ],
    [
        'external agent, unknown kind',
        facts({ toolName: 'Do something', kind: 'other', readOnly: false, external: true, paths: [] }),
        { ask: 'ask', auto_edit: 'ask', plan: 'deny', full: 'allow' },
    ],
];

describe('permission contract', () => {
    for (const [name, call, expected] of TABLE) {
        for (const mode of Object.keys(expected) as PermissionMode[]) {
            it(`${name} in ${mode} mode → ${expected[mode]}`, () => {
                expect(decide(call, context(mode)).decision).toBe(expected[mode]);
            });
        }
    }
});

describe('rules', () => {
    const rule = (
        decision: Rule['decision'],
        tool: string,
        pattern: string,
        scope: Rule['scope'] = 'project',
    ): Rule => ({
        id: `${decision}-${tool}-${pattern}`,
        scope,
        ...(scope === 'project' ? { projectId: 'p1' } : {}),
        tool,
        pattern,
        decision,
        createdAt: 0,
    });

    it('deny rules win over mode defaults, even in full mode', () => {
        const result = decide(command, context('full', [rule('deny', 'bash', 'pnpm')]));
        expect(result.decision).toBe('deny');
        expect(result.ruleId).toBe('deny-bash-pnpm');
    });

    it('allow rules match command prefixes on word boundaries', () => {
        const rules = [rule('allow', 'bash', 'pnpm test')];
        expect(decide(command, context('ask', rules)).decision).toBe('allow');
        expect(decide({ ...command, command: 'pnpm test:e2e' }, context('ask', rules)).decision).toBe('ask');
        expect(decide({ ...command, command: 'pnpm testing' }, context('ask', rules)).decision).toBe('ask');
    });

    it('allow rules never lift the guard on secrets or paths outside the workspace', () => {
        const rules = [rule('allow', '*', '*', 'global')];
        expect(
            decide(facts({ paths: ['/etc/passwd'], outside: ['/etc/passwd'] }), context('ask', rules)).decision,
        ).toBe('ask');
        expect(
            decide(facts({ paths: [`${root}/.env`], sensitive: [`${root}/.env`] }), context('ask', rules)).decision,
        ).toBe('ask');
    });

    it('allow rules cannot override plan mode', () => {
        expect(decide(edit, context('plan', [rule('allow', 'edit', '*')])).decision).toBe('deny');
    });

    it('path rules match globs relative to the project', () => {
        const rules = [rule('allow', 'edit', 'src/**')];
        expect(decide(edit, context('ask', rules)).decision).toBe('allow');
        expect(decide({ ...edit, paths: [`${root}/package.json`] }, context('ask', rules)).decision).toBe('ask');
    });

    it('project rules do not leak into other projects', () => {
        const other: Rule = { ...rule('allow', 'edit', '*'), projectId: 'p2' };
        expect(decide(edit, context('ask', [other])).decision).toBe('ask');
    });

    it('ask rules force a question in permissive modes', () => {
        expect(decide(edit, context('auto_edit', [rule('ask', 'edit', 'src/**')])).decision).toBe('ask');
    });

    it('"allow for this session" applies to the same tool and command prefix only', () => {
        const allowed = [sessionKey(command)];
        expect(decide(command, context('ask', [], allowed)).decision).toBe('allow');
        expect(decide({ ...command, command: 'rm -rf build' }, context('ask', [], allowed)).decision).toBe('ask');
    });

    it('derives rule patterns from the first two words of a command', () => {
        expect(rulePattern(command)).toBe('pnpm test');
        expect(rulePattern(edit)).toBe('*');
    });
});

describe('high-risk actions (06 §8)', () => {
    const push = facts({
        toolName: 'bash',
        kind: 'execute',
        readOnly: false,
        command: 'git push origin main',
        readOnlyCommand: false,
        paths: [],
        highRisk: highRiskOf({ toolName: 'bash', command: 'git push origin main' }, { cwd: root }),
    });
    const allowAll: Rule = {
        id: 'allow-all',
        scope: 'global',
        tool: '*',
        pattern: '*',
        decision: 'allow',
        createdAt: 0,
    };

    it('are recognized for commands and MCP tools', () => {
        expect(push.highRisk?.action).toBe('push');
        expect(highRiskOf({ toolName: 'mcp__slack__slack_post_message' }, { cwd: root })?.action).toBe(
            'external_message',
        );
        expect(highRiskOf({ toolName: 'bash', command: 'git status' }, { cwd: root })).toBeUndefined();
    });

    it('ask in every mode that would run them, whatever the rules and the session allow', () => {
        const allowed = [sessionKey(push)];
        for (const mode of ['ask', 'auto_edit', 'full'] as const) {
            const result = decide(push, context(mode, [allowAll], allowed));
            expect(result.decision).toBe('ask');
            expect(result.reason).toContain('推送');
        }
    });

    it('are still denied where the mode or a rule denies them', () => {
        expect(decide(push, context('plan')).decision).toBe('deny');
        const deny: Rule = { ...allowAll, id: 'deny-push', tool: 'bash', pattern: 'git push', decision: 'deny' };
        expect(decide(push, context('full', [deny])).decision).toBe('deny');
    });
});

describe('risks', () => {
    it('labels what a card should warn about', () => {
        const result = decide(
            facts({
                toolName: 'bash',
                kind: 'execute',
                readOnly: false,
                command: 'rm -rf /tmp/x',
                readOnlyCommand: false,
                paths: ['/tmp/x'],
                outside: ['/tmp/x'],
            }),
            context('ask'),
        );
        expect(result.risks).toEqual(expect.arrayContaining(['execute', 'unknown_command', 'outside_workspace']));
    });
});
