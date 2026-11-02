import { z } from 'zod';
import { isRecord, jsonCandidates, relaxedJsonParse } from './json.ts';

/** Model tiers of an organization (06 §3), strongest first. */
export const TIERS = ['flagship', 'standard', 'economy', 'fast'] as const;
export type Tier = (typeof TIERS)[number];
export const TierSchema = z.enum(TIERS);

export type Currency = 'CNY' | 'USD';
export const CurrencySchema = z.enum(['CNY', 'USD']);

/** `critical` tasks keep their tier when the budget runs low (06 §3 rule 5). */
export const PRIORITIES = ['critical', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Where a task runs: its own worktree, the project directory, or nowhere writable. */
export const WORKSPACES = ['worktree', 'local', 'readonly'] as const;
export type Workspace = (typeof WORKSPACES)[number];

const text = () => z.string().trim().min(1);
const textList = () => z.array(text()).default([]);

export const TaskIdSchema = z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'task ids are 1-64 letters, digits, ".", "_" or "-"');

export const CommandCheckSchema = z.object({
    type: z.literal('command'),
    run: text(),
    /** `fail` for reproduction steps, whose command has to fail. Absent means `pass`. */
    expect: z.enum(['pass', 'fail']).optional(),
});
export const ReviewCheckSchema = z.object({
    type: z.literal('review'),
    /** Reviewer agent id or role, `supervisor`, or `human`. */
    by: text(),
});
export const ManualCheckSchema = z.object({ type: z.literal('manual'), note: text() });
export const AcceptanceCheckSchema = z.discriminatedUnion('type', [
    CommandCheckSchema,
    ReviewCheckSchema,
    ManualCheckSchema,
]);
export type CommandCheck = z.output<typeof CommandCheckSchema>;
export type ReviewCheck = z.output<typeof ReviewCheckSchema>;
export type ManualCheck = z.output<typeof ManualCheckSchema>;
export type AcceptanceCheck = z.output<typeof AcceptanceCheckSchema>;

/**
 * A task card (06 §6): one goal, one deliverable, explicit acceptance. Lists may be omitted and default to
 * empty; the board's quality gate rejects cards without acceptance checks (06 §8).
 */
export const TaskCardSchema = z.object({
    id: TaskIdSchema,
    title: text(),
    goal: text(),
    /** Executor category such as `coding`, `testing` or `docs`; stored in lower case. */
    category: text().toLowerCase(),
    tier: TierSchema,
    /** Required when the card asks for a tier above its role's default (06 §3 rule 1). */
    tierReason: text().optional(),
    /** Agent the supervisor intends to do the task; the board's claim lock decides who actually holds it. */
    assignee: text().optional(),
    dependsOn: z.array(TaskIdSchema).default([]),
    context: z.object({ files: textList(), facts: textList(), links: textList() }).prefault({}),
    /** Globs of the files this task may change, relative to the project root. */
    ownership: textList(),
    constraints: textList(),
    acceptance: z.array(AcceptanceCheckSchema).default([]),
    deliverable: z.object({ kind: text(), artifacts: textList() }),
    budget: z.object({
        cost: z.number().nonnegative(),
        currency: CurrencySchema.default('CNY'),
        /** The host applies its own default when absent. */
        maxTurns: z.number().int().positive().optional(),
    }),
    workspace: z.enum(WORKSPACES),
    priority: z.enum(PRIORITIES).optional(),
});
export type TaskCard = z.output<typeof TaskCardSchema>;
/** What a supervisor or a file may provide: defaulted lists can be left out. */
export type TaskCardInput = z.input<typeof TaskCardSchema>;

export const DELIVERABLE_STATUSES = ['done', 'partial', 'blocked', 'escalate'] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];
export const CHANGE_KINDS = ['added', 'modified', 'deleted', 'renamed'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const EvidenceSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('command'),
        run: text(),
        /** `null` when unknown, or when the command was killed or timed out. */
        exit: z.number().int().nullable(),
        output: z.string().optional(),
    }),
    /** The diff itself comes from the workspace; `ref` can name a commit or patch. */
    z.object({ type: z.literal('diff'), ref: z.string().optional() }),
    z.object({ type: z.literal('screenshot'), path: text() }),
    z.object({ type: z.literal('note'), text: text() }),
]);
export type Evidence = z.output<typeof EvidenceSchema>;

