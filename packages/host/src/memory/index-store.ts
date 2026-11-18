import { readFileSync, statSync } from 'node:fs';
import type { XoraDatabase } from '@xora/storage';
import { noteDate, noteText } from './notes.ts';

export interface MemorySearchSource {
    readonly file: string;
    readonly who: string;
    readonly project: string | undefined;
    readonly boost: number;
}

export interface RankedMemoryHit {
    readonly line: string;
    readonly score: number;
    readonly date: string;
}

export interface ScoreNoteInput {
    readonly bodyLower: string;
    readonly noteDate: string;
    readonly queryLower: string;
    readonly terms: readonly string[];
    readonly boost: number;
    readonly bm25?: number;
    readonly nowMs: number;
}

const DAY_MS = 86_400_000;
const HALF_LIFE_DAYS = 60;
const FTS_LIMIT = 300;

function recencyBonus(dateText: string, nowMs: number): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return 0;
    const parsed = Date.parse(`${dateText}T00:00:00Z`);
    if (!Number.isFinite(parsed)) return 0;
    const ageDays = Math.max(0, (nowMs - parsed) / DAY_MS);
    return 1.5 * Math.exp(-ageDays / HALF_LIFE_DAYS);
}

/**
 * Hybrid relevance score combining FTS5 trigram BM25 specificity, exact-phrase bonus, query-term coverage,
 * ownership/project boost, and a 60-day exponential recency decay.
 */
export function scoreNoteHit(input: ScoreNoteInput): number {
    const matched = input.terms.filter((term) => input.bodyLower.includes(term)).length;
    const exactPhrase = input.queryLower.length > 0 && input.bodyLower.includes(input.queryLower);
    if (matched === 0 && !exactPhrase) return 0;
    const rawBm25 = input.bm25 !== undefined && Number.isFinite(input.bm25) ? Math.max(0, -input.bm25) : 0;
    const bm25Part = Math.min(12, rawBm25) * 1.5;
    const phrasePart = exactPhrase && input.terms.length > 1 ? 4 : 0;
    const coveragePart = (matched / Math.max(1, input.terms.length)) * 6 + matched * 2;
    const scopePart = input.boost * 2.5;
    const recencyPart = recencyBonus(input.noteDate, input.nowMs);
    return bm25Part + phrasePart + coveragePart + scopePart + recencyPart;
}

