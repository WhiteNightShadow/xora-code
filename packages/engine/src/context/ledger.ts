import path from 'node:path';
import type { Message } from '@xora/providers';
import { clipText, renderTodos, type TodoItem } from '../deps.ts';
import { argsOf, callsOf, describeCall, notableLine, refOf } from './outputs.ts';
import { clipTokens, estimateTokens, messageText, userWords } from './tokens.ts';

/**
 * The task ledger (20 §4.2): the state of the work in a session, which replaces the compacted turns. The engine
 * records what it can observe — the messages to the model, the files read and changed, the commands and how they
 * ended, the other tools called, the failures not yet fixed — from the history itself, so nothing is recited by the
 * model. What only the model can judge (constraints, decisions, facts, open questions, dead ends) it writes at each
 * compaction, as additions to what is there, under ids the engine gives; nothing is deleted, only marked closed.
 */

export type JudgmentKind = 'constraint' | 'decision' | 'fact' | 'question' | 'deadend';

export interface Judgment {
    /** C1, D2, F3, Q4, X5. */
    readonly id: string;
    readonly kind: JudgmentKind;
    readonly text: string;
    readonly status: 'open' | 'done' | 'superseded';
    /** For a constraint: the words it rests on, part of one of the messages to the model. */
    readonly quote?: string;
    /** For a decision: why. */
    readonly why?: string;
    /** The compaction that wrote it, from 1. */
    readonly at: number;
}

export const ID_PREFIX: Readonly<Record<JudgmentKind, string>> = {
    constraint: 'C',
    decision: 'D',
    fact: 'F',
    question: 'Q',
    deadend: 'X',
};

export interface FileState {
    readonly path: string;
    reads: number;
    edits: number;
    /** History index of the latest result that read or changed it. */
    last: number;
    lastEdit?: number;
}

export interface CallState {
    readonly index: number;
    /** The tool and what it worked on, or the command. */
    readonly what: string;
    readonly ok: boolean;
    readonly line: string;
}

export interface Observed {
    /** The messages to the model in their own words (see `userWords`), oldest first. */
    readonly requests: ReadonlyArray<{ readonly index: number; readonly text: string }>;
    /** Latest activity first. */
    readonly files: readonly FileState[];
    /** Shell commands, oldest first. */
    readonly commands: readonly CallState[];
    /** Calls of every other tool (search, the web, MCP servers, the host's tools), oldest first. */
    readonly others: readonly CallState[];
    /** Failures no later call of the same tool on the same thing has fixed, the latest last. */
    readonly failures: readonly CallState[];
    /** The latest reply of the model with text. */
    readonly lastReply?: number;
}

const FILE_READERS = new Set(['read', 'lsp']);
const FILE_WRITERS = new Set(['edit', 'multi_edit', 'write']);
/** Tools the ledger shows elsewhere (the plan) or that only read what is already in it. */
const UNLISTED = new Set(['todo', 'tool_output', 'bash_output']);

/** The paths a patch names, renames included. */
function patchPaths(patch: unknown): string[] {
    if (typeof patch !== 'string') return [];
    return [...patch.matchAll(/^\s*\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+)$/gm)].map((match) =>
        (match[1] ?? '').trim(),
    );
}

/**
 * Observes the history from `from` (where the context last started over, 20 §4.4), with absolute indexes for
 * references. Paths are shown relative to `cwd` when inside it, so one file read both ways counts once.
 */
