import { describe, expect, it } from 'vitest';
import { judge, planAcceptance, type ReviewOutcome, retryFeedback } from '../src/index.ts';
import { card, deliverable } from './helpers.ts';

const reviewed = card({
    acceptance: [
        { type: 'manual', note: 'try it on a phone' },
        { type: 'review', by: 'reviewer' },
        { type: 'command', run: 'pnpm test src/auth' },
        { type: 'command', run: 'pnpm lint' },
    ],
});

const approval: ReviewOutcome = { by: 'reviewer-1', verdict: 'pass', issues: [] };
const passing = [
    { run: 'pnpm test src/auth', exit: 0 },
    { run: 'pnpm  lint', exit: 0 },
];

describe('planAcceptance', () => {
    it('runs commands first, then reviews, then manual checks', () => {
        expect(planAcceptance(reviewed).map((step) => [step.check.type, step.index])).toEqual([
            ['command', 2],
            ['command', 3],
            ['review', 1],
            ['manual', 0],
        ]);
    });
});

describe('judge', () => {
    it('passes when every check passes and the evidence is there', () => {
        const judgement = judge(card(), deliverable(), [{ run: 'pnpm test src/auth', exit: 0 }]);
        expect(judgement).toMatchObject({
            taskId: 'T1',
            verdict: 'pass',
            reasons: [],
            outOfOwnership: [],
            warnings: [],
        });
        expect(judgement.checks).toEqual([
            { index: 0, check: { type: 'command', run: 'pnpm test src/auth' }, status: 'passed', detail: 'passed' },
        ]);
    });

    it('fails a done deliverable without evidence (evidence first)', () => {
        const judgement = judge(card(), deliverable({ evidence: [] }), [{ run: 'pnpm test src/auth', exit: 0 }]);
        expect(judgement.verdict).toBe('fail');
        expect(judgement.reasons).toEqual([expect.stringContaining('no evidence')]);
        const notesOnly = deliverable({ evidence: [{ type: 'note', text: 'works for me' }] });
        expect(judge(card(), notesOnly, [{ run: 'pnpm test src/auth', exit: 0 }]).verdict).toBe('fail');
        const scout = card({
            workspace: 'readonly',
            ownership: [],
            acceptance: [{ type: 'review', by: 'supervisor' }],
        });
        const facts = deliverable({
            changes: [],
            evidence: [{ type: 'note', text: 'sms is sent from src/infra/sms.ts:12' }],
        });
        expect(judge(scout, facts, [], { by: 'supervisor', verdict: 'pass', issues: [] }).verdict).toBe('pass');
    });

    it('requires a reproduction step to fail', () => {
        const repro = card({ acceptance: [{ type: 'command', run: 'pnpm test sms.repro', expect: 'fail' }] });
        const evidence = deliverable({ evidence: [{ type: 'command', run: 'pnpm test sms.repro', exit: 1 }] });
        expect(judge(repro, evidence, [{ run: 'pnpm test sms.repro', exit: 1 }]).verdict).toBe('pass');
        const judgement = judge(repro, evidence, [{ run: 'pnpm test sms.repro', exit: 0 }]);
        expect(judgement.verdict).toBe('fail');
        expect(judgement.reasons).toContain('`pnpm test sms.repro` passed, but this reproduction must fail');
        expect(judge(repro, evidence, [{ run: 'pnpm test sms.repro', exit: null }]).verdict).toBe('fail');
    });

    it('fails on a failing command and flags evidence that disagrees with the host run', () => {
        const judgement = judge(card(), deliverable(), [
            { run: 'pnpm test src/auth', exit: 1, output: 'FAIL verify.test.ts' },
        ]);
        expect(judgement.verdict).toBe('fail');
        expect(judgement.reasons).toEqual([
            "the evidence says `pnpm test src/auth` exited with 0, but the host's run exited with 1",
            '`pnpm test src/auth` exited with 1',
        ]);
        expect(judgement.checks[0]).toMatchObject({ status: 'failed', output: 'FAIL verify.test.ts' });
    });

    it('needs a person for manual checks and missing results, but a failure wins', () => {
        const pending = judge(reviewed, deliverable(), passing, approval);
        expect(pending.verdict).toBe('needs_human');
        expect(pending.reasons).toEqual(['manual check: try it on a phone']);
        expect(judge(reviewed, deliverable(), passing, approval, { manualConfirmed: true }).verdict).toBe('pass');

        const unrun = judge(reviewed, deliverable(), passing.slice(0, 1), approval, { manualConfirmed: true });
        expect(unrun).toMatchObject({
            verdict: 'needs_human',
            reasons: ['acceptance command `pnpm lint` was not run'],
        });

        const noReview = judge(reviewed, deliverable(), passing, undefined, { manualConfirmed: true });
        expect(noReview).toMatchObject({ verdict: 'needs_human', reasons: ['review by reviewer is missing'] });

        const failing = judge(
            reviewed,
            deliverable(),
            [
                { run: 'pnpm test src/auth', exit: 2 },
                { run: 'pnpm lint', exit: 0 },
            ],
            approval,
        );
        expect(failing.verdict).toBe('fail');
        expect(failing.reasons).toEqual([
            "the evidence says `pnpm test src/auth` exited with 0, but the host's run exited with 2",
            '`pnpm test src/auth` exited with 2',
            'manual check: try it on a phone',
        ]);
    });

    it('fails on a rejecting review or blocking issues, not on suggestions', () => {
        const rejected = judge(
            reviewed,
            deliverable(),
            passing,
            {
                by: 'reviewer',
                verdict: 'pass',
                issues: [
                    {
                        file: 'src/auth/sms/verify.ts',
                        line: 42,
                        problem: 'codes compared with ==',
                        fix: 'constant-time compare',
                        blocking: true,
                    },
                    { problem: 'rename x', blocking: false },
                ],
            },
            { manualConfirmed: true },
        );
        expect(rejected.verdict).toBe('fail');
        expect(rejected.reasons).toContain(
            'review: src/auth/sms/verify.ts:42: codes compared with == Fix: constant-time compare',
        );
        expect(rejected.issues).toHaveLength(1);
        const suggestions = judge(
            reviewed,
            deliverable(),
            passing,
            { by: 'reviewer', verdict: 'pass', issues: [{ problem: 'rename x', blocking: false }] },
            { manualConfirmed: true },
        );
        expect(suggestions.verdict).toBe('pass');
    });

    it('asks a person for a human review', () => {
        const human = card({ acceptance: [{ type: 'review', by: 'human' }] });
        expect(judge(human, deliverable(), [])).toMatchObject({
            verdict: 'needs_human',
            reasons: ['a person has to review the deliverable'],
        });
        expect(judge(human, deliverable(), [], { by: 'user', verdict: 'pass', issues: [] }).verdict).toBe('pass');
    });

    it('fails changes outside the ownership, preferring the real diff', () => {
        const strayed = deliverable({
            changes: [
                { file: 'src/auth/sms/verify.ts', kind: 'added' },
                { file: 'src/auth/sms/old.ts', kind: 'renamed', from: 'src/legacy/old.ts' },
            ],
        });
        const judgement = judge(card(), strayed, [{ run: 'pnpm test src/auth', exit: 0 }]);
        expect(judgement.verdict).toBe('fail');
        expect(judgement.outOfOwnership).toEqual(['src/legacy/old.ts']);
        const real = judge(card(), deliverable(), [{ run: 'pnpm test src/auth', exit: 0 }], undefined, {
            changedFiles: ['src/auth/sms/verify.ts', 'package.json'],
        });
        expect(real.outOfOwnership).toEqual(['package.json']);
    });

    it('fails partial, blocked and escalated deliverables', () => {
        const results = [{ run: 'pnpm test src/auth', exit: 0 }];
        expect(judge(card(), deliverable({ status: 'partial' }), results).reasons[0]).toMatch(
            /^the deliverable is partial/,
        );
        expect(
            judge(card(), deliverable({ status: 'blocked', openQuestions: ['who owns the key?'] }), results).reasons[0],
        ).toBe(
            'the executor is blocked: Added both endpoints; codes expire after 5 minutes; open questions: who owns the key?',
        );
        const escalated = deliverable({
            status: 'escalate',
            escalate: { to: 'standard', reason: 'design unclear', findings: [] },
        });
        expect(judge(card(), escalated, results).reasons[0]).toBe('the executor escalated to standard: design unclear');
        expect(judge(card(), deliverable({ taskId: 'T2' }), results).reasons[0]).toBe(
            'the deliverable is for task T2, not T1',
        );
    });

    it('warns about overspending and open questions', () => {
        const judgement = judge(
            card(),
            deliverable({ usage: { cost: 4.5, currency: 'CNY' }, openQuestions: ['keep the old endpoint?'] }),
            [{ run: 'pnpm test src/auth', exit: 0 }],
        );
        expect(judgement.verdict).toBe('pass');
        expect(judgement.warnings).toEqual([
            'spent 4.5 CNY of a 3 budget',
            'done with open questions: keep the old endpoint?',
        ]);
    });
});

