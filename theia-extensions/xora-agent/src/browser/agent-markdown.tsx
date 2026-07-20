import * as React from '@theia/core/shared/react';

export type AgentMarkdownInline =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'strong'; readonly children: readonly AgentMarkdownInline[] }
    | { readonly kind: 'code'; readonly text: string };

export type AgentMarkdownBlock =
    | { readonly kind: 'paragraph'; readonly text: string }
    | { readonly kind: 'heading'; readonly depth: number; readonly text: string }
    | { readonly kind: 'list'; readonly ordered: boolean; readonly start?: number; readonly items: readonly string[] }
    | {
        readonly kind: 'table';
        readonly headers: readonly string[];
        readonly rows: readonly (readonly string[])[];
        readonly alignments: readonly AgentMarkdownTableAlignment[];
    }
    | { readonly kind: 'code'; readonly code: string; readonly language?: string; readonly closed: boolean };

export type AgentMarkdownTableAlignment = 'left' | 'center' | 'right' | undefined;

export interface AgentMarkdownProps {
    readonly text: string;
    readonly className?: string;
}

interface FenceStart {
    readonly size: number;
    readonly language?: string;
}

interface ListItem {
    readonly ordered: boolean;
    readonly start?: number;
    readonly text: string;
}

const HEADING_PATTERN = /^ {0,3}(#{1,6})[\t ]+(.+?)\s*$/;
const FENCE_PATTERN = /^ {0,3}(`{3,})([^`]*)$/;
const UNORDERED_ITEM_PATTERN = /^ {0,3}[-+*][\t ]+(.*)$/;
const ORDERED_ITEM_PATTERN = /^ {0,3}(\d+)[.)][\t ]+(.*)$/;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;

/**
 * Parses the small, presentation-oriented Markdown subset used by streamed
 * Agent replies. It deliberately keeps raw HTML as text so rendering remains
 * safe without an HTML sanitizer or an HTML injection escape hatch.
 */
export function parseAgentMarkdown(source: string): readonly AgentMarkdownBlock[] {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const blocks: AgentMarkdownBlock[] = [];
    let index = 0;

    while (index < lines.length) {
        if (isBlank(lines[index])) {
            index += 1;
            continue;
        }

        const fence = matchFenceStart(lines[index]);
        if (fence) {
            const codeLines: string[] = [];
            let closed = false;
            index += 1;
            while (index < lines.length) {
                if (isFenceEnd(lines[index], fence.size)) {
                    closed = true;
                    index += 1;
                    break;
                }
                codeLines.push(lines[index]);
                index += 1;
            }
            blocks.push({
                kind: 'code',
                code: codeLines.join('\n'),
                language: fence.language,
                closed
            });
            continue;
        }

        const heading = HEADING_PATTERN.exec(lines[index]);
        if (heading) {
            blocks.push({
                kind: 'heading',
                depth: heading[1].length,
                text: trimClosingHeadingMarks(heading[2])
            });
            index += 1;
            continue;
        }

        const table = matchTable(lines, index);
        if (table) {
            blocks.push(table.block);
            index = table.nextIndex;
            continue;
        }

        const firstItem = matchListItem(lines[index]);
        if (firstItem) {
            const items: string[] = [];
            const ordered = firstItem.ordered;
            const start = firstItem.start;
            while (index < lines.length) {
                const item = matchListItem(lines[index]);
                if (!item || item.ordered !== ordered) {
                    break;
                }
                items.push(item.text);
                index += 1;
            }
            blocks.push({ kind: 'list', ordered, start, items });
            continue;
        }

        const paragraph: string[] = [];
        while (index < lines.length && !isBlank(lines[index])) {
            if (paragraph.length > 0 && startsBlock(lines, index)) {
                break;
            }
            paragraph.push(lines[index]);
            index += 1;
        }
        blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    }

    return blocks;
}

/** Parses strong emphasis and inline code while leaving every other token as text. */
export function parseAgentMarkdownInline(source: string): readonly AgentMarkdownInline[] {
    return parseInline(source, 0);
}

function AgentMarkdownView({ text, className = 'xora-agent-markdown' }: AgentMarkdownProps): React.ReactElement {
    return <div className={className}>
        {parseAgentMarkdown(text).map((block, index) => renderBlock(block, index))}
    </div>;
}

/** Completed messages keep the same text prop, so streaming a later message
 * must not repeatedly parse and rebuild all earlier Markdown blocks. */
export const AgentMarkdown = React.memo(AgentMarkdownView);
AgentMarkdown.displayName = 'AgentMarkdown';

