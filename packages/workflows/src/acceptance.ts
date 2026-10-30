import { outOfOwnership } from './ownership.ts';
import { MAX_FAILED_ACCEPTANCES } from './routing.ts';
import type { AcceptanceCheck, Deliverable, ReviewIssue, TaskCard } from './schemas.ts';

/**
 * Acceptance (06 §5 ⑧, §8): the host runs the card's commands, then a reviewer looks at the evidence, then a
 * person confirms manual checks. `judge` turns the results into a verdict; evidence comes first.
 */

export interface PlannedCheck {
    /** Position in the card's `acceptance` list. */
    readonly index: number;
    readonly check: AcceptanceCheck;
}

const ORDER: Readonly<Record<AcceptanceCheck['type'], number>> = { command: 0, review: 1, manual: 2 };

/** The card's checks in the order to run them: commands, then reviews, then manual checks; stable within each. */
export function planAcceptance(card: Pick<TaskCard, 'acceptance'>): PlannedCheck[] {
    return card.acceptance
        .map((check, index) => ({ index, check }))
        .sort((a, b) => ORDER[a.check.type] - ORDER[b.check.type]);
}

/** A command the host ran in the task's workspace. */
export interface CommandResult {
    readonly run: string;
    /** `null` when the command was killed or timed out. */
    readonly exit: number | null;
    readonly output?: string;
    readonly durationMs?: number;
}

/** A review of the deliverable, e.g. a parsed reviewer verdict plus who gave it. */
export interface ReviewOutcome {
    /** Agent id, role, `supervisor` or `human`. */
    readonly by: string;
    readonly verdict: 'pass' | 'fail';
    readonly summary?: string;
    readonly issues: readonly ReviewIssue[];
}

export interface JudgeOptions {
    /** Files actually changed in the workspace; the deliverable's `changes` are used when absent. */
    readonly changedFiles?: readonly string[];
    /** A person confirmed the manual checks. */
    readonly manualConfirmed?: boolean;
}

export type CheckStatus = 'passed' | 'failed' | 'missing' | 'needs_human';

export interface CheckResult {
    readonly index: number;
    readonly check: AcceptanceCheck;
    readonly status: CheckStatus;
    readonly detail: string;
    /** Output of a failed command, for feedback. */
    readonly output?: string;
}

export type Verdict = 'pass' | 'fail' | 'needs_human';

export interface Judgement {
    readonly taskId: string;
    readonly verdict: Verdict;
    /** Why the verdict is not `pass`, one line each; written for the supervisor and the executor. */
    readonly reasons: readonly string[];
    /** Changed files outside the card's ownership, flagged red (06 §6). */
    readonly outOfOwnership: readonly string[];
    /** Worth knowing but not blocking, e.g. spending over the card's budget. */
    readonly warnings: readonly string[];
    readonly checks: readonly CheckResult[];
    /** Blocking review issues, for feedback. */
    readonly issues: readonly ReviewIssue[];
}

const HUMAN_REVIEWERS = new Set(['human', 'user']);
const OUTPUT_TAIL = 1_500;

function squash(text: string): string {
    return text.trim().replace(/\s+/g, ' ');
}

/** Last part of a command's output, which is where test runners put the failures. */
function tail(output: string | undefined): string | undefined {
    if (output === undefined || output.trim() === '') {
        return undefined;
    }
    const trimmed = output.trimEnd();
    return trimmed.length > OUTPUT_TAIL ? `…${trimmed.slice(-OUTPUT_TAIL)}` : trimmed;
}

/** Whether a review from `by` answers a review check for `wanted` (also `reviewer-2` for `reviewer`). */
function reviewMatches(wanted: string, by: string): boolean {
    const a = wanted.toLowerCase();
    const b = by.toLowerCase();
    return a === b || b.startsWith(`${a}-`) || (HUMAN_REVIEWERS.has(a) && HUMAN_REVIEWERS.has(b));
}

/**
 * The verdict on a deliverable. `fail` wins over `needs_human`, which wins over `pass`:
 * - the deliverable must be for this card, and `done` (a `partial`, `blocked` or `escalate` one fails);
 * - evidence first: `done` without evidence fails; work that changes files needs a command result, a diff or a
 *   screenshot, not just notes;
 * - every command check needs a result from the host: exit 0, or non-zero for `expect: 'fail'` (a
 *   reproduction); a killed or timed-out command satisfies neither;
 * - every review check needs a passing review without blocking issues; a missing human review, or any manual
 *   check that nobody confirmed, needs a person;
 * - changes outside the ownership fail.
 */
