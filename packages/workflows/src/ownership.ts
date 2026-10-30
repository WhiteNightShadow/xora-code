import picomatch from 'picomatch/posix';
import type { TaskCard } from './schemas.ts';

/**
 * Ownership globs (06 §6–§7): the files a task may change, relative to the project root, POSIX style. A glob
 * without wildcards also owns everything below it, so `src/auth` means the file or the directory; a trailing
 * `/` means the directory only. `!glob` excludes. Dotfiles match like any other file.
 */

const MATCH_OPTIONS = { dot: true } as const;
const MAX_EXPANSIONS = 64;

/** Repo-relative POSIX path: `\` → `/`, no leading `./`, no duplicate or trailing slashes. */
export function normalizePath(path: string): string {
    return path
        .trim()
        .replaceAll('\\', '/')
        .replace(/\/{2,}/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/(.)\/$/, '$1');
}

function isGlob(pattern: string): boolean {
    return picomatch.scan(pattern).isGlob;
}

/** A glob entry as written, cleaned up: POSIX separators, no leading `./` or `/`. */
function cleanEntry(entry: string): string {
    return entry
        .trim()
        .replaceAll('\\', '/')
        .replace(/^(\.\/)+/, '')
        .replace(/^\/+/, '');
}

/** The patterns a positive ownership entry matches with: `dir/` → `dir/**`, a literal → itself and `literal/**`. */
function matchPatterns(entry: string): string[] {
    const cleaned = cleanEntry(entry);
    if (cleaned === '') {
        return [];
    }
    if (cleaned.endsWith('/')) {
        return [`${normalizePath(cleaned)}/**`];
    }
    const pattern = normalizePath(cleaned);
    return isGlob(pattern) ? [pattern] : [pattern, `${pattern}/**`];
}

const matchers = new Map<string, picomatch.Matcher>();

function compiled(patterns: readonly string[]): picomatch.Matcher {
    const key = patterns.join('\0');
    let matcher = matchers.get(key);
    if (!matcher) {
        matcher = picomatch([...patterns], MATCH_OPTIONS);
        if (matchers.size > 500) {
            matchers.clear();
        }
        matchers.set(key, matcher);
    }
    return matcher;
}

/** Whether `path` is `entry` itself or lies below it, taken literally (`app/[id]` is a real directory name). */
function underLiteral(entry: string, path: string): boolean {
    const literal = normalizePath(cleanEntry(entry));
    return literal !== '' && (path === literal || path.startsWith(`${literal}/`));
}

/** A matcher for "is this path owned"; nothing is owned by an empty ownership list. */
export function ownershipMatcher(ownership: readonly string[]): (path: string) => boolean {
    const include = ownership.filter((entry) => entry.trim() !== '' && !entry.trim().startsWith('!'));
    const exclude = ownership.filter((entry) => entry.trim().startsWith('!')).map((entry) => entry.trim().slice(1));
    const includePatterns = include.flatMap(matchPatterns);
    const excludePatterns = exclude.flatMap(matchPatterns);
    if (includePatterns.length === 0) {
        return () => false;
    }
    const included = compiled(includePatterns);
    const excluded = excludePatterns.length > 0 ? compiled(excludePatterns) : () => false;
    return (path) => {
        const normalized = normalizePath(path);
        const isIncluded = included(normalized) || include.some((entry) => underLiteral(entry, normalized));
        const isExcluded = excluded(normalized) || exclude.some((entry) => underLiteral(entry, normalized));
        return isIncluded && !isExcluded;
    };
}

/**
 * Changed files outside the card's ownership, flagged red at acceptance (06 §6). Every change of a card without
 * ownership is outside it. Paths are normalised and deduplicated, in first-seen order.
 */
export function outOfOwnership(card: Pick<TaskCard, 'ownership'>, changedFiles: readonly string[]): string[] {
    const owned = ownershipMatcher(card.ownership);
    const outside = new Set<string>();
    for (const file of changedFiles) {
        const normalized = normalizePath(file);
        if (normalized !== '' && !owned(normalized)) {
            outside.add(normalized);
        }
    }
    return [...outside];
}

/**
 * Whether two ownership globs can match a common path. Exact for literals, `*`-only segments and `**`;
 * conservative (reports an overlap) where a heuristic cannot rule one out. Exclusions (`!glob`) never overlap.
 */
export function globsOverlap(a: string, b: string): boolean {
    if (a.trim().startsWith('!') || b.trim().startsWith('!')) {
        return false;
    }
    if (cleanEntry(a) !== '' && normalizePath(cleanEntry(a)) === normalizePath(cleanEntry(b))) {
        return true;
    }
    for (const left of matchPatterns(a).flatMap((pattern) => expandBraces(pattern))) {
        for (const right of matchPatterns(b).flatMap((pattern) => expandBraces(pattern))) {
            if (segmentsOverlap(left.split('/'), right.split('/'))) {
                return true;
            }
        }
    }
    return false;
}

