import { detectEol, withEol } from './text.ts';

/**
 * Where an edit means, when its old text is not in the file character for character (21 §4.2). Models copy text
 * with the line numbers `read` shows, lose whitespace at the ends of lines, shift a block's indentation or write
 * spaces where the file has tabs. Each of these is told apart from a wrong edit by the lines themselves: everything
 * but the whitespace in question has to be equal, and only one place in the file may fit. The new text is then
 * fitted to the file the same way, or the place does not count.
 */

export interface LooseMatch {
    /** The text to replace: offsets into the file. */
    readonly start: number;
    readonly end: number;
    /** What goes there: the new text, fitted to the file like the old text was. */
    readonly replacement: string;
    /** How the place was found, as the end of "it was matched …". */
    readonly how: string;
}

export type LooseOutcome =
    | { readonly kind: 'found'; readonly match: LooseMatch }
    /** Several places fit, at these 1-based lines. */
    | { readonly kind: 'ambiguous'; readonly how: string; readonly lines: readonly number[] }
    | { readonly kind: 'none' };

interface FileLines {
    /** Each line without its line break. */
    readonly text: readonly string[];
    /** Where each line starts in the file. */
    readonly start: readonly number[];
    /** Length of each line's break; 0 for a last line without one. */
    readonly breakLength: readonly number[];
}

function fileLines(text: string): FileLines {
    const lines: string[] = [];
    const start: number[] = [];
    const breakLength: number[] = [];
    let at = 0;
    while (at < text.length) {
        const newline = text.indexOf('\n', at);
        if (newline < 0) {
            lines.push(text.slice(at));
            start.push(at);
            breakLength.push(0);
            break;
        }
        const carriage = newline > at && text.charCodeAt(newline - 1) === 13;
        lines.push(text.slice(at, carriage ? newline - 1 : newline));
        start.push(at);
        breakLength.push(carriage ? 2 : 1);
        at = newline + 1;
    }
    return { text: lines, start, breakLength };
}

/** The lines of text a model sent, and whether it ended with a line break. */
function sentLines(text: string): { readonly lines: string[]; readonly finalBreak: boolean } {
    const unix = withEol(text, '\n');
    const finalBreak = unix.endsWith('\n');
    return { lines: (finalBreak ? unix.slice(0, -1) : unix).split('\n'), finalBreak };
}

const isBlank = (line: string): boolean => line.trim() === '';
const indentOf = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';

/** The whitespace every line that is not blank starts with. */
function commonIndent(lines: readonly string[]): string {
    let common: string | undefined;
    for (const line of lines) {
        if (isBlank(line)) {
            continue;
        }
        const indent = indentOf(line);
        if (common === undefined) {
            common = indent;
            continue;
        }
        let length = 0;
        while (length < common.length && length < indent.length && common[length] === indent[length]) {
            length++;
        }
        common = common.slice(0, length);
    }
    return common ?? '';
}

/** The line numbers of `read` output (`    12<tab>`), or of Claude Code's (`12→`). */
const NUMBERED = /^\s*\d+(?:\t|→)/;

/** `lines` without the line numbers a model copied along from `read` output; nothing when they are not all numbered. */
function withoutLineNumbers(lines: readonly string[]): string[] | undefined {
    const filled = lines.filter((line) => !isBlank(line));
    if (filled.length === 0 || !filled.every((line) => NUMBERED.test(line))) {
        return undefined;
    }
    return lines.map((line) => line.replace(NUMBERED, ''));
}

/**
 * The new text of an edit whose old text came with line numbers. A new line loses its number when it is one the old
 * text had, to the character (`     2<tab>`): a line that was kept, or changed behind its number. A line without a
 * number is new text as it stands. A line that starts like a number the old text did not have is either one the
 * model numbered itself or text that begins that way (a column of numbers before a tab): when it has the shape of
 * the old numbers there is no telling, and the new text cannot be used (nothing).
 */
