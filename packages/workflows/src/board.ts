import { z } from 'zod';
import { ownershipOverlap } from './ownership.ts';
import { type AttemptRecord, tierRank } from './routing.ts';
import {
    type Deliverable,
    DeliverableSchema,
    formatIssues,
    PRIORITIES,
    type TaskCard,
    type TaskCardInput,
    TaskCardSchema,
    type Tier,
    TierSchema,
} from './schemas.ts';
import { type Clock, deepFreeze } from './util.ts';

/**
 * The team's task board (06 §7): the single source of truth for task status, dependencies, claims and owners.
 * Commands validate first and then emit events; state only ever changes by applying events, so a board can be
 * persisted as a snapshot plus the events after it and replayed after a restart (06 §9).
 */

export const TASK_STATUSES = [
    'pending',
    'ready',
    'assigned',
    'in_progress',
    'in_review',
    'done',
    'failed',
    'blocked',
    'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses in which a task holds its claim and may be changing files. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['assigned', 'in_progress', 'in_review'];

const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
    pending: ['ready', 'blocked', 'cancelled'],
    ready: ['pending', 'assigned', 'blocked', 'cancelled'],
    assigned: ['in_progress', 'ready', 'blocked', 'failed', 'cancelled'],
    in_progress: ['in_review', 'ready', 'blocked', 'failed', 'cancelled'],
    in_review: ['done', 'in_progress', 'ready', 'blocked', 'failed', 'cancelled'],
    blocked: ['pending', 'ready', 'in_progress', 'failed', 'cancelled'],
    failed: ['pending', 'ready', 'cancelled'],
    done: [],
    cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return TRANSITIONS[from].includes(to);
}

/** Who works the task: executors, or the supervisor once flagship failed (06 §9). */
export type TaskHandler = 'executor' | 'supervisor';

export interface BoardAttempt extends AttemptRecord {
    readonly agentId?: string;
    readonly ts: number;
}

export interface BoardTask {
    readonly card: TaskCard;
    readonly status: TaskStatus;
    /** Current tier: the card's tier until an escalation raises it. */
    readonly tier: Tier;
    /** Holder of the claim lock; kept after `done` for attribution. */
    readonly owner?: string;
    readonly handler: TaskHandler;
    /** Failed acceptances at the current tier and handler. */
    readonly retries: number;
    /** Every finished attempt, for {@link shouldEscalate} and first-pass statistics. */
    readonly attempts: readonly BoardAttempt[];
    /** The latest deliverable. */
    readonly deliverable?: Deliverable;
    /** Why the task is blocked, failed or cancelled. */
    readonly note?: string;
    readonly createdAt: number;
    readonly updatedAt: number;
}

interface EventBase {
    readonly seq: number;
    readonly ts: number;
    readonly taskId: string;
}

export type BoardEvent = EventBase &
    (
        | { readonly type: 'added'; readonly card: TaskCard }
        | { readonly type: 'updated'; readonly card: TaskCard }
        | { readonly type: 'status'; readonly from: TaskStatus; readonly to: TaskStatus; readonly reason: string }
        | { readonly type: 'claimed'; readonly agentId: string }
        | { readonly type: 'released'; readonly agentId: string }
        | { readonly type: 'delivered'; readonly deliverable: Deliverable }
        | { readonly type: 'attempt'; readonly attempt: BoardAttempt }
        | { readonly type: 'tier'; readonly from: Tier; readonly to: Tier; readonly reason: string }
        | { readonly type: 'handler'; readonly handler: TaskHandler; readonly reason: string }
    );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type NewEvent = DistributiveOmit<BoardEvent, 'seq' | 'ts'>;

export type BoardErrorCode =
    | 'invalid_card'
    | 'missing_acceptance'
    | 'duplicate_task'
    | 'unknown_task'
    | 'unknown_dependency'
    | 'dependency_cycle'
    | 'invalid_transition'
    | 'already_claimed'
    | 'not_owner'
    | 'missing_ownership'
    | 'ownership_conflict'
    | 'invalid_deliverable'
    | 'invalid_tier';

export interface BoardError {
    readonly code: BoardErrorCode;
    /** Written for the supervisor: it is relayed as the result of its task tool call. */
    readonly message: string;
    readonly taskId?: string;
    readonly details: readonly string[];
}