function renderBlock(block: AgentMarkdownBlock, key: number): React.ReactNode {
    switch (block.kind) {
        case 'heading':
            return React.createElement(
                `h${block.depth}`,
                { key, className: 'xora-agent-markdown-heading' },
                renderInline(block.text, `heading-${key}`)
            );
        case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            const props: React.HTMLAttributes<HTMLOListElement | HTMLUListElement> & { key: number; start?: number } = { key };
            if (block.ordered && block.start !== undefined && block.start !== 1) {
                props.start = block.start;
            }
            return <Tag {...props} className='xora-agent-markdown-list'>
                {block.items.map((item, itemIndex) => <li key={itemIndex}>
                    {renderInlineWithBreaks(item, `list-${key}-${itemIndex}`)}
                </li>)}
            </Tag>;
        }
        case 'table':
            return <div key={key} className='xora-agent-markdown-table-wrap'>
                <table className='xora-agent-markdown-table'>
                    <thead>
                        <tr>{block.headers.map((header, columnIndex) => <th
                            key={columnIndex}
                            data-align={block.alignments[columnIndex]}>
                            {renderInlineWithBreaks(header, `table-${key}-header-${columnIndex}`)}
                        </th>)}</tr>
                    </thead>
                    <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>
                        {row.map((cell, columnIndex) => <td
                            key={columnIndex}
                            data-align={block.alignments[columnIndex]}>
                            {renderInlineWithBreaks(cell, `table-${key}-${rowIndex}-${columnIndex}`)}
                        </td>)}
                    </tr>)}</tbody>
                </table>
            </div>;
        case 'code':
            return <pre
                key={key}
                className={`xora-agent-markdown-code${block.closed ? '' : ' is-streaming'}`}
                data-streaming={block.closed ? undefined : 'true'}>
                <code data-language={block.language}>{block.code}</code>
            </pre>;
        case 'paragraph':
            return <p key={key} className='xora-agent-markdown-paragraph'>
                {renderInlineWithBreaks(block.text, `paragraph-${key}`)}
            </p>;
    }
}

function renderInlineWithBreaks(source: string, keyPrefix: string): React.ReactNode[] {
    const lines = source.split('\n');
    const result: React.ReactNode[] = [];
    lines.forEach((line, lineIndex) => {
        if (lineIndex > 0) {
            result.push(<br key={`${keyPrefix}-break-${lineIndex}`} />);
        }
        result.push(...renderInline(line, `${keyPrefix}-line-${lineIndex}`));
    });
    return result;
}

function renderInline(source: string, keyPrefix: string): React.ReactNode[] {
    return parseAgentMarkdownInline(source).map((segment, index) => {
        const key = `${keyPrefix}-${index}`;
        switch (segment.kind) {
            case 'strong':
                return <strong key={key}>{renderInlineSegments(segment.children, key)}</strong>;
            case 'code':
                return <code key={key} className='xora-agent-markdown-inline-code'>{segment.text}</code>;
            case 'text':
                return <React.Fragment key={key}>{segment.text}</React.Fragment>;
        }
    });
}

function renderInlineSegments(segments: readonly AgentMarkdownInline[], keyPrefix: string): React.ReactNode[] {
    return segments.map((segment, index) => {
        const key = `${keyPrefix}-${index}`;
        switch (segment.kind) {
            case 'strong':
                return <strong key={key}>{renderInlineSegments(segment.children, key)}</strong>;
            case 'code':
                return <code key={key} className='xora-agent-markdown-inline-code'>{segment.text}</code>;
            case 'text':
                return <React.Fragment key={key}>{segment.text}</React.Fragment>;
        }
    });
}

function parseInline(source: string, depth: number): AgentMarkdownInline[] {
    if (!source || depth > 8) {
        return source ? [{ kind: 'text', text: source }] : [];
    }

    const result: AgentMarkdownInline[] = [];
    let cursor = 0;
    while (cursor < source.length) {
        const token = findNextInlineToken(source, cursor);
        if (!token) {
            appendText(result, source.slice(cursor));
            break;
        }
        if (token.index > cursor) {
            appendText(result, source.slice(cursor, token.index));
        }

        if (token.marker === '`') {
            const markerSize = countRun(source, token.index, '`');
            const marker = '`'.repeat(markerSize);
            const end = source.indexOf(marker, token.index + markerSize);
            if (end >= 0) {
                result.push({
                    kind: 'code',
                    text: source.slice(token.index + markerSize, end)
                });
                cursor = end + markerSize;
                continue;
            }
            appendText(result, marker);
            cursor = token.index + markerSize;
            continue;
        }

        const end = source.indexOf(token.marker, token.index + token.marker.length);
        if (end >= 0 && end > token.index + token.marker.length) {
            result.push({
                kind: 'strong',
                children: parseInline(source.slice(token.index + token.marker.length, end), depth + 1)
            });
            cursor = end + token.marker.length;
            continue;
        }
        appendText(result, token.marker);
        cursor = token.index + token.marker.length;
    }
    return result;
}

