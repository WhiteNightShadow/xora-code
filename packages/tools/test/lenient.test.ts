import { describe, expect, it } from 'vitest';
import {
    bashKillTool,
    bashOutputTool,
    bashTool,
    createDefaultTools,
    editTool,
    grepTool,
    lenientInput,
    lenientToolInput,
    multiEditTool,
    parseToolArguments,
    readTool,
    resolveToolName,
    todoTool,
    webFetchTool,
    writeTool,
} from '../src/index.ts';

/** What a tool's schema makes of an input as a model sent it. */
function accepted(tool: Parameters<typeof lenientToolInput>[0], raw: unknown): unknown {
    const fitted = lenientToolInput(tool, raw);
    expect(fitted.unknown).toEqual([]);
    return tool.schema.parse(fitted.input);
}

describe('parseToolArguments', () => {
    it('reads JSON, and nothing as an empty object', () => {
        expect(parseToolArguments('{"path":"a.ts"}')).toEqual({ ok: true, value: { path: 'a.ts' } });
        expect(parseToolArguments('  ')).toEqual({ ok: true, value: {} });
    });

    it('repairs what a model slips on when it writes JSON by hand', () => {
        // A line break and a tab written raw inside a string.
        expect(parseToolArguments('{"content":"a\n\tb"}')).toEqual({ ok: true, value: { content: 'a\n\tb' } });
        // A regular expression whose backslashes were not doubled.
        expect(parseToolArguments('{"pattern":"\\d+\\.\\w"}')).toEqual({ ok: true, value: { pattern: '\\d+\\.\\w' } });
        // A comma before the closing bracket, Python's literals, a code fence.
        expect(parseToolArguments('{"edits":[{"a":1,},],"all":True,"none":None,}')).toEqual({
            ok: true,
            value: { edits: [{ a: 1 }], all: true, none: null },
        });
        expect(parseToolArguments('```json\n{"path":"a"}\n```')).toEqual({ ok: true, value: { path: 'a' } });
        // The same object sent twice, or followed by the end of a tag.
        expect(parseToolArguments('{"path":"a"}{"path":"a"}')).toEqual({ ok: true, value: { path: 'a' } });
        expect(parseToolArguments('{"path":"a"}</tool_call>')).toEqual({ ok: true, value: { path: 'a' } });
    });

    it('keeps valid escapes and words inside strings as they are', () => {
        expect(parseToolArguments('{"a":"x\\n\\u00e9 True None",}')).toEqual({
            ok: true,
            value: { a: 'x\né True None' },
        });
    });

    it('never completes text that was cut off', () => {
        expect(parseToolArguments('{"path":"a.ts","content":"half of the fi')).toEqual({ ok: false });
        expect(parseToolArguments('{"path":"a.ts"')).toEqual({ ok: false });
        expect(parseToolArguments('not json at all')).toEqual({ ok: false });
    });

    it('does not sort out single backslashes next to escapes that read both ways', () => {
        // `\b` is a word boundary to the model and a backspace to JSON; `\t` and `\n` in a path likewise.
        expect(parseToolArguments('{"pattern":"\\bfoo\\d+"}')).toEqual({ ok: false });
        expect(parseToolArguments('{"path":"C:\\Users\\test\\notes.txt"}')).toEqual({ ok: false });
        expect(parseToolArguments('{"path":"m.tex","content":"\\begin{a}\\frac{a}{b}\\end{a}\\n"}')).toEqual({
            ok: false,
        });
        // Another string of the same arguments counts: the model that wrote `\d` wrote `\temp` the same way.
        expect(parseToolArguments('{"path":"C:\\temp\\new.txt","pattern":"\\d+"}')).toEqual({ ok: false });
        // Quotes and backslashes that are escaped read one way, and so do line breaks written raw.
        expect(parseToolArguments('{"command":"grep -E \\"\\d+\\" a.txt"}')).toEqual({
            ok: true,
            value: { command: 'grep -E "\\d+" a.txt' },
        });
        expect(parseToolArguments('{"content":"a = \\d\nb"}')).toEqual({ ok: true, value: { content: 'a = \\d\nb' } });
        // Valid JSON is JSON, whatever the model meant.
        expect(parseToolArguments('{"pattern":"\\bfoo"}')).toEqual({ ok: true, value: { pattern: '\bfoo' } });
    });

    it('drops nothing that follows the first value but its repetition', () => {
        // Two calls run into one, a parameter after the object closed, a quote that was not escaped.
        expect(parseToolArguments('{"command":"git add -A"}{"command":"git commit -m x"}')).toEqual({ ok: false });
        expect(parseToolArguments('{"command":"sleep 100"},"background":true}')).toEqual({ ok: false });
        expect(parseToolArguments('{"command":"echo "}" >> out.txt"}')).toEqual({ ok: false });
        expect(parseToolArguments('{"path":"a.txt","content":"He said "} and left"}')).toEqual({ ok: false });
        expect(parseToolArguments('{"path":"a"} {"path":"a"}\n{"path":"a"}</tool_call>')).toEqual({
            ok: true,
            value: { path: 'a' },
        });
        expect(parseToolArguments('{"path":"a",}<｜tool▁call▁end｜>')).toEqual({ ok: true, value: { path: 'a' } });
    });
});