function newTextWithoutNumbers(old: readonly string[], fresh: readonly string[]): string[] | undefined {
    const had = new Set<string>();
    for (const line of old) {
        const number = NUMBERED.exec(line)?.[0];
        if (number !== undefined) {
            had.add(number);
        }
    }
    const lengths = new Set([...had].map((number) => number.length));
    const out: string[] = [];
    for (const line of fresh) {
        const number = NUMBERED.exec(line)?.[0];
        if (number === undefined) {
            out.push(line);
        } else if (had.has(number)) {
            out.push(line.slice(number.length));
        } else if (lengths.has(number.length)) {
            return undefined;
        } else {
            out.push(line);
        }
    }
    return out;
}

/** Fits the new lines to the file as the old ones were found to fit; nothing when a line cannot be. */
type Fit = (lines: readonly string[]) => string[] | undefined;

interface Strategy {
    /** How the old text is told to be in the file, as the end of "it was matched …". */
    readonly how: string;
    /** What happens to the new text, as a sentence part after "and"; empty when nothing does. */
    readonly fitted: string;
    /** How the new text is fitted when `old` is what the file has at `at`, differences of this kind aside. */
    fit(file: readonly string[], old: readonly string[], at: number): Fit | undefined;
}

const same: Fit = (lines) => [...lines];

const EXACT: Strategy = {
    how: '',
    fitted: '',
    fit: (file, old, at) => (old.every((line, k) => file[at + k] === line) ? same : undefined),
};

const LINE_ENDS: Strategy = {
    how: 'ignoring whitespace at the ends of lines',
    fitted: '',
    fit: (file, old, at) => (old.every((line, k) => file[at + k]?.trimEnd() === line.trimEnd()) ? same : undefined),
};

/**
 * The whole block sits deeper or shallower in the file than in the old text, by more or less of the same character;
 * the lines agree relative to it. Tabs in the file where the old text has spaces are no shift but another unit
 * ({@link UNITS}): moving the new text over would leave it with spaces after the file's tabs.
 */
const SHIFTED: Strategy = {
    how: 'at a different indentation',
    fitted: 'newString was shifted to the indentation of the file',
    fit(file, old, at) {
        const block = file.slice(at, at + old.length);
        const inFile = commonIndent(block);
        const sent = commonIndent(old);
        const char = unitOf(inFile + sent);
        if (inFile === sent || char === undefined) {
            return undefined;
        }
        const agree = old.every((line, k) => {
            const there = block[k] ?? '';
            return isBlank(line)
                ? isBlank(there)
                : there.slice(inFile.length).trimEnd() === line.slice(sent.length).trimEnd();
        });
        if (!agree) {
            return undefined;
        }
        const deeper = inFile.length - sent.length;
        return (lines) => {
            const fitted: string[] = [];
            for (const line of lines) {
                const indent = indentOf(line);
                if (isBlank(line)) {
                    fitted.push('');
                } else if (indent === char.repeat(indent.length) && indent.length + deeper >= 0) {
                    fitted.push(char.repeat(indent.length + deeper) + line.slice(indent.length));
                } else {
                    // Indented with the other character, or not as deep as the block is moved up.
                    return undefined;
                }
            }
            return fitted;
        };
    },
};

/** `text` when it is one character repeated (an indentation of tabs only, or of spaces only). */
function unitOf(text: string): string | undefined {
    const char = text[0];
    return char !== undefined && text === char.repeat(text.length) ? char : undefined;
}

/**
 * The file and the old text indent by different units: tabs against spaces, or two spaces against four. Every
 * indented line has to give the same ratio, and each side one character throughout. Between spaces and spaces the
 * old text has to show the ratio at two depths (0 and 4 against 0 and 2 will do): at one depth alone a block that
 * sits deeper looks the same, and that is {@link SHIFTED}'s to fit or to leave.
 */