export const EscalationSchema = z.object({ to: TierSchema, reason: text(), findings: textList() });
export type Escalation = z.output<typeof EscalationSchema>;

/** What an executor hands back for one task card (06 §6). */
export const DeliverableSchema = z
    .object({
        taskId: TaskIdSchema,
        status: z.enum(DELIVERABLE_STATUSES),
        summary: text(),
        changes: z
            .array(z.object({ file: text(), kind: z.enum(CHANGE_KINDS), from: z.string().optional() }))
            .default([]),
        evidence: z.array(EvidenceSchema).default([]),
        risks: textList(),
        openQuestions: textList(),
        /** What is left when the status is `partial`, one item each: the supervisor reviews the stage (06 §20). */
        remaining: textList(),
        escalate: EscalationSchema.nullable().default(null),
        /** As reported by the agent; the host's metering is authoritative and may overwrite it. */
        usage: z.object({ cost: z.number().nonnegative(), currency: CurrencySchema }).optional(),
    })
    .superRefine((deliverable, ctx) => {
        if (deliverable.status === 'escalate' && deliverable.escalate === null) {
            ctx.addIssue({
                code: 'custom',
                path: ['escalate'],
                message: 'status "escalate" needs escalate: {to, reason, findings}',
            });
        }
    });
export type Deliverable = z.output<typeof DeliverableSchema>;

export const ReviewIssueSchema = z.object({
    file: z.string().optional(),
    line: z.number().int().positive().optional(),
    problem: text(),
    fix: z.string().optional(),
    /** Non-blocking issues are suggestions; they never fail acceptance. */
    blocking: z.boolean().default(true),
});
export type ReviewIssue = z.output<typeof ReviewIssueSchema>;

/** A reviewer's verdict on one deliverable. */
export const ReviewSchema = z.object({
    verdict: z.enum(['pass', 'fail']),
    summary: z.string().default(''),
    issues: z.array(ReviewIssueSchema).default([]),
});
export type Review = z.output<typeof ReviewSchema>;

export type ParseErrorKind = 'no_json' | 'invalid_json' | 'invalid' | 'task_mismatch';

/** Why structured output could not be read; the host then asks a reviewer to normalise it (06 §16). */
export interface StructuredParseError {
    readonly kind: ParseErrorKind;
    readonly message: string;
    /** Schema problems of the closest candidate, as `path: message`. */
    readonly issues: readonly string[];
    /** The JSON text that came closest. */
    readonly candidate?: string;
}

export type DeliverableParse =
    | { readonly ok: true; readonly deliverable: Deliverable }
    | { readonly ok: false; readonly error: StructuredParseError };

export type ReviewParse =
    | { readonly ok: true; readonly review: Review }
    | { readonly ok: false; readonly error: StructuredParseError };

export interface ParseDeliverableOptions {
    /** The task the deliverable belongs to: fills a missing `taskId` and rejects a different one. */
    readonly taskId?: string;
}

