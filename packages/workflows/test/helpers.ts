import {
    type Deliverable,
    DeliverableSchema,
    type TaskCard,
    type TaskCardInput,
    TaskCardSchema,
} from '../src/index.ts';

/** A valid task card; fields override the defaults. */
export function cardInput(fields: Partial<TaskCardInput> = {}): TaskCardInput {
    return {
        id: 'T1',
        title: 'Add the sms endpoints',
        goal: 'Send and verify codes with expiry and replay protection',
        category: 'coding',
        tier: 'economy',
        ownership: ['src/auth/sms/**'],
        acceptance: [{ type: 'command', run: 'pnpm test src/auth' }],
        deliverable: { kind: 'code-change', artifacts: ['diff'] },
        budget: { cost: 3, currency: 'CNY', maxTurns: 40 },
        workspace: 'worktree',
        ...fields,
    };
}

export function card(fields: Partial<TaskCardInput> = {}): TaskCard {
    return TaskCardSchema.parse(cardInput(fields));
}

/** A `done` deliverable with command evidence for `taskId`. */
export function deliverable(fields: Partial<Deliverable> & { taskId?: string } = {}): Deliverable {
    return DeliverableSchema.parse({
        taskId: 'T1',
        status: 'done',
        summary: 'Added both endpoints; codes expire after 5 minutes',
        changes: [{ file: 'src/auth/sms/verify.ts', kind: 'added' }],
        evidence: [{ type: 'command', run: 'pnpm test src/auth', exit: 0 }],
        ...fields,
    });
}

/** A clock that ticks one second per call, from 2026-10-30 10:00 Beijing time. */
export function fakeClock(start = Date.parse('2026-10-30T10:00:00+08:00')): () => number {
    let now = start - 1000;
    return () => {
        now += 1000;
        return now;
    };
}

/**
 * The user's Chinese style outside code: English in lower case and no space between Chinese and English or
 * digits. Code spans and fenced blocks are skipped.
 */
export function followsChineseStyle(text: string): boolean {
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    const spaced = /[　-鿿＀-￯] [A-Za-z0-9$]|[A-Za-z0-9%] [　-鿿＀-￯]/;
    return !/[A-Z]/.test(prose) && !spaced.test(prose);
}
