/** Output trimming shared by the tools. Lengths are JavaScript string lengths (UTF-16 code units). */

/** How far a cut may move to land on a line break. */
const SNAP_WINDOW = 200;

const middleMarker = (cut: number): string => `\n[... ${cut} characters truncated ...]\n`;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Shortens `text` to at most `maxChars` characters by cutting out the middle and putting a marker that says how much
 * was removed in its place. The head shows what ran and the tail usually holds the error or the summary, so both are
 * kept. Cuts move to a nearby line break when there is one and never split a surrogate pair.
 */
export function truncateMiddle(text: string, maxChars: number): string {
    if (text.length <= maxChars) {
        return text;
    }
    // The marker for the largest possible cut bounds every real marker, so the result never exceeds `maxChars`.
    const keep = Math.max(0, Math.floor(maxChars) - middleMarker(text.length).length);
    let headEnd = Math.ceil(keep / 2);
    let tailStart = text.length - (keep - headEnd);

    const lineEnd = text.lastIndexOf('\n', headEnd - 1);
    if (lineEnd >= 0 && headEnd - lineEnd <= SNAP_WINDOW) {
        headEnd = lineEnd;
    }
    const lineStart = text.indexOf('\n', tailStart);
    if (lineStart >= 0 && lineStart - tailStart < SNAP_WINDOW) {
        tailStart = lineStart + 1;
    }
    if (headEnd > 0 && isHighSurrogate(text.charCodeAt(headEnd - 1))) {
        headEnd -= 1;
    }
    if (tailStart < text.length && isLowSurrogate(text.charCodeAt(tailStart))) {
        tailStart += 1;
    }
    return text.slice(0, headEnd) + middleMarker(tailStart - headEnd) + text.slice(tailStart);
}

/**
 * Cuts a single line after `maxChars` characters and says how many were dropped. `fullLength` is the length of the
 * original line when the caller only kept a prefix of it.
 */
export function truncateLine(line: string, maxChars: number, fullLength = line.length): string {
    if (fullLength <= maxChars) {
        return line;
    }
    let end = Math.min(maxChars, line.length);
    if (end > 0 && isHighSurrogate(line.charCodeAt(end - 1))) {
        end -= 1;
    }
    return `${line.slice(0, end)} [... ${fullLength - end} characters truncated]`;
}
