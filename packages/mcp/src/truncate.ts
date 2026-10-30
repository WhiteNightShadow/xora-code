import type { BlobResourceContents, ContentBlock, TextResourceContents } from '@modelcontextprotocol/client';

/**
 * Output caps. Text keeps its head and tail around a marker; images, audio and blobs cannot be cut, so they are
 * kept while they fit in half of the budget and replaced by a short note otherwise.
 */

function marker(omittedBytes: number): string {
    return `\n[... ${omittedBytes} bytes truncated ...]\n`;
}

/** Largest index ≤ `index` that does not split a UTF-8 sequence. */
function utf8Floor(bytes: Buffer, index: number): number {
    let i = Math.min(index, bytes.length);
    while (i > 0 && i < bytes.length && ((bytes[i] ?? 0) & 0xc0) === 0x80) {
        i -= 1;
    }
    return i;
}

/** Smallest index ≥ `index` that does not split a UTF-8 sequence. */
function utf8Ceil(bytes: Buffer, index: number): number {
    let i = Math.max(0, index);
    while (i < bytes.length && ((bytes[i] ?? 0) & 0xc0) === 0x80) {
        i += 1;
    }
    return i;
}

/** Keeps the first and last part of `text` so that it fits `maxBytes` of UTF-8, marker included. */
export function truncateMiddle(text: string, maxBytes: number): string {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= maxBytes) {
        return text;
    }
    const keep = Math.max(0, maxBytes - Buffer.byteLength(marker(bytes.length)));
    const headEnd = utf8Floor(bytes, Math.ceil(keep / 2));
    const tailStart = utf8Ceil(bytes, bytes.length - Math.floor(keep / 2));
    return (
        bytes.subarray(0, headEnd).toString('utf8') +
        marker(tailStart - headEnd) +
        bytes.subarray(tailStart).toString('utf8')
    );
}

/** Splits `budget` so that small items keep their full size and the large ones share the rest equally. */
function fairShares(sizes: readonly number[], budget: number): number[] {
    const shares = sizes.map(() => 0);
    const order = sizes.map((_, index) => index).sort((a, b) => (sizes[a] ?? 0) - (sizes[b] ?? 0));
    let remaining = Math.max(0, budget);
    order.forEach((index, position) => {
        const share = Math.min(sizes[index] ?? 0, Math.floor(remaining / (order.length - position)));
        shares[index] = share;
        remaining -= share;
    });
    return shares;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

function isTextResource(contents: TextResourceContents | BlobResourceContents): contents is TextResourceContents {
    return typeof (contents as { text?: unknown }).text === 'string';
}

type Piece =
    | {
          readonly kind: 'text';
          readonly size: number;
          readonly text: string;
          readonly rebuild: (text: string) => unknown;
      }
    | { readonly kind: 'binary'; readonly size: number; readonly placeholder: () => unknown }
    | { readonly kind: 'fixed'; readonly size: number };

/** Caps `items` described by `pieces` (same order) to about `budget` bytes. Returns the new items. */
function capPieces<T>(items: readonly T[], pieces: readonly Piece[], budget: number): T[] {
    let remaining = budget;
    for (const piece of pieces) {
        if (piece.kind === 'fixed') {
            remaining -= piece.size;
        }
    }
    const out: unknown[] = [...items];
    const textual: { index: number; size: number; text: string; rebuild: (text: string) => unknown }[] = [];
    const binaryBudget = Math.floor(remaining / 2);
    let binaryUsed = 0;
    pieces.forEach((piece, index) => {
        if (piece.kind === 'text') {
            textual.push({ index, size: piece.size, text: piece.text, rebuild: piece.rebuild });
        } else if (piece.kind === 'binary') {
            if (binaryUsed + piece.size <= binaryBudget) {
                binaryUsed += piece.size;
            } else {
                out[index] = piece.placeholder();
                remaining -= 100;
            }
        }
    });
    remaining -= binaryUsed;
    const shares = fairShares(
        textual.map((entry) => entry.size),
        remaining,
    );
    textual.forEach((entry, position) => {
        const share = shares[position] ?? 0;
        if (share < entry.size) {
            out[entry.index] = entry.rebuild(truncateMiddle(entry.text, share));
        }
    });
    return out as T[];
}

function jsonSize(value: unknown): number {
    return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value) ?? '');
}

function blockPiece(block: ContentBlock): Piece {
    switch (block.type) {
        case 'text':
            return {
                kind: 'text',
                size: Buffer.byteLength(block.text),
                text: block.text,
                rebuild: (text) => ({ ...block, text }),
            };
        case 'image':
        case 'audio':
            return {
                kind: 'binary',
                size: block.data.length,
                placeholder: () => ({
                    type: 'text',
                    text: `[${block.type} omitted: ${formatBytes(block.data.length)} ${block.mimeType}]`,
                }),
            };
        case 'resource': {
            const resource = block.resource;
            if (isTextResource(resource)) {
                return {
                    kind: 'text',
                    size: Buffer.byteLength(resource.text),
                    text: resource.text,
                    rebuild: (text) => ({ ...block, resource: { ...resource, text } }),
                };
            }
            return {
                kind: 'binary',
                size: resource.blob.length,
                placeholder: () => ({
                    type: 'text',
                    text: `[resource ${resource.uri} omitted: ${formatBytes(resource.blob.length)}]`,
                }),
            };
        }
        default:
            return { kind: 'fixed', size: jsonSize(block) };
    }
}

export interface CappedContent {
    readonly content: ContentBlock[];
    readonly structuredContent: unknown;
    readonly truncated: boolean;
}

/** Caps a tool result's content and structured content to about `maxBytes`; structured content is dropped first. */
export function capContent(
    content: readonly ContentBlock[],
    structuredContent: unknown,
    maxBytes: number,
): CappedContent {
    const pieces = content.map(blockPiece);
    const structuredSize = jsonSize(structuredContent);
    const total = pieces.reduce((sum, piece) => sum + piece.size, 0) + structuredSize;
    if (total <= maxBytes) {
        return { content: [...content], structuredContent, truncated: false };
    }
    // Structured content usually repeats the text content; keep it only while it is small.
    const keepStructured = structuredContent !== undefined && structuredSize <= maxBytes / 4;
    const budget = maxBytes - (keepStructured ? structuredSize : 0);
    return {
        content: capPieces(content, pieces, budget),
        structuredContent: keepStructured ? structuredContent : undefined,
        truncated: true,
    };
}

export type ResourceContents = TextResourceContents | BlobResourceContents;

/** Caps the contents of a `resources/read` result to about `maxBytes`. */
export function capResourceContents(
    contents: readonly ResourceContents[],
    maxBytes: number,
): { readonly contents: ResourceContents[]; readonly truncated: boolean } {
    const pieces: Piece[] = contents.map((entry) =>
        isTextResource(entry)
            ? {
                  kind: 'text',
                  size: Buffer.byteLength(entry.text),
                  text: entry.text,
                  rebuild: (text) => ({ ...entry, text }),
              }
            : {
                  kind: 'binary',
                  size: entry.blob.length,
                  placeholder: () => ({
                      uri: entry.uri,
                      mimeType: 'text/plain',
                      text: `[${entry.mimeType ?? 'blob'} omitted: ${formatBytes(entry.blob.length)}]`,
                  }),
              },
    );
    const total = pieces.reduce((sum, piece) => sum + piece.size, 0);
    if (total <= maxBytes) {
        return { contents: [...contents], truncated: false };
    }
    return { contents: capPieces(contents, pieces, maxBytes), truncated: true };
}