const UNITS: Strategy = {
    how: 'with a different unit of indentation (tabs for spaces, or another number of spaces)',
    fitted: 'newString was converted to the unit of the file',
    fit(file, old, at) {
        // The first indented pair sets the ratio: `inFile` characters of the file for every `sent` of the old text.
        let unit: { readonly fileChar: string; readonly sentChar: string; inFile: number; sent: number } | undefined;
        const depths = new Set<number>();
        for (const [k, line] of old.entries()) {
            const there = file[at + k] ?? '';
            if (isBlank(line) && isBlank(there)) {
                continue;
            }
            const inFile = indentOf(there);
            const sent = indentOf(line);
            if (there.slice(inFile.length).trimEnd() !== line.slice(sent.length).trimEnd()) {
                return undefined;
            }
            depths.add(sent.length);
            if (inFile === '' && sent === '') {
                continue;
            }
            const fileChar = unitOf(inFile);
            const sentChar = unitOf(sent);
            if (fileChar === undefined || sentChar === undefined) {
                return undefined;
            }
            unit ??= { fileChar, sentChar, inFile: inFile.length, sent: sent.length };
            if (
                unit.fileChar !== fileChar ||
                unit.sentChar !== sentChar ||
                inFile.length * unit.sent !== unit.inFile * sent.length
            ) {
                return undefined;
            }
        }
        if (!unit || (unit.fileChar === unit.sentChar && (unit.inFile === unit.sent || depths.size < 2))) {
            return undefined;
        }
        const { fileChar, sentChar, inFile, sent } = unit;
        return (lines) => {
            const fitted: string[] = [];
            for (const line of lines) {
                const indent = indentOf(line);
                const length = (indent.length * inFile) / sent;
                if (isBlank(line)) {
                    fitted.push('');
                } else if (indent === sentChar.repeat(indent.length) && Number.isInteger(length)) {
                    fitted.push(fileChar.repeat(length) + line.slice(indent.length));
                } else {
                    return undefined;
                }
            }
            return fitted;
        };
    },
};

const NUMBERS_DROPPED = 'after dropping the line numbers copied from read output';

/**
 * The one place in `text` that `oldString` means when it does not occur there exactly: tried without copied line
 * numbers, ignoring whitespace at line ends, at another indentation, and with another unit of indentation, the
 * stricter first. A place only counts when `newString` can be fitted to the file the same way.
 */
export function locateLoosely(text: string, oldString: string, newString: string): LooseOutcome {
    const file = fileLines(text);
    const old = sentLines(oldString);
    const fresh = sentLines(newString);
    if (old.lines.every(isBlank)) {
        return { kind: 'none' };
    }
    const eol = detectEol(text);
    const attempts: Array<{
        old: readonly string[];
        fresh: readonly string[];
        prefix: string;
        strategies: Strategy[];
    }> = [{ old: old.lines, fresh: fresh.lines, prefix: '', strategies: [LINE_ENDS, SHIFTED, UNITS] }];
    const unnumbered = withoutLineNumbers(old.lines);
    const unnumberedFresh = unnumbered && newTextWithoutNumbers(old.lines, fresh.lines);
    // Numbered blank lines alone say nothing about where they are.
    if (unnumbered && unnumberedFresh && !unnumbered.every(isBlank)) {
        attempts.push({
            old: unnumbered,
            fresh: unnumberedFresh,
            prefix: NUMBERS_DROPPED,
            strategies: [EXACT, LINE_ENDS, SHIFTED, UNITS],
        });
    }
    for (const attempt of attempts) {
        const count = attempt.old.length;
        // Every strategy takes the lines to be equal but for whitespace around them: one line tells most places apart.
        const anchor = attempt.old.findIndex((line) => !isBlank(line));
        const anchorText = (attempt.old[anchor] ?? '').trim();
        for (const strategy of attempt.strategies) {
            const places: Array<{ at: number; lines: string[] }> = [];
            for (let at = 0; at + count <= file.text.length; at++) {
                if (file.text[at + anchor]?.trim() !== anchorText) {
                    continue;
                }
                const fitted = strategy.fit(file.text, attempt.old, at)?.(attempt.fresh);
                if (fitted) {
                    places.push({ at, lines: fitted });
                }
            }
            const how = [attempt.prefix, strategy.how].filter(Boolean).join(', ');
            if (places.length > 1) {
                return { kind: 'ambiguous', how, lines: places.map((place) => place.at + 1) };
            }
            const place = places[0];
            if (place) {
                const last = place.at + count - 1;
                const contentEnd = (file.start[last] ?? 0) + (file.text[last]?.length ?? 0);
                return {
                    kind: 'found',
                    match: {
                        start: file.start[place.at] ?? 0,
                        end: old.finalBreak ? contentEnd + (file.breakLength[last] ?? 0) : contentEnd,
                        replacement: place.lines.join(eol) + (fresh.finalBreak ? eol : ''),
                        how: strategy.fitted ? `${how}, and ${strategy.fitted}` : how,
                    },
                };
            }
        }
    }
    return { kind: 'none' };
}