/** Formats zod issues as `path: message`. */
export function formatIssues(
    issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string[] {
    return issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
}

/**
 * Extracts the deliverable from an agent's final message: a fenced ```json block or a bare object, the last
 * one first, tolerant of surrounding prose, comments, trailing commas and common synonyms. A message with no
 * JSON but an `ESCALATE: <tier> <reason>` line becomes an escalation when `taskId` is known.
 */
export function parseDeliverable(text: string, options: ParseDeliverableOptions = {}): DeliverableParse {
    const parsed = parseStructured(text, {
        schema: DeliverableSchema,
        wrapper: 'deliverable',
        keys: DELIVERABLE_KEYS,
        normalize: (raw) => normalizeDeliverable(raw, options.taskId),
    });
    if (parsed.ok) {
        if (options.taskId !== undefined && parsed.value.taskId !== options.taskId) {
            return {
                ok: false,
                error: {
                    kind: 'task_mismatch',
                    message: `the deliverable is for task ${parsed.value.taskId}, expected ${options.taskId}`,
                    issues: [],
                    candidate: parsed.candidate,
                },
            };
        }
        return { ok: true, deliverable: parsed.value };
    }
    const escalation = options.taskId === undefined ? undefined : escalationMarker(text, options.taskId);
    return escalation ? { ok: true, deliverable: escalation } : { ok: false, error: parsed.error };
}

/** Extracts a reviewer's `{verdict, summary, issues}` from its final message, like {@link parseDeliverable}. */
export function parseReview(text: string): ReviewParse {
    const parsed = parseStructured(text, {
        schema: ReviewSchema,
        wrapper: 'review',
        keys: ['verdict', 'summary', 'issues'],
        normalize: normalizeReview,
    });
    return parsed.ok ? { ok: true, review: parsed.value } : { ok: false, error: parsed.error };
}

const DELIVERABLE_KEYS = [
    'taskId',
    'status',
    'summary',
    'changes',
    'evidence',
    'risks',
    'openQuestions',
    'remaining',
    'escalate',
    'usage',
] as const;

interface StructuredSpec<T> {
    readonly schema: z.ZodType<T>;
    /** Key under which models sometimes nest the object, e.g. `{"deliverable": {…}}`. */
    readonly wrapper: string;
    /** Keys that make an object look like the wanted one; used to pick the closest candidate for errors. */
    readonly keys: readonly string[];
    readonly normalize: (raw: Record<string, unknown>) => unknown;
}

type StructuredResult<T> =
    | { readonly ok: true; readonly value: T; readonly candidate: string }
    | { readonly ok: false; readonly error: StructuredParseError };

function parseStructured<T>(text: string, spec: StructuredSpec<T>): StructuredResult<T> {
    let closest: { score: number; issues: string[]; candidate: string } | undefined;
    let jsonError: string | undefined;
    for (const candidate of jsonCandidates(text)) {
        const parsed = relaxedJsonParse(candidate);
        if (!parsed.ok) {
            // Braces in prose are not JSON; only report errors of text that looks like JSON.
            if (/"\s*:/.test(candidate)) {
                jsonError ??= parsed.error;
            }
            continue;
        }
        if (!isRecord(parsed.value)) {
            continue;
        }
        const nested = parsed.value[spec.wrapper];
        const raw = isRecord(nested) ? nested : parsed.value;
        const result = spec.schema.safeParse(spec.normalize(raw));
        if (result.success) {
            return { ok: true, value: result.data, candidate };
        }
        const score = spec.keys.filter((key) => Object.hasOwn(raw, key)).length;
        if (!closest || score > closest.score) {
            closest = { score, issues: formatIssues(result.error.issues), candidate };
        }
    }
    if (closest && closest.score > 0) {
        return {
            ok: false,
            error: {
                kind: 'invalid',
                message: `found a ${spec.wrapper} that does not match the schema`,
                issues: closest.issues,
                candidate: closest.candidate,
            },
        };
    }
    if (jsonError !== undefined) {
        return { ok: false, error: { kind: 'invalid_json', message: `malformed JSON: ${jsonError}`, issues: [] } };
    }
    return { ok: false, error: { kind: 'no_json', message: `no ${spec.wrapper} JSON object found`, issues: [] } };
}

const ESCALATE_MARKER = /^[ \t>*_`]*ESCALATE\s*:\s*([A-Za-z]+)[ \t]*[-:–—]?[ \t]*(.*)$/m;
const MAX_FINDINGS = 4_000;

/** The bare `ESCALATE: standard <reason>` form some agents use instead of JSON. */
function escalationMarker(text: string, taskId: string): Deliverable | undefined {
    const match = ESCALATE_MARKER.exec(text);
    const tier = match?.[1]?.toLowerCase();
    if (!match || !TierSchema.safeParse(tier).success) {
        return undefined;
    }
    const reason = (match[2] ?? '').replace(/[*_`]+$/, '').trim() || 'escalated by the executor';
    const findings = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
    const result = DeliverableSchema.safeParse({
        taskId,
        status: 'escalate',
        summary: reason,
        escalate: { to: tier, reason, findings: findings ? [findings.slice(0, MAX_FINDINGS)] : [] },
    });
    return result.success ? result.data : undefined;
}