export type BoardResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: BoardError };

export interface OwnershipConflict {
    /** The running task whose ownership overlaps. */
    readonly taskId: string;
    readonly globs: ReadonlyArray<readonly [string, string]>;
}

export interface BoardSnapshot {
    readonly version: 1;
    readonly seq: number;
    readonly tasks: readonly BoardTask[];
}

export interface TaskBoardOptions {
    readonly clock?: Clock;
}

export type BoardListener = (event: BoardEvent) => void;

const ok = <T>(value: T): BoardResult<T> => ({ ok: true, value });

function fail<T>(
    code: BoardErrorCode,
    message: string,
    taskId?: string,
    details: readonly string[] = [],
): BoardResult<T> {
    return { ok: false, error: { code, message, taskId, details } };
}

/**
 * Schema validation plus the creation gate (06 §8): a card without acceptance criteria is rejected, and so is
 * one that depends on itself. Duplicate dependencies are dropped.
 */
export function checkCard(input: unknown): BoardResult<TaskCard> {
    const parsed = TaskCardSchema.safeParse(input);
    if (!parsed.success) {
        const id = (input as { id?: unknown } | null)?.id;
        const issues = formatIssues(parsed.error.issues);
        return fail(
            'invalid_card',
            `invalid task card: ${issues.join('; ')}`,
            typeof id === 'string' ? id : undefined,
            issues,
        );
    }
    const card = parsed.data;
    if (card.acceptance.length === 0) {
        return fail(
            'missing_acceptance',
            `task ${card.id} has no acceptance criteria; every card needs at least one command, review or manual check`,
            card.id,
        );
    }
    if (card.dependsOn.includes(card.id)) {
        return fail('dependency_cycle', `task ${card.id} depends on itself`, card.id, [card.id]);
    }
    return ok({ ...card, dependsOn: [...new Set(card.dependsOn)] });
}

/** A dependency cycle as a path `[a, b, …, a]` (each depends on the next), or `undefined`. */
export function findDependencyCycle(cards: Iterable<Pick<TaskCard, 'id' | 'dependsOn'>>): string[] | undefined {
    const graph = new Map<string, readonly string[]>();
    for (const card of cards) {
        graph.set(card.id, card.dependsOn);
    }
    const state = new Map<string, 'visiting' | 'done'>();
    const path: string[] = [];
    const visit = (id: string): string[] | undefined => {
        const mark = state.get(id);
        if (mark === 'done') {
            return undefined;
        }
        if (mark === 'visiting') {
            return [...path.slice(path.indexOf(id)), id];
        }
        state.set(id, 'visiting');
        path.push(id);
        for (const dependency of graph.get(id) ?? []) {
            const cycle = graph.has(dependency) ? visit(dependency) : undefined;
            if (cycle) {
                return cycle;
            }
        }
        path.pop();
        state.set(id, 'done');
        return undefined;
    };
    for (const id of graph.keys()) {
        const cycle = visit(id);
        if (cycle) {
            return cycle;
        }
    }
    return undefined;
}

const ACTIVE = new Set<TaskStatus>(ACTIVE_STATUSES);
const TERMINAL = new Set<TaskStatus>(['done', 'cancelled']);
const EDITABLE = new Set<TaskStatus>(['pending', 'ready', 'blocked', 'failed']);
const PRIORITY_RANK = new Map<string, number>(PRIORITIES.map((priority, index) => [priority, index]));

function priorityRank(card: TaskCard): number {
    return PRIORITY_RANK.get(card.priority ?? 'normal') ?? PRIORITY_RANK.get('normal') ?? 0;
}

