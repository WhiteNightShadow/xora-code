import { z } from 'zod';
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
    targets: () => [],
    title: (input) => `Update todos (${input.items.length})`,
    run: runTodo,
};
