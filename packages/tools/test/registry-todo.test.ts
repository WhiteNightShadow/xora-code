import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AnyTool, createDefaultTools, todoTool, toolOutputTool, toolSpec } from '../src/index.ts';
import { makeContext, runTool, temporaryDir } from './helpers.ts';

describe('todo', () => {
    it('replaces the session list and renders it', async () => {
        const ctx = await makeContext(await temporaryDir());
        const items = [
            { content: 'Read the code', status: 'completed' },
            { content: 'Write the fix', status: 'in_progress', priority: 'high' },
            { content: 'Run the tests', status: 'pending' },
        ];
        const result = await runTool(todoTool, { items }, ctx);
        expect(result.content).toBe(
            'Todo list updated (1 of 3 completed):\n[x] Read the code\n[~] Write the fix (high)\n[ ] Run the tests',
        );
        expect(ctx.todoItems()).toEqual(items);
        expect(result.display).toEqual({ kind: 'todo', items });
        const cleared = await runTool(todoTool, { items: [] }, ctx);
        expect(cleared.content).toBe('The todo list is now empty.');
        expect(ctx.todoItems()).toEqual([]);
    });

    it('validates items', () => {
        expect(todoTool.schema.safeParse({ items: [{ content: '', status: 'pending' }] }).success).toBe(false);
        expect(todoTool.schema.safeParse({ items: [{ content: 'x', status: 'done' }] }).success).toBe(false);
    });
});

describe('tool_output', () => {
    const output = Array.from(
        { length: 900 },
        (_, index) => `line ${index + 1}${index === 499 ? ' Error: boom' : ''}`,
    ).join('\n');
    const context = () =>
        makeContext('/tmp', {
            outputs: { read: (ref) => (ref === 'R12' ? { tool: 'bash', text: output } : undefined) },
        });

    it('gives back an earlier output by its reference, a page at a time', async () => {
        const ctx = await context();
        const first = await runTool(toolOutputTool, { ref: '#r12' }, ctx);
        expect(first.isError).toBeFalsy();
        expect(first.content.startsWith('line 1\n')).toBe(true);
        expect(first.content).toContain('[lines 1–400 of 900; ask for more with offset]');
        const page = await runTool(toolOutputTool, { ref: 'R12', offset: 899, limit: 5 }, ctx);
        expect(page.content).toBe('line 899\nline 900');
    });

    it('finds lines in it, numbered, and says when nothing matches or the reference is unknown', async () => {
        const ctx = await context();
        const found = await runTool(toolOutputTool, { ref: 'R12', grep: 'error' }, ctx);
        expect(found.content).toBe('R12 (bash), 1 matching lines:\n500: line 500 Error: boom');
        const none = await runTool(toolOutputTool, { ref: 'R12', grep: 'nothing here' }, ctx);
        expect(none.content).toContain('No line of R12');
        const unknown = await runTool(toolOutputTool, { ref: 'R99' }, ctx);
        expect(unknown.isError).toBe(true);
    });
});

describe('createDefaultTools', () => {
    const tools = createDefaultTools({ ripgrep: false });
    const byName = new Map<string, AnyTool>(tools.map((tool) => [tool.name, tool]));

    it('offers every built-in tool once', () => {
        expect(tools.map((tool) => tool.name)).toEqual([
            'read',
            'list',
            'glob',
            'grep',
            'lsp',
            'edit',
            'multi_edit',
            'write',
            'apply_patch',
            'bash',
            'bash_output',
            'bash_kill',
            'web_fetch',
            'web_search',
            'todo',
            'tool_output',
        ]);
    });

    it('marks exactly the tools that change nothing as read-only', () => {
        const readOnly = tools.filter((tool) => tool.readOnly).map((tool) => tool.name);
        expect(readOnly).toEqual(['read', 'list', 'glob', 'grep', 'lsp', 'bash_output', 'todo', 'tool_output']);
        expect(byName.get('apply_patch')?.kind).toBe('edit');
        expect(byName.get('bash')?.kind).toBe('execute');
        expect(byName.get('grep')?.kind).toBe('search');
        // The web tools always ask the host, which decides by mode and by domain.
        expect(byName.get('web_fetch')?.kind).toBe('fetch');
        expect(byName.get('web_search')?.kind).toBe('fetch');
    });

    it('resolves targets against the working directory', () => {
        const cwd = path.resolve('/work/repo');
        const ctx = { cwd };
        expect(byName.get('read')?.targets({ path: 'a.ts' }, ctx)).toEqual([path.join(cwd, 'a.ts')]);
        expect(byName.get('write')?.targets({ path: '../b.ts', content: '' }, ctx)).toEqual([
            path.resolve(cwd, '..', 'b.ts'),
        ]);
        expect(byName.get('edit')?.targets({ path: 'c.ts', oldString: 'a', newString: 'b' }, ctx)).toEqual([
            path.join(cwd, 'c.ts'),
        ]);
        expect(byName.get('list')?.targets({}, ctx)).toEqual([cwd]);
        expect(byName.get('grep')?.targets({ pattern: 'x' }, ctx)).toEqual([cwd]);
        expect(byName.get('todo')?.targets({ items: [] }, ctx)).toEqual([]);
        expect(byName.get('web_fetch')?.targets({ url: 'https://example.com/' }, ctx)).toEqual([]);
    });
});

describe('toolSpec', () => {
    it('describes inputs as JSON Schema without $schema or safe-integer noise', () => {
        const read = toolSpec(createDefaultTools().find((tool) => tool.name === 'read') as AnyTool);
        expect(read.name).toBe('read');
        expect(read.description).toContain('cat -n');
        expect(read.parameters).toEqual({
            type: 'object',
            properties: {
                path: { type: 'string', minLength: 1, description: expect.any(String) },
                offset: { type: 'integer', minimum: 1, description: expect.any(String) },
                limit: { type: 'integer', minimum: 1, description: expect.any(String) },
            },
            required: ['path'],
            additionalProperties: false,
        });
    });

    it('produces a valid spec for every tool', () => {
        for (const tool of createDefaultTools()) {
            const spec = toolSpec(tool);
            expect(spec.parameters.type, tool.name).toBe('object');
            expect(spec.parameters.$schema, tool.name).toBeUndefined();
            expect(JSON.stringify(spec.parameters), tool.name).not.toContain('9007199254740991');
            expect(spec.description.length, tool.name).toBeGreaterThan(40);
        }
        const multiEdit = toolSpec(createDefaultTools().find((tool) => tool.name === 'multi_edit') as AnyTool);
        expect(multiEdit.parameters).toMatchObject({
            properties: {
                edits: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false } },
            },
        });
    });
});
