import {
    type Effort,
    type EventEnvelope,
    type FileChange,
    type Item,
    type ItemOf,
    type ModelRef,
    type PermissionMode,
    parseThreadEvent,
    type ThreadSnapshot,
    type TurnUsage,
} from '@xora/protocol';

export interface TurnView {
    readonly turnId: string;
    readonly input: ItemOf<'user_message'>;
    readonly model: ModelRef | null;
    readonly mode: PermissionMode;
    readonly effort: Effort;
    readonly startedAt: number;
    items: Item[];
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    stopReason?: string;
    durationMs?: number;
    usage?: TurnUsage;
    changes?: { files: FileChange[]; additions: number; deletions: number };
    error?: ItemOf<'error'>;
    reverted?: { paths: string[]; conflicts: Array<{ path: string; reason: string }> };
    /** Went back to before this turn or an earlier one: no longer part of the agent's context. */
    rewound?: boolean;
}

export interface ThreadView {
    readonly threadId: string;
    turns: TurnView[];
    lastSeq: number;
}

function upsert(turn: TurnView, item: Item): void {
    const index = turn.items.findIndex((existing) => existing.id === item.id);
    if (index >= 0) {
        turn.items[index] = item;
    } else {
        turn.items.push(item);
    }
}

function turnOf(view: ThreadView, turnId: string | undefined): TurnView | undefined {
    if (!turnId) return undefined;
    for (let index = view.turns.length - 1; index >= 0; index--) {
        const turn = view.turns[index];
        if (turn?.turnId === turnId) return turn;
    }
    return undefined;
}

/** Applies one persisted event. Returns false when the event leaves a gap and the view must resync. */
export function applyEvent(view: ThreadView, envelope: EventEnvelope): boolean {
    if (envelope.seq <= view.lastSeq) {
        return true;
    }
    if (envelope.seq !== view.lastSeq + 1 && view.lastSeq !== 0) {
        return false;
    }
    view.lastSeq = envelope.seq;
    const event = parseThreadEvent(envelope);
    if (!event) {
        return true;
    }
    switch (event.kind) {
        case 'turn.started':
            view.turns.push({
                turnId: event.payload.turnId,
                input: event.payload.input,
                model: event.payload.model,
                mode: event.payload.mode,
                effort: event.payload.effort,
                startedAt: event.ts,
                items: [],
                status: 'running',
            });
            break;
        case 'item.started':
        case 'item.completed': {
            const turn = turnOf(view, event.payload.item.turnId);
            if (turn) upsert(turn, event.payload.item);
            break;
        }
        case 'turn.completed': {
            const turn = turnOf(view, event.payload.turnId);
            if (turn) {
                turn.status = event.payload.stopReason === 'cancelled' ? 'cancelled' : 'completed';
                turn.stopReason = event.payload.stopReason;
                turn.durationMs = event.payload.durationMs;
                turn.usage = event.payload.usage;
                if (event.payload.changes) turn.changes = event.payload.changes;
            }
            break;
        }
        case 'turn.failed': {
            const turn = turnOf(view, event.payload.turnId);
            if (turn) {
                turn.status = 'failed';
                turn.error = event.payload.error;
                turn.durationMs = event.payload.durationMs;
            }
            break;
        }
        case 'turn.reverted': {
            const turn = turnOf(view, event.payload.turnId);
            if (turn) {
                turn.reverted = { paths: event.payload.paths, conflicts: event.payload.conflicts };
            }
            break;
        }
        case 'thread.rewound': {
            const at = view.turns.findIndex((turn) => turn.turnId === event.payload.turnId);
            for (const turn of at >= 0 ? view.turns.slice(at) : []) {
                turn.rewound = true;
            }
            break;
        }
        default:
            break;
    }
    return true;
}

export function viewFromSnapshot(snapshot: ThreadSnapshot): ThreadView {
    const view: ThreadView = { threadId: snapshot.thread.id, turns: [], lastSeq: 0 };
    for (const event of snapshot.events) {
        applyEvent(view, event);
    }
    view.lastSeq = snapshot.lastSeq;
    for (const item of snapshot.live) {
        applyLiveItem(view, item);
    }
    return view;
}