const STATUS_ALIASES: Readonly<Record<string, DeliverableStatus>> = {
    done: 'done',
    complete: 'done',
    completed: 'done',
    finished: 'done',
    success: 'done',
    succeeded: 'done',
    partial: 'partial',
    partially_done: 'partial',
    incomplete: 'partial',
    blocked: 'blocked',
    stuck: 'blocked',
    escalate: 'escalate',
    escalated: 'escalate',
    escalation: 'escalate',
};

const CHANGE_ALIASES: Readonly<Record<string, ChangeKind>> = {
    added: 'added',
    add: 'added',
    new: 'added',
    created: 'added',
    create: 'added',
    modified: 'modified',
    modify: 'modified',
    changed: 'modified',
    change: 'modified',
    updated: 'modified',
    update: 'modified',
    edited: 'modified',
    edit: 'modified',
    deleted: 'deleted',
    delete: 'deleted',
    removed: 'deleted',
    remove: 'deleted',
    renamed: 'renamed',
    rename: 'renamed',
    moved: 'renamed',
    move: 'renamed',
    // git status letters
    a: 'added',
    m: 'modified',
    d: 'deleted',
    r: 'renamed',
};

const EVIDENCE_ALIASES: Readonly<Record<string, Evidence['type']>> = {
    command: 'command',
    cmd: 'command',
    shell: 'command',
    test: 'command',
    tests: 'command',
    run: 'command',
    diff: 'diff',
    patch: 'diff',
    screenshot: 'screenshot',
    image: 'screenshot',
    note: 'note',
    text: 'note',
    comment: 'note',
    log: 'note',
};

const VERDICT_ALIASES: Readonly<Record<string, Review['verdict']>> = {
    pass: 'pass',
    passed: 'pass',
    approve: 'pass',
    approved: 'pass',
    accept: 'pass',
    accepted: 'pass',
    lgtm: 'pass',
    fail: 'fail',
    failed: 'fail',
    reject: 'fail',
    rejected: 'fail',
    request_changes: 'fail',
    changes_requested: 'fail',
};

function alias<T extends string>(table: Readonly<Record<string, T>>, value: unknown): T | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const key = value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    return Object.hasOwn(table, key) ? table[key] : undefined;
}

function asArray(value: unknown): unknown[] {
    if (value === undefined || value === null) {
        return [];
    }
    return Array.isArray(value) ? value : [value];
}

/** Text of a list item that should have been a string, e.g. `{"risk": "…"}`. */
function textOf(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }
    if (isRecord(value)) {
        for (const key of ['text', 'description', 'question', 'risk', 'message', 'summary', 'finding']) {
            const field = value[key];
            if (typeof field === 'string') {
                return field;
            }
        }
    }
    return typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}

function stringList(value: unknown): string[] {
    return asArray(value)
        .map(textOf)
        .filter((item) => item.trim() !== '');
}

/** The first non-blank string among `keys`. */
function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim() !== '') {
            return value;
        }
    }
    return undefined;
}

function normalizeChange(change: unknown): unknown {
    if (typeof change === 'string') {
        return { file: change, kind: 'modified' };
    }
    if (!isRecord(change)) {
        return change;
    }
    const file = firstString(change, ['file', 'path']);
    const kind = change.kind ?? change.type ?? change.action ?? 'modified';
    return { ...change, file, kind: alias(CHANGE_ALIASES, kind) ?? kind };
}

function exitCode(value: unknown): unknown {
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
        return Number(value.trim());
    }
    return value === undefined ? null : value;
}

