/**
 * URL slug of a title: lower case ASCII letters and digits joined by single hyphens, no leading or trailing hyphen.
 * Accented Latin letters lose their accents ("Crème Brûlée" → "creme-brulee"); other characters are dropped.
 */
export function slugify(title) {
    throw new Error('not implemented');
}

/**
 * `text` cut to at most `max` characters. A cut text ends with "…", which counts toward `max`, and is cut at the
 * last space before the limit when there is one (no half words). Text that fits is returned as it is.
 */
export function truncate(text, max) {
    throw new Error('not implemented');
}

/** Number of words: runs of letters or digits (a CJK character counts as one word each). */
export function wordCount(text) {
    throw new Error('not implemented');
}