/** In-flight item state (tool progress, streaming text) that is not persisted yet. */
export function applyLiveItem(view: ThreadView, item: Item): void {
    const turn = turnOf(view, item.turnId);
    if (turn) upsert(turn, item);
}

export function applyDelta(
    view: ThreadView,
    delta: { turnId: string; itemId: string; stream: 'agent_message' | 'reasoning' | 'tool_output'; text: string },
): void {
    const turn = turnOf(view, delta.turnId);
    if (!turn) return;
    const existing = turn.items.find((item) => item.id === delta.itemId);
    if (existing && (existing.type === 'agent_message' || existing.type === 'reasoning')) {
        upsert(turn, { ...existing, text: existing.text + delta.text });
        return;
    }
    if (delta.stream === 'tool_output') return;
    upsert(turn, { id: delta.itemId, turnId: delta.turnId, ts: Date.now(), type: delta.stream, text: delta.text });
}

/** Whether an item is a call of the todo tool: each one is a version of the plan (03 §4). */
export function isTodoCall(item: Item): item is ItemOf<'tool_call'> {
    return item.type === 'tool_call' && (item.name === 'todo' || item.display?.kind === 'todo');
}

/**
 * The items a turn shows: a tool call that started a subagent, or that the chief handed work on with, is shown by
 * that card instead. A turn whose plan comes from todo calls shows those, each where it was made, not the plan item
 * (it stays where the plan was first written, and the composer shows the latest version of it).
 */
export function visibleItems(items: readonly Item[]): readonly Item[] {
    const paired = new Set(
        items.flatMap((item) =>
            (item.type === 'subagent' || item.type === 'delegation') && item.toolCallId ? [item.toolCallId] : [],
        ),
    );
    const todos = items.some(isTodoCall);
    return paired.size === 0 && !todos
        ? items
        : items.filter(
              (item) => !(item.type === 'tool_call' && paired.has(item.toolCallId)) && !(todos && item.type === 'plan'),
          );
}

/**
 * The plan of the latest turn that has one, that turn, and whether its turn is the one running. A turn gone back from
 * is no longer part of the agent's context, and the engine put its todo list back as it was: its plan does not count.
 */
export function latestPlanOf(
    turns: readonly TurnView[],
): { readonly plan: ItemOf<'plan'>; readonly turn: TurnView; readonly live: boolean } | undefined {
    const kept = turns.filter((turn) => !turn.rewound);
    const latest = kept.at(-1);
    for (let index = kept.length - 1; index >= 0; index--) {
        const turn = kept[index];
        const plan = turn?.items.find((item): item is ItemOf<'plan'> => item.type === 'plan');
        if (turn && plan) return { plan, turn, live: turn === latest && turn.status === 'running' };
    }
    return undefined;
}

/** The plan of the latest turn that has one. */
export function latestPlan(view: ThreadView | undefined): ItemOf<'plan'> | undefined {
    return view ? latestPlanOf(view.turns)?.plan : undefined;
}

/**
 * What the plan above the composer says: how far along it is, and the step in hand (`now` while the turn runs; the
 * next one when none is started; where it stopped when the turn is over), or none when every step is done.
 */
export function planProgress(
    entries: ItemOf<'plan'>['entries'],
    running: boolean,
): { done: number; total: number; step?: string; state: 'now' | 'next' | 'stopped' | 'done' } {
    const done = entries.filter((entry) => entry.status === 'completed').length;
    const total = entries.length;
    if (done === total) return { done, total, state: 'done' };
    const current = entries.find((entry) => entry.status === 'in_progress');
    const pending = entries.find((entry) => entry.status === 'pending');
    const step = (current ?? pending)?.content;
    return {
        done,
        total,
        ...(step ? { step } : {}),
        state: !running ? 'stopped' : current ? 'now' : 'next',
    };
}
