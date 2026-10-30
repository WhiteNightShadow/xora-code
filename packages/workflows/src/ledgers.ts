import type { BoardTask, TaskStatus } from './board.ts';
import type { Currency, TaskCard, Tier } from './schemas.ts';
import { type Clock, deepFreeze } from './util.ts';

/**
 * The supervisor's two ledgers (06 §5–§6, after magentic-one): the task ledger holds the plan and keeps every
 * revision; the progress ledger records, after every event, whether the team is getting anywhere.
 */

export interface TaskGraphNode {
    readonly id: string;
    readonly title: string;
    readonly dependsOn: readonly string[];
    readonly tier: Tier;
    readonly assignee?: string;
    readonly status?: TaskStatus;
}

export interface BudgetPlan {
    readonly total: number;
    readonly currency: Currency;
    /** Planned spend per task id. */
    readonly perTask: Readonly<Record<string, number>>;
    /** Held back for retries, escalations and integration. */
    readonly reserve?: number;
}

export interface TaskLedgerContent {
    readonly goal: string;
    readonly facts: readonly string[];
    readonly assumptions: readonly string[];
    /** The approach, in prose. */
    readonly plan: string;
    readonly tasks: readonly TaskGraphNode[];
    readonly decisions: readonly string[];
    readonly risks: readonly string[];
    readonly budget?: BudgetPlan;
}

export interface TaskLedgerRevision {
    /** 1 for the first version. */
    readonly version: number;
    readonly ts: number;
    readonly reason: string;
    readonly author?: string;
    readonly content: TaskLedgerContent;
}

export interface TaskLedgerSnapshot {
    readonly kind: 'task_ledger';
    readonly revisions: readonly TaskLedgerRevision[];
}

export type TaskLedgerListField = 'facts' | 'assumptions' | 'decisions' | 'risks';

export interface LedgerOptions {
    readonly clock?: Clock;
}

const CONTENT_FIELDS = ['goal', 'facts', 'assumptions', 'plan', 'tasks', 'decisions', 'risks', 'budget'] as const;

/** The plan, versioned: every revision keeps its time, reason and author, and old versions stay readable. */
export class TaskLedger {
    readonly #clock: Clock;
    readonly #revisions: TaskLedgerRevision[] = [];

    constructor(
        initial: string | (Partial<TaskLedgerContent> & { readonly goal: string }),
        options: LedgerOptions & { readonly reason?: string; readonly author?: string } = {},
    ) {
        this.#clock = options.clock ?? Date.now;
        const fields = typeof initial === 'string' ? { goal: initial } : initial;
        const content: TaskLedgerContent = {
            facts: [],
            assumptions: [],
            plan: '',
            tasks: [],
            decisions: [],
            risks: [],
            ...fields,
        };
        this.#push(content, options.reason ?? 'created', options.author);
    }

    static restore(snapshot: TaskLedgerSnapshot, options: LedgerOptions = {}): TaskLedger {
        const [first, ...rest] = snapshot.revisions;
        if (snapshot.kind !== 'task_ledger' || !first) {
            throw new Error('invalid task ledger snapshot');
        }
        const ledger = new TaskLedger(first.content, options);
        ledger.#revisions.length = 0;
        let version = 0;
        for (const revision of [first, ...rest]) {
            if (revision.version !== version + 1) {
                throw new Error(`task ledger snapshot skips from version ${version} to ${revision.version}`);
            }
            version = revision.version;
            ledger.#revisions.push(deepFreeze(revision));
        }
        return ledger;
    }

    get current(): TaskLedgerContent {
        return this.#latest().content;
    }

    get version(): number {
        return this.#latest().version;
    }

    get revisions(): readonly TaskLedgerRevision[] {
        return this.#revisions;
    }

    at(version: number): TaskLedgerRevision | undefined {
        return this.#revisions[version - 1];
    }

    /**
     * Records a new version with `changes` applied. A reason is required; a revision that changes nothing is
     * not recorded and returns the current one.
     */
    revise(changes: Partial<TaskLedgerContent>, reason: string, author?: string): TaskLedgerRevision {
        if (reason.trim() === '') {
            throw new Error('a task ledger revision needs a reason');
        }
        const current = this.current;
        const next: TaskLedgerContent = { ...current, ...changes };
        if (changedFields(current, next).length === 0) {
            return this.#latest();
        }
        return this.#push(next, reason, author);
    }