describe('lenientInput', () => {
    it('takes null, an empty string and a non-positive number below the minimum as not sent', () => {
        expect(accepted(readTool, { path: 'a.ts', offset: null, limit: null })).toEqual({ path: 'a.ts' });
        expect(accepted(readTool, { path: 'a.ts', offset: 0, limit: -1 })).toEqual({ path: 'a.ts' });
        expect(accepted(grepTool, { pattern: 'x', path: '', glob: '', headLimit: 0 })).toEqual({ pattern: 'x' });
        // A required parameter is never dropped: an empty file and an empty replacement are values.
        expect(accepted(writeTool, { path: 'a.ts', content: '' })).toEqual({ path: 'a.ts', content: '' });
        expect(accepted(editTool, { path: 'a.ts', oldString: 'x', newString: '' })).toMatchObject({ newString: '' });
    });

    it('gives numbers and booleans written as text their type, and the other way round', () => {
        expect(accepted(readTool, { path: 'a.ts', offset: '10', limit: ' 20 ' })).toEqual({
            path: 'a.ts',
            offset: 10,
            limit: 20,
        });
        expect(accepted(editTool, { path: 'a', oldString: 'x', newString: 'y', replaceAll: 'True' })).toMatchObject({
            replaceAll: true,
        });
        expect(accepted(grepTool, { pattern: 404 })).toEqual({ pattern: '404' });
        // Not a number: left for validation to refuse.
        expect(readTool.schema.safeParse(lenientToolInput(readTool, { path: 'a', offset: 'ten' }).input).success).toBe(
            false,
        );
        expect(readTool.schema.safeParse(lenientToolInput(readTool, { path: 'a', offset: '1.5' }).input).success).toBe(
            false,
        );
    });

    it('renames parameters written another way', () => {
        expect(accepted(editTool, { file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true })).toEqual({
            path: 'a.ts',
            oldString: 'x',
            newString: 'y',
            replaceAll: true,
        });
        expect(accepted(editTool, { filePath: 'a.ts', old_str: 'x', new_str: 'y' })).toMatchObject({ path: 'a.ts' });
        expect(accepted(readTool, { FILE_PATH: 'a.ts', start_line: 5 })).toEqual({ path: 'a.ts', offset: 5 });
        expect(accepted(writeTool, { file: 'a.ts', file_text: 'x' })).toEqual({ path: 'a.ts', content: 'x' });
        expect(
            accepted(grepTool, { regex: 'x', include: '*.ts', '-i': true, output_mode: 'content', '-C': 2, limit: 5 }),
        ).toEqual({ pattern: 'x', glob: '*.ts', ignoreCase: true, outputMode: 'content', context: 2, headLimit: 5 });
        // Its own name stands when both are sent.
        expect(accepted(readTool, { path: 'a.ts', file_path: 'b.ts' })).toEqual({ path: 'a.ts' });
    });

    it('renames inside lists, reads lists written as JSON text, and wraps a single item', () => {
        const edits = [{ oldString: 'a', newString: 'b' }];
        expect(accepted(multiEditTool, { path: 'a', edits: [{ old_string: 'a', new_string: 'b' }] })).toEqual({
            path: 'a',
            edits,
        });
        expect(accepted(multiEditTool, { path: 'a', edits: JSON.stringify(edits) })).toEqual({ path: 'a', edits });
        expect(accepted(multiEditTool, { path: 'a', edits: { old_str: 'a', new_str: 'b' } })).toEqual({
            path: 'a',
            edits,
        });
        // The whole input as JSON text.
        expect(accepted(readTool, '{"path":"a.ts"}')).toEqual({ path: 'a.ts' });
    });

    it('reads a todo list the way other harnesses write one', () => {
        expect(
            accepted(todoTool, {
                todos: [
                    { content: 'Read the code', status: 'done', activeForm: 'Reading the code', id: '1' },
                    { title: 'Fix it', status: 'In-Progress' },
                    { task: 'Test it', state: 'todo' },
                    { step: 'Ship it' },
                    'Tell the user',
                ],
            }),
        ).toEqual({
            items: [
                { content: 'Read the code', status: 'completed' },
                { content: 'Fix it', status: 'in_progress' },
                { content: 'Test it', status: 'pending' },
                { content: 'Ship it', status: 'pending' },
                { content: 'Tell the user', status: 'pending' },
            ],
        });
        // A status under another spelling of its name is still the status.
        expect(
            accepted(todoTool, {
                todos: [
                    { content: 'x', Status: 'completed' },
                    { content: 'y', State: 'Done' },
                ],
            }),
        ).toEqual({
            items: [
                { content: 'x', status: 'completed' },
                { content: 'y', status: 'completed' },
            ],
        });
    });

    it('refuses a todo list that is to be merged into the one there is', () => {
        const partial = { todos: [{ id: '2', content: 'Write the fix', status: 'completed' }] };
        expect(lenientToolInput(todoTool, { merge: true, ...partial }).refused).toMatch(/replaces the whole list/);
        expect(lenientToolInput(todoTool, { Merge: 'true', ...partial }).refused).toBeDefined();
        // Not merged: the list as sent is the list.
        expect(accepted(todoTool, { merge: false, ...partial })).toEqual({
            items: [{ content: 'Write the fix', status: 'completed' }],
        });
    });

    it('reads the timeout of other shells in their unit', () => {
        // Claude Code's Bash counts milliseconds, most others seconds; ten minutes is the most either way.
        expect(accepted(bashTool, { command: 'x', timeout: 30 })).toEqual({ command: 'x', timeoutMs: 30_000 });
        expect(accepted(bashTool, { command: 'x', timeout: 600 })).toEqual({ command: 'x', timeoutMs: 600_000 });
        expect(accepted(bashTool, { command: 'x', timeout: 30_000 })).toEqual({ command: 'x', timeoutMs: 30_000 });
        expect(accepted(bashTool, { command: 'x', timeout: '120000' })).toEqual({ command: 'x', timeoutMs: 120_000 });
        // No limit.
        expect(accepted(bashTool, { command: 'x', timeout: 0 })).toEqual({ command: 'x' });
        expect(accepted(bashTool, { command: 'x', timeout: null })).toEqual({ command: 'x' });
        // Fifteen minutes, or under a second: not a guess to stop a build on.
        for (const timeout of [900, 1800, 3600, 5000, '30s']) {
            expect(lenientToolInput(bashTool, { command: 'x', timeout })).toEqual({
                input: { command: 'x' },
                unknown: ['timeout'],
            });
        }
        // The same reading when waiting for a job.
        expect(accepted(bashOutputTool, { id: 'job-1', timeout: 60 })).toEqual({ jobId: 'job-1', waitMs: 60_000 });
        expect(accepted(bashOutputTool, { shell_id: 'job-1', wait: 15_000 })).toEqual({
            jobId: 'job-1',
            waitMs: 15_000,
        });
        expect(accepted(bashOutputTool, { jobId: 'job-1', timeout_ms: 500 })).toEqual({ jobId: 'job-1', waitMs: 500 });
        expect(lenientToolInput(bashOutputTool, { jobId: 'job-1', timeout: 900, wait: true }).unknown).toEqual([
            'timeout',
            'wait',
        ]);
        expect(lenientToolInput(bashKillTool, { jobId: 'job-1', signal: 'SIGINT' }).unknown).toEqual(['signal']);
        expect(accepted(bashTool, { command: 'x', timeout_seconds: '45' })).toEqual({
            command: 'x',
            timeoutMs: 45_000,
        });
        expect(accepted(bashTool, { command: 'x', timeoutMs: 500, timeout: 30 })).toEqual({
            command: 'x',
            timeoutMs: 500,
        });
        expect(accepted(bashTool, { cmd: 'x', run_in_background: 'true', explanation: 'Start it' })).toEqual({
            command: 'x',
            background: true,
            description: 'Start it',
        });
    });

    it('reports parameters a built-in tool does not have, but not commentary', () => {
        expect(lenientToolInput(bashTool, { command: 'x', cwd: 'sub', stdin: 'y' }).unknown).toEqual(['cwd', 'stdin']);
        expect(lenientToolInput(writeTool, { path: 'a', content: 'x', append: true }).unknown).toEqual(['append']);
        expect(
            lenientToolInput(multiEditTool, { path: 'a', edits: [{ oldString: 'a', newString: 'b', n: 1 }] }),
        ).toMatchObject({ unknown: ['edits[0].n'] });
        expect(lenientToolInput(readTool, { path: 'a', reason: 'to see it', Thought: '…' }).unknown).toEqual([]);
        expect(lenientToolInput(webFetchTool, { url: 'https://a.example', prompt: 'summarise' }).unknown).toEqual([]);
    });

    it('leaves what a schema does not describe alone unless it is strict', () => {
        const schema = {
            type: 'object',
            properties: { count: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } },
            additionalProperties: false,
        };
        expect(lenientInput(schema, { count: '3', tags: 'a', extra: null, note: '' })).toEqual({
            input: { count: 3, tags: 'a', extra: null, note: '' },
            unknown: [],
        });
        // Without types there is nothing to go by.
        expect(lenientInput({ type: 'object', properties: { any: {} } }, { any: null, other: '1' })).toEqual({
            input: { any: null, other: '1' },
            unknown: [],
        });
        expect(lenientInput({ type: 'object' }, ['not', 'an', 'object'])).toEqual({
            input: ['not', 'an', 'object'],
            unknown: [],
        });
    });

    it('keeps null where the schema takes it, and where the parameter has to be there', () => {
        const schema = {
            type: 'object',
            properties: {
                a: { type: ['string', 'null'] },
                b: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                c: { type: 'string', nullable: true },
                d: { type: 'string' },
                e: { type: 'string' },
            },
            required: ['d'],
        };
        expect(lenientInput(schema, { a: null, b: null, c: null, d: null, e: null }).input).toEqual({
            a: null,
            b: null,
            c: null,
            d: null,
        });
        expect(readTool.schema.safeParse(lenientToolInput(readTool, { path: null }).input).success).toBe(false);
    });

    it('tells names in other scripts apart, and never matches a name of signs alone', () => {
        // The members of a team by their names, as the host's `agent` tool lists them.
        const schema = {
            type: 'object',
            properties: { agent: { type: 'string', enum: ['规划', '计划评审', '测试'] }, 描述: { type: 'string' } },
            additionalProperties: false,
        };
        const sent = (agent: string): unknown => (lenientInput(schema, { agent }).input as { agent: unknown }).agent;
        expect(sent('测试')).toBe('测试');
        expect(sent('测试 ')).toBe('测试');
        expect(sent('@测试')).toBe('测试');
        // Not a member: the host says so, with the names there are.
        expect(sent('测试员')).toBe('测试员');
        expect(sent('编码')).toBe('编码');
        expect(sent('')).toBe('');
        expect(lenientInput(schema, { 提示: 'x', '': 'y' }).input).toEqual({ 提示: 'x', '': 'y' });

        const operators = { type: 'object', properties: { op: { enum: ['<', '>', '<=', '>=', '='] } } };
        expect(lenientInput(operators, { op: '!=' }).input).toEqual({ op: '!=' });
        const languages = { type: 'object', properties: { lang: { enum: ['c', 'c++', 'c#'] } } };
        expect(lenientInput(languages, { lang: 'C++' }).input).toEqual({ lang: 'c++' });
        expect(lenientInput(languages, { lang: 'C' }).input).toEqual({ lang: 'c' });
        // Could be any of them once the signs are set aside: left alone.
        expect(lenientInput(languages, { lang: 'c--' }).input).toEqual({ lang: 'c--' });
    });

    it('leaves a spelling that could be two parameters alone', () => {
        const schema = { type: 'object', properties: { a_b: { type: 'number' }, ab: { type: 'number' } } };
        expect(lenientInput(schema, { AB: '1' }).input).toEqual({ AB: '1' });
        expect(lenientInput(schema, { ab: '1', a_b: '2' }).input).toEqual({ ab: 1, a_b: 2 });
    });

    it('does not pick a branch of a union for the value', () => {
        const schema = {
            type: 'object',
            properties: {
                filter: {
                    anyOf: [
                        { type: 'object', properties: { kind: { const: 'text' }, value: { type: 'string' } } },
                        { type: 'object', properties: { kind: { const: 'count' }, value: { type: 'number' } } },
                    ],
                },
                branch: { anyOf: [{ enum: ['main', 'develop'] }, { type: 'string' }] },
                level: { anyOf: [{ enum: ['low', 'high'] }, { type: 'null' }] },
                rows: {
                    anyOf: [
                        { type: 'array', items: { type: 'string' } },
                        { type: 'array', items: { type: 'number' } },
                    ],
                },
            },
        };
        expect(
            lenientInput(schema, { filter: { kind: 'count', value: 5 }, branch: 'Main', level: 'HIGH', rows: [1, '2'] })
                .input,
        ).toEqual({ filter: { kind: 'count', value: 5 }, branch: 'Main', level: 'high', rows: [1, '2'] });
    });

    it('wraps one path into a list only for the built-in tools, and never an empty string or a list as text', () => {
        const schema = { type: 'object', properties: { skills: { type: 'array', items: { type: 'string' } } } };
        // A host tool: `""` and `"none"` are for the tool to read, not names of skills.
        expect(lenientInput(schema, { skills: '' }).input).toEqual({ skills: '' });
        expect(lenientInput(schema, { skills: 'none' }).input).toEqual({ skills: 'none' });
        expect(lenientInput(schema, { skills: '["pdf","docx"]' }).input).toEqual({ skills: ['pdf', 'docx'] });
        expect(lenientInput(schema, { skills: 'pdf' }, { strict: true }).input).toEqual({ skills: ['pdf'] });
        expect(lenientInput(schema, { skills: '' }, { strict: true }).input).toEqual({});
        expect(lenientInput(schema, { skills: 'pdf, docx' }, { strict: true }).input).toEqual({ skills: 'pdf, docx' });
    });
});