/** Pairs of overlapping globs between two ownership lists; empty when parallel work on them is safe. */
export function ownershipOverlap(a: readonly string[], b: readonly string[]): Array<readonly [string, string]> {
    const pairs: Array<readonly [string, string]> = [];
    for (const left of a) {
        for (const right of b) {
            if (globsOverlap(left, right)) {
                pairs.push([left, right]);
            }
        }
    }
    return pairs;
}

/** `{a,b}` alternatives, nested ones included, up to {@link MAX_EXPANSIONS}; other braces stay as they are. */
function expandBraces(pattern: string): string[] {
    for (let open = pattern.indexOf('{'); open >= 0; open = pattern.indexOf('{', open + 1)) {
        let depth = 0;
        let close = -1;
        const commas: number[] = [];
        for (let index = open; index < pattern.length; index += 1) {
            const char = pattern.charAt(index);
            if (char === '{') {
                depth += 1;
            } else if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    close = index;
                    break;
                }
            } else if (char === ',' && depth === 1) {
                commas.push(index);
            }
        }
        if (close < 0 || commas.length === 0) {
            continue;
        }
        const head = pattern.slice(0, open);
        const tail = pattern.slice(close + 1);
        const bounds = [open, ...commas, close];
        const out: string[] = [];
        for (let index = 0; index + 1 < bounds.length; index += 1) {
            const alternative = pattern.slice((bounds[index] as number) + 1, bounds[index + 1]);
            for (const expanded of expandBraces(head + alternative + tail)) {
                out.push(expanded);
                if (out.length >= MAX_EXPANSIONS) {
                    return out;
                }
            }
        }
        return out;
    }
    return [pattern];
}

/** Unifies two segment lists where `**` stands for any number of segments. */
function segmentsOverlap(a: readonly string[], b: readonly string[]): boolean {
    const memo = new Map<number, boolean>();
    const step = (i: number, j: number): boolean => {
        const key = i * (b.length + 1) + j;
        const cached = memo.get(key);
        if (cached !== undefined) {
            return cached;
        }
        let result: boolean;
        if (i === a.length && j === b.length) {
            result = true;
        } else if (a[i] === '**') {
            result = step(i + 1, j) || (j < b.length && step(i, j + 1));
        } else if (b[j] === '**') {
            result = step(i, j + 1) || (i < a.length && step(i + 1, j));
        } else if (i === a.length || j === b.length) {
            result = false;
        } else {
            result = segmentOverlap(a[i] as string, b[j] as string) && step(i + 1, j + 1);
        }
        memo.set(key, result);
        return result;
    };
    return step(0, 0);
}

const MAGIC = /[*?[{]|[@!+]\(/;
const MAGIC_CHARS = /[*?[\]{}()!+@]/;

function segmentMatches(pattern: string, literal: string): boolean {
    return compiled([pattern])(literal);
}

/** Whether two single-segment patterns can match the same name. */
function segmentOverlap(x: string, y: string): boolean {
    if (x === y) {
        return true;
    }
    const xGlob = MAGIC.test(x);
    const yGlob = MAGIC.test(y);
    if (!xGlob && !yGlob) {
        return false;
    }
    if (!xGlob) {
        return segmentMatches(y, x);
    }
    if (!yGlob) {
        return segmentMatches(x, y);
    }
    // Every match of a pattern starts with its literal head and ends with its literal tail.
    const [xHead, xTail] = literalEnds(x);
    const [yHead, yTail] = literalEnds(y);
    const headsFit = xHead.startsWith(yHead) || yHead.startsWith(xHead);
    const tailsFit = xTail.endsWith(yTail) || yTail.endsWith(xTail);
    if (!headsFit || !tailsFit) {
        return false;
    }
    if (/^[^?[\]{}()!+@]*$/.test(x + y)) {
        // Star-only patterns with fitting ends always share a name: longer head + longer tail.
        return true;
    }
    for (const sample of samples(x)) {
        if (segmentMatches(y, sample)) {
            return true;
        }
    }
    for (const sample of samples(y)) {
        if (segmentMatches(x, sample)) {
            return true;
        }
    }
    // Undecided: assume an overlap, so parallel tasks are serialised rather than allowed to collide.
    return true;
}

/** Literal text before the first and after the last glob character. */
function literalEnds(pattern: string): [string, string] {
    let first = pattern.length;
    let last = -1;
    for (let index = 0; index < pattern.length; index += 1) {
        if (MAGIC_CHARS.test(pattern.charAt(index))) {
            first = Math.min(first, index);
            last = index;
        }
    }
    return last < 0 ? [pattern, pattern] : [pattern.slice(0, first), pattern.slice(last + 1)];
}

/** A few concrete names a segment pattern matches, for the sampling fallback. */
function samples(pattern: string): Set<string> {
    const out = new Set<string>();
    for (const filler of ['', 'x', 'a']) {
        out.add(
            pattern
                .replace(/\[!?\^?([^\]])[^\]]*\]/g, (_, first: string) => first)
                .replace(/[@!+*?]\(([^|)]*)[^)]*\)/g, (_, first: string) => first)
                .replaceAll('*', filler)
                .replaceAll('?', 'x'),
        );
    }
    return out;
}