    /** Adds items to a list field (facts, assumptions, decisions, risks), skipping ones already there. */
    append(field: TaskLedgerListField, items: readonly string[], reason: string, author?: string): TaskLedgerRevision {
        const existing = this.current[field];
        const added = items.map((item) => item.trim()).filter((item) => item !== '' && !existing.includes(item));
        return this.revise({ [field]: [...existing, ...new Set(added)] }, reason, author);
    }

    /** Fields that differ between two versions; `to` defaults to the current one. */
    changes(from: number, to: number = this.version): Array<keyof TaskLedgerContent> {
        const a = this.at(from);
        const b = this.at(to);
        if (!a || !b) {
            throw new Error(`no task ledger version ${a ? to : from}`);
        }
        return changedFields(a.content, b.content);
    }

    snapshot(): TaskLedgerSnapshot {
        return { kind: 'task_ledger', revisions: [...this.#revisions] };
    }

    #latest(): TaskLedgerRevision {
        const latest = this.#revisions.at(-1);
        if (!latest) {
            throw new Error('the task ledger has no revisions');
        }
        return latest;
    }

    #push(content: TaskLedgerContent, reason: string, author: string | undefined): TaskLedgerRevision {
        const revision: TaskLedgerRevision = deepFreeze({
            version: this.#revisions.length + 1,
            ts: this.#clock(),
            reason,
            ...(author === undefined ? {} : { author }),
            content: structuredClone(content),
        });
        this.#revisions.push(revision);
        return revision;
    }
}

function changedFields(a: TaskLedgerContent, b: TaskLedgerContent): Array<keyof TaskLedgerContent> {
    return CONTENT_FIELDS.filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]));
}

/** Task graph nodes for the ledger, from board tasks (with status) or plain cards. */
export function taskGraph(tasks: readonly (BoardTask | TaskCard)[]): TaskGraphNode[] {
    return tasks.map((item) => {
        const card = 'card' in item ? item.card : item;
        return {
            id: card.id,
            title: card.title,
            dependsOn: [...card.dependsOn],
            tier: 'card' in item ? item.tier : card.tier,
            ...(card.assignee === undefined ? {} : { assignee: card.assignee }),
            ...('card' in item ? { status: item.status } : {}),
        };
    });
}

/** One check of the progress ledger, taken after every event (06 §5 ⑨). */
export interface ProgressEntry {
    readonly ts: number;
    /** Is the goal fully achieved? */
    readonly complete: boolean;
    /** Did the last step move the team forward? */
    readonly progressing: boolean;
    /** Is the team repeating itself? */
    readonly looping: boolean;
    /** Who acts next. */
    readonly nextAssignee?: string;
    /** What they are told to do. */
    readonly instruction?: string;
    readonly reason: string;
}

/** Entries in a row without progress after which the supervisor replans (06 §9). */
export const DEFAULT_STALL_WINDOW = 3;

/** Trailing entries in a row that made no progress (not complete, and not progressing or looping). */
export function stallCount(progress: readonly ProgressEntry[]): number {
    let count = 0;
    for (let index = progress.length - 1; index >= 0; index -= 1) {
        const entry = progress[index];
        if (!entry || entry.complete || (entry.progressing && !entry.looping)) {
            break;
        }
        count += 1;
    }
    return count;
}

/** True after `window` entries in a row without progress: time to replan. */
export function isStalled(progress: readonly ProgressEntry[], window: number = DEFAULT_STALL_WINDOW): boolean {
    return stallCount(progress) >= Math.max(1, Math.floor(window));
}

export interface ProgressLedgerSnapshot {
    readonly kind: 'progress_ledger';
    readonly entries: readonly ProgressEntry[];
    /** Index of the first entry after the latest replan. */
    readonly since: number;
    readonly replans: number;
}

