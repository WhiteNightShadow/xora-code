import { describe, expect, it } from 'vitest';
import { DeliverableSchema, parseDeliverable, parseReview, TaskCardSchema } from '../src/index.ts';
import { cardInput } from './helpers.ts';

describe('TaskCardSchema', () => {
    it('accepts the card of 06 §6 and fills empty lists', () => {
        const parsed = TaskCardSchema.parse({
            id: 'T3',
            title: '后端：短信验证码发送与校验接口',
            goal: '新增发送和校验接口，带过期和防重放',
            category: 'Coding',
            tier: 'economy',
            assignee: 'coder-1',
            dependsOn: ['T1'],
            context: { files: ['src/auth/**'], facts: ['短信封装在src/infra/sms.ts'] },
            ownership: ['src/auth/sms/**', 'src/routes/auth.ts'],
            constraints: ['不改公共接口的已有字段'],
            acceptance: [
                { type: 'command', run: 'pnpm test src/auth' },
                { type: 'review', by: 'reviewer' },
            ],
            deliverable: { kind: 'code-change', artifacts: ['diff', 'testReport'] },
            budget: { cost: 3, currency: 'CNY', maxTurns: 40 },
            workspace: 'worktree',
        });
        expect(parsed.category).toBe('coding');
        expect(parsed.context.links).toEqual([]);
        expect(parsed.acceptance[0]).toEqual({ type: 'command', run: 'pnpm test src/auth' });
    });

    it('defaults lists, context and currency', () => {
        const parsed = TaskCardSchema.parse({
            id: 'scout-1',
            title: 'Find the sms wrapper',
            goal: 'Where is sms sent from?',
            category: 'research',
            tier: 'fast',
            deliverable: { kind: 'facts' },
            budget: { cost: 0.5 },
            workspace: 'readonly',
        });
        expect(parsed).toMatchObject({
            dependsOn: [],
            ownership: [],
            constraints: [],
            acceptance: [],
            context: { files: [], facts: [], links: [] },
            deliverable: { kind: 'facts', artifacts: [] },
            budget: { cost: 0.5, currency: 'CNY' },
        });
    });

    it.each([
        ['an id with spaces', { id: 'task one' }],
        ['an unknown tier', { tier: 'premium' }],
        ['a negative budget', { budget: { cost: -1 } }],
        ['an unknown workspace', { workspace: 'remote' }],
        ['an empty goal', { goal: '   ' }],
        ['a command check without a command', { acceptance: [{ type: 'command', run: '' }] }],
    ])('rejects %s', (_, fields) => {
        expect(TaskCardSchema.safeParse(cardInput(fields as never)).success).toBe(false);
    });
});

describe('DeliverableSchema', () => {
    it('requires escalate details when the status is escalate', () => {
        const result = DeliverableSchema.safeParse({ taskId: 'T1', status: 'escalate', summary: 'too hard' });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.path).toEqual(['escalate']);
    });
});

const DELIVERABLE = `{
  "taskId": "T3",
  "status": "done",
  "summary": "新增两个接口，验证码5分钟过期",
  "changes": [{ "file": "src/auth/sms/verify.ts", "kind": "added" }],
  "evidence": [{ "type": "command", "run": "pnpm test src/auth", "exit": 0 }],
  "risks": ["短信服务商的错误码没有全部映射"],
  "openQuestions": [],
  "escalate": null,
  "usage": { "cost": 1.2, "currency": "CNY" }
}`;

