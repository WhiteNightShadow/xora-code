import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Message } from '@xora/providers';
import { describe, expect, it } from 'vitest';
import { readSessionConfig } from '../src/config.ts';
import {
    applyCompaction,
    compactionCut,
    compactionMessages,
    compactionShares,
    displayState,
    mergeJudgments,
    parseProposal,
    withInstruction,
} from '../src/context/compaction.ts';
import { type Judgment, observe, renderState } from '../src/context/ledger.ts';
import { contextMessages } from '../src/context/messages.ts';
import {
    describeCall,
    maskToolResults,
    notableLine,
    placeholder,
    readOutput,
    spillToolOutput,
} from '../src/context/outputs.ts';
import { userWords } from '../src/context/tokens.ts';
import { COMPACT_AT, contextBudget, DEFAULT_WORKING_SET, MIN_ROOM } from '../src/context/window.ts';
import { EngineSession, resolveTarget } from '../src/session.ts';
import { SessionFile } from '../src/store.ts';

function session(): EngineSession {
    const dir = mkdtempSync(path.join(tmpdir(), 'xora-context-'));
    const created = new EngineSession({
        id: 's1',
        cwd: dir,
        roots: [dir],
        dir,
        config: readSessionConfig({
            xora: {
                model: { connection: { presetId: 'custom-openai', apiKey: 'k', baseUrl: 'http://x' }, model: 'm' },
            },
        }),
    });
    created.file.create({ t: 'header', v: 1, id: 's1', cwd: dir, roots: [dir], createdAt: 0 });
    return created;
}

const user = (text: string): Message => ({
    role: 'user',
    content: [
        { type: 'text', text: '<environment>\nDate: 2026-11-11\n</environment>' },
        { type: 'text', text },
    ],
});
const call = (id: string, name: string, args: Record<string, unknown>): Message => ({
    role: 'assistant',
    content: [{ type: 'tool_call', id, name, arguments: JSON.stringify(args) }],
    provider: 'p',
    model: 'm',
});
const result = (id: string, name: string, text: string, isError = false): Message => ({
    role: 'tool',
    toolCallId: id,
    toolName: name,
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
});
const answer = (text: string): Message => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'p',
    model: 'm',
});

/** A turn: the user's request, then `steps` tool calls each with a large result. */
function work(target: EngineSession, request: string, steps: number, size = 4000): void {
    target.append(user(request));
    for (let step = 0; step < steps; step++) {
        const id = `c${target.history.length}`;
        target.append(call(id, 'bash', { command: `npm test -- part ${step}` }));
        target.append(result(id, 'bash', `ok part ${step}\n${'x'.repeat(size)}`));
    }
}

