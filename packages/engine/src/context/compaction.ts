import type { Message } from '@xora/providers';
import { z } from 'zod';
import { clipText } from '../deps.ts';
import type { EngineSession } from '../session.ts';
import { ID_PREFIX, type Judgment, observe, renderState } from './ledger.ts';
import { contextMessages } from './messages.ts';
import { estimateMessageTokens, estimateTokens, userWords } from './tokens.ts';

/**
 * Compaction (20 §4.4): older turns give way to the state of the work. The engine renders the state itself from what
 * it recorded; the model, asked in the same request it would have made next (same model, system prompt, tools and
 * messages, so the provider's cache covers it), adds only what it alone can judge: a short account of how the work
 * went and additions to the ledger. Its answer is checked item by item, and when it fails the state is the engine's
 * part alone.
 */

/** Additions the model may make to the ledger in one compaction. */
const MAX_ADDITIONS = 12;
/** Narratives longer than this are cut: the state is read on every request until the next compaction. */
const NARRATIVE_CHARS = 2_000;
/** Narratives the session keeps; the state shows them all. */
const KEEP_NARRATIVES = 2;

export interface Sizes {
    /** The budget the context must stay within (see `contextBudget`). */
    readonly budget: number;
    /** The system prompt and tool definitions, estimated: what no compaction shrinks. */
    readonly fixed: number;
    /** The whole request as the vendor counts it, best guess. */
    readonly used: number;
    /** The whole request as the engine estimates it, the fixed part included. */
    readonly estimated: number;
}

/**
 * How much a compaction keeps: the latest steps verbatim (a share of the room the conversation has, at most a quarter
 * of what there is, so a `/compact` of a small context still shrinks it) and the messages to the model in the state.
 * In the engine's units, as the cut and the state are measured in them.
 */
export function compactionShares(sizes: Sizes): { tail: number; requests: number } {
    const { budget, fixed, used, estimated } = sizes;
    const scale = used > 0 && estimated > 0 ? Math.min(4, Math.max(0.25, estimated / used)) : 1;
    const room = Math.max(8_000, budget - fixed);
    const messages = Math.max(0, estimated - fixed);
    return {
        tail: Math.min(Math.min(24_000, room * 0.15) * scale, messages * 0.25),
        requests: Math.min(20_000, room * 0.15) * scale,
    };
}

/**
 * Where what the model has not seen yet begins: the results of its latest calls (from the reply that made them, a
 * call and its result are never parted), else the messages sent after its latest reply.
 */
export function unseenFrom(session: EngineSession): number {
    const history = session.history;
    for (let index = history.length - 1; index >= session.contextStart; index--) {
        const message = history[index];
        if (message?.role === 'assistant') {
            return history.slice(index + 1).some((item) => item.role === 'tool') ? index : index + 1;
        }
    }
    return session.contextStart;
}

/**
 * Where the kept tail of the history starts after a compaction: the latest steps within `keep` tokens, cut before a
 * message to the model or a reply, never between a call and its result; what the model has not seen yet is kept
 * whatever its size. `history.length`: nothing is kept (the state alone continues the work); `undefined`: nothing to
 * compact — the context fits, or before the cut there are only messages to the model, which the state would repeat.
 */
