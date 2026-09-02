const CF_HTML_VERSION = /^Version:(?:0\.\d+|1\.\d+)$/;
const CF_HTML_OFFSET = /^(StartHTML|EndHTML|StartFragment|EndFragment):(-1|\d{10})$/;
const START_FRAGMENT_MARKER = /<!--\s*StartFragment\s*-->/i;
const END_FRAGMENT_MARKER = /<!--\s*EndFragment\s*-->/i;

const BLOCK_ELEMENTS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
    'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
    'SECTION', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL'
]);

const FALLBACK_ENTITY_VALUES: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: '\u00a0',
    quot: '"'
};

export interface WindowsCfHtmlClipboard {
    readonly html: string;
    readonly text: string;
}

export interface TextSelectionReplacement {
    readonly text: string;
    readonly cursor: number;
}

export function htmlElementPreservesWhitespace(tagName: string, styleAttribute?: string | null): boolean {
    const tag = tagName.toUpperCase();
    return tag === 'PRE'
        || tag === 'CODE'
        || /\bwhite-space\s*:\s*(?:pre-wrap|break-spaces|pre)\b/i.test(styleAttribute ?? '');
}

/**
 * Parses the Windows CF_HTML clipboard envelope. The strict header check is
 * intentional: snippets that merely discuss StartHTML must remain ordinary
 * text and use Chromium's native paste path.
 */
export function parseWindowsCfHtmlClipboard(raw: string): WindowsCfHtmlClipboard | undefined {
    if (!raw || !raw.startsWith('Version:')) return undefined;
    const lines = raw.split(/\r?\n/);
    if (!CF_HTML_VERSION.test(lines[0] ?? '')) return undefined;

    const offsets = new Map<string, number>();
    let headerEnd = -1;
    for (let index = 1; index < Math.min(lines.length, 32); index += 1) {
        const line = lines[index];
        const match = CF_HTML_OFFSET.exec(line);
        if (match) {
            if (offsets.has(match[1])) return undefined;
            offsets.set(match[1], Number(match[2]));
            continue;
        }
        if (/^(?:StartSelection|EndSelection):(?:-1|\d{10})$/.test(line)
            || /^SourceURL:\S.*$/.test(line)) {
            continue;
        }
        // The first HTML-looking line closes the header. Any other field or
        // prose before it means this is not a CF_HTML envelope we own.
        if (/^\s*(?:<!DOCTYPE\s+html\b|<html\b|<body\b|<!--)/i.test(line)) {
            headerEnd = index;
            break;
        }
        return undefined;
    }

    if (headerEnd < 0
        || !['StartHTML', 'EndHTML', 'StartFragment', 'EndFragment'].every(key => offsets.has(key))) {
        return undefined;
    }

    const startMarker = START_FRAGMENT_MARKER.exec(raw);
    if (startMarker?.index !== undefined) {
        const fragmentStart = startMarker.index + startMarker[0].length;
        const remaining = raw.slice(fragmentStart);
        const endMarker = END_FRAGMENT_MARKER.exec(remaining);
        if (endMarker?.index !== undefined) {
            const html = remaining.slice(0, endMarker.index);
            return { html, text: htmlFragmentToPlainText(html) };
        }
    }

    const startFragment = offsets.get('StartFragment')!;
    const endFragment = offsets.get('EndFragment')!;
    const startHtml = offsets.get('StartHTML')!;
    const endHtml = offsets.get('EndHTML')!;
    if (startFragment < 0 || endFragment <= startFragment) return undefined;
    if (startHtml >= 0 && startFragment < startHtml) return undefined;
    if (endHtml >= 0 && (endFragment > endHtml || endHtml <= startHtml)) return undefined;

    const bytes = new TextEncoder().encode(raw);
    if (endFragment > bytes.byteLength) return undefined;
    try {
        const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(startFragment, endFragment));
        return { html, text: htmlFragmentToPlainText(html) };
    } catch {
        return undefined;
    }
}