/** Applies one event to a task record. Pure; the board keeps the records frozen. */
function reduce(task: BoardTask, event: BoardEvent): BoardTask {
    const base = { ...task, updatedAt: event.ts };
    switch (event.type) {
        case 'added':
            return task;
        case 'updated':
            return { ...base, card: event.card };
        case 'status': {
            const noted = event.to === 'blocked' || event.to === 'failed' || event.to === 'cancelled';
            return { ...base, status: event.to, note: noted ? event.reason : undefined };
        }
        case 'claimed':
            return { ...base, owner: event.agentId };
        case 'released':
            return { ...base, owner: undefined };
        case 'delivered':
            return { ...base, deliverable: event.deliverable };
        case 'attempt':
            return {
                ...base,
                attempts: [...task.attempts, event.attempt],
                retries: event.attempt.outcome === 'fail' ? task.retries + 1 : task.retries,
            };
        case 'tier':
            return { ...base, tier: event.to, retries: 0 };
        case 'handler':
            return { ...base, handler: event.handler, retries: 0 };
    }
}

export class TaskBoard {
    readonly #clock: Clock;
    readonly #tasks = new Map<string, BoardTask>();
    readonly #log: BoardEvent[] = [];
    readonly #listeners = new Set<BoardListener>();
    #unsent: BoardEvent[] = [];
    #seq = 0;

    constructor(options: TaskBoardOptions = {}) {
        this.#clock = options.clock ?? Date.now;
    }

    /** Rebuilds a board from a snapshot. Throws when the snapshot is malformed. */
    static restore(snapshot: unknown, options: TaskBoardOptions = {}): TaskBoard {
        const parsed = BoardSnapshotSchema.safeParse(snapshot);
        if (!parsed.success) {
            throw new Error(`invalid board snapshot: ${formatIssues(parsed.error.issues).join('; ')}`);
        }
        const board = new TaskBoard(options);
        for (const task of parsed.data.tasks) {
            board.#tasks.set(task.card.id, deepFreeze(task));
        }
        board.#seq = parsed.data.seq;
        return board;
    }

    /** Rebuilds a board from its full event log. Throws on an inconsistent log. */
    static replay(events: readonly BoardEvent[], options: TaskBoardOptions = {}): TaskBoard {
        const board = new TaskBoard(options);
        board.replayEvents(events);
        return board;
    }

