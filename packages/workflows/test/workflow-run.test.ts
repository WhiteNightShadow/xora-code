import { describe, expect, it } from 'vitest';
import {
    decideSteps,
    newStepState,
    parseWorkflow,
    type RunContext,
    renderTemplate,
    resolveInputs,
    runOutcome,
    type StepState,
    shellQuote,
    type WorkflowDefinition,
} from '../src/index.ts';

function definition(source: string): WorkflowDefinition {
    const result = parseWorkflow(source);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.definition;
}

function context(def: WorkflowDefinition, overrides: Record<string, Partial<StepState>> = {}): RunContext {
    const steps: Record<string, StepState> = {};
    for (const step of def.steps) steps[step.id] = { ...newStepState(), ...overrides[step.id] };
    return { runId: 'wf_1', inputs: { issue: "it's broken; rm -rf /" }, trigger: { reason: 'manual' }, steps };
}

const DEF = definition(`
name: x
inputs: { issue: {} }
steps:
  - { id: a, agent: c, task: "复现{{inputs.issue}}", outputs: [file] }
  - { id: b, agent: c, task: "修{{steps.a.outputs.file}}", needs: [a] }
  - { id: c, agent: c, task: t, needs: [a] }
  - { id: d, run: "echo {{steps.a.outputs.file}} {{inputs.issue}}", needs: [b, c] }
  - { id: e, agent: c, task: t, needs: [b], if: "steps.b.outcome == 'failed'" }
`);

describe('decideSteps', () => {
    it('starts steps whose dependencies finished, in parallel when independent', () => {
        expect(decideSteps(DEF, context(DEF)).map((d) => [d.step.id, d.action])).toEqual([['a', 'run']]);
        const after = context(DEF, { a: { status: 'succeeded', outputs: { file: 'x.test.ts' } } });
        expect(decideSteps(DEF, after).map((d) => [d.step.id, d.action])).toEqual([
            ['b', 'run'],
            ['c', 'run'],
        ]);
    });

    it('skips steps after a dependency that did not succeed unless a condition says otherwise', () => {
        const ctx = context(DEF, {
            a: { status: 'succeeded' },
            b: { status: 'failed' },
            c: { status: 'succeeded' },
        });
        expect(decideSteps(DEF, ctx).map((d) => [d.step.id, d.action, 'reason' in d ? d.reason : ''])).toEqual([
            ['d', 'skip', '依赖的步骤b没有成功'],
            ['e', 'run', ''],
        ]);
        const fine = context(DEF, { a: { status: 'succeeded' }, b: { status: 'succeeded' }, c: { status: 'running' } });
        expect(decideSteps(DEF, fine).map((d) => [d.step.id, d.action])).toEqual([['e', 'skip']]);
    });
});

describe('renderTemplate', () => {
    const ctx = context(DEF, { a: { status: 'succeeded', outputs: { file: 'src/a b.ts' }, summary: 'ok' } });

    it('fills text fields as they are', () => {
        expect(renderTemplate('修{{ steps.a.outputs.file }}：{{inputs.issue}}', ctx)).toBe(
            "修src/a b.ts：it's broken; rm -rf /",
        );
    });

    it('quotes every value in commands so inputs cannot add shell syntax', () => {
        expect(
            renderTemplate('echo {{steps.a.outputs.file}} {{inputs.issue}}', ctx, {
                command: true,
                platform: 'darwin',
            }),
        ).toBe(`echo 'src/a b.ts' 'it'\\''s broken; rm -rf /'`);
        expect(renderTemplate('echo {{inputs.issue}}', ctx, { command: true, platform: 'win32' })).toBe(
            "echo 'it''s broken; rm -rf /'",
        );
        const files = { ...ctx, trigger: { reason: 'files' as const, files: ['a.ts', 'b c.ts'] } };
        expect(renderTemplate('lint {{trigger.files}}', files, { command: true, platform: 'linux' })).toBe(
            "lint 'a.ts' 'b c.ts'",
        );
        expect(renderTemplate('{{trigger.files}}', files)).toBe('a.ts\nb c.ts');
        expect(shellQuote('')).toBe("''");
    });
});

describe('resolveInputs and runOutcome', () => {
    it('converts inputs and reports missing or unknown ones', () => {
        const declared = definition(`
name: x
inputs:
  issue: {}
  count: { type: number, default: 2 }
  dry: { type: boolean }
steps: [{ id: a, agent: c, task: t }]
`).inputs;
        expect(resolveInputs(declared, { issue: 'x', dry: 'true' })).toEqual({
            inputs: { issue: 'x', count: 2, dry: true },
        });
        expect(resolveInputs(declared, { count: 'many', other: 1 })).toEqual({
            errors: ['没有名为other的输入', '缺少输入issue', '输入count应为数字', '缺少输入dry'],
        });
    });

    it('is over once every step finished', () => {
        const done: Record<string, StepState> = {};
        for (const step of DEF.steps) done[step.id] = { ...newStepState(), status: 'succeeded' };
        expect(runOutcome(DEF, done)).toBe('completed');
        expect(runOutcome(DEF, { ...done, e: { ...newStepState(), status: 'skipped' } })).toBe('completed');
        expect(runOutcome(DEF, { ...done, b: { ...newStepState(), status: 'failed' } })).toBe('failed');
        expect(runOutcome(DEF, { ...done, c: { ...newStepState(), status: 'waiting' } })).toBe('running');
    });
});
