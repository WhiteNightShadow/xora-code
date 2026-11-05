import type { XoraDatabase } from '@xora/storage';

/**
 * Supervisor scores (19 §9): each card of a team run gets a base score from the facts, and the run's supervisor
 * moves it by at most ten points with a reason. A model that judges work done by the same model tends to be kind:
 * the facts carry the score, and the average of many counts, not one.
 */

/** What the host knows of how a card went. */
export interface CardFacts {
    readonly status: 'done' | 'failed' | 'blocked';
    /** Acceptances it did not pass. */
    readonly fails: number;
    /** Times the card moved up a tier. */
    readonly escalations: number;
    /** Times the watch caught the member going in circles or silent. */
    readonly watches: number;
}

const MAX_ADJUST = 10;
/** A card that did not get done scores no higher than this, whatever its supervisor adds. */
const UNDONE_CAP = 50;
const REASON_CHARS = 300;

export function baseScore(facts: CardFacts): number {
    const lost = facts.fails * 5 + facts.escalations * 5 + facts.watches * 3;
    if (facts.status !== 'done') return Math.max(10, 40 - lost);
    const clean = facts.fails === 0 && facts.escalations === 0;
    return Math.max(50, 80 + (clean ? 5 : 0) - lost);
}

export function finalScore(base: number, adjust: number, status: CardFacts['status']): number {
    const moved = base + Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, Math.round(adjust)));
    return Math.max(0, Math.min(status === 'done' ? 100 : UNDONE_CAP, moved));
}

export interface Verdict {
    readonly adjust: number;
    readonly reason: string;
}

/** The supervisor's answer, by card: only what it clearly said. Nothing is made up for a card it left out. */
export function parseScores(answer: string): Map<string, Verdict> {
    const found = new Map<string, Verdict>();
    const json = /\{[\s\S]*\}/.exec(answer)?.[0];
    if (!json) return found;
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return found;
    }
    const scores = (parsed as { scores?: unknown } | null)?.scores;
    if (!Array.isArray(scores)) return found;
    for (const entry of scores) {
        const { task, adjust, reason } = (entry ?? {}) as { task?: unknown; adjust?: unknown; reason?: unknown };
        if (typeof task !== 'string' || typeof adjust !== 'number' || !Number.isFinite(adjust)) continue;
        if (typeof reason !== 'string' || !reason.trim()) continue;
        found.set(task, { adjust, reason: reason.trim().slice(0, REASON_CHARS) });
    }
    return found;
}

export const scoreSystem = (
    language: string,
) => `You are the supervisor of a team run that has ended, scoring how your members did on their cards, for the user who owns the team.

Each card comes with a base score the host worked out from the facts: whether it was done, how often it failed acceptance, moved up a tier or was caught by the watch. Do not work it out again. Move it by at most ${MAX_ADJUST} points either way, and only for what the record shows and those facts miss: does the work really meet the card's goal, is it correct and well made, did the member report plainly and say what it could not do. 0 is the usual answer when nothing stands out. Cost and time are no part of the score. Go by what the record shows; confident wording earns nothing.

Answer with one line of JSON and nothing else: {"scores":[{"task":"<card id>","adjust":<number from -${MAX_ADJUST} to ${MAX_ADJUST}>,"reason":"<one short sentence in ${language}, naming what in the record it rests on>"}]}`;

export interface ScoreRow {
    readonly runId: string;
    readonly taskId: string;
    readonly memberId: string;
    readonly at: number;
    readonly projectId: string;
    readonly scorerId: string;
    readonly title: string;
    readonly base: number;
    readonly adjust: number;
    readonly score: number;
    readonly reason: string;
}

interface StoredScore {
    readonly at: number;
    readonly score: number;
    readonly reason: string;
    readonly scorerId: string;
    readonly projectId: string;
    readonly title: string;
}

/** Scores behind an average; it shows from three on. */
const WINDOW = 10;
const MIN_FOR_AVERAGE = 3;
const RECENT = 5;
/** Points between two averages that count as a change. */
const TREND_POINTS = 3;

const mean = (rows: readonly { readonly score: number }[]) =>
    rows.reduce((total, row) => total + row.score, 0) / rows.length;

export class ScoreService {
    readonly #db: XoraDatabase;

    constructor(db: XoraDatabase) {
        this.#db = db;
    }

    /** Scores a run already has stay as they were: a run scored again after a restart adds none twice. */
    add(rows: readonly ScoreRow[]): void {
        this.#db.transaction(() => {
            for (const row of rows) {
                this.#db.run(
                    `insert or ignore into member_scores
                        (run_id, task_id, member_id, ts, project_id, scorer_id, title, base, adjust, score, reason)
                     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        row.runId,
                        row.taskId,
                        row.memberId,
                        row.at,
                        row.projectId,
                        row.scorerId,
                        row.title,
                        row.base,
                        row.adjust,
                        row.score,
                        row.reason,
                    ],
                );
            }
        });
    }

    /** What a member's panel shows: the average of its last scores, how that moved, and the latest ones. */
    summary(memberId: string): {
        average?: number;
        count: number;
        trend?: 'up' | 'down' | 'flat';
        recent: readonly StoredScore[];
    } {
        const rows = this.#db.all<StoredScore>(
            `select ts as at, score, reason, scorer_id as scorerId, project_id as projectId, title
             from member_scores where member_id = ? order by ts desc, task_id desc limit ?`,
            [memberId, WINDOW * 2],
        );
        const count =
            this.#db.get<{ count: number }>('select count(*) as count from member_scores where member_id = ?', [
                memberId,
            ])?.count ?? 0;
        const latest = rows.slice(0, WINDOW);
        const before = rows.slice(WINDOW);
        const average = count >= MIN_FOR_AVERAGE ? mean(latest) : undefined;
        const change = average !== undefined && before.length >= MIN_FOR_AVERAGE ? average - mean(before) : undefined;
        return {
            ...(average !== undefined ? { average: Math.round(average) } : {}),
            count,
            ...(change !== undefined
                ? { trend: change >= TREND_POINTS ? 'up' : change <= -TREND_POINTS ? 'down' : 'flat' }
                : {}),
            recent: rows.slice(0, RECENT),
        };
    }

    /** Every member's average, for the tree: those with enough scores. */
    averages(): Map<string, number> {
        const rows = this.#db.all<{ memberId: string; average: number }>(
            `select member_id as memberId, avg(score) as average, count(*) as count from (
                 select member_id, score,
                        row_number() over (partition by member_id order by ts desc, task_id desc) as place
                 from member_scores
             ) where place <= ? group by member_id having count >= ?`,
            [WINDOW, MIN_FOR_AVERAGE],
        );
        return new Map(rows.map((row) => [row.memberId, Math.round(row.average)]));
    }
}
