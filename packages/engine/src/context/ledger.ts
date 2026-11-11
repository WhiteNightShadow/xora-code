import type { Message } from '@xora/providers';
import type { TodoItem } from '@xora/tools';
import { argsOf, callsOf, describeCall, notableLine, refOf } from './outputs.ts';
import { clipTokens, estimateTokens, messageText, userWords } from './tokens.ts';

/**
 * The task ledger (20 §4.2): the state of the work in a session, which replaces the compacted turns. The host's engine
 * records what it can observe — the user's requests, the files read and changed, the commands and how they ended,
 * the failures not yet fixed — from the history itself, so nothing is recited by the model. What only the model can
 * judge (constraints, decisions, facts, open questions, dead ends) it writes at each compaction, as additions to
 * what is there, under stable ids; nothing is rewritten whole and nothing is deleted, only marked superseded.
 */

export type JudgmentKind = 'constraint' | 'decision' | 'fact' | 'question' | 'deadend';

export interface Judgment {
    /** C1, D2, F3, Q4, X5. */
    readonly id: string;
    readonly kind: JudgmentKind;
    readonly text: string;
    readonly status: 'open' | 'done' | 'superseded';
    /** For a constraint: the user's own words it rests on, a part of one of their messages. */
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

export interface CommandState {
    readonly index: number;
    readonly command: string;
    readonly ok: boolean;
    readonly line: string;
}

export interface Observed {
    /** The user's messages: their own words, without the environment block or reminders. */
    readonly requests: ReadonlyArray<{ readonly index: number; readonly text: string }>;
    /** Latest activity first. */
    readonly files: readonly FileState[];
    /** Oldest first. */
    readonly commands: readonly CommandState[];
    /** Failures no later call of the same tool on the same thing has fixed. */
    readonly failures: ReadonlyArray<{ readonly index: number; readonly what: string; readonly line: string }>;
}

const FILE_READERS = new Set(['read', 'lsp']);
const FILE_WRITERS = new Set(['edit', 'multi_edit', 'write']);

/** The paths an apply_patch call names. */
function patchPaths(patch: unknown): string[] {
    if (typeof patch !== 'string') return [];
    return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => (match[1] ?? '').trim());
}

/** What the history shows of the work. */
export function observe(history: readonly Message[]): Observed {
    const calls = callsOf(history);
    const requests: Array<{ index: number; text: string }> = [];
    const files = new Map<string, FileState>();
    const commands: CommandState[] = [];
    const failing = new Map<string, { index: number; what: string; line: string }>();
    const touch = (path: string, index: number, edit: boolean) => {
        const state = files.get(path) ?? { path, reads: 0, edits: 0, last: index };
        if (edit) {
            state.edits++;
            state.lastEdit = index;
        } else {
            state.reads++;
        }
        state.last = index;
        files.delete(path);
        files.set(path, state);
    };
    history.forEach((message, index) => {
        if (message.role === 'user') {
            const text = userWords(message.content);
            if (text) requests.push({ index, text });
            return;
        }
        if (message.role !== 'tool') return;
        const call = calls.get(index);
        const args = argsOf(call);
        const name = message.toolName;
        const failed = message.isError === true;
        const path = typeof args.path === 'string' ? args.path : undefined;
        if (!failed && path && FILE_READERS.has(name)) touch(path, index, false);
        if (!failed && path && FILE_WRITERS.has(name)) touch(path, index, true);
        if (!failed && name === 'apply_patch') for (const file of patchPaths(args.patch)) touch(file, index, true);
        const text = messageText(message);
        if (name === 'bash' && typeof args.command === 'string') {
            commands.push({ index, command: args.command, ok: !failed, line: notableLine(text, failed) });
        }
        const what = `${name} ${describeCall(call)}`.trim();
        if (failed) {
            failing.set(what, { index, what, line: notableLine(text, true) });
        } else {
            failing.delete(what);
        }
    });
    return {
        requests,
        files: [...files.values()].reverse(),
        commands,
        failures: [...failing.values()],
    };
}

