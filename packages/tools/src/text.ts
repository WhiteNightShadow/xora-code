import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { realpathLoose } from './path.ts';

/** How a text file is stored, so edits can write it back the same way. */
export type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';

export interface TextFile {
    readonly text: string;
    readonly encoding: TextEncoding;
}

/** Bytes inspected for a NUL byte, the same rule git uses to call a file binary. */
const SNIFF_BYTES = 8000;

/** The encoding of a file starting with `head`, or `binary`. A byte order mark decides; otherwise NUL means binary. */
export function detectEncoding(head: Uint8Array): TextEncoding | 'binary' {
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
        return 'utf8bom';
    }
    if (head[0] === 0xff && head[1] === 0xfe) {
        return 'utf16le';
    }
    if (head[0] === 0xfe && head[1] === 0xff) {
        return 'utf16be';
    }
    return head.subarray(0, SNIFF_BYTES).includes(0) ? 'binary' : 'utf8';
}

/** A streaming-capable decoder for `encoding`; it drops the byte order mark. */
export function textDecoder(encoding: TextEncoding): TextDecoder {
    return new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : encoding === 'utf16be' ? 'utf-16be' : 'utf-8');
}

export function decodeText(bytes: Uint8Array, encoding: TextEncoding): string {
    return textDecoder(encoding).decode(bytes);
}

export function encodeText(text: string, encoding: TextEncoding): Buffer {
    switch (encoding) {
        case 'utf8':
            return Buffer.from(text, 'utf8');
        case 'utf8bom':
            return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
        case 'utf16le':
            return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
        case 'utf16be':
            return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
    }
}

/** Reads a text file; `null` when it is binary. Throws like `readFile` when it cannot be read. */
export async function readTextFile(file: string): Promise<TextFile | null> {
    const bytes = await readFile(file);
    const encoding = detectEncoding(bytes);
    if (encoding === 'binary') {
        return null;
    }
    return { text: decodeText(bytes, encoding), encoding };
}

/** The line ending most lines of `text` use; LF when there are none. */
export function detectEol(text: string): '\n' | '\r\n' {
    let crlf = 0;
    let lf = 0;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
        if (i > 0 && text.charCodeAt(i - 1) === 13) {
            crlf++;
        } else {
            lf++;
        }
    }
    return crlf > lf ? '\r\n' : '\n';
}

/** Converts every line ending in `text` to `eol`. */
export function withEol(text: string, eol: '\n' | '\r\n'): string {
    const lf = text.replace(/\r\n/g, '\n');
    return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/** Number of lines as an editor counts them: a final line break does not start another line. */
export function countLines(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    let lines = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
        lines++;
    }
    return text.endsWith('\n') ? lines - 1 : lines;
}

const RENAME_ATTEMPTS = 8;

export interface AtomicWriteOptions {
    /** Permission bits for a file that does not exist yet; by default the process umask decides. */
    readonly mode?: number | undefined;
}

/**
 * Replaces `file` atomically: the data goes to a temporary file in the same directory, which is then renamed over the
 * target, so readers never see a half-written file. Missing parent directories are created, symbolic links are
 * written through (the link stays a link) and an existing file keeps its permission bits.
 */
export async function writeFileAtomic(
    file: string,
    data: string | Uint8Array,
    options: AtomicWriteOptions = {},
): Promise<void> {
    const target = await realpathLoose(file);
    const dir = path.dirname(target);
    await mkdir(dir, { recursive: true });
    let mode = options.mode;
    try {
        mode = (await stat(target)).mode & 0o7777;
    } catch {
        // A new file.
    }
    const temporary = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
        const handle = await open(temporary, 'wx', mode ?? 0o666);
        try {
            await handle.writeFile(data);
            if (mode !== undefined) {
                // The mode given to `open` is reduced by the umask; restore the original bits exactly.
                await handle.chmod(mode);
            }
            await handle.sync();
        } finally {
            await handle.close();
        }
        await renameReplacing(temporary, target, data);
    } finally {
        await rm(temporary, { force: true });
    }
}

/**
 * `rename` over an existing file. On Windows it fails while another process (an editor, a virus scanner) holds the
 * target open; retry for a moment, then fall back to writing the target in place.
 */
async function renameReplacing(from: string, to: string, data: string | Uint8Array): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const busy = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
            if (process.platform !== 'win32' || !busy) {
                throw error;
            }
            if (attempt >= RENAME_ATTEMPTS) {
                await writeFile(to, data);
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, attempt * 25));
        }
    }
}