describe('parseDeliverable', () => {
    it('reads a fenced json block surrounded by prose', () => {
        const text = `All done. Here is the deliverable:\n\n\`\`\`json\n${DELIVERABLE}\n\`\`\`\n\nLet me know if anything else is needed.`;
        const result = parseDeliverable(text);
        expect(result.ok).toBe(true);
        expect(result.ok && result.deliverable).toMatchObject({
            taskId: 'T3',
            status: 'done',
            usage: { cost: 1.2, currency: 'CNY' },
            risks: ['短信服务商的错误码没有全部映射'],
        });
    });

    it('reads a bare object with comments and trailing commas', () => {
        const text = `Summary first.\n{\n  // the task\n  "taskId": "T3", "status": "done", "summary": "ok",\n  "evidence": [{"type": "diff"},],\n}\nThanks!`;
        const result = parseDeliverable(text);
        expect(result.ok && result.deliverable.evidence).toEqual([{ type: 'diff' }]);
    });

    it('prefers the last deliverable over an earlier example', () => {
        const example = '```json\n{"taskId": "EXAMPLE", "status": "partial", "summary": "example"}\n```';
        const text = `The format is:\n${example}\nAnd mine:\n\`\`\`json\n${DELIVERABLE}\n\`\`\``;
        const result = parseDeliverable(text);
        expect(result.ok && result.deliverable.taskId).toBe('T3');
    });

    it('unwraps {"deliverable": …} and normalises common synonyms', () => {
        const text = JSON.stringify({
            deliverable: {
                status: 'Completed',
                summary: 'done',
                changes: ['src/a.ts', { path: 'src/b.ts', kind: 'created' }, { file: 'src/c.ts', type: 'Removed' }],
                evidence: [
                    { type: 'test', command: 'pnpm test', exitCode: '0', output: ['ok', '3 passed'] },
                    'checked the log by hand',
                ],
                risks: 'one risk',
                escalate: 'none',
            },
        });
        const result = parseDeliverable(text, { taskId: 'T9' });
        expect(result.ok).toBe(true);
        expect(result.ok && result.deliverable).toMatchObject({
            taskId: 'T9',
            status: 'done',
            changes: [
                { file: 'src/a.ts', kind: 'modified' },
                { file: 'src/b.ts', kind: 'added' },
                { file: 'src/c.ts', kind: 'deleted' },
            ],
            evidence: [
                { type: 'command', run: 'pnpm test', exit: 0, output: 'ok\n3 passed' },
                { type: 'note', text: 'checked the log by hand' },
            ],
            risks: ['one risk'],
            escalate: null,
        });
    });

    it('reads an escalation with findings', () => {
        const text = `I could not finish.\n\`\`\`json\n${JSON.stringify({
            taskId: 'T3',
            status: 'escalated',
            summary: 'the replay protection needs a design decision',
            escalate: { to: 'Standard', reason: 'design unclear', findings: 'tokens are stored in redis' },
        })}\n\`\`\``;
        const result = parseDeliverable(text);
        expect(result.ok && result.deliverable).toMatchObject({
            status: 'escalate',
            escalate: { to: 'standard', reason: 'design unclear', findings: ['tokens are stored in redis'] },
        });
    });

    it('turns a bare ESCALATE line into an escalation when the task is known', () => {
        const text = 'Tried twice, the race is in the queue code.\n\n**ESCALATE: flagship — needs a deeper look**';
        const result = parseDeliverable(text, { taskId: 'T4' });
        expect(result.ok && result.deliverable).toMatchObject({
            taskId: 'T4',
            status: 'escalate',
            summary: 'needs a deeper look',
            escalate: { to: 'flagship', findings: ['Tried twice, the race is in the queue code.'] },
        });
        expect(parseDeliverable(text).ok).toBe(false);
    });

    it('rejects a deliverable for another task', () => {
        const result = parseDeliverable(DELIVERABLE, { taskId: 'T4' });
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.kind).toBe('task_mismatch');
    });

    it('reports no_json, invalid_json and invalid with typed errors', () => {
        const none = parseDeliverable('I finished the task, everything works.');
        expect(!none.ok && none.error.kind).toBe('no_json');

        const malformed = parseDeliverable('```json\n{"taskId": "T1", "status": "done", "summary": }\n```');
        expect(!malformed.ok && malformed.error.kind).toBe('invalid_json');

        const invalid = parseDeliverable('```json\n{"taskId": "T1", "status": "finished-ish", "summary": "x"}\n```');
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
            expect(invalid.error.kind).toBe('invalid');
            expect(invalid.error.issues.some((issue) => issue.startsWith('status:'))).toBe(true);
            expect(invalid.error.candidate).toContain('finished-ish');
        }
    });

    it('ignores braces in prose', () => {
        const text =
            'Use the {placeholder} syntax, then:\n{"taskId": "T1", "status": "blocked", "summary": "need access", "openQuestions": ["who owns the sms key?"]}';
        const result = parseDeliverable(text);
        expect(result.ok && result.deliverable.openQuestions).toEqual(['who owns the sms key?']);
    });

    it('keeps odd evidence as notes instead of failing', () => {
        const result = parseDeliverable(
            JSON.stringify({
                taskId: 'T1',
                status: 'done',
                summary: 'x',
                evidence: [
                    { type: 'link', url: 'https://example.com/run/1' },
                    { type: 'test', passed: true },
                    { type: 'diff', files: 2 },
                ],
            }),
        );
        expect(result.ok && result.deliverable.evidence).toEqual([
            { type: 'note', text: '{"type":"link","url":"https://example.com/run/1"}' },
            { type: 'note', text: '{"type":"test","passed":true}' },
            { type: 'diff' },
        ]);
    });

    it('drops malformed self-reported usage instead of failing', () => {
        const result = parseDeliverable(
            '{"taskId": "T1", "status": "done", "summary": "x", "usage": {"cost": "a lot"}}',
        );
        expect(result.ok && result.deliverable.usage).toBeUndefined();
    });
});

describe('parseReview', () => {
    it('reads a verdict with issues and severities', () => {
        const text = `Reviewed.\n\`\`\`json\n${JSON.stringify({
            verdict: 'Request changes',
            summary: 'codes are compared unsafely',
            issues: [
                { file: 'src/auth/sms/verify.ts', line: '42', problem: 'uses ==', fix: 'constant-time compare' },
                { message: 'rename a variable', severity: 'nit' },
                'missing test for expiry',
            ],
        })}\n\`\`\``;
        const result = parseReview(text);
        expect(result.ok).toBe(true);
        expect(result.ok && result.review).toEqual({
            verdict: 'fail',
            summary: 'codes are compared unsafely',
            issues: [
                {
                    file: 'src/auth/sms/verify.ts',
                    line: 42,
                    problem: 'uses ==',
                    fix: 'constant-time compare',
                    blocking: true,
                },
                { problem: 'rename a variable', blocking: false },
                { problem: 'missing test for expiry', blocking: true },
            ],
        });
    });

    it('accepts approved: true and LGTM', () => {
        expect(parseReview('{"approved": true}').ok && parseReview('{"approved": true}')).toMatchObject({
            review: { verdict: 'pass', issues: [] },
        });
        const lgtm = parseReview('{"verdict": "LGTM", "issues": []}');
        expect(lgtm.ok && lgtm.review.verdict).toBe('pass');
    });

    it('fails without a verdict', () => {
        const result = parseReview('{"summary": "looks fine"}');
        expect(!result.ok && result.error.kind).toBe('invalid');
    });
});