export function observe(history: readonly Message[], from = 0, cwd?: string): Observed {
    const calls = callsOf(history);
    const requests: Array<{ index: number; text: string }> = [];
    const files = new Map<string, FileState>();
    const commands: CallState[] = [];
    const others: CallState[] = [];
    const failing = new Map<string, CallState>();
    let lastReply: number | undefined;
    const shown = (file: string): string => {
        if (!cwd) return file;
        const absolute = path.resolve(cwd, file);
        const relative = path.relative(cwd, absolute);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : absolute;
    };
    const touch = (file: string, index: number, edit: boolean) => {
        const key = shown(file);
        const state = files.get(key) ?? { path: key, reads: 0, edits: 0, last: index };
        if (edit) {
            state.edits++;
            state.lastEdit = index;
        } else {
            state.reads++;
        }
        state.last = index;
        files.delete(key);
        files.set(key, state);
    };
    for (let index = Math.max(0, from); index < history.length; index++) {
        const message = history[index];
        if (!message) continue;
        if (message.role === 'user') {
            const text = userWords(message.content);
            if (text) requests.push({ index, text });
            continue;
        }
        if (message.role === 'assistant') {
            if (message.content.some((part) => part.type === 'text' && part.text.trim())) lastReply = index;
            continue;
        }
        const call = calls.get(index);
        const args = argsOf(call);
        const name = message.toolName;
        const failed = message.isError === true;
        const file = typeof args.path === 'string' ? args.path : undefined;
        if (!failed && file && FILE_READERS.has(name)) touch(file, index, false);
        if (!failed && file && FILE_WRITERS.has(name)) touch(file, index, true);
        if (!failed && name === 'apply_patch') for (const item of patchPaths(args.patch)) touch(item, index, true);
        const line = notableLine(messageText(message), failed);
        const what = `${name} ${describeCall(call)}`.trim();
        if (name === 'bash' && typeof args.command === 'string') {
            commands.push({ index, what: args.command, ok: !failed, line });
        } else if (
            !FILE_READERS.has(name) &&
            !FILE_WRITERS.has(name) &&
            name !== 'apply_patch' &&
            !UNLISTED.has(name)
        ) {
            others.push({ index, what, ok: !failed, line });
        }
        // The latest failure of a call goes last, so a failure that keeps coming back is never pushed out.
        failing.delete(what);
        if (failed) failing.set(what, { index, what, ok: false, line });
    }
    return {
        requests,
        files: [...files.values()].reverse(),
        commands,
        others,
        failures: [...failing.values()],
        ...(lastReply === undefined ? {} : { lastReply }),
    };
}

// Rendering --------------------------------------------------------------------------------------------------

/** What the rendered state keeps at most: it is read on every request until the next compaction. */
const LIMITS = { files: 40, commands: 12, others: 12, failures: 10, judgments: 20, base: 6_000 };
/** Tokens one message other than the newest may take: one long message does not push all the others out. */
const MESSAGE_TOKENS = 4_000;

export interface StateParts {
    readonly observed: Observed;
    readonly plan: readonly TodoItem[];
    readonly judgments: readonly Judgment[];
    /** What the model wrote at each compaction of how the work went, oldest first. */
    readonly narratives: readonly string[];
    /** Where the work stood when the context last started over: the host's account, or a summary from before 1.3. */
    readonly base?: string | undefined;
    /** Background jobs still running, one line each. */
    readonly jobs: readonly string[];
    /** The environment the work runs in, as the first message gave it. */
    readonly environment?: string | undefined;
    /** Compactions so far, this one included. */
    readonly compactions: number;
    /** Messages from here on stay verbatim in the history after the state; they are not repeated in it. */
    readonly keptFrom: number;
    /** Tokens the messages to the model may take in the state; the newest is cut rather than left out. */
    readonly requestTokens: number;
}

function clip(text: string, limit: number): string {
    return clipText(text.replace(/\s+/g, ' ').trim(), limit);
}

function callLine(call: CallState): string {
    return `- #${refOf(call.index)} \`${clip(call.what, 160)}\` → ${call.ok ? 'ok' : 'failed'}${call.line ? ` · ${call.line}` : ''}`;
}

/**
 * The state as the model reads it, always in the same order and form, so equal states render equally. Headings are
 * English like the rest of the engine's instructions; the content is in whatever language it was written in.
 */