    /** Applies persisted events newer than {@link seq}, e.g. after {@link restore}; listeners are not called. */
    replayEvents(events: readonly BoardEvent[]): void {
        for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
            if (event.seq <= this.#seq) {
                continue;
            }
            this.#apply(deepFreeze(event));
            this.#seq = event.seq;
            this.#log.push(event);
        }
    }

    /** Sequence number of the latest event. */
    get seq(): number {
        return this.#seq;
    }

    get(taskId: string): BoardTask | undefined {
        return this.#tasks.get(taskId);
    }

    /** Tasks in the order they were added, optionally filtered by status and owner. */
    list(filter: { readonly status?: TaskStatus | readonly TaskStatus[]; readonly owner?: string } = {}): BoardTask[] {
        const statuses = filter.status === undefined ? undefined : new Set([filter.status].flat());
        return [...this.#tasks.values()].filter(
            (task) =>
                (statuses === undefined || statuses.has(task.status)) &&
                (filter.owner === undefined || task.owner === filter.owner),
        );
    }

    /** Tasks whose dependencies are all done and that nobody holds, most urgent first, then oldest first. */
    ready(): BoardTask[] {
        return this.list({ status: 'ready' }).sort((a, b) => priorityRank(a.card) - priorityRank(b.card));
    }

    /** Claimed tasks that may be changing files. */
    active(): BoardTask[] {
        return this.list({ status: ACTIVE_STATUSES });
    }

    /** Dependencies of a task that are not done yet; a cancelled or failed one keeps it waiting until replanned. */
    waitingOn(taskId: string): string[] {
        const task = this.#tasks.get(taskId);
        return task ? this.#unmet(task.card) : [];
    }

    /** Tasks that depend directly on `taskId`. */
    dependents(taskId: string): BoardTask[] {
        return [...this.#tasks.values()].filter((task) => task.card.dependsOn.includes(taskId));
    }

    /** Tasks an agent still holds; the host sends an agent that goes idle with any of these back to work (06 §8). */
    unfinishedFor(agentId: string): BoardTask[] {
        return this.list({ owner: agentId, status: ['assigned', 'in_progress'] });
    }

    /** True when every task is done or cancelled. */
    isComplete(): boolean {
        return [...this.#tasks.values()].every((task) => TERMINAL.has(task.status));
    }

    /** Task ids with every dependency before its dependents, ties in the order added; for integration (06 §5 ⑩). */
    topologicalOrder(): string[] {
        const order: string[] = [];
        const placed = new Set<string>();
        const pending = [...this.#tasks.values()].map((task) => task.card);
        while (pending.length > 0) {
            const index = pending.findIndex((card) =>
                card.dependsOn.every((id) => placed.has(id) || !this.#tasks.has(id)),
            );
            // Cards are validated to be acyclic, so some card is always placeable.
            const [card] = pending.splice(Math.max(index, 0), 1);
            if (card) {
                order.push(card.id);
                placed.add(card.id);
            }
        }
        return order;
    }

    /** Running, writable tasks whose ownership overlaps the given task's. */
    conflicts(taskId: string): OwnershipConflict[] {
        const task = this.#tasks.get(taskId);
        if (!task || task.card.workspace === 'readonly') {
            return [];
        }
        const conflicts: OwnershipConflict[] = [];
        for (const other of this.#tasks.values()) {
            if (other.card.id === taskId || !ACTIVE.has(other.status) || other.card.workspace === 'readonly') {
                continue;
            }
            const globs = ownershipOverlap(task.card.ownership, other.card.ownership);
            if (globs.length > 0) {
                conflicts.push({ taskId: other.card.id, globs });
            }
        }
        return conflicts;
    }

    /**
     * Ready tasks that can be claimed together right now, most urgent first: writable ones need ownership that
     * overlaps neither a running task nor another pick.
     */
    dispatchable(limit: number = Number.POSITIVE_INFINITY): BoardTask[] {
        const picked: BoardTask[] = [];
        const writing = this.active().filter((task) => task.card.workspace !== 'readonly');
        for (const task of this.ready()) {
            if (picked.length >= limit) {
                break;
            }
            if (task.card.workspace !== 'readonly') {
                if (task.card.ownership.length === 0) {
                    continue;
                }
                const clash = [...writing, ...picked.filter((pick) => pick.card.workspace !== 'readonly')].some(
                    (other) => ownershipOverlap(task.card.ownership, other.card.ownership).length > 0,
                );
                if (clash) {
                    continue;
                }
            }
            picked.push(task);
        }
        return picked;
    }

    /** Adds one card (a {@link TaskCardInput}, validated here) through the quality gate. */
    add(input: unknown): BoardResult<BoardTask> {
        const result = this.addMany([input]);
        return result.ok ? ok(result.value[0] as BoardTask) : result;
    }

    /** Adds cards that may depend on each other; all or nothing. */
    addMany(inputs: readonly unknown[]): BoardResult<BoardTask[]> {
        const cards: TaskCard[] = [];
        const ids = new Set<string>();
        for (const input of inputs) {
            const checked = checkCard(input);
            if (!checked.ok) {
                return checked;
            }
            const card = checked.value;
            if (this.#tasks.has(card.id) || ids.has(card.id)) {
                return fail('duplicate_task', `task ${card.id} already exists`, card.id, [card.id]);
            }
            ids.add(card.id);
            cards.push(card);
        }
        for (const card of cards) {
            const missing = card.dependsOn.filter((id) => !this.#tasks.has(id) && !ids.has(id));
            if (missing.length > 0) {
                return fail(
                    'unknown_dependency',
                    `task ${card.id} depends on unknown tasks: ${missing.join(', ')}`,
                    card.id,
                    missing,
                );
            }
        }
        const cycle = findDependencyCycle([...this.#cards(), ...cards]);
        if (cycle) {
            return fail('dependency_cycle', `dependency cycle: ${cycle.join(' -> ')}`, cycle[0], cycle);
        }
        for (const card of cards) {
            this.#emit({ type: 'added', taskId: card.id, card });
        }
        for (const card of cards) {
            this.#refreshReadiness(card.id);
        }
        this.#flush();
        return ok(cards.map((card) => this.#require(card.id)));
    }

    /** Changes a card that is not running (pending, ready, blocked or failed); the id stays. */
    update(taskId: string, patch: Partial<TaskCardInput>): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (!EDITABLE.has(task.status)) {
            return fail(
                'invalid_transition',
                `task ${taskId} is ${task.status}; only pending, ready, blocked or failed tasks can be edited`,
                taskId,
            );
        }
        const checked = checkCard({ ...task.card, ...patch, id: task.card.id });
        if (!checked.ok) {
            return checked;
        }
        const card = checked.value;
        const missing = card.dependsOn.filter((id) => !this.#tasks.has(id));
        if (missing.length > 0) {
            return fail(
                'unknown_dependency',
                `task ${taskId} depends on unknown tasks: ${missing.join(', ')}`,
                taskId,
                missing,
            );
        }
        const cycle = findDependencyCycle([...this.#cards().filter((other) => other.id !== taskId), card]);
        if (cycle) {
            return fail('dependency_cycle', `dependency cycle: ${cycle.join(' -> ')}`, taskId, cycle);
        }
        this.#emit({ type: 'updated', taskId, card });
        if (task.attempts.length === 0 && card.tier !== task.tier) {
            this.#emit({ type: 'tier', taskId, from: task.tier, to: card.tier, reason: 'card updated' });
        }
        this.#refreshReadiness(taskId);
        this.#flush();
        return ok(this.#require(taskId));
    }

    /**
     * Takes the claim lock on a ready task: one owner at a time, so a second claim fails. Writable tasks need
     * ownership and may not overlap a running writable task unless `allowOverlap` is set.
     */
    claim(taskId: string, agentId: string, options: { readonly allowOverlap?: boolean } = {}): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (TERMINAL.has(task.status)) {
            return fail('invalid_transition', `task ${taskId} is ${task.status}`, taskId);
        }
        if (task.owner !== undefined) {
            if (task.owner === agentId) {
                return ACTIVE.has(task.status)
                    ? ok(task)
                    : fail('invalid_transition', `task ${taskId} is ${task.status}; unblock it first`, taskId);
            }
            return fail('already_claimed', `task ${taskId} is already claimed by ${task.owner}`, taskId, [task.owner]);
        }
        if (task.status !== 'ready') {
            const waiting = this.#unmet(task.card);
            const why =
                task.status === 'pending' && waiting.length > 0
                    ? `is waiting on ${waiting.join(', ')}`
                    : `is ${task.status}, not ready`;
            return fail('invalid_transition', `task ${taskId} ${why}`, taskId, waiting);
        }
        if (task.card.workspace !== 'readonly' && task.card.ownership.length === 0) {
            return fail(
                'missing_ownership',
                `task ${taskId} changes files in a ${task.card.workspace} workspace but has no ownership; ` +
                    'set the files it may change before dispatching it',
                taskId,
            );
        }
        if (options.allowOverlap !== true) {
            const conflicts = this.conflicts(taskId);
            if (conflicts.length > 0) {
                const details = conflicts.map(
                    (conflict) => `${conflict.taskId}: ${conflict.globs.map(([a, b]) => `${a} ~ ${b}`).join(', ')}`,
                );
                return fail(
                    'ownership_conflict',
                    `task ${taskId} would edit the same files as running tasks (${details.join('; ')}); ` +
                        'wait for them, or make the ownership disjoint',
                    taskId,
                    details,
                );
            }
        }
        this.#emit({ type: 'claimed', taskId, agentId });
        this.#emit({ type: 'status', taskId, from: 'ready', to: 'assigned', reason: `claimed by ${agentId}` });
        this.#flush();
        return ok(this.#require(taskId));
    }

    /** Gives up a claim; an active task goes back to ready. */
    release(taskId: string, agentId: string, reason = 'released'): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (task.owner !== agentId || TERMINAL.has(task.status)) {
            return this.#notOwner(task, agentId);
        }
        this.#emit({ type: 'released', taskId, agentId });
        if (ACTIVE.has(task.status)) {
            this.#emit({ type: 'status', taskId, from: task.status, to: 'ready', reason });
        }
        this.#flush();
        return ok(this.#require(taskId));
    }

    /** The owner starts working. */
    start(taskId: string, agentId: string): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (task.owner !== agentId) {
            return this.#notOwner(task, agentId);
        }
        if (task.status === 'in_progress') {
            return ok(task);
        }
        if (task.status !== 'assigned') {
            return fail(
                'invalid_transition',
                `task ${taskId} is ${task.status}; only an assigned task can start`,
                taskId,
            );
        }
        this.#emit({ type: 'status', taskId, from: 'assigned', to: 'in_progress', reason: `started by ${agentId}` });
        this.#flush();
        return ok(this.#require(taskId));
    }

    /**
     * The owner hands in a deliverable; the task goes to review. An `escalate` deliverable is recorded as an
     * attempt right away so {@link shouldEscalate} sees it.
     */
    submit(taskId: string, agentId: string, deliverable: Deliverable): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (task.owner !== agentId) {
            return this.#notOwner(task, agentId);
        }
        if (task.status !== 'assigned' && task.status !== 'in_progress') {
            return fail(
                'invalid_transition',
                `task ${taskId} is ${task.status}; nothing is expected from ${agentId}`,
                taskId,
            );
        }
        const parsed = DeliverableSchema.safeParse(deliverable);
        if (!parsed.success) {
            const issues = formatIssues(parsed.error.issues);
            return fail('invalid_deliverable', `invalid deliverable: ${issues.join('; ')}`, taskId, issues);
        }
        if (parsed.data.taskId !== taskId) {
            return fail(
                'invalid_deliverable',
                `the deliverable is for task ${parsed.data.taskId}, not ${taskId}`,
                taskId,
            );
        }
        if (task.status === 'assigned') {
            this.#emit({
                type: 'status',
                taskId,
                from: 'assigned',
                to: 'in_progress',
                reason: `started by ${agentId}`,
            });
        }
        this.#emit({ type: 'delivered', taskId, deliverable: parsed.data });
        if (parsed.data.status === 'escalate') {
            this.#emit({
                type: 'attempt',
                taskId,
                attempt: {
                    tier: task.tier,
                    outcome: 'escalate',
                    by: task.handler,
                    agentId,
                    escalateTo: parsed.data.escalate?.to,
                    ts: this.#clock(),
                },
            });
        }
        this.#emit({
            type: 'status',
            taskId,
            from: 'in_progress',
            to: 'in_review',
            reason: `delivered: ${parsed.data.status}`,
        });
        this.#flush();
        return ok(this.#require(taskId));
    }

    /** Acceptance passed: the task is done and its dependents may become ready. */
    accept(taskId: string, reason = 'accepted'): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (task.status !== 'in_review') {
            return fail(
                'invalid_transition',
                `task ${taskId} is ${task.status}; only a task in review can be accepted`,
                taskId,
            );
        }
        if (task.deliverable?.status === 'escalate') {
            return fail('invalid_transition', `task ${taskId} was escalated; re-dispatch it with escalate()`, taskId);
        }
        this.#emit({ type: 'attempt', taskId, attempt: this.#attempt(task, 'pass') });
        this.#emit({ type: 'status', taskId, from: 'in_review', to: 'done', reason });
        for (const dependent of this.dependents(taskId)) {
            this.#refreshReadiness(dependent.card.id);
        }
        this.#flush();
        return ok(this.#require(taskId));
    }

    /**
     * Acceptance failed: the same owner continues with `feedback` (06 §5 ⑧). Check {@link shouldEscalate} on
     * the task's attempts to decide whether to escalate instead.
     */
    reject(taskId: string, feedback: string): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (task.status !== 'in_review') {
            return fail(
                'invalid_transition',
                `task ${taskId} is ${task.status}; only a task in review can be rejected`,
                taskId,
            );
        }
        this.#emit({ type: 'attempt', taskId, attempt: this.#attempt(task, 'fail') });
        this.#emit({ type: 'status', taskId, from: 'in_review', to: 'in_progress', reason: feedback });
        this.#flush();
        return ok(this.#require(taskId));
    }

    /**
     * A stage of the task was handed in and moved it forward (06 §20): the same owner goes on with the next stage.
     * Recorded as a `progress` attempt, which ends a run of failed ones for {@link shouldEscalate}.
     */
    continue(taskId: string, note: string): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (task.status !== 'in_review') {
            return fail(
                'invalid_transition',
                `task ${taskId} is ${task.status}; only a task in review can go on to its next stage`,
                taskId,
            );
        }
        this.#emit({ type: 'attempt', taskId, attempt: this.#attempt(task, 'progress') });
        this.#emit({ type: 'status', taskId, from: 'in_review', to: 'in_progress', reason: note });
        this.#flush();
        return ok(this.#require(taskId));
    }

    /**
     * Re-dispatches a task one or more tiers up, or hands it to the supervisor (06 §9). The claim is released
     * and the task is ready again.
     */
    escalate(taskId: string, to: Tier | 'supervisor', reason: string): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (!canTransition(task.status, 'ready') || task.status === 'pending') {
            return fail('invalid_transition', `task ${taskId} is ${task.status} and cannot be escalated`, taskId);
        }
        if (to === 'supervisor') {
            if (task.handler === 'supervisor') {
                return fail('invalid_tier', `task ${taskId} is already with the supervisor; ask the user`, taskId);
            }
            this.#emit({ type: 'handler', taskId, handler: 'supervisor', reason });
        } else {
            if (tierRank(to) <= tierRank(task.tier)) {
                return fail(
                    'invalid_tier',
                    `task ${taskId} runs at ${task.tier}; escalation must go higher than that`,
                    taskId,
                );
            }
            this.#emit({ type: 'tier', taskId, from: task.tier, to, reason });
        }
        if (task.owner !== undefined) {
            this.#emit({ type: 'released', taskId, agentId: task.owner });
        }
        this.#emit({ type: 'status', taskId, from: task.status, to: 'ready', reason: `escalated: ${reason}` });
        this.#flush();
        return ok(this.#require(taskId));
    }

    /** Parks a task that cannot continue, e.g. waiting for an answer; the owner keeps the claim. */
    block(taskId: string, reason: string): BoardResult<BoardTask> {
        return this.#move(taskId, 'blocked', reason);
    }

    /** Resumes a blocked task: back to its owner, or to ready or pending when nobody holds it. */
    unblock(taskId: string, reason = 'unblocked'): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (task.status !== 'blocked') {
            return fail('invalid_transition', `task ${taskId} is ${task.status}, not blocked`, taskId);
        }
        const to: TaskStatus =
            task.owner !== undefined ? 'in_progress' : this.#unmet(task.card).length > 0 ? 'pending' : 'ready';
        return this.#move(taskId, to, reason);
    }

    /** Gives up on a task for now; the claim is released. */
    fail(taskId: string, reason: string): BoardResult<BoardTask> {
        return this.#move(taskId, 'failed', reason);
    }

    /** Puts a failed task back in the queue. */
    retry(taskId: string, reason = 'retry'): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (task.status !== 'failed') {
            return fail('invalid_transition', `task ${taskId} is ${task.status}, not failed`, taskId);
        }
        return this.#move(taskId, this.#unmet(task.card).length > 0 ? 'pending' : 'ready', reason);
    }

    cancel(taskId: string, reason: string): BoardResult<BoardTask> {
        return this.#move(taskId, 'cancelled', reason);
    }

    snapshot(): BoardSnapshot {
        return { version: 1, seq: this.#seq, tasks: [...this.#tasks.values()] };
    }

    /** Events after `afterSeq`, oldest first. A restored board only has the events applied since. */
    events(afterSeq = 0): BoardEvent[] {
        return this.#log.filter((event) => event.seq > afterSeq);
    }

    /** Calls `listener` with every new event after the command that caused it completed. */
    onEvent(listener: BoardListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    #cards(): TaskCard[] {
        return [...this.#tasks.values()].map((task) => task.card);
    }

    #require(taskId: string): BoardTask {
        const task = this.#tasks.get(taskId);
        if (!task) {
            throw new Error(`task ${taskId} vanished from the board`);
        }
        return task;
    }

    #unmet(card: TaskCard): string[] {
        return card.dependsOn.filter((id) => this.#tasks.get(id)?.status !== 'done');
    }

    #unknown<T>(taskId: string): BoardResult<T> {
        return fail('unknown_task', `there is no task ${taskId}`, taskId);
    }

    #notOwner<T>(task: BoardTask, agentId: string): BoardResult<T> {
        const holder = task.owner === undefined ? 'nobody holds it' : `it is held by ${task.owner}`;
        return fail('not_owner', `${agentId} does not hold task ${task.card.id}; ${holder}`, task.card.id);
    }

    #attempt(task: BoardTask, outcome: BoardAttempt['outcome']): BoardAttempt {
        return { tier: task.tier, outcome, by: task.handler, agentId: task.owner, ts: this.#clock() };
    }

    /** A plain status change; claims are released when the task leaves the active statuses for good. */
    #move(taskId: string, to: TaskStatus, reason: string): BoardResult<BoardTask> {
        const task = this.#tasks.get(taskId);
        if (!task) {
            return this.#unknown(taskId);
        }
        if (!canTransition(task.status, to)) {
            return fail('invalid_transition', `task ${taskId} cannot go from ${task.status} to ${to}`, taskId);
        }
        if (task.owner !== undefined && (to === 'failed' || to === 'cancelled')) {
            this.#emit({ type: 'released', taskId, agentId: task.owner });
        }
        this.#emit({ type: 'status', taskId, from: task.status, to, reason });
        this.#flush();
        return ok(this.#require(taskId));
    }

    /** Moves a pending or ready task to whichever of the two its dependencies allow. */
    #refreshReadiness(taskId: string): void {
        const task = this.#tasks.get(taskId);
        if (!task || (task.status !== 'pending' && task.status !== 'ready')) {
            return;
        }
        const waiting = this.#unmet(task.card);
        const to: TaskStatus = waiting.length === 0 ? 'ready' : 'pending';
        if (to !== task.status) {
            const reason =
                to === 'pending'
                    ? `waiting on ${waiting.join(', ')}`
                    : task.card.dependsOn.length > 0
                      ? 'dependencies done'
                      : 'no dependencies';
            this.#emit({ type: 'status', taskId, from: task.status, to, reason });
        }
    }

    #emit(event: NewEvent): void {
        this.#seq += 1;
        const full = deepFreeze({ ...event, seq: this.#seq, ts: this.#clock() } as BoardEvent);
        this.#apply(full);
        this.#log.push(full);
        this.#unsent.push(full);
    }

    #apply(event: BoardEvent): void {
        if (event.type === 'added') {
            if (this.#tasks.has(event.taskId)) {
                throw new Error(`board event ${event.seq} adds task ${event.taskId} twice`);
            }
            this.#tasks.set(
                event.taskId,
                deepFreeze({
                    card: event.card,
                    status: 'pending',
                    tier: event.card.tier,
                    handler: 'executor',
                    retries: 0,
                    attempts: [],
                    createdAt: event.ts,
                    updatedAt: event.ts,
                }),
            );
            return;
        }
        const task = this.#tasks.get(event.taskId);
        if (!task) {
            throw new Error(`board event ${event.seq} refers to unknown task ${event.taskId}`);
        }
        this.#tasks.set(event.taskId, deepFreeze(reduce(task, event)));
    }

    /** Notifies listeners once a command has applied all its events; rethrows the first listener error. */
    #flush(): void {
        const events = this.#unsent;
        this.#unsent = [];
        let failure: unknown;
        for (const event of events) {
            for (const listener of this.#listeners) {
                try {
                    listener(event);
                } catch (error) {
                    failure ??= error;
                }
            }
        }
        if (failure !== undefined) {
            throw failure;
        }
    }
}

const AttemptSchema = z.object({
    tier: TierSchema,
    outcome: z.enum(['pass', 'fail', 'escalate', 'progress']),
    by: z.enum(['executor', 'supervisor']).optional(),
    escalateTo: TierSchema.optional(),
    agentId: z.string().optional(),
    ts: z.number(),
});

const BoardTaskSchema = z.object({
    card: TaskCardSchema,
    status: z.enum(TASK_STATUSES),
    tier: TierSchema,
    owner: z.string().optional(),
    handler: z.enum(['executor', 'supervisor']),
    retries: z.number().int().nonnegative(),
    attempts: z.array(AttemptSchema),
    deliverable: DeliverableSchema.optional(),
    note: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

/** Validates persisted snapshots, e.g. before {@link TaskBoard.restore}. */
export const BoardSnapshotSchema = z.object({
    version: z.literal(1),
    seq: z.number().int().nonnegative(),
    tasks: z.array(BoardTaskSchema),
});