// Rendering --------------------------------------------------------------------------------------------------

/** What the rendered state keeps at most: it is read on every request until the next compaction. */
const LIMITS = { files: 40, commands: 12, failures: 10, judgments: 20 };

const STATUS_MARK: Readonly<Record<TodoItem['status'], string>> = {
    completed: '[x]',
    in_progress: '[~]',
    pending: '[ ]',
};

export interface StateParts {
    readonly observed: Observed;
    readonly plan: readonly TodoItem[];
    readonly judgments: readonly Judgment[];
    /** What the model wrote at each compaction of how the work went, oldest first. */
    readonly narratives: readonly string[];
    /** Background jobs still running, one line each. */
    readonly jobs: readonly string[];
    /** Compactions so far, this one included. */
    readonly compactions: number;
    /** User messages from here on stay verbatim in the history after the state; they are not repeated in it. */
    readonly keptFrom: number;
    /** Tokens the user's messages may take in the state; the newest is cut rather than left out. */
    readonly requestTokens: number;
}

function clip(text: string, limit: number): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * The state as the model reads it, always in the same order and form, so equal states render equally. Headings are
 * English like the rest of the engine's instructions; the content is in whatever language it was written in.
 */
export function renderState(parts: StateParts): string {
    const lines: string[] = [
        '<task_state>',
        'The earlier turns of this conversation were replaced by this state of the work: what the host recorded as it happened and what was judged worth keeping at each compaction. Continue from it. Ids are stable. tool_output("R123") returns an earlier tool output as it was, without running anything again.',
    ];
    const requests = parts.observed.requests.filter((request) => request.index < parts.keptFrom);
    if (requests.length > 0) {
        lines.push('', "## The user's messages, newest first, in their own words");
        let budget = parts.requestTokens;
        const left: string[] = [];
        [...requests].reverse().forEach((request, order) => {
            const ref = refOf(request.index);
            const cost = estimateTokens(request.text);
            if (cost <= budget) {
                budget -= cost;
                lines.push(`- #${ref} ${request.text.replace(/\n/g, '\n  ')}`);
            } else if (order === 0) {
                // The newest is the work in progress: never left out, at most cut, and whole a reference away.
                const clipped = clipTokens(request.text, budget);
                budget = 0;
                lines.push(
                    `- #${ref} ${clipped.replace(/\n/g, '\n  ')}… [cut for room; tool_output("${ref}") returns the whole message]`,
                );
            } else {
                left.push(`#${ref}`);
            }
        });
        if (left.length > 0) {
            lines.push(
                `- ${left.length} older message(s) left out for room: ${left.slice(0, 10).join(', ')}${left.length > 10 ? ', …' : ''}`,
            );
        }
    }
    if (parts.plan.length > 0) {
        lines.push('', '## Plan (the todo list)');
        for (const item of parts.plan) lines.push(`- ${STATUS_MARK[item.status]} ${item.content}`);
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
                ? ` — the user: "${clip(item.quote, 200)}"`
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
        for (const command of commands) {
            lines.push(
                `- #${refOf(command.index)} \`${clip(command.command, 160)}\` → ${command.ok ? 'ok' : 'failed'}${command.line ? ` · ${command.line}` : ''}`,
            );
        }
    }
    const failures = parts.observed.failures.slice(-LIMITS.failures);
    if (failures.length > 0) {
        lines.push('', '## Failures not fixed since');
        for (const failure of failures) {
            lines.push(
                `- #${refOf(failure.index)} ${clip(failure.what, 160)}${failure.line ? ` · ${failure.line}` : ''}`,
            );
        }
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
    if (parts.compactions >= 3) {
        lines.push(
            '',
            `This conversation has been compacted ${parts.compactions} times. If much work is left, suggest to the user to go on in a new conversation started from this state.`,
        );
    }
    lines.push('</task_state>');
    return lines.join('\n');
}
