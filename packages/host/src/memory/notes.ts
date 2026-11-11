/**
 * Notes as memory files hold them: one Markdown line each, `- [project date] text` (or `- [date] text` for notes
 * that hold everywhere). Pure functions: the service does the reading and writing.
 */

/** A memory file stays under this: a new note pushes out the oldest ones. */
export const MEMORY_FILE_CHARS = 16_000;
/** The longest note `remember` takes. */
export const NOTE_CHARS = 500;
/** What `recall` returns at most from notes, and from earlier conversations. */
export const RECALL_RESULTS = 15;
export const RECALL_CONVERSATIONS = 5;
export const REMEMBER_TOOL = 'remember';
export const RECALL_TOOL = 'recall';

export function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export function today(at: number): string {
    const date = new Date(at);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A note line's own words, without its `- [project date]` tag. */
export function noteText(line: string): string {
    return line
        .replace(/^\s*[-*]\s*/, '')
        .replace(/^\[[^\]\n]*\]\s*/, '')
        .trim();
}

/** A note's date from its tag, for ranking newer notes first. */
export function noteDate(line: string): string {
    return /\[[^\]\n]*?(\d{4}-\d{2}-\d{2})\]/.exec(line)?.[1] ?? '';
}

/** The latest notes that fit in `limit` characters, and whether older ones were left out. */
export function recentNotes(text: string, limit: number): { text: string; omitted: boolean } {
    const trimmed = text.trim();
    if (trimmed.length <= limit) return { text: trimmed, omitted: false };
    const kept: string[] = [];
    let size = 0;
    for (const line of trimmed.split('\n').reverse()) {
        if (size + line.length + 1 > limit) break;
        kept.unshift(line);
        size += line.length + 1;
    }
    return { text: kept.join('\n').trim(), omitted: true };
}

/** The words of a query, and the two-character pieces of Chinese words, which are written without spaces. */
export function queryTerms(query: string): string[] {
    const terms = new Set<string>();
    for (const word of query.toLowerCase().split(/[\s,，、。;；:：/]+/)) {
        if (!word) continue;
        terms.add(word);
        if (/[\u3400-\u9fff]/.test(word) && word.length > 2) {
            for (let index = 0; index + 2 <= word.length; index++) terms.add(word.slice(index, index + 2));
        }
    }
    return [...terms];
}

export type Placed =
    | { readonly outcome: 'noted'; readonly lines: readonly string[]; readonly dropped: number }
    | { readonly outcome: 'replaced'; readonly lines: readonly string[]; readonly dropped: number }
    | { readonly outcome: 'already' }
    | { readonly outcome: 'noMatch' };

/**
 * A note put into a file: in place of the note that contains `replaces`, or added; a repeat is not written twice;
 * past MEMORY_FILE_CHARS the oldest notes make room.
 */
export function placeNote(saved: string, line: string, note: string, replaces: string): Placed {
    const lines = saved
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter((item) => item.trim() !== '');
    let outcome: 'noted' | 'replaced' = 'noted';
    if (replaces) {
        const index = lines.findIndex((item) => noteText(item).toLowerCase().includes(replaces.toLowerCase()));
        if (index < 0) return { outcome: 'noMatch' };
        lines[index] = line;
        outcome = 'replaced';
    } else if (lines.some((item) => noteText(item).toLowerCase() === note.toLowerCase())) {
        return { outcome: 'already' };
    } else {
        lines.push(line);
    }
    let dropped = 0;
    while (lines.length > 1 && lines.join('\n').length + 1 > MEMORY_FILE_CHARS) {
        lines.shift();
        dropped++;
    }
    return { outcome, lines, dropped };
}
