import type { Message } from '@xora/providers';
import { z } from 'zod';
import type { EngineSession } from '../session.ts';
import { ID_PREFIX, type Judgment, type JudgmentKind, observe, renderState } from './ledger.ts';
import { contextMessages, STATE_TAG } from './messages.ts';
import { estimateMessageTokens, estimateTokens, userWords } from './tokens.ts';

/**
 * Compaction (20 §4.4): older turns give way to the state of the work. The engine renders the state itself from what
 * it recorded; the model, asked in the same request it would have made next (same model, system prompt, tools and
 * messages, so the provider's cache covers it), adds only what it alone can judge: a short account of how the work
 * went and additions to the ledger. Its answer is checked, and when it fails or does not pass the state is the
 * engine's part alone.
 */

/** Additions the model may make to the ledger in one compaction. */
const MAX_ADDITIONS = 12;
/** Narratives longer than this are cut: the state is read on every request until the next compaction. */
const NARRATIVE_CHARS = 2_000;
/** Narratives the session keeps; the state shows them all. */
const KEEP_NARRATIVES = 2;

/**
 * How much of the context a compaction keeps: the latest steps verbatim (a share of the budget, at most a quarter of
 * what there is, so a `/compact` of a small context still shrinks it) and the user's messages in the state. `used`
 * is the context as the vendor counts it, `estimated` as the engine does: the shares are in the engine's units, as
 * the cut and the state are measured in them.
 */
export function compactionShares(
    budget: number,
    used: number,
    estimated: number,
    level: 3 | 4,
): { tail: number; requests: number } {
    const scale = used > 0 && estimated > 0 ? Math.min(4, Math.max(0.25, estimated / used)) : 1;
    const cap = Math.min(24_000, budget * (level === 4 ? 0.05 : 0.15)) * scale;
    return { tail: Math.min(cap, estimated * 0.25), requests: Math.min(20_000, budget * 0.15) * scale };
}

/**
 * Where the kept tail of the history starts after a compaction: the latest steps within `keep` tokens, cut before a
 * user message or a model reply, never between a call and its result. `history.length`: nothing is kept (the state
 * alone continues the work); `undefined`: nothing to compact — before the cut there are only messages of the user,
 * which the state would repeat (a long message of theirs is theirs to send whole).
 */
export function compactionCut(session: EngineSession, keep: number): number | undefined {
    const history = session.history;
    let cut = history.length;
    let tokens = 0;
    for (let index = history.length - 1; index > session.contextStart; index--) {
        const message = history[index];
        if (!message) continue;
        tokens += estimateMessageTokens(message);
        if (tokens > keep) break;
        if (message.role !== 'tool') cut = index;
    }
    for (let index = session.contextStart; index < cut; index++) {
        if (history[index]?.role !== 'user') return cut;
    }
    return undefined;
}

const JudgmentAddition = z.object({
    kind: z.enum(['constraint', 'decision', 'fact', 'question', 'deadend']),
    text: z.string().trim().min(1),
    quote: z.string().trim().min(1).optional(),
    why: z.string().trim().min(1).optional(),
});

const LedgerDelta = z.object({
    add: z.array(z.unknown()).optional(),
    close: z.array(z.object({ id: z.string(), status: z.enum(['done', 'superseded']) })).optional(),
});

export interface Proposal {
    readonly narrative: string | undefined;
    readonly delta: z.infer<typeof LedgerDelta> | undefined;
}

/** The model's answer to the compaction request: its narrative and its additions to the ledger, as it wrote them. */
export function parseProposal(text: string): Proposal {
    const narrative = /<narrative>([\s\S]*?)<\/narrative>/i.exec(text)?.[1]?.trim();
    const raw = /<ledger>([\s\S]*?)<\/ledger>/i.exec(text)?.[1]?.trim();
    let delta: Proposal['delta'];
    if (raw) {
        const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        try {
            const parsed = LedgerDelta.safeParse(JSON.parse(json));
            delta = parsed.success ? parsed.data : undefined;
        } catch {
            delta = undefined;
        }
    }
    return { narrative: narrative || undefined, delta };
}

