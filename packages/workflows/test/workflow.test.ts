import { describe, expect, it } from 'vitest';
import { ancestors, issuePath, parseCondition, parseWorkflow, type WorkflowParse } from '../src/index.ts';

const BUGFIX = `
name: bugfix-pipeline
title: 缺陷修复流水线
trigger:
  manual: true
  schedule: "0 2 * * *"
  offPeakOnly: true
inputs:
  issue: { type: string, description: 问题描述或链接 }
budget: { perRun: 20, currency: CNY }
steps:
  - id: reproduce
    agent: debugger
    tier: economy
    task: "复现问题：{{inputs.issue}}，写出一个会失败的测试"
    outputs: [testFile]
    verify: { command: "pnpm test -- {{steps.reproduce.outputs.testFile}}", expect: fail }
  - id: fix
    type: supervise
    needs: [reproduce]
    goal: "修复问题，让{{steps.reproduce.outputs.testFile}}通过，且不破坏其他测试"
    verify: { command: "pnpm test" }
  - id: review
    agent: reviewer
    needs: [fix]
    task: "审查fix这一步的全部改动"
  - id: approve
    needs: [review]
    gate: human
  - id: pr
    agent: coder
    needs: [approve]
    if: "steps.review.outcome == 'succeeded'"
    task: "提交并开pr"
`;

function issues(result: WorkflowParse): string[] {
    return result.ok ? [] : result.issues.map((issue) => `${issuePath(issue.path)}: ${issue.message}`);
}

describe('parseWorkflow', () => {
    it('reads the design example, inferring step types and filling defaults', () => {
        const result = parseWorkflow(BUGFIX);
        expect(issues(result)).toEqual([]);
        if (!result.ok) return;
        const { definition } = result;
        expect(definition.steps.map((step) => step.type)).toEqual(['agent', 'supervise', 'agent', 'gate', 'agent']);
        expect(definition.trigger).toMatchObject({
            manual: true,
            schedule: '0 2 * * *',
            missed: 'skip',
            offPeakOnly: true,
        });
        expect(definition.concurrency).toBe(3);
        expect(definition.steps[0]).toMatchObject({ verify: { expect: 'fail', timeoutMinutes: 10 }, needs: [] });
        expect([...ancestors(definition, 'pr')].sort()).toEqual(['approve', 'fix', 'reproduce', 'review']);
    });

    it('reports YAML syntax errors with their line', () => {
        const result = parseWorkflow('name: x\nsteps:\n  - id: a\n   agent: b\n');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.issues[0]?.line).toBeGreaterThan(1);
    });

    it('checks ids, dependencies and cycles', () => {
        const duplicate = parseWorkflow(
            'name: x\nsteps:\n  - { id: a, agent: c, task: t }\n  - { id: a, agent: c, task: t }\n',
        );
        expect(issues(duplicate)).toEqual(['steps[1].id: duplicate step id a']);
        const unknown = parseWorkflow('name: x\nsteps:\n  - { id: a, agent: c, task: t, needs: [b] }\n');
        expect(issues(unknown)).toEqual(['steps[0].needs[0]: unknown step b']);
        const cycle = parseWorkflow(
            'name: x\nsteps:\n  - { id: a, agent: c, task: t, needs: [b] }\n  - { id: b, agent: c, task: t, needs: [a] }\n',
        );
        expect(issues(cycle)[0]).toMatch(/cycle: a → b → a/);
    });

    it('checks every template reference against inputs, outputs and dependencies', () => {
        const result = parseWorkflow(`name: x
inputs: { issue: {} }
steps:
  - { id: a, agent: c, task: "{{inputs.nope}}", outputs: [file] }
  - { id: b, agent: c, task: "{{steps.a.outputs.file}} {{steps.a.outputs.other}}" }
  - { id: d, agent: c, needs: [a], task: "{{steps.a.outputs.other}} {{steps.zz.summary}} {{wat}}" }
  - { id: e, run: "echo {{inputs.issue}}", needs: [a], if: "steps.a.outcome ~ 1" }
`);
        expect(issues(result)).toEqual([
            'steps[0].task: unknown input nope',
            'steps[1].task: b uses a without waiting for it (add it to needs)',
            'steps[1].task: b uses a without waiting for it (add it to needs)',
            'steps[1].task: a does not declare the output other',
            'steps[2].task: a does not declare the output other',
            'steps[2].task: unknown step zz',
            'steps[2].task: unknown reference {{wat}}',
            'steps[3].if: unknown reference steps.a.outcome ~ 1',
        ]);
    });

    it('rejects unknown fields and a workflow that runs itself', () => {
        expect(issues(parseWorkflow('name: x\nsteps:\n  - { id: a, agent: c, task: t, colour: red }\n'))[0]).toMatch(
            /steps\[0\]/,
        );
        expect(issues(parseWorkflow('name: x\nsteps:\n  - { id: a, workflow: x }\n'))).toEqual([
            'steps[0].workflow: a workflow cannot run itself',
        ]);
    });
});

describe('parseCondition', () => {
    it('reads references, negation and comparisons', () => {
        expect(parseCondition('steps.a.outcome')).toEqual({
            kind: 'truthy',
            negate: false,
            ref: { kind: 'step', step: 'a', field: 'outcome' },
        });
        expect(parseCondition('!inputs.dry')).toMatchObject({ kind: 'truthy', negate: true });
        expect(parseCondition("{{ inputs.mode }} != 'fast'")).toMatchObject({ op: '!=', value: 'fast' });
        expect(parseCondition('inputs.n == 3')).toMatchObject({ value: 3 });
        expect(parseCondition('inputs.n == maybe')).toEqual({
            error: 'maybe is not a quoted string, number, true or false',
        });
    });
});