describe('resolveToolName', () => {
    const names = createDefaultTools().map((tool) => tool.name);

    it('finds a tool by another case, other separators, or what another harness calls it', () => {
        expect(resolveToolName('read', names)).toBe('read');
        expect(resolveToolName('Read', names)).toBe('read');
        expect(resolveToolName('MultiEdit', names)).toBe('multi_edit');
        expect(resolveToolName('WebFetch', names)).toBe('web_fetch');
        expect(resolveToolName('BashOutput', names)).toBe('bash_output');
        expect(resolveToolName('run_terminal_cmd', names)).toBe('bash');
        expect(resolveToolName('str_replace_editor', names)).toBe('edit');
        expect(resolveToolName('TodoWrite', names)).toBe('todo');
        expect(resolveToolName('LS', names)).toBe('list');
    });

    it('does not guess', () => {
        expect(resolveToolName('search', names)).toBeUndefined();
        expect(resolveToolName('deploy', names)).toBeUndefined();
        // An alias only stands for a tool the session has.
        expect(resolveToolName('shell', ['read', 'grep'])).toBeUndefined();
        // Tools of an MCP server named in Chinese are not one another, and two tools a name could be are not picked from.
        expect(resolveToolName('mcp__库__删', ['mcp__库__读', 'mcp__库__写'])).toBeUndefined();
        expect(resolveToolName('MCP__库__读', ['mcp__库__读', 'mcp__库__写'])).toBe('mcp__库__读');
        expect(resolveToolName('AB', ['a_b', 'ab'])).toBeUndefined();
        expect(resolveToolName('', names)).toBeUndefined();
        expect(resolveToolName('__', names)).toBeUndefined();
    });
});