/** Text without differences of spacing or case, to find a quote in the user's words. */
const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

export interface Merged {
    readonly judgments: readonly Judgment[];
    /** Additions dropped: malformed, over the limit, or a constraint whose quote the user never wrote. */
    readonly rejected: number;
}

/**
 * The model's additions merged into the ledger. Ids are the engine's, never the model's, and nothing is removed: a
 * closed entry stays with its status. A constraint must quote the user; one that does not is dropped.
 */
export function mergeJudgments(
    judgments: readonly Judgment[],
    delta: Proposal['delta'],
    history: readonly Message[],
    at: number,
): Merged {
    if (!delta) return { judgments, rejected: 0 };
    const next = [...judgments];
    let rejected = 0;
    for (const close of delta.close ?? []) {
        const index = next.findIndex((item) => item.id === close.id.trim().toUpperCase());
        const item = next[index];
        if (item && item.status === 'open') next[index] = { ...item, status: close.status };
    }
    const words = normalise(
        history.map((message) => (message.role === 'user' ? userWords(message.content) : '')).join('\n'),
    );
    const open = new Set(next.filter((item) => item.status === 'open').map((item) => normalise(item.text)));
    let added = 0;
    for (const raw of delta.add ?? []) {
        const parsed = JudgmentAddition.safeParse(raw);
        if (!parsed.success || added >= MAX_ADDITIONS) {
            rejected++;
            continue;
        }
        const addition = parsed.data;
        if (addition.kind === 'constraint' && !(addition.quote && words.includes(normalise(addition.quote)))) {
            rejected++;
            continue;
        }
        const text = addition.text.slice(0, 500);
        // The same entry again, as models tend to repeat what the state already says.
        if (open.has(normalise(text))) continue;
        open.add(normalise(text));
        added++;
        next.push({
            id: `${ID_PREFIX[addition.kind as JudgmentKind]}${next.length + 1}`,
            kind: addition.kind,
            text,
            status: 'open',
            ...(addition.kind === 'constraint' && addition.quote ? { quote: addition.quote.slice(0, 300) } : {}),
            ...(addition.kind === 'decision' && addition.why ? { why: addition.why.slice(0, 300) } : {}),
            at,
        });
    }
    return { judgments: next, rejected };
}

/**
 * What the model is asked at the end of the context. English like the engine's other instructions; the content in
 * the language of the conversation.
 */
export function compactionInstruction(judgments: readonly Judgment[], focus?: string): string {
    const open = judgments.filter((item) => item.status === 'open');
    const ids = open.length > 0 ? `Open entries you may close: ${open.map((item) => item.id).join(', ')}.` : '';
    return `<system-reminder>The context is nearly full. Do not answer or call any tool now: the earlier turns are about to be replaced by a state of the work that the host renders from its records — every message of the user word for word, the todo list, the files read and changed, the latest commands and their results, the failures not yet fixed and the background jobs. Add what only you can judge, in the language of the conversation, in exactly this form:

<narrative>
How the work went, in at most 250 words: why it was done this way, what is in progress right now and the next concrete step, anything learned that is not obvious from the records. Name files, symbols and commands exactly. No preamble.
</narrative>
<ledger>
{"add": [{"kind": "constraint", "text": "...", "quote": "the user's exact words"}, {"kind": "decision", "text": "...", "why": "..."}, {"kind": "fact", "text": "..."}, {"kind": "question", "text": "..."}, {"kind": "deadend", "text": "what was tried and why it failed"}], "close": [{"id": "Q4", "status": "done"}, {"id": "D2", "status": "superseded"}]}
</ledger>

Rules for the ledger: only entries that are new or changed — never repeat what the state already holds; at most ${MAX_ADDITIONS}; one sentence each. A constraint is a requirement or preference the user stated, and its quote must be copied exactly from one of their messages. A question is one still open. Close entries that were settled or replaced. ${ids}${focus ? `\nThe user asked to keep in particular: ${focus}` : ''}</system-reminder>`;
}