describe('retryFeedback', () => {
    it('lists concrete fixes with command output', () => {
        const judgement = judge(
            card(),
            deliverable({ changes: [{ file: 'src/db/schema.ts', kind: 'modified' }] }),
            [{ run: 'pnpm test src/auth', exit: 1, output: 'FAIL verify.test.ts\n  expected 300 to be 600' }],
            undefined,
        );
        const feedback = retryFeedback(judgement, { failures: 1 });
        expect(feedback).toBe(
            [
                'Your deliverable for task T1 was not accepted. Fix the following and deliver again:',
                '1. `pnpm test src/auth` exited with 1. Output:',
                '```',
                'FAIL verify.test.ts',
                '  expected 300 to be 600',
                '```',
                "2. The evidence says `pnpm test src/auth` exited with 0, but the host's run exited with 1.",
                '3. You changed files outside your ownership: src/db/schema.ts. Revert them, or deliver blocked and explain why the task needs them.',
                'Run the acceptance commands again before delivering and attach their real output as evidence.',
                'This is your last attempt at this tier; if it fails too, the task moves to a stronger tier.',
            ].join('\n'),
        );
        expect(retryFeedback(judgement, { failures: 1, maxFailures: 3 })).toContain(
            'You have 2 attempts left at this tier.',
        );
    });

    it('includes blocking review issues', () => {
        const judgement = judge(card({ acceptance: [{ type: 'review', by: 'reviewer' }] }), deliverable(), [], {
            by: 'reviewer',
            verdict: 'fail',
            summary: 'unsafe compare',
            issues: [{ problem: 'codes compared with ==', blocking: true }],
        });
        const feedback = retryFeedback(judgement);
        expect(feedback).toContain('1. Review by reviewer failed: unsafe compare.');
        expect(feedback).toContain('2. Review: codes compared with ==.');
    });
});