/** Converts a clipboard HTML fragment to compact, readable prompt text. */
export function htmlFragmentToPlainText(html: string): string {
    if (!html) return '';
    if (typeof DOMParser !== 'undefined') {
        const document = new DOMParser().parseFromString(html, 'text/html');
        document.querySelectorAll('script,style,noscript,template,svg').forEach(node => node.remove());
        const chunks: string[] = [];
        const preserved: string[] = [];
        const preserve = (value: string): void => {
            const index = preserved.push(value.replace(/\r\n?/g, '\n')) - 1;
            chunks.push(`\uE000${index}\uE001`);
        };
        const visit = (node: Node, preformatted = false): void => {
            if (node.nodeType === Node.TEXT_NODE) {
                const value = node.nodeValue ?? '';
                if (preformatted) preserve(value);
                else chunks.push(value.replace(/[\t\n\f\r ]+/g, ' '));
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const element = node as Element;
            const tag = element.tagName.toUpperCase();
            if (tag === 'BR') {
                chunks.push('\n');
                return;
            }
            const preservesWhitespace = preformatted
                || htmlElementPreservesWhitespace(tag, element.getAttribute('style'));
            if (tag === 'PRE') {
                chunks.push('\n');
                element.childNodes.forEach(child => visit(child, true));
                chunks.push('\n');
                return;
            }
            if (tag === 'TD' || tag === 'TH') chunks.push('\t');
            if (BLOCK_ELEMENTS.has(tag)) chunks.push('\n');
            element.childNodes.forEach(child => visit(child, preservesWhitespace));
            if (BLOCK_ELEMENTS.has(tag)) chunks.push('\n');
        };
        document.body.childNodes.forEach(child => visit(child));
        return normalizeClipboardText(chunks.join(''), preserved);
    }

    // Node-based unit tests do not expose DOMParser. Keep the fallback small
    // and deterministic; Electron takes the DOM path above.
    const preserved: string[] = [];
    const protectContents = (contents: string): string => {
        const plain = decodeHtmlEntities(contents
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(?:div|li|p|tr)\s*>/gi, '\n')
            .replace(/<!--[^]*?-->/g, '')
            .replace(/<[^>]+>/g, ''))
            .replace(/\r\n?/g, '\n');
        const index = preserved.push(plain) - 1;
        return `\uE000${index}\uE001`;
    };
    const withProtectedCode = protectPreformattedHtml(html, protectContents);
    const withoutIgnored = withProtectedCode.replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    const withBreaks = withoutIgnored
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?(?:address|article|aside|blockquote|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|tfoot|thead|tr|ul)\b[^>]*>/gi, '\n')
        .replace(/<\/?(?:td|th)\b[^>]*>/gi, '\t')
        .replace(/<!--[^]*?-->/g, '')
        .replace(/<[^>]+>/g, '');
    return normalizeClipboardText(decodeHtmlEntities(withBreaks), preserved);
}

/** Protects PRE/CODE and Monaco-style `white-space: pre` regions without a
 * regex-only nested-tag bug. CF_HTML commonly represents each source line as
 * a DIV inside another DIV with the same tag name. */
function protectPreformattedHtml(html: string, protect: (contents: string) => string): string {
    const opening = /<([a-z][a-z0-9:-]*)\b([^>]*)>/gi;
    let output = '';
    let copiedUntil = 0;
    let match: RegExpExecArray | null;
    while ((match = opening.exec(html))) {
        const tag = match[1];
        if (match[0].endsWith('/>') || !htmlElementPreservesWhitespace(tag, match[2])) continue;
        const boundary = matchingHtmlElementBoundary(html, tag, opening.lastIndex);
        if (!boundary) continue;
        output += html.slice(copiedUntil, match.index);
        output += protect(html.slice(opening.lastIndex, boundary.contentEnd));
        copiedUntil = boundary.elementEnd;
        opening.lastIndex = boundary.elementEnd;
    }
    return copiedUntil ? `${output}${html.slice(copiedUntil)}` : html;
}

function matchingHtmlElementBoundary(
    html: string,
    tagName: string,
    contentStart: number
): { contentEnd: number; elementEnd: number } | undefined {
    const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = new RegExp(`<\\/?${escapedTag}\\b[^>]*>`, 'gi');
    boundary.lastIndex = contentStart;
    let depth = 1;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(html))) {
        if (/^<\//.test(match[0])) {
            depth -= 1;
            if (depth === 0) return { contentEnd: match.index, elementEnd: boundary.lastIndex };
        } else if (!match[0].endsWith('/>')) {
            depth += 1;
        }
    }
    return undefined;
}

export function replaceTextSelection(
    value: string,
    replacement: string,
    selectionStart: number | null | undefined,
    selectionEnd: number | null | undefined
): TextSelectionReplacement {
    const start = Math.max(0, Math.min(selectionStart ?? value.length, value.length));
    const end = Math.max(start, Math.min(selectionEnd ?? start, value.length));
    return {
        text: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
        cursor: start + replacement.length
    };
}

function normalizeClipboardText(value: string, preserved: readonly string[] = []): string {
    const marker = /\uE000(\d+)\uE001/g;
    let output = '';
    let offset = 0;
    for (const match of value.matchAll(marker)) {
        const index = match.index ?? 0;
        output += normalizeOrdinaryClipboardText(value.slice(offset, index));
        output += preserved[Number(match[1])] ?? '';
        offset = index + match[0].length;
    }
    output += normalizeOrdinaryClipboardText(value.slice(offset));
    // Strip only line breaks introduced by surrounding block elements. A
    // leading/trailing space in an inline fragment can be semantically needed
    // to keep the pasted text separate from adjacent prompt words.
    return output.replace(/^\n+/, '').replace(/\n+$/, '');
}

function normalizeOrdinaryClipboardText(value: string): string {
    return value
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ')
        .replace(/[\t ]+\n/g, '\n')
        .replace(/\n[\t ]+/g, '\n')
        .replace(/[\t ]{2,}/g, ' ')
        .replace(/\n{2,}/g, '\n');
}

function decodeHtmlEntities(value: string): string {
    return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
        if (body[0] === '#') {
            const hexadecimal = body[1]?.toLowerCase() === 'x';
            const numeric = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
            if (!Number.isFinite(numeric) || numeric < 0 || numeric > 0x10ffff) return entity;
            try {
                return String.fromCodePoint(numeric);
            } catch {
                return entity;
            }
        }
        return FALLBACK_ENTITY_VALUES[body.toLowerCase()] ?? entity;
    });
}