function normalizeEvidence(evidence: unknown): unknown {
    if (typeof evidence === 'string') {
        return { type: 'note', text: evidence };
    }
    if (!isRecord(evidence)) {
        return evidence;
    }
    const run = firstString(evidence, ['run', 'command', 'cmd']);
    const type =
        alias(EVIDENCE_ALIASES, evidence.type) ??
        (run !== undefined ? 'command' : typeof evidence.path === 'string' ? 'screenshot' : 'note');
    if (type === 'command' && run !== undefined) {
        const output = Array.isArray(evidence.output) ? evidence.output.map(textOf).join('\n') : evidence.output;
        return {
            type,
            run,
            exit: exitCode(evidence.exit ?? evidence.exitCode ?? evidence.exit_code ?? evidence.code),
            ...(typeof output === 'string' ? { output } : {}),
        };
    }
    if (type === 'diff' || (type === 'screenshot' && typeof evidence.path === 'string')) {
        return { ...evidence, type };
    }
    // Anything else becomes a note, so one odd evidence item never sinks the whole deliverable.
    return {
        type: 'note',
        text: firstString(evidence, ['text', 'note', 'description', 'summary']) ?? JSON.stringify(evidence),
    };
}

function normalizeEscalation(value: unknown, summary: unknown): unknown {
    if (value === undefined || value === null || value === false) {
        return null;
    }
    if (typeof value === 'string') {
        const tier = value.trim().toLowerCase();
        if (tier === '' || tier === 'none' || tier === 'null' || tier === 'false') {
            return null;
        }
        return { to: tier, reason: typeof summary === 'string' ? summary : 'escalated by the executor', findings: [] };
    }
    if (!isRecord(value)) {
        return value;
    }
    const to = value.to ?? value.tier;
    return {
        to: typeof to === 'string' ? to.trim().toLowerCase() : to,
        reason: firstString(value, ['reason', 'why']) ?? (typeof summary === 'string' ? summary : undefined),
        findings: stringList(value.findings),
    };
}

function normalizeDeliverable(raw: Record<string, unknown>, taskId: string | undefined): unknown {
    const usage = raw.usage;
    return {
        ...raw,
        taskId: raw.taskId === undefined || raw.taskId === null || raw.taskId === '' ? taskId : String(raw.taskId),
        status: alias(STATUS_ALIASES, raw.status) ?? raw.status,
        changes: asArray(raw.changes).map(normalizeChange),
        evidence: asArray(raw.evidence).map(normalizeEvidence),
        risks: stringList(raw.risks),
        openQuestions: stringList(raw.openQuestions ?? raw.questions),
        remaining: stringList(raw.remaining ?? raw.todo ?? raw.left),
        escalate: normalizeEscalation(raw.escalate ?? raw.escalation, raw.summary),
        // Self-reported usage is informational; a malformed one is dropped rather than failing the deliverable.
        usage: isRecord(usage) && typeof usage.cost === 'number' && usage.cost >= 0 ? usage : undefined,
    };
}

function normalizeIssue(issue: unknown): unknown {
    if (typeof issue === 'string') {
        return { problem: issue };
    }
    if (!isRecord(issue)) {
        return issue;
    }
    const severity = typeof issue.severity === 'string' ? issue.severity.toLowerCase() : undefined;
    const line = typeof issue.line === 'string' && /^\d+$/.test(issue.line) ? Number(issue.line) : issue.line;
    return {
        ...issue,
        problem: firstString(issue, ['problem', 'message', 'description', 'issue', 'title', 'text']),
        fix: firstString(issue, ['fix', 'suggestion']),
        line: typeof line === 'number' && line > 0 ? line : undefined,
        blocking:
            typeof issue.blocking === 'boolean'
                ? issue.blocking
                : !['minor', 'nit', 'suggestion', 'info', 'low'].includes(severity ?? ''),
    };
}

function normalizeReview(raw: Record<string, unknown>): unknown {
    const approved = typeof raw.approved === 'boolean' ? (raw.approved ? 'pass' : 'fail') : undefined;
    const verdict = raw.verdict ?? raw.decision ?? raw.result ?? approved;
    return {
        ...raw,
        verdict: alias(VERDICT_ALIASES, verdict) ?? verdict,
        summary: typeof raw.summary === 'string' ? raw.summary : undefined,
        issues: asArray(raw.issues ?? raw.findings).map(normalizeIssue),
    };
}