function findNextInlineToken(source: string, from: number): { readonly index: number; readonly marker: '`' | '**' | '__' } | undefined {
    const candidates = ([
        ['`', source.indexOf('`', from)],
        ['**', source.indexOf('**', from)],
        ['__', source.indexOf('__', from)]
    ] as const).filter((candidate): candidate is readonly ['`' | '**' | '__', number] => candidate[1] >= 0);
    candidates.sort((left, right) => left[1] - right[1] || markerPriority(left[0]) - markerPriority(right[0]));
    const candidate = candidates[0];
    return candidate ? { marker: candidate[0], index: candidate[1] } : undefined;
}

function markerPriority(marker: '`' | '**' | '__'): number {
    return marker === '`' ? 0 : 1;
}

function appendText(result: AgentMarkdownInline[], text: string): void {
    if (!text) {
        return;
    }
    const previous = result[result.length - 1];
    if (previous?.kind === 'text') {
        result[result.length - 1] = { kind: 'text', text: previous.text + text };
    } else {
        result.push({ kind: 'text', text });
    }
}

function countRun(source: string, from: number, character: string): number {
    let size = 0;
    while (source[from + size] === character) {
        size += 1;
    }
    return size;
}

function matchFenceStart(line: string): FenceStart | undefined {
    const match = FENCE_PATTERN.exec(line);
    if (!match) {
        return undefined;
    }
    const info = match[2].trim();
    const language = info ? info.split(/\s+/, 1)[0] : undefined;
    return { size: match[1].length, language };
}

function isFenceEnd(line: string, minimumSize: number): boolean {
    const match = /^ {0,3}(`{3,})\s*$/.exec(line);
    return !!match && match[1].length >= minimumSize;
}

function matchListItem(line: string): ListItem | undefined {
    const ordered = ORDERED_ITEM_PATTERN.exec(line);
    if (ordered) {
        return { ordered: true, start: Number.parseInt(ordered[1], 10), text: ordered[2] };
    }
    const unordered = UNORDERED_ITEM_PATTERN.exec(line);
    return unordered ? { ordered: false, text: unordered[1] } : undefined;
}

function matchTable(
    lines: readonly string[],
    index: number
): { readonly block: Extract<AgentMarkdownBlock, { readonly kind: 'table' }>; readonly nextIndex: number } | undefined {
    if (index + 1 >= lines.length) {
        return undefined;
    }
    const headers = splitTableRow(lines[index]);
    const separators = splitTableRow(lines[index + 1]);
    if (!headers || headers.length < 2 || !separators || separators.length !== headers.length
        || separators.some(cell => !TABLE_SEPARATOR_CELL_PATTERN.test(cell))) {
        return undefined;
    }

    const alignments = separators.map(tableAlignment);
    const rows: string[][] = [];
    let nextIndex = index + 2;
    while (nextIndex < lines.length && !isBlank(lines[nextIndex])) {
        const cells = splitTableRow(lines[nextIndex]);
        if (!cells) {
            break;
        }
        rows.push(headers.map((_, columnIndex) => cells[columnIndex] ?? ''));
        nextIndex += 1;
    }
    return {
        block: { kind: 'table', headers, rows, alignments },
        nextIndex
    };
}

/** Splits a compact GFM-style table row without treating pipes inside inline code as columns. */
function splitTableRow(line: string): string[] | undefined {
    let source = line.trim();
    if (!source.includes('|')) {
        return undefined;
    }
    if (source.startsWith('|')) {
        source = source.slice(1);
    }
    if (source.endsWith('|') && !source.endsWith('\\|')) {
        source = source.slice(0, -1);
    }

    const cells: string[] = [];
    let cell = '';
    let inCode = false;
    for (let cursor = 0; cursor < source.length; cursor += 1) {
        const character = source[cursor];
        if (character === '\\' && source[cursor + 1] === '|') {
            cell += '|';
            cursor += 1;
            continue;
        }
        if (character === '`') {
            inCode = !inCode;
            cell += character;
            continue;
        }
        if (character === '|' && !inCode) {
            cells.push(cell.trim());
            cell = '';
            continue;
        }
        cell += character;
    }
    cells.push(cell.trim());
    return cells.length >= 2 ? cells : undefined;
}

function tableAlignment(separator: string): AgentMarkdownTableAlignment {
    const left = separator.startsWith(':');
    const right = separator.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return left ? 'left' : undefined;
}

function startsBlock(lines: readonly string[], index: number): boolean {
    const line = lines[index];
    return !!matchFenceStart(line) || HEADING_PATTERN.test(line) || !!matchListItem(line) || !!matchTable(lines, index);
}

function trimClosingHeadingMarks(text: string): string {
    return text.replace(/[\t ]+#+[\t ]*$/, '');
}

function isBlank(line: string): boolean {
    return /^\s*$/.test(line);
}
