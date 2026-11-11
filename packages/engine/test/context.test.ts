import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Message } from '@xora/providers';
import { describe, expect, it } from 'vitest';
import { readSessionConfig } from '../src/config.ts';
import {
    applyCompaction,
    compactionCut,
    compactionMessages,
    displayState,
    mergeJudgments,
    parseProposal,
    withInstruction,
} from '../src/context/compaction.ts';
import { type Judgment, observe, renderState } from '../src/context/ledger.ts';
import { contextMessages } from '../src/context/messages.ts';
import { maskToolResults, placeholder, readOutput } from '../src/context/outputs.ts';
import { EngineSession } from '../src/session.ts';
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
        expect(observed.commands.map((command) => [command.command, command.ok])).toEqual([
            ['npm test', false],
            ['npm run lint', false],
            ['npm test', true],
        ]);
        // The test failure was fixed by the later run; the lint failure was not.
        expect(observed.failures.map((failure) => failure.what)).toEqual(['bash "npm run lint"']);
        expect(observed.failures[0]?.line).toBe('Error: lint broke');
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
        expect(state).toContain('- [x] Read the code\n- [~] Fix it');
        expect(state).toContain('- C1 Keep the schema — the user: "schema"');
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
        work(target, 'run the parts', 12);
        // 12 results of about 1000 tokens: masking 4 frees too little of a 100k budget.
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
        expect(readOutput(target, 'R0')).toEqual({ tool: 'user message', text: 'run the parts' });
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
        // Nothing fits: the state alone continues; nothing at all older: nothing to compact.
        expect(compactionCut(target, 1)).toBe(target.history.length);
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
        expect(target.narratives).toEqual(['Goal: port the parser. Done: the lexer.']);
        expect(target.summary).toContain('## How the work went\nGoal: port the parser. Done: the lexer.');
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
        expect(state).toContain('- [~] Port the lexer');
        expect(state).toContain('- C1 Keep the public API — the user: "Keep the public API."');
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
});