export function judge(
    card: TaskCard,
    deliverable: Deliverable,
    commandResults: readonly CommandResult[],
    review?: ReviewOutcome | readonly ReviewOutcome[],
    options: JudgeOptions = {},
): Judgement {
    const fails: string[] = [];
    const humans: string[] = [];
    const warnings: string[] = [];
    const checks: CheckResult[] = [];
    const issues: ReviewIssue[] = [];

    if (deliverable.taskId !== card.id) {
        fails.push(`the deliverable is for task ${deliverable.taskId}, not ${card.id}`);
    }
    if (deliverable.status === 'partial') {
        fails.push(`the deliverable is partial: ${deliverable.summary}`);
    } else if (deliverable.status === 'blocked') {
        const questions =
            deliverable.openQuestions.length > 0 ? `; open questions: ${deliverable.openQuestions.join(' | ')}` : '';
        fails.push(`the executor is blocked: ${deliverable.summary}${questions}`);
    } else if (deliverable.status === 'escalate') {
        fails.push(
            `the executor escalated to ${deliverable.escalate?.to ?? 'a higher tier'}: ${deliverable.escalate?.reason ?? deliverable.summary}`,
        );
    } else if (!hasEvidence(card, deliverable)) {
        fails.push('the deliverable says done but carries no evidence (command output, diff or screenshot)');
    }

    const reviews: ReviewOutcome[] = review === undefined ? [] : isReviewList(review) ? [...review] : [review];
    const results = new Map<string, CommandResult>();
    for (const result of commandResults) {
        results.set(squash(result.run), result);
    }

    for (const { index, check } of planAcceptance(card)) {
        if (check.type === 'command') {
            const expectFail = check.expect === 'fail';
            const result = results.get(squash(check.run));
            if (!result) {
                humans.push(`acceptance command \`${check.run}\` was not run`);
                checks.push({ index, check, status: 'missing', detail: 'not run' });
                continue;
            }
            const claimed = deliverable.evidence.find(
                (item) => item.type === 'command' && squash(item.run) === squash(check.run),
            );
            let passed: boolean;
            let detail: string;
            if (result.exit === null) {
                passed = false;
                detail = 'was killed or timed out';
            } else if (expectFail) {
                passed = result.exit !== 0;
                detail = passed
                    ? `failed as expected (exit ${result.exit})`
                    : 'passed, but this reproduction must fail';
            } else {
                passed = result.exit === 0;
                detail = passed ? 'passed' : `exited with ${result.exit}`;
            }
            if (claimed?.type === 'command' && claimed.exit !== null && claimed.exit !== result.exit) {
                const where = result.exit === null ? 'did not finish' : `exited with ${result.exit}`;
                fails.push(
                    `the evidence says \`${check.run}\` exited with ${claimed.exit}, but the host's run ${where}`,
                );
            }
            if (!passed) {
                fails.push(`\`${check.run}\` ${detail}`);
            }
            checks.push({
                index,
                check,
                status: passed ? 'passed' : 'failed',
                detail,
                ...(passed ? {} : { output: tail(result.output) }),
            });
        } else if (check.type === 'review') {
            const position = reviews.findIndex((outcome) => reviewMatches(check.by, outcome.by));
            const outcome = position >= 0 ? reviews.splice(position, 1)[0] : reviews.shift();
            if (!outcome) {
                const human = HUMAN_REVIEWERS.has(check.by.toLowerCase());
                humans.push(human ? 'a person has to review the deliverable' : `review by ${check.by} is missing`);
                checks.push({ index, check, status: human ? 'needs_human' : 'missing', detail: 'no review yet' });
                continue;
            }
            const blocking = outcome.issues.filter((issue) => issue.blocking);
            issues.push(...blocking);
            const passed = outcome.verdict === 'pass' && blocking.length === 0;
            if (!passed) {
                const summary = outcome.summary ? `: ${outcome.summary}` : '';
                fails.push(`review by ${outcome.by} failed${summary}`);
                for (const issue of blocking) {
                    fails.push(`review: ${describeIssue(issue)}`);
                }
            }
            checks.push({
                index,
                check,
                status: passed ? 'passed' : 'failed',
                detail: passed ? `approved by ${outcome.by}` : `rejected by ${outcome.by}`,
            });
        } else if (options.manualConfirmed === true) {
            checks.push({ index, check, status: 'passed', detail: 'confirmed by a person' });
        } else {
            humans.push(`manual check: ${check.note}`);
            checks.push({ index, check, status: 'needs_human', detail: check.note });
        }
    }

    const changed =
        options.changedFiles ??
        deliverable.changes.flatMap((change) => (change.from ? [change.file, change.from] : [change.file]));
    const outside = outOfOwnership(card, changed);
    if (outside.length > 0) {
        fails.push(`changed files outside the ownership: ${outside.join(', ')}`);
    }

    if (
        deliverable.usage &&
        deliverable.usage.currency === card.budget.currency &&
        deliverable.usage.cost > card.budget.cost
    ) {
        warnings.push(`spent ${deliverable.usage.cost} ${card.budget.currency} of a ${card.budget.cost} budget`);
    }
    if (deliverable.status === 'done' && deliverable.openQuestions.length > 0) {
        warnings.push(`done with open questions: ${deliverable.openQuestions.join(' | ')}`);
    }

    const verdict: Verdict = fails.length > 0 ? 'fail' : humans.length > 0 ? 'needs_human' : 'pass';
    return {
        taskId: card.id,
        verdict,
        reasons: verdict === 'fail' ? [...fails, ...humans] : humans,
        outOfOwnership: outside,
        warnings,
        checks,
        issues,
    };
}