/** The execution log; stall detection only looks at entries since the latest replan. */
export class ProgressLedger {
    readonly #clock: Clock;
    readonly #entries: ProgressEntry[] = [];
    #since = 0;
    #replans = 0;

    constructor(options: LedgerOptions = {}) {
        this.#clock = options.clock ?? Date.now;
    }

    static restore(snapshot: ProgressLedgerSnapshot, options: LedgerOptions = {}): ProgressLedger {
        if (snapshot.kind !== 'progress_ledger' || snapshot.since < 0 || snapshot.since > snapshot.entries.length) {
            throw new Error('invalid progress ledger snapshot');
        }
        const ledger = new ProgressLedger(options);
        ledger.#entries.push(...snapshot.entries.map((entry) => deepFreeze({ ...entry })));
        ledger.#since = snapshot.since;
        ledger.#replans = snapshot.replans;
        return ledger;
    }

    record(entry: Omit<ProgressEntry, 'ts'> & { readonly ts?: number }): ProgressEntry {
        const recorded = deepFreeze({ ...entry, ts: entry.ts ?? this.#clock() });
        this.#entries.push(recorded);
        return recorded;
    }

    get entries(): readonly ProgressEntry[] {
        return this.#entries;
    }

    /** Entries since the latest replan. */
    get current(): readonly ProgressEntry[] {
        return this.#entries.slice(this.#since);
    }

    get latest(): ProgressEntry | undefined {
        return this.#entries.at(-1);
    }

    get replans(): number {
        return this.#replans;
    }

    stalled(window: number = DEFAULT_STALL_WINDOW): boolean {
        return isStalled(this.current, window);
    }

    /** Starts a new stall window after the plan was revised. */
    markReplanned(): void {
        this.#since = this.#entries.length;
        this.#replans += 1;
    }

    snapshot(): ProgressLedgerSnapshot {
        return { kind: 'progress_ledger', entries: [...this.#entries], since: this.#since, replans: this.#replans };
    }
}

/** One step taken by an agent, for loop detection. */
export interface AgentAction {
    readonly actor?: string;
    /** The action, e.g. a tool call with its arguments or "dispatch t3 to coder". */
    readonly action: string;
    /** What came back. The same action with a different observation brought new information. */
    readonly observation?: string;
}

export interface LoopCheck {
    readonly looping: boolean;
    /** Length of the repeated block: 1 for A A A, 2 for A B A B A B. */
    readonly period?: number;
    readonly repeats?: number;
    /** The repeated actions. */
    readonly actions?: readonly string[];
}

export interface LoopOptions {
    /** Repetitions of the same block that count as a loop. Default 3. */
    readonly minRepeats?: number;
    /** Longest block considered. Default 3. */
    readonly maxPeriod?: number;
}

/**
 * Whether the latest actions repeat the same block (same actor, action and observation) at least `minRepeats`
 * times in a row: the same thing done again without new information.
 */
export function detectLoop(recentActions: readonly (AgentAction | string)[], options: LoopOptions = {}): LoopCheck {
    const minRepeats = Math.max(2, options.minRepeats ?? 3);
    const maxPeriod = Math.max(1, options.maxPeriod ?? 3);
    const actions = recentActions.map((item) => (typeof item === 'string' ? { action: item } : item));
    const keys = actions.map((item) =>
        [item.actor ?? '', squash(item.action), item.observation === undefined ? '' : squash(item.observation)].join(
            '\u0000',
        ),
    );
    const total = keys.length;
    for (let period = 1; period <= maxPeriod && period * minRepeats <= total; period += 1) {
        let repeats = 1;
        while (
            (repeats + 1) * period <= total &&
            sameBlock(keys, total - period, total - (repeats + 1) * period, period)
        ) {
            repeats += 1;
        }
        if (repeats >= minRepeats) {
            return {
                looping: true,
                period,
                repeats,
                actions: actions.slice(total - period).map((item) => squash(item.action)),
            };
        }
    }
    return { looping: false };
}

function squash(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}

function sameBlock(keys: readonly string[], a: number, b: number, length: number): boolean {
    for (let offset = 0; offset < length; offset += 1) {
        if (keys[a + offset] !== keys[b + offset]) {
            return false;
        }
    }
    return true;
}