export function renderState(parts: StateParts): string {
    const lines: string[] = [
        '<task_state>',
        'The earlier turns of this conversation were replaced by this state of the work: what the engine recorded as it happened and what was judged worth keeping at each compaction. Continue from it. Ids are stable. tool_output("R123") returns a message or tool output of the conversation as it was, without running anything again.',
    ];
    if (parts.environment) {
        lines.push('', '## Environment', parts.environment);
    }
    const requests = parts.observed.requests.filter((request) => request.index < parts.keptFrom);
    if (requests.length > 0) {
        lines.push(
            '',
            "## Messages to you, newest first, word for word (the user's; in work the host hands you, the host's)",
        );
        let budget = parts.requestTokens;
        const left: string[] = [];
        [...requests].reverse().forEach((request, order) => {
            const ref = refOf(request.index);
            // The newest is the work in progress: never left out, at most cut, and whole a reference away.
            const allowed = order === 0 ? budget : Math.min(budget, MESSAGE_TOKENS);
            if (order > 0 && allowed < Math.min(MESSAGE_TOKENS, estimateTokens(request.text))) {
                left.push(`#${ref}`);
                return;
            }
            const shown = clipTokens(request.text, Math.max(0, allowed));
            budget -= estimateTokens(shown);
            const cut = shown.length < request.text.length;
            lines.push(
                `- #${ref} ${shown.replace(/\n/g, '\n  ')}${cut ? `… [cut for room; tool_output("${ref}") returns the whole message]` : ''}`,
            );
        });
        if (left.length > 0) {
            lines.push(
                `- ${left.length} older message(s) left out for room: ${left.slice(0, 10).join(', ')}${left.length > 10 ? ', …' : ''}`,
            );
        }
    }
    if (parts.base) {
        lines.push(
            '',
            '## Where the work stood when this conversation last started over',
            clipText(parts.base.trim(), LIMITS.base),
        );
    }
    if (parts.plan.length > 0) {
        lines.push('', '## Plan (the todo list)', renderTodos(parts.plan));
    }
    const sections: ReadonlyArray<[JudgmentKind, string]> = [
        ['constraint', 'Constraints'],
        ['decision', 'Decisions'],
        ['fact', 'Facts'],
        ['question', 'Open questions'],
        ['deadend', 'Dead ends (tried, did not work)'],
    ];
    for (const [kind, title] of sections) {
        const open = parts.judgments
            .filter((item) => item.kind === kind && item.status === 'open')
            .slice(-LIMITS.judgments);
        if (open.length === 0) continue;
        lines.push('', `## ${title}`);
        for (const item of open) {
            const extra = item.quote
                ? ` — quoted: "${clip(item.quote, 200)}"`
                : item.why
                  ? ` — because ${clip(item.why, 200)}`
                  : '';
            lines.push(`- ${item.id} ${clip(item.text, 300)}${extra}`);
        }
    }
    const files = parts.observed.files.slice(0, LIMITS.files);
    if (files.length > 0) {
        lines.push('', '## Files, latest first');
        for (const file of files) {
            const done = [file.reads > 0 ? `read ${file.reads}×` : '', file.edits > 0 ? `changed ${file.edits}×` : '']
                .filter(Boolean)
                .join(', ');
            lines.push(`- ${file.path} — ${done} (latest #${refOf(file.lastEdit ?? file.last)})`);
        }
        const more = parts.observed.files.length - files.length;
        if (more > 0) lines.push(`- and ${more} more`);
    }
    const commands = parts.observed.commands.slice(-LIMITS.commands);
    if (commands.length > 0) {
        lines.push('', '## Latest commands');
        for (const command of commands) lines.push(callLine(command));
    }
    const others = parts.observed.others.slice(-LIMITS.others);
    if (others.length > 0) {
        lines.push('', '## Other tool calls, latest last (they ran: do not repeat one that changes something)');
        for (const call of others) lines.push(callLine(call));
    }
    const failures = parts.observed.failures.slice(-LIMITS.failures);
    if (failures.length > 0) {
        lines.push('', '## Failures not fixed since');
        for (const failure of failures) lines.push(callLine(failure));
    }
    if (parts.jobs.length > 0) {
        lines.push('', '## Background jobs still running');
        for (const job of parts.jobs) lines.push(`- ${job}`);
    }
    if (parts.narratives.length > 0) {
        lines.push('', '## How the work went');
        for (const narrative of parts.narratives) lines.push(narrative.trim(), '');
        if (lines.at(-1) === '') lines.pop();
    }
    const reply = parts.observed.lastReply;
    if (reply !== undefined && reply < parts.keptFrom) {
        lines.push('', `Your latest reply before this state is #${refOf(reply)}.`);
    }
    if (parts.compactions >= 3) {
        lines.push(
            '',
            `This conversation has been compacted ${parts.compactions} times. If much work is left, suggest to the user to go on in a new conversation started from this state.`,
        );
    }
    lines.push('</task_state>');
    return lines.join('\n');
}