export function compactionCut(session: EngineSession, keep: number): number | undefined {
    const history = session.history;
    let cut = history.length;
    let tokens = 0;
    for (let index = history.length - 1; index >= session.contextStart; index--) {
        const message = history[index];
        if (!message) continue;
        tokens += estimateMessageTokens(message);
        if (tokens > keep) break;
        if (message.role !== 'tool') cut = index;
    }
    cut = Math.min(cut, unseenFrom(session));
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

const JudgmentClose = z.object({ id: z.string().trim().min(1), status: z.string().trim().min(1) });

/** How models write that an entry was settled or replaced, in English and Chinese. */
const DONE = /^(done|resolved|completed?|answered|closed|fixed|settled|已?完成|已?解决|已?回答|已关闭)$/i;
const SUPERSEDED = /^(superseded|replaced|obsolete|outdated|被取代|已取代|已替换|过时|作废)$/i;
/** Text copied from the form instead of written: `...`, `<one sentence>`. */
const PLACEHOLDER = /^(\.{2,}|…+|<[^<>]*>)$/;

export interface Proposal {
    readonly narrative: string | undefined;
    /** The ledger's additions and closings as the model wrote them, each item still to be checked. */
    readonly delta: { readonly add: readonly unknown[]; readonly close: readonly unknown[] } | undefined;
}

/** The model's answer to the compaction request: its narrative and its ledger, read as leniently as is safe. */
export function parseProposal(text: string): Proposal {
    const narrative = /<narrative>([\s\S]*?)<\/narrative>/i.exec(text)?.[1]?.trim();
    const section = /<ledger>([\s\S]*?)<\/ledger>/i.exec(text)?.[1] ?? '';
    // The JSON object inside, whatever fences or words come around it.
    const json = section.slice(section.indexOf('{'), section.lastIndexOf('}') + 1);
    let parsed: unknown;
    try {
        parsed = json ? JSON.parse(json) : undefined;
    } catch {
        parsed = undefined;
    }
    const object = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
    return {
        narrative: narrative || undefined,
        delta: object
            ? {
                  add: Array.isArray(object.add) ? object.add : [],
                  close: Array.isArray(object.close) ? object.close : [],
              }
            : undefined,
    };
}

/** Text without differences of spacing or case, to find a quote in the messages. */
const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

export interface Merged {
    readonly judgments: readonly Judgment[];
    /**
     * Items dropped: malformed, a placeholder, over the limit, a constraint whose quote is in no message to the model,
     * or a closing of an entry that is not open.
     */
    readonly rejected: number;
}

/**
 * The model's additions merged into the ledger, each item on its own: a bad one is dropped, the rest still count.
 * Ids are the engine's, never the model's, and nothing is removed: a closed entry stays with its status.
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
    for (const raw of delta.close) {
        const close = JudgmentClose.safeParse(raw);
        const status = close.success
            ? DONE.test(close.data.status)
                ? 'done'
                : SUPERSEDED.test(close.data.status)
                  ? 'superseded'
                  : undefined
            : undefined;
        const index = close.success ? next.findIndex((item) => item.id === close.data.id.toUpperCase()) : -1;
        const item = next[index];
        if (!status || !item || item.status !== 'open') {
            rejected++;
            continue;
        }
        next[index] = { ...item, status };
    }
    const words = normalise(
        history.map((message) => (message.role === 'user' ? userWords(message.content) : '')).join('\n'),
    );
    const open = new Set(next.filter((item) => item.status === 'open').map((item) => normalise(item.text)));
    let added = 0;
    for (const raw of delta.add) {
        const parsed = JudgmentAddition.safeParse(raw);
        const addition = parsed.success ? parsed.data : undefined;
        if (
            !addition ||
            added >= MAX_ADDITIONS ||
            PLACEHOLDER.test(addition.text) ||
            (addition.kind === 'constraint' &&
                !(addition.quote && !PLACEHOLDER.test(addition.quote) && words.includes(normalise(addition.quote))))
        ) {
            rejected++;
            continue;
        }
        const text = clipText(addition.text, 500);
        // The same entry again, as models tend to repeat what the state already says.
        if (open.has(normalise(text))) continue;
        open.add(normalise(text));
        added++;
        const why = addition.why && !PLACEHOLDER.test(addition.why) ? addition.why : undefined;
        next.push({
            id: `${ID_PREFIX[addition.kind]}${next.length + 1}`,
            kind: addition.kind,
            text,
            status: 'open',
            ...(addition.kind === 'constraint' && addition.quote ? { quote: clipText(addition.quote, 300) } : {}),
            ...(addition.kind === 'decision' && why ? { why: clipText(why, 300) } : {}),
            at,
        });
    }
    return { judgments: next, rejected };
}

/**
 * What the model is asked at the end of the context. English like the engine's other instructions; the content in
 * the language of the conversation. The form has no ids or text a model could copy as if they were real.
 */
export function compactionInstruction(judgments: readonly Judgment[], focus?: string): string {
    const open = judgments.filter((item) => item.status === 'open');
    const ids =
        open.length > 0
            ? `The open entries, the only ids "close" may name: ${open.map((item) => item.id).join(', ')}.`
            : 'There are no open entries yet, so leave "close" empty.';
    return `<system-reminder>The context is nearly full. Do not answer or call any tool now: the earlier turns are about to be replaced by a state of the work that the engine renders from its records — every message to you word for word, the todo list, the files read and changed, the latest commands and other tool calls with their results, the failures not yet fixed and the background jobs. Add what only you can judge, in the language of the conversation, in this form:

<narrative>
How the work went, in at most 250 words: why it was done this way, what is in progress right now and the next concrete step, anything learned that is not obvious from the records. Name files, symbols and commands exactly. No preamble.
</narrative>
<ledger>
{"add": [{"kind": "<constraint, decision, fact, question or deadend>", "text": "<one sentence>", "quote": "<for a constraint: its words copied exactly from a message to you>", "why": "<for a decision: why>"}], "close": [{"id": "<an open id>", "status": "<done or superseded>"}]}
</ledger>

Rules for the ledger: add only entries that are new or changed, never what the state already holds, at most ${MAX_ADDITIONS}, one sentence each; leave out what you have nothing for — an empty list is fine. A constraint is a requirement or preference stated in a message to you. A question is one still open. A deadend is what was tried and why it failed. Close entries that were settled (done) or replaced (superseded). ${ids}${focus ? `\nThe user asked to keep in particular: ${focus}` : ''}</system-reminder>`;
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
        /** The environment the work runs in (the lines of the first message's environment block). */
        readonly environment?: string;
    },
): Compacted {
    const before = contextMessages(session).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    const at = session.compactions + 1;
    const proposal = options.answer ? parseProposal(options.answer) : { narrative: undefined, delta: undefined };
    const merged = mergeJudgments(session.judgments, proposal.delta, session.history, at);
    const narrative = proposal.narrative ? clipText(proposal.narrative, NARRATIVE_CHARS) : undefined;
    const narratives =
        narrative && narrative !== session.narratives.at(-1)
            ? [...session.narratives, narrative].slice(-KEEP_NARRATIVES)
            : session.narratives;
    const judged = narrative !== undefined || proposal.delta !== undefined;
    // A summary that is not a state (one written before 1.3) is the account of the turns behind it.
    const base = session.base ?? (session.summary?.startsWith('<task_state>') ? undefined : session.summary);
    const state = renderState({
        // The whole history since the context last started over: what happened in the kept tail counts too (a
        // failure fixed there is fixed).
        observed: observe(session.history, session.ledgerFrom, session.cwd),
        plan: session.todos,
        judgments: merged.judgments,
        narratives,
        base,
        jobs: options.jobs ?? [],
        environment: options.environment,
        compactions: at,
        keptFrom: cut,
        requestTokens: options.requestTokens,
    });
    session.startFrom({
        contextStart: cut,
        summary: state,
        base,
        ledgerFrom: session.ledgerFrom,
        judgments: merged.judgments,
        narratives,
        compactions: at,
    });
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
