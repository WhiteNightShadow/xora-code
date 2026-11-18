import { z } from 'zod';
import { sameName } from '../lenient.ts';
import type { TodoItem, ToolContext, ToolDefinition, ToolResult } from '../types.ts';

const TodoInput = z.object({
    items: z
        .array(
            z.object({
                content: z.string().min(1).describe('The step, as a short imperative sentence'),
                status: z.enum(['pending', 'in_progress', 'completed']),
                priority: z.enum(['high', 'medium', 'low']).optional(),
            }),
        )
        .describe('The complete list; it replaces the previous one'),
});

export type TodoInput = z.infer<typeof TodoInput>;

const MARKS: Readonly<Record<TodoItem['status'], string>> = {
    completed: '[x]',
    in_progress: '[~]',
    pending: '[ ]',
};

/** The list as the model sees it: one line per item, `[x]` done, `[~]` in progress, `[ ]` pending. */
export function renderTodos(items: readonly TodoItem[]): string {
    return items
        .map(
            (item) =>
                `${MARKS[item.status]} ${item.content}${item.priority === undefined ? '' : ` (${item.priority})`}`,
        )
        .join('\n');
}

async function runTodo(input: TodoInput, ctx: ToolContext): Promise<ToolResult> {
    const items: TodoItem[] = input.items.map((item) =>
        item.priority === undefined
            ? { content: item.content, status: item.status }
            : { content: item.content, status: item.status, priority: item.priority },
    );
    ctx.todos.set(items);
    if (items.length === 0) {
        return { content: 'The todo list is now empty.', display: { kind: 'todo', items } };
    }
    const done = items.filter((item) => item.status === 'completed').length;
    return {
        content: `Todo list updated (${done} of ${items.length} completed):\n${renderTodos(items)}`,
        display: { kind: 'todo', items },
    };
}

export const todoTool: ToolDefinition<TodoInput> = {
    name: 'todo',
    description:
        'Replace the todo list of this session with `items`; always send the whole list. Use it for tasks with three or more steps: write down the steps when you start, keep exactly one item `in_progress`, and mark each item `completed` as soon as it is done, adding new steps as you discover them. Skip it for simple one-step requests.',
    kind: 'think',
    schema: TodoInput,
    readOnly: true,
    lenient: {
        aliases: {
            items: ['todos', 'todo_list', 'tasks', 'steps', 'plan', 'list'],
            content: ['text', 'title', 'task', 'step', 'description', 'subject', 'name'],
            status: ['state'],
        },
        values: {
            status: {
                done: 'completed',
                complete: 'completed',
                finished: 'completed',
                checked: 'completed',
                doing: 'in_progress',
                active: 'in_progress',
                started: 'in_progress',
                running: 'in_progress',
                current: 'in_progress',
                todo: 'pending',
                open: 'pending',
                not_started: 'pending',
                planned: 'pending',
                waiting: 'pending',
            },
        },
        // What other harnesses' todo tools carry besides the step and its status.
        ignore: ['id', 'activeForm'],
        // Cursor's `merge: true` sends only the items that changed, to be merged into the list. Taken as a whole
        // list it would throw the others away.
        refuse: (input) =>
            Object.entries(input).some(
                ([name, value]) => sameName(name, 'merge') && (value === true || value === 'true'),
            )
                ? 'todo always replaces the whole list and has no merge: send every item of the list, the unchanged ones too.'
                : undefined,
        adapt: (input) => {
            const rest = Object.fromEntries(Object.entries(input).filter(([name]) => !sameName(name, 'merge')));
            // A step written as plain text, or without a status, is a pending one.
            const key = Object.keys(rest).find((name) => Array.isArray(rest[name]));
            if (key === undefined) {
                return rest;
            }
            const stated = (item: object): boolean =>
                Object.keys(item).some((name) => sameName(name, 'status') || sameName(name, 'state'));
            const items = (rest[key] as unknown[]).map((item) => {
                if (typeof item === 'string') {
                    return { content: item, status: 'pending' };
                }
                return item !== null && typeof item === 'object' && !stated(item)
                    ? { ...item, status: 'pending' }
                    : item;
            });
            return { ...rest, [key]: items };
        },
    },
    targets: () => [],
    title: (input) => `Update todos (${input.items.length})`,
    run: runTodo,
};