function isReviewList(value: ReviewOutcome | readonly ReviewOutcome[]): value is readonly ReviewOutcome[] {
    return Array.isArray(value);
}

/**
 * Evidence first (06 §8): notes are claims, so work that changes files needs a command result, a diff or a
 * screenshot; for read-only tasks the notes are the result and count.
 */
function hasEvidence(card: TaskCard, deliverable: Deliverable): boolean {
    return card.workspace === 'readonly'
        ? deliverable.evidence.length > 0
        : deliverable.evidence.some((item) => item.type !== 'note');
}

function describeIssue(issue: ReviewIssue): string {
    const where = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}: ` : '';
    const fix = issue.fix ? ` Fix: ${issue.fix}` : '';
    return `${where}${issue.problem}${fix}`;
}

export interface FeedbackOptions {
    /** Failed acceptances at the current tier so far, this one included. */
    readonly failures?: number;
    /** Failures at one tier before the task moves up; {@link MAX_FAILED_ACCEPTANCES} by default. */
    readonly maxFailures?: number;
}

/**
 * Concrete feedback for the executor when a `fail` judgement sends its deliverable back (06 §5 ⑧): failing
 * commands with their output, review issues, files outside the ownership, and how many attempts are left.
 */
export function retryFeedback(judgement: Judgement, options: FeedbackOptions = {}): string {
    const items: string[] = [];
    const failedChecks = judgement.checks.filter(
        (check) => check.status === 'failed' && check.check.type === 'command',
    );
    const covered = new Set<string>();
    for (const result of failedChecks) {
        if (result.check.type !== 'command') {
            continue;
        }
        const line = `\`${result.check.run}\` ${result.detail}`;
        covered.add(line);
        items.push(result.output ? `${line}. Output:\n\`\`\`\n${result.output}\n\`\`\`` : `${line}.`);
    }
    for (const reason of judgement.reasons) {
        if (covered.has(reason) || reason.startsWith('changed files outside the ownership')) {
            continue;
        }
        items.push(`${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`);
    }
    if (judgement.outOfOwnership.length > 0) {
        items.push(
            `You changed files outside your ownership: ${judgement.outOfOwnership.join(', ')}. Revert them, or ` +
                'deliver blocked and explain why the task needs them.',
        );
    }
    const lines = [
        `Your deliverable for task ${judgement.taskId} was not accepted. Fix the following and deliver again:`,
    ];
    items.forEach((item, index) => {
        lines.push(`${index + 1}. ${item}`);
    });
    lines.push('Run the acceptance commands again before delivering and attach their real output as evidence.');
    if (options.failures !== undefined) {
        const left = (options.maxFailures ?? MAX_FAILED_ACCEPTANCES) - options.failures;
        lines.push(
            left <= 1
                ? 'This is your last attempt at this tier; if it fails too, the task moves to a stronger tier.'
                : `You have ${left} attempts left at this tier.`,
        );
    }
    return lines.join('\n');
}