export interface ClosestLines {
    /** 1-based lines of the file that look most like the old text. */
    readonly from: number;
    readonly to: number;
    /** The first line of them that is not what the old text says, when one is. */
    readonly differs?: { readonly line: number; readonly inFile: string; readonly sent: string };
}

/** Share of the longer of two lines that their common start and end cover. */
function likeness(a: string, b: string): number {
    const longer = Math.max(a.length, b.length);
    if (longer === 0) {
        return 0;
    }
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) {
        head++;
    }
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
        tail++;
    }
    return (head + tail) / longer;
}

/**
 * The lines of `text` an old text that was not found most likely aimed at: for several lines, where most of them
 * are (surrounding whitespace aside); for one line, the line most like it. Nothing when nothing comes close.
 */
export function closestLines(text: string, oldString: string): ClosestLines | undefined {
    const file = fileLines(text).text;
    const sent = sentLines(oldString).lines;
    const old = withoutLineNumbers(sent) ?? sent;
    const filled = old.filter((line) => !isBlank(line)).length;
    if (filled === 0 || file.length === 0) {
        return undefined;
    }
    if (old.length === 1) {
        const wanted = (old[0] ?? '').trim();
        let best = -1;
        let bestScore = 0.6;
        for (const [index, line] of file.entries()) {
            const score = likeness(line.trim(), wanted);
            if (score > bestScore) {
                best = index;
                bestScore = score;
            }
        }
        return best < 0
            ? undefined
            : {
                  from: best + 1,
                  to: best + 1,
                  differs: { line: best + 1, inFile: file[best] ?? '', sent: old[0] ?? '' },
              };
    }
    // Each line of the file that is one of the old lines votes for the place the old text would start at.
    const wanted = new Map<string, number[]>();
    for (const [k, line] of old.entries()) {
        if (!isBlank(line)) {
            const key = line.trim();
            wanted.set(key, [...(wanted.get(key) ?? []), k]);
        }
    }
    const votes = new Map<number, number>();
    for (const [index, line] of file.entries()) {
        for (const k of wanted.get(line.trim()) ?? []) {
            votes.set(index - k, (votes.get(index - k) ?? 0) + 1);
        }
    }
    let best: number | undefined;
    let bestVotes = Math.max(1, Math.ceil(filled / 2)) - 1;
    for (const [at, count] of votes) {
        if (count > bestVotes || (count === bestVotes && best !== undefined && at < best)) {
            best = at;
            bestVotes = count;
        }
    }
    if (best === undefined) {
        return undefined;
    }
    const from = Math.max(0, best);
    const to = Math.min(file.length, best + old.length) - 1;
    for (const [k, line] of old.entries()) {
        const there = file[best + k];
        if (there !== line) {
            const at = Math.min(Math.max(best + k, from), to);
            return { from: from + 1, to: to + 1, differs: { line: at + 1, inFile: file[at] ?? '', sent: line } };
        }
    }
    return { from: from + 1, to: to + 1 };
}
