import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Message } from '@xora/providers';
import type { TodoItem } from '@xora/tools';
import type { Judgment } from './context/ledger.ts';

/**
 * The engine's own session log: the source of the model context (02 §5). Append-only JSONL; a compaction
 * entry does not delete anything, it records where the effective context now starts.
 */
export type SessionEntry =
    | {
          readonly t: 'header';
          readonly v: 1;
          readonly id: string;
          readonly cwd: string;
          readonly roots: readonly string[];
          readonly createdAt: number;
      }
    | { readonly t: 'config'; readonly ts: number; readonly config: Record<string, unknown> }
    | { readonly t: 'message'; readonly ts: number; readonly message: Message }
    | { readonly t: 'todos'; readonly ts: number; readonly items: readonly TodoItem[] }
    | { readonly t: 'title'; readonly ts: number; readonly title: string }
    | {
          readonly t: 'compaction';
          readonly ts: number;
          readonly level: number;
          readonly summary: string;
          /** Index in the full message list where the kept tail starts. */
          readonly keepFrom: number;
          readonly tokensBefore: number;
          readonly tokensAfter: number;
          /** The ledger's judgments after this compaction, all of them (20 §4.2); absent before 1.3. */
          readonly judgments?: readonly Judgment[];
          /** The model's accounts of how the work went, the latest few. */
          readonly narratives?: readonly string[];
          /**
           * The context started over from the host's account of the work (a supervisor woken with the state of its
           * run, 06 §29): the ledger looks at the history from here on and earlier judgments no longer hold.
           */
          readonly fresh?: true;
      }
    /** Tool results before `upTo` are shown as one-line references from now on (20 §4.3). */
    | { readonly t: 'prune'; readonly ts: number; readonly upTo: number }
    /** A host turn starts here, so the host can go back to before it or fork from it (M3-3). */
    | { readonly t: 'turn'; readonly ts: number; readonly turnId: string }
    /** The session is back at its state when the turn `turnId` started; nothing before is deleted. */
    | { readonly t: 'rewind'; readonly ts: number; readonly turnId: string };

export const SESSION_FILE = 'session.jsonl';

export class SessionFile {
    readonly dir: string;
    readonly file: string;

    constructor(dir: string) {
        this.dir = dir;
        this.file = path.join(dir, SESSION_FILE);
    }

    static exists(dir: string): boolean {
        return existsSync(path.join(dir, SESSION_FILE));
    }

    create(header: Extract<SessionEntry, { t: 'header' }>): void {
        mkdirSync(this.dir, { recursive: true });
        appendFileSync(this.file, `${JSON.stringify(header)}\n`, 'utf8');
    }

    append(entry: SessionEntry): void {
        appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    }

    /** Reads every entry, skipping a torn last line or any line that does not parse. */
    read(): SessionEntry[] {
        if (!existsSync(this.file)) {
            return [];
        }
        const entries: SessionEntry[] = [];
        for (const line of readFileSync(this.file, 'utf8').split('\n')) {
            if (line.trim().length === 0) {
                continue;
            }
            try {
                entries.push(JSON.parse(line) as SessionEntry);
            } catch {
                // A crash mid-append leaves at most one torn line; it is safe to ignore.
            }
        }
        return entries;
    }
}

export interface StoredSessionInfo {
    readonly id: string;
    readonly cwd: string;
    readonly title?: string;
    readonly updatedAt: string;
}

/** Lists sessions under `<root>/<id>/session.jsonl`, newest first. */
export function listStoredSessions(root: string, cwd?: string): StoredSessionInfo[] {
    if (!existsSync(root)) {
        return [];
    }
    const sessions: StoredSessionInfo[] = [];
    for (const name of readdirSync(root)) {
        const file = new SessionFile(path.join(root, name));
        if (!existsSync(file.file)) {
            continue;
        }
        const entries = file.read();
        const header = entries.find((entry) => entry.t === 'header');
        if (!header || (cwd && header.cwd !== cwd)) {
            continue;
        }
        const title = entries.findLast((entry) => entry.t === 'title');
        sessions.push({
            id: header.id,
            cwd: header.cwd,
            ...(title ? { title: title.title } : {}),
            updatedAt: statSync(file.file).mtime.toISOString(),
        });
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Turns that can still be rewound to, in order: a rewind drops its turn and every later one. */
export function liveTurns(entries: readonly SessionEntry[]): string[] {
    const turns: string[] = [];
    for (const entry of entries) {
        if (entry.t === 'turn') {
            turns.push(entry.turnId);
        } else if (entry.t === 'rewind') {
            const at = turns.indexOf(entry.turnId);
            if (at >= 0) turns.length = at;
        }
    }
    return turns;
}