describe('what the review of 2026-11-11 found', () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

    it('never splits an emoji where it cuts text short', () => {
        const line = `${'x'.repeat(119)}🚀 deployed`;
        expect(lone.test(notableLine(line, false))).toBe(false);
        const call = {
            type: 'tool_call' as const,
            id: 'a',
            name: 'bash',
            arguments: JSON.stringify({ command: `${'y'.repeat(79)}🚀🚀` }),
        };
        expect(lone.test(describeCall(call))).toBe(false);
        const target = session();
        target.append(user(`${'字'.repeat(10)}🚀`.repeat(400)));
        target.append(answer('ok'));
        applyCompaction(target, target.history.length, { level: 3, jobs: [], requestTokens: 37 });
        expect(lone.test(target.summary ?? '')).toBe(false);
    });

    it('keeps what the model has not seen, however large, and lists every other tool that ran', () => {
        const target = session();
        target.append(user('file a jira issue and look around'));
        target.append({
            role: 'assistant',
            content: [
                { type: 'tool_call', id: 'g', name: 'grep', arguments: JSON.stringify({ pattern: 'TODO' }) },
                {
                    type: 'tool_call',
                    id: 'j',
                    name: 'mcp__jira__create_issue',
                    arguments: JSON.stringify({ title: 'Broken login' }),
                },
            ],
            provider: 'p',
            model: 'm',
        });
        target.append(result('g', 'grep', 'a.ts:1: TODO'.repeat(4000)));
        target.append(result('j', 'mcp__jira__create_issue', 'Created ABC-12'));
        // The latest step alone is over any tail: it stays, as the model has not seen its results.
        expect(compactionCut(target, 100)).toBeUndefined();
        target.append(answer('Filed ABC-12.'));
        target.append(user('now fix it'));
        const cut = compactionCut(target, 10) ?? 0;
        expect(target.history[cut]?.role).toBe('user');
        applyCompaction(target, cut, { level: 3, jobs: [], requestTokens: 20_000 });
        const state = target.summary ?? '';
        expect(state).toContain('## Other tool calls, latest last');
        expect(state).toMatch(/#R3 `mcp__jira__create_issue "Broken login"` → ok · Created ABC-12/);
        expect(state).toMatch(/#R2 `grep "TODO"` → ok/);
        expect(state).toContain('Your latest reply before this state is #R4.');
    });

    it('compacts nothing when everything after the first message of the context fits', () => {
        const target = session();
        work(target, 'go', 3, 100);
        applyCompaction(target, 1, { level: 3, jobs: [], requestTokens: 20_000 });
        expect(target.history[target.contextStart]?.role).toBe('assistant');
        expect(compactionCut(target, 1_000_000)).toBeUndefined();
    });

    it('counts the system prompt and the tool definitions, and leaves the conversation room beside them', () => {
        const target = session();
        // By default, a model uses its full supported context window minus output reserve.
        const model = {
            ...resolveTarget(target.config.model),
            model: { ...resolveTarget(target.config.model).model, contextWindow: 1_000_000, maxOutput: 32_000 },
        };
        expect(contextBudget(target, model, 5_000)).toBe(1_000_000 - 32_000);
        const binaryMillion = {
            ...model,
            model: { ...model.model, contextWindow: DEFAULT_WORKING_SET, maxOutput: 32_000 },
        };
        expect(contextBudget(target, binaryMillion, 5_000)).toBe(DEFAULT_WORKING_SET - 32_000);
        // Reserve comes out of the hard window on smaller models too.
        const tight = { ...model, model: { ...model.model, contextWindow: 200_000, maxOutput: 32_000 } };
        expect(contextBudget(target, tight, 5_000)).toBe(200_000 - 32_000);
        // When an explicit workingSet cap is configured, heavy fixed tokens still leave MIN_ROOM below COMPACT_AT.
        const capped = session();
        capped.config = { ...capped.config, workingSet: 256_000 };
        const plain = contextBudget(capped, model, 5_000);
        expect(plain).toBe(256_000);
        const heavy = contextBudget(capped, model, 210_000);
        expect(heavy).toBeGreaterThan(plain);
        expect(heavy * COMPACT_AT - 210_000).toBeGreaterThanOrEqual(MIN_ROOM - 1);
        // Shares are of the conversation's room, not of the fixed part.
        const shares = compactionShares({ budget: heavy, fixed: 210_000, used: 240_000, estimated: 240_000 });
        expect(shares.tail).toBeGreaterThan(0);
        expect(shares.tail).toBeLessThanOrEqual(30_000 * 0.25);
    });

    it('starts over from the host’s account: what came before stays out, the account stays whole', () => {
        const target = session();
        work(target, 'plan the run', 2, 100);
        target.append(result('x', 'bash', 'Error: npm test failed', true));
        const account = `<run_state>${'card '.repeat(1_000)}</run_state>`;
        // As TurnRunner.run({ fresh }) does it.
        target.startFrom({
            contextStart: target.history.length,
            summary: account,
            base: account,
            ledgerFrom: target.history.length,
            judgments: [],
            narratives: [],
            compactions: 0,
        });
        target.file.append({
            t: 'compaction',
            ts: 0,
            level: 3,
            summary: account,
            keepFrom: target.history.length,
            tokensBefore: 0,
            tokensAfter: 0,
            fresh: true,
        });
        work(target, '<team_update>card 3 done</team_update>', 2, 100);
        applyCompaction(target, target.history.length, { level: 3, jobs: [], requestTokens: 20_000 });
        const state = target.summary ?? '';
        expect(state).not.toContain('plan the run');
        expect(state).not.toContain('npm test failed');
        expect(state).toContain('card card card');
        expect(target.compactions).toBe(1);
        const restored = new EngineSession({ ...target, config: target.config });
        restored.restore(new SessionFile(target.dir).read());
        expect(restored.compactions).toBe(1);
        expect(restored.ledgerFrom).toBe(target.ledgerFrom);
        expect(restored.base).toBe(account);
    });

    it('reads the ledger item by item: a bad item is dropped, the rest still count', () => {
        const history = [user('Never touch the schema.')];
        const earlier: Judgment[] = [
            { id: 'Q1', kind: 'question', text: 'Which DB?', status: 'open', at: 1 },
            { id: 'D2', kind: 'decision', text: 'Use sqlite', status: 'open', at: 1 },
        ];
        const proposal = parseProposal(`<ledger>
\`\`\`json
{"add": [{"kind": "constraint", "text": "Schema is frozen", "quote": "Never touch the schema."},
         {"kind": "fact", "text": "<one sentence>"}, {"kind": "deadend", "text": "..."}],
 "close": [{"id": "Q1", "status": "已解决"}, {"id": "D2", "status": "maybe"}, null, {"id": "Q4", "status": "done"}]}
\`\`\`
That is all.
</ledger>`);
        const merged = mergeJudgments(earlier, proposal.delta, history, 2);
        expect(merged.judgments.map((item) => [item.id, item.status])).toEqual([
            ['Q1', 'done'],
            ['D2', 'open'],
            ['C3', 'open'],
        ]);
        // Two placeholders, a status nobody knows, a null and an id that is not there.
        expect(merged.rejected).toBe(5);
        expect(parseProposal('<ledger>{"add": [], "close": null}</ledger>').delta).toEqual({ add: [], close: [] });
    });

    it('takes neither host notes nor attached files for the words of a message', () => {
        const words = userWords([
            { type: 'text', text: 'Fix the bug' },
            { type: 'text', text: '<file uri="file:///big.log">\nthousands of lines\n</file>' },
            { type: 'text', text: '<host_note>\nHow things stand…\n</host_note>' },
        ]);
        expect(words).toBe('Fix the bug\n[attached file file:///big.log]');
        // One long message leaves room for the others.
        const target = session();
        target.append(user('first: keep the API'));
        target.append(answer('ok'));
        target.append(user(`log: ${'line\n'.repeat(20_000)}`));
        target.append(answer('ok'));
        target.append(user('last request'));
        applyCompaction(target, target.history.length, { level: 3, jobs: [], requestTokens: 20_000 });
        const state = target.summary ?? '';
        expect(state).toContain('first: keep the API');
        expect(state).toContain('tool_output("R2") returns the whole message');
    });

    it('keeps the latest failure of a call last, reads renames in patches and one path either way', () => {
        const history: Message[] = [
            user('go'),
            call('a', 'bash', { command: 'make' }),
            result('a', 'bash', 'Error: one', true),
            call('b', 'bash', { command: 'lint' }),
            result('b', 'bash', 'Error: lint', true),
            call('c', 'bash', { command: 'make' }),
            result('c', 'bash', 'Error: two', true),
            call('d', 'apply_patch', {
                patch: '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to:src/b.ts\n*** End Patch',
            }),
            result('d', 'apply_patch', 'done'),
            call('e', 'read', { path: '/work/src/b.ts' }),
            result('e', 'read', 'x'),
        ];
        const observed = observe(history, 0, '/work');
        expect(observed.failures.map((failure) => failure.line)).toEqual(['Error: lint', 'Error: two']);
        // Relative to the working directory in the platform's own form: `src\b.ts` on Windows, one entry either way.
        expect(observed.files.map((file) => [file.path, file.reads, file.edits])).toEqual([
            [path.join('src', 'b.ts'), 1, 1],
            [path.join('src', 'a.ts'), 0, 1],
        ]);
    });
});

describe('the ledger', () => {
    it('records what the history shows: requests, files, commands and failures until fixed', () => {
        const history: Message[] = [
            user('Fix the login bug. Do not touch the database schema.'),
            call('a', 'read', { path: 'src/login.ts' }),
            result('a', 'read', '1\texport function login() {}'),
            call('b', 'edit', { path: 'src/login.ts', oldString: 'a', newString: 'b' }),
            result('b', 'edit', 'Edited src/login.ts'),
            call('c', 'bash', { command: 'npm test' }),
            result('c', 'bash', 'FAIL src/login.test.ts\nError: expected 200, got 500', true),
            call('d', 'bash', { command: 'npm run lint' }),
            result('d', 'bash', 'Error: lint broke', true),
            call('e', 'bash', { command: 'npm test' }),
            result('e', 'bash', 'all 12 passed'),
            call('f', 'apply_patch', { patch: '*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** End Patch' }),
            result('f', 'apply_patch', 'done'),
        ];
        const observed = observe(history);
        expect(observed.requests).toEqual([{ index: 0, text: 'Fix the login bug. Do not touch the database schema.' }]);
        expect(observed.files.map((file) => [file.path, file.reads, file.edits])).toEqual([
            ['src/new.ts', 0, 1],
            ['src/login.ts', 1, 1],
        ]);
        expect(observed.commands.map((command) => [command.what, command.ok])).toEqual([
            ['npm test', false],
            ['npm run lint', false],
            ['npm test', true],
        ]);
        // The test failure was fixed by the later run; the lint failure was not.
        expect(observed.failures.map((failure) => failure.what)).toEqual(['bash "npm run lint"']);
        expect(observed.failures[0]?.line).toBe('Error: lint broke');
    });

    it('follows a command that was left running to how its job ended', () => {
        const left = (job: string): string =>
            `building…\n\nThe command is still running after 2m 0s: it was not stopped and carries on in the background as ${job}. What is above is its output so far, not its result. Wait for it with bash_output (jobId "${job}" and waitMs, up to 600000), or stop it with bash_kill.`;
        const history: Message[] = [
            user('Run the tests and the build.'),
            call('a', 'bash', { command: 'pnpm test' }),
            result('a', 'bash', left('job-1')),
            call('b', 'bash', { command: 'pnpm build' }),
            result('b', 'bash', left('job-2')),
            call('c', 'bash', { command: 'pnpm dev', background: true }),
            result(
                'c',
                'bash',
                'Started background job job-3. Read its output with bash_output (jobId "job-3") and stop it with bash_kill.',
            ),
            call('d', 'bash', { command: 'pnpm lint' }),
            result('d', 'bash', left('job-4')),
            call('e', 'bash_output', { jobId: 'job-1', waitMs: 600000 }),
            result(
                'e',
                'bash_output',
                'Job job-1 is running (started 12m 0s ago).\nNo new output since the last check.',
            ),
            call('f', 'bash_output', { jobId: 'job-1', waitMs: 600000 }),
            result(
                'f',
                'bash_output',
                'Job job-1 exited with code 1 after 14m 2s.\nNew output since the last check:\nFAIL src/a.test.ts',
                true,
            ),
            call('g', 'bash_output', { jobId: 'job-2' }),
            result(
                'g',
                'bash_output',
                'Job job-2 exited with code 0 after 3m 1s.\nNew output since the last check:\nbuilt in 181s',
            ),
            call('h', 'bash_kill', { jobId: 'job-3' }),
            result('h', 'bash_kill', 'Stopped job job-3.'),
        ];
        const observed = observe(history);
        expect(observed.commands).toEqual([
            { index: 12, what: 'pnpm test', ok: false, line: 'FAIL src/a.test.ts' },
            { index: 14, what: 'pnpm build', ok: true, line: 'Job job-2 exited with code 0 after 3m 1s.' },
            { index: 16, what: 'pnpm dev', ok: true, line: 'Stopped job job-3.', stopped: true },
            { index: 8, what: 'pnpm lint', ok: true, line: 'building…', job: 'job-4' },
        ]);
        // The test run failed, though the call that started it did not.
        expect(observed.failures).toEqual([
            { index: 12, what: 'bash "pnpm test"', ok: false, line: 'FAIL src/a.test.ts' },
        ]);
        expect(observed.others).toEqual([]);
        const state = renderState({
            observed,
            plan: [],
            judgments: [],
            narratives: [],
            jobs: [],
            compactions: 1,
            keptFrom: history.length,
            requestTokens: 1000,
        });
        expect(state).toContain('- #R12 `pnpm test` → failed · FAIL src/a.test.ts');
        expect(state).toContain('- #R16 `pnpm dev` → stopped · Stopped job job-3.');
        expect(state).toContain('- #R8 `pnpm lint` → running on as job-4, no result yet · building…');
        // Masked, the output so far is not passed off as a result either.
        const masked = history[2] as Extract<Message, { role: 'tool' }>;
        expect(placeholder(2, masked, undefined)).toContain('#R2 bash · running on as job-1, no result yet · ');
    });

    it('renders the same state for the same records, the newest request first, never dropping the latest', () => {
        const history: Message[] = [user('first request'), answer('done'), user(`second ${'字'.repeat(300)}`)];
        const parts = {
            observed: observe(history),
            plan: [
                { content: 'Read the code', status: 'completed' as const },
                { content: 'Fix it', status: 'in_progress' as const },
            ],
            judgments: [
                { id: 'C1', kind: 'constraint', text: 'Keep the schema', status: 'open', quote: 'schema', at: 1 },
                { id: 'Q2', kind: 'question', text: 'Old question', status: 'done', at: 1 },
            ] satisfies Judgment[],
            narratives: ['Tried X first.'],
            jobs: ['job-1: `npm run dev`'],
            compactions: 3,
            keptFrom: history.length,
            requestTokens: 100,
        };
        const state = renderState(parts);
        expect(renderState(parts)).toBe(state);
        expect(state.startsWith('<task_state>')).toBe(true);
        // Over the budget: the newest is cut with its reference, the older one is left out with its reference.
        expect(state).toContain('- #R2 second 字');
        expect(state).toContain('[cut for room; tool_output("R2") returns the whole message]');
        expect(state).toContain('1 older message(s) left out for room: #R0');
        expect(state).toContain('## Plan (the todo list)\n[x] Read the code\n[~] Fix it');
        expect(state).toContain('- C1 Keep the schema — quoted: "schema"');
        expect(state).not.toContain('Old question');
        expect(state).toContain('job-1');
        expect(state).toContain('Tried X first.');
        expect(state).toContain('compacted 3 times');
        expect(displayState(state).startsWith('##')).toBe(true);
        expect(displayState(state)).not.toContain('task_state');
    });
});

describe('masking', () => {
    it('masks older results all at once to references the tool gives back, then holds until a compaction', () => {
        const target = session();
        work(target, 'run the parts', 16);
        // 16 results of about 1000 tokens: masking 4 frees too little of a 100k budget.
        expect(maskToolResults(target, 100_000)).toBe(false);
        expect(maskToolResults(target, 15_000)).toBe(true);
        const messages = contextMessages(target);
        const masked = messages.filter(
            (message) => message.role === 'tool' && JSON.stringify(message.content).includes('masked'),
        );
        expect(masked).toHaveLength(4);
        const first = masked[0];
        const text = first?.content[0]?.type === 'text' ? first.content[0].text : '';
        expect(text).toMatch(/^\[#R2 bash "npm test -- part 0" · ok · 4\.\dk chars · ok part 0 — masked/);
        expect(readOutput(target, '#R2')?.text).toContain('x'.repeat(4000));
        expect(readOutput(target, 'R0')).toMatchObject({
            tool: 'message',
            text: expect.stringContaining('run the parts'),
        });
        expect(readOutput(target, 'R1')).toBeUndefined();
        // Frozen: more results do not mask again until the next compaction.
        work(target, 'more', 8);
        expect(maskToolResults(target, 15_000)).toBe(false);
        const restored = new EngineSession({ ...target, config: target.config });
        restored.restore(new SessionFile(target.dir).read());
        expect(restored.prunedUpTo).toBe(target.prunedUpTo);
        expect(restored.maskFrozen).toBe(true);
    });

    it('keeps the first error of a failed result in its reference', () => {
        const failed = result('x', 'bash', 'building\nerror TS2304: Cannot find name foo\nmore', true);
        expect(placeholder(5, failed as Extract<Message, { role: 'tool' }>, undefined)).toContain(
            'failed · 48 chars · error TS2304: Cannot find name foo',
        );
    });
});

describe('compaction', () => {
    it('cuts before a step or a request, never between a call and its result', () => {
        const target = session();
        work(target, 'go', 6, 400);
        const cut = compactionCut(target, 300);
        expect(cut).toBeDefined();
        expect(target.history[cut ?? 0]?.role).toBe('assistant');
        // Nothing fits: what the model has not seen yet still stays, its latest call with the results.
        expect(compactionCut(target, 1)).toBe(target.history.length - 2);
        // Everything fits: nothing to compact.
        expect(compactionCut(target, 1_000_000)).toBeUndefined();
        const empty = session();
        empty.append(user('hi'));
        empty.append(user(`a long paste ${'x'.repeat(8000)}`));
        expect(compactionCut(empty, 1)).toBeUndefined();
    });

    it('puts the instruction at the end without a user message straight after tool results', () => {
        const tail = withInstruction([user('a'), call('c', 'read', {}), result('c', 'read', 'r')], 'INSTRUCTION');
        expect(tail).toHaveLength(3);
        expect(JSON.stringify(tail[2])).toContain('INSTRUCTION');
        expect(tail[2]?.role).toBe('tool');
        const after = withInstruction([user('a'), answer('b')], 'INSTRUCTION');
        expect(after.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'INSTRUCTION' }] });
    });

    it('asks in the same request the model would have made next', () => {
        const target = session();
        work(target, 'go', 3, 100);
        const plain = contextMessages(target);
        const asked = compactionMessages(target, 'keep the numbers');
        expect(asked.slice(0, -1)).toEqual(plain.slice(0, -1));
        expect(JSON.stringify(asked.at(-1))).toContain('The user asked to keep in particular: keep the numbers');
    });

    it('reads the model part, keeps quoted constraints only, and gives ids of its own', () => {
        const history = [user('Use pnpm, never npm. Ship by Friday.')];
        const proposal = parseProposal(`thinking out loud
<narrative>
Switched to pnpm after npm broke the lockfile.
</narrative>
<ledger>
\`\`\`json
{"add": [
  {"kind": "constraint", "text": "Use pnpm", "quote": "Use pnpm,  never npm."},
  {"kind": "constraint", "text": "Write tests first", "quote": "always write tests first"},
  {"kind": "decision", "text": "Pin node 24", "why": "the CI image has it"},
  {"kind": "question", "text": "Which registry?"},
  {"kind": "bogus", "text": "x"}
], "close": [{"id": "q9", "status": "done"}]}
\`\`\`
</ledger>`);
        expect(proposal.narrative).toBe('Switched to pnpm after npm broke the lockfile.');
        const earlier: Judgment[] = [{ id: 'Q9', kind: 'question', text: 'Which version?', status: 'open', at: 1 }];
        const merged = mergeJudgments(earlier, proposal.delta, history, 2);
        expect(merged.rejected).toBe(2);
        expect(merged.judgments.map((item) => [item.id, item.status, item.text])).toEqual([
            ['Q9', 'done', 'Which version?'],
            ['C2', 'open', 'Use pnpm'],
            ['D3', 'open', 'Pin node 24'],
            ['Q4', 'open', 'Which registry?'],
        ]);
        expect(merged.judgments[2]?.why).toBe('the CI image has it');
        // Malformed ledgers add nothing; the narrative alone still counts.
        expect(parseProposal('<narrative>n</narrative><ledger>{oops</ledger>')).toEqual({
            narrative: 'n',
            delta: undefined,
        });
    });

    it('keeps a summary written before the state as the earliest account', () => {
        const target = session();
        work(target, 'old work', 2, 100);
        target.summary = 'Goal: port the parser. Done: the lexer.';
        target.contextStart = 2;
        work(target, 'new work', 3, 100);
        applyCompaction(target, target.history.length, { level: 4, jobs: [], requestTokens: 20_000 });
        expect(target.base).toBe('Goal: port the parser. Done: the lexer.');
        expect(target.summary).toContain(
            '## Where the work stood when this conversation last started over\nGoal: port the parser. Done: the lexer.',
        );
        // It stays the account the next states start from, whatever comes after.
        work(target, 'more work', 2, 100);
        applyCompaction(target, target.history.length, { level: 3, jobs: [], requestTokens: 20_000 });
        expect(target.summary).toContain('Goal: port the parser. Done: the lexer.');
    });

    it('starts the context from the state, survives a restart, and goes back with a rewind', () => {
        const target = session();
        target.beginTurn('t1');
        work(target, 'Port the parser to rust. Keep the public API.', 6, 2000);
        target.setTodos([{ content: 'Port the lexer', status: 'in_progress' }]);
        const cut = compactionCut(target, 1_500) ?? 0;
        const result = applyCompaction(target, cut, {
            level: 3,
            answer: '<narrative>Lexer half done.</narrative><ledger>{"add":[{"kind":"constraint","text":"Keep the public API","quote":"Keep the public API."}]}</ledger>',
            jobs: [],
            requestTokens: 20_000,
        });
        expect(result.judged).toBe(true);
        expect(result.after).toBeLessThan(result.before);
        const first = contextMessages(target)[0];
        const state = first?.content[0]?.type === 'text' ? first.content[0].text : '';
        expect(state).toContain('- #R0 Port the parser to rust. Keep the public API.');
        expect(state).toContain('[~] Port the lexer');
        expect(state).toContain('- C1 Keep the public API — quoted: "Keep the public API."');
        expect(state).toContain('Lexer half done.');
        expect(state).toMatch(/#R\d+ `npm test -- part \d` → ok/);
        expect(target.maskFrozen).toBe(false);

        const restored = new EngineSession({ ...target, config: target.config });
        restored.restore(new SessionFile(target.dir).read());
        expect(restored.summary).toBe(target.summary);
        expect(restored.judgments).toEqual(target.judgments);
        expect(restored.narratives).toEqual(['Lexer half done.']);
        expect(restored.compactions).toBe(1);

        target.beginTurn('t2');
        work(target, 'next', 1);
        applyCompaction(target, target.history.length, { level: 4, jobs: [], requestTokens: 20_000 });
        expect(target.compactions).toBe(2);
        expect(target.rewind('t2')).toBe(true);
        expect(target.compactions).toBe(1);
        expect(target.summary).toBe(restored.summary);
    });

    it('spills large tool outputs to R<index>.txt with structured preview and lossless recall, and cleans up on rewind', () => {
        const target = session();
        target.beginTurn('t1');
        target.append(user('run full test suite'));

        target.beginTurn('t2');
        target.append(call('c1', 'bash', { command: 'pnpm test' }));
        const fullLines = Array.from({ length: 800 }, (_, i) =>
            i === 419
                ? 'FATAL Error: port 5432 already in use by orphan container'
                : `step ${i + 1}: ${'build-output-segment-'.repeat(3)}`,
        );
        const fullText = fullLines.join('\n');
        expect(fullText.length).toBeGreaterThan(40_000);

        const idx = target.history.length;
        const preview = spillToolOutput(target, idx, 'bash', fullText.slice(0, 30_000), fullText);
        target.append(result('c1', 'bash', preview));

        expect(preview.length).toBeLessThan(12_000);
        expect(preview).toContain('step 1:');
        expect(preview).toContain('L420: FATAL Error: port 5432 already in use by orphan container');
        expect(preview).toContain('step 800:');
        expect(preview).toContain(`#R${idx}`);
        expect(existsSync(path.join(target.outputsDir, `R${idx}.txt`))).toBe(true);

        // readOutput returns the complete un-truncated 800-line text from disk, including ordinary middle lines.
        const recalled = readOutput(target, `R${idx}`);
        expect(recalled?.tool).toBe('bash');
        expect(recalled?.text).toBe(fullText);
        expect(recalled?.text).toContain('step 350:');

        // Task ledger still observes the failure line accurately from the structured preview.
        const observed = observe(target.history);
        expect(observed.commands[0]?.ok).toBe(true);

        // Rewinding t2 cleans up spilled R<idx>.txt on disk.
        expect(target.rewind('t2')).toBe(true);
        expect(existsSync(path.join(target.outputsDir, `R${idx}.txt`))).toBe(false);
    });

    it('surfaces newly validated ledger facts, constraints, and deadends from applyCompaction', () => {
        const target = session();
        target.beginTurn('t1');
        work(target, 'Keep Node 22 compatibility.', 4, 1500);
        const cut = compactionCut(target, 1_000) ?? target.history.length;
        const res = applyCompaction(target, cut, {
            level: 3,
            answer: [
                '<narrative>Verified tests.</narrative>',
                '<ledger>{"add":[',
                '{"kind":"constraint","text":"Keep Node 22 compatibility","quote":"Keep Node 22 compatibility."},',
                '{"kind":"deadend","text":"Vitest threads pool hangs with sqlite","why":"switch to forks pool"}',
                ']}</ledger>',
            ].join(''),
            jobs: [],
            requestTokens: 10_000,
        });
        expect(res.added.map((entry) => [entry.kind, entry.text])).toEqual([
            ['constraint', 'Keep Node 22 compatibility'],
            ['deadend', 'Vitest threads pool hangs with sqlite'],
        ]);
    });
});