/**
 * The request's messages with the instruction at the end: in the last user or tool message when the context ends
 * with one (a user message straight after tool results is refused by some providers), else in a message of its own.
 */
export function withInstruction(messages: readonly Message[], instruction: string): Message[] {
    const out = [...messages];
    const last = out.at(-1);
    if (last?.role === 'user' || last?.role === 'tool') {
        out[out.length - 1] = { ...last, content: [...last.content, { type: 'text', text: instruction }] } as Message;
    } else {
        out.push({ role: 'user', content: [{ type: 'text', text: instruction }] });
    }
    return out;
}

/** The request the model is asked to compact with: the context it would have sent next, then the instruction. */
export function compactionMessages(session: EngineSession, focus?: string): Message[] {
    return withInstruction(contextMessages(session), compactionInstruction(session.judgments, focus));
}

/** The state as the user is shown it when they open a compaction: without the wrapper and the note to the model. */
export function displayState(state: string): string {
    const lines = state.split('\n');
    if (lines[0] !== '<task_state>') return state;
    return lines
        .slice(2)
        .filter((line) => line !== '</task_state>')
        .join('\n')
        .trim();
}

export interface Compacted {
    readonly before: number;
    readonly after: number;
    /** The state that now starts the context. */
    readonly state: string;
    /** Whether the model's part made it into the state. */
    readonly judged: boolean;
    readonly rejected: number;
}

/**
 * Starts the context from the state of the work, keeping the history from `cut` on. `answer`: the model's reply to
 * the compaction request, if it gave one.
 */
export function applyCompaction(
    session: EngineSession,
    cut: number,
    options: {
        readonly answer?: string;
        readonly level: number;
        readonly jobs?: readonly string[];
        readonly requestTokens: number;
    },
): Compacted {
    const before = contextMessages(session).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    const at = session.compactions + 1;
    const proposal = options.answer ? parseProposal(options.answer) : { narrative: undefined, delta: undefined };
    const merged = mergeJudgments(session.judgments, proposal.delta, session.history, at);
    const narrative = proposal.narrative?.slice(0, NARRATIVE_CHARS);
    // A summary that is not a state (one written before 1.3, or the host's for a fresh start) is the account of the
    // turns behind it: it stays as the earliest narrative instead of being lost.
    const earlier =
        session.summary && !session.summary.startsWith(STATE_TAG)
            ? [...session.narratives, session.summary.slice(0, NARRATIVE_CHARS)]
            : session.narratives;
    const narratives =
        narrative && narrative !== earlier.at(-1) ? [...earlier, narrative].slice(-KEEP_NARRATIVES) : earlier;
    const judged = narrative !== undefined || proposal.delta !== undefined;
    const state = renderState({
        observed: observe(session.history.slice(0, cut)),
        plan: session.todos,
        judgments: merged.judgments,
        narratives,
        jobs: options.jobs ?? [],
        compactions: at,
        keptFrom: cut,
        requestTokens: options.requestTokens,
    });
    session.contextStart = cut;
    session.summary = state;
    session.prunedUpTo = Math.max(session.prunedUpTo, cut);
    session.judgments = merged.judgments;
    session.narratives = narratives;
    session.compactions = at;
    session.maskFrozen = false;
    session.lastPromptTokens = 0;
    session.lastPromptEstimate = 0;
    const after = estimateTokens(state);
    session.file.append({
        t: 'compaction',
        ts: Date.now(),
        level: options.level,
        summary: state,
        keepFrom: cut,
        tokensBefore: before,
        tokensAfter: after,
        judgments: merged.judgments,
        narratives,
    });
    return { before, after, state, judged, rejected: merged.rejected };
}