function escapeLike(term: string): string {
    return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

interface FtsRow {
    file_path: string;
    line_no: number;
    raw_line: string;
    note_date: string;
    body: string;
    bm25: number;
}

/**
 * SQLite FTS5 trigram index over Markdown memory files. The `.md` files remain the source of truth so users can
 * inspect and edit them directly; each queried file checks `(mtime_ms, size)` first and only re-indexes on change.
 */
export class MemoryIndexStore {
    readonly #db: XoraDatabase;

    constructor(db: XoraDatabase) {
        this.#db = db;
    }

    syncFile(filePath: string, force = false): void {
        let mtimeStamp = 0;
        let size = 0;
        try {
            const info = statSync(filePath);
            mtimeStamp = Math.round(info.mtimeMs * 1000);
            size = info.size;
        } catch {
            this.removeFile(filePath);
            return;
        }
        if (!force) {
            const tracked = this.#db.get<{ mtime_ms: number; size: number }>(
                'select mtime_ms, size from memory_files where file_path = ?',
                [filePath],
            );
            if (tracked && tracked.mtime_ms === mtimeStamp && tracked.size === size) {
                return;
            }
        }
        let content = '';
        try {
            content = readFileSync(filePath, 'utf8');
        } catch {
            this.removeFile(filePath);
            return;
        }
        const entries: Array<{ lineNo: number; rawLine: string; date: string; body: string }> = [];
        for (const [index, line] of content.replace(/\r\n?/g, '\n').split('\n').entries()) {
            const body = noteText(line).toLowerCase();
            if (!body) continue;
            entries.push({
                lineNo: index + 1,
                rawLine: line,
                date: noteDate(line),
                body,
            });
        }
        this.#db.transaction(() => {
            this.#db.run('delete from memory_notes_fts where file_path = ?', [filePath]);
            for (const entry of entries) {
                this.#db.run(
                    'insert into memory_notes_fts (file_path, line_no, raw_line, note_date, body) values (?, ?, ?, ?, ?)',
                    [filePath, entry.lineNo, entry.rawLine, entry.date, entry.body],
                );
            }
            this.#db.run(
                `insert into memory_files (file_path, mtime_ms, size) values (?, ?, ?)
                 on conflict(file_path) do update set mtime_ms = excluded.mtime_ms, size = excluded.size`,
                [filePath, mtimeStamp, size],
            );
        });
    }

    removeFile(filePath: string): void {
        const tracked = this.#db.get<{ file_path: string }>('select file_path from memory_files where file_path = ?', [
            filePath,
        ]);
        if (!tracked) return;
        this.#db.transaction(() => {
            this.#db.run('delete from memory_notes_fts where file_path = ?', [filePath]);
            this.#db.run('delete from memory_files where file_path = ?', [filePath]);
        });
    }

    search(
        sources: readonly MemorySearchSource[],
        query: string,
        terms: readonly string[],
        nowMs: number,
    ): RankedMemoryHit[] {
        if (sources.length === 0) return [];
        const byFile = new Map<string, MemorySearchSource>();
        for (const source of sources) {
            this.syncFile(source.file);
            byFile.set(source.file, source);
        }
        const queryLower = query.toLowerCase();
        const unique = [...new Set([queryLower, ...terms])].filter(Boolean);
        const ftsTerms = unique.filter((term) => [...term].length >= 3).slice(0, 24);
        const shortTerms = unique
            .filter((term) => {
                const len = [...term].length;
                return len >= 1 && len < 3;
            })
            .slice(0, 24);

        const merged = new Map<string, FtsRow>();
        if (ftsTerms.length > 0) {
            const matchExpr = ftsTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
            try {
                const rows = this.#db.all<FtsRow>(
                    `select file_path, line_no, raw_line, note_date, body, bm25(memory_notes_fts) as bm25
                     from memory_notes_fts where memory_notes_fts match ? order by rank limit ${FTS_LIMIT}`,
                    [matchExpr],
                );
                for (const row of rows) {
                    if (!byFile.has(row.file_path)) continue;
                    merged.set(`${row.file_path}:${row.line_no}`, row);
                }
            } catch {
                // Fall back to LIKE below if an unusual query cannot be parsed by FTS5.
            }
        }
        if (shortTerms.length > 0) {
            const clauses = shortTerms.map(() => "body like ? escape '\\'").join(' or ');
            const params = shortTerms.map(escapeLike);
            const rows = this.#db.all<FtsRow>(
                `select file_path, line_no, raw_line, note_date, body, 0.0 as bm25
                 from memory_notes_fts where ${clauses} limit ${FTS_LIMIT}`,
                params,
            );
            for (const row of rows) {
                if (!byFile.has(row.file_path)) continue;
                const key = `${row.file_path}:${row.line_no}`;
                if (!merged.has(key)) merged.set(key, row);
            }
        }

        const hits: RankedMemoryHit[] = [];
        for (const row of merged.values()) {
            const source = byFile.get(row.file_path);
            if (!source) continue;
            const score = scoreNoteHit({
                bodyLower: row.body,
                noteDate: row.note_date,
                queryLower,
                terms,
                boost: source.boost,
                bm25: row.bm25,
                nowMs,
            });
            if (score <= 0) continue;
            const where = source.project ? `${source.who} · ${source.project}` : source.who;
            hits.push({
                line: `- (${where}) ${row.raw_line.replace(/^\s*[-*]\s*/, '')}`,
                score,
                date: row.note_date,
            });
        }
        hits.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
        return hits;
    }
}
