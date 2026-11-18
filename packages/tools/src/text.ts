import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { realpathLoose } from './path.ts';

/**
 * How a text file is stored, so edits can write it back the same way. `gb18030` is Chinese text from before UTF-8
 * (GBK and GB2312 are parts of it): a file without a byte order mark that is not valid UTF-8 but is valid GB18030.
 */
export type TextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be' | 'gb18030';

export interface TextFile {
    readonly text: string;
    readonly encoding: TextEncoding;
    /**
     * The bytes are text in no encoding known here: `text` shows what could not be decoded as U+FFFD, and writing it
     * back would destroy those bytes. Such a file can be read but must not be rewritten from `text`.
     */
    readonly lossy?: boolean;
}

/** Bytes inspected for a NUL byte, the same rule git uses to call a file binary. */
const SNIFF_BYTES = 8000;

function bomEncoding(head: Uint8Array): TextEncoding | undefined {
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
        return 'utf8bom';
    }
    if (head[0] === 0xff && head[1] === 0xfe) {
        return 'utf16le';
    }
    if (head[0] === 0xfe && head[1] === 0xff) {
        return 'utf16be';
    }
    return undefined;
}

const LABELS: Readonly<Record<TextEncoding, string>> = {
    utf8: 'utf-8',
    utf8bom: 'utf-8',
    utf16le: 'utf-16le',
    utf16be: 'utf-16be',
    gb18030: 'gb18030',
};

/** `bytes` decoded in the encoding `label` names when every byte is valid in it. */
function decodeStrictly(bytes: Uint8Array, label: string): string | undefined {
    try {
        return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch {
        // Not text in this encoding, or the runtime does not know the encoding.
        return undefined;
    }
}

/**
 * How a file that starts with `head` is read until its bytes say otherwise: in the encoding of its byte order mark,
 * not at all (`binary`: a NUL byte), or as UTF-8. Whether the bytes are that is for a strict decoder to find out
 * ({@link strictDecoder}); {@link decodeFile} decides for a file whose bytes are not.
 */
export function startingEncoding(head: Uint8Array): TextEncoding | 'binary' {
    return bomEncoding(head) ?? (head.subarray(0, SNIFF_BYTES).includes(0) ? 'binary' : 'utf8');
}

/** A streaming-capable decoder for `encoding` that throws at bytes that are not in it; it drops the byte order mark. */
export function strictDecoder(encoding: TextEncoding): TextDecoder {
    return new TextDecoder(LABELS[encoding], { fatal: true });
}

/** A streaming-capable decoder for `encoding`; it drops the byte order mark. */
export function textDecoder(encoding: TextEncoding): TextDecoder {
    return new TextDecoder(LABELS[encoding]);
}

export function decodeText(bytes: Uint8Array, encoding: TextEncoding): string {
    return textDecoder(encoding).decode(bytes);
}

/**
 * Whether text decoded as UTF-8 with losses is UTF-8 all the same, with a few bytes in it that are not (a file put
 * together from two encodings, a stray Latin-1 byte). What decoded has to outnumber what did not by more than chance
 * gives: of Chinese text in GB18030 about one character in five happens to be a valid UTF-8 sequence, never two for
 * every byte that is not. Such a file must not be taken for GB18030, which its two-byte UTF-8 characters also are:
 * it would be shown as Chinese, and new text would go into it in the wrong encoding.
 */
function mostlyUtf8(text: string): boolean {
    let decoded = 0;
    let lost = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 0xfffd) {
            lost++;
        } else if (code >= 0x80 && (code < 0xdc00 || code > 0xdfff)) {
            decoded++;
        }
    }
    return decoded > 2 * lost;
}

/** Code point → its GB18030 bytes as one number (two bytes, or four), built from the runtime's decoder on first use. */
let gb18030Codes: Map<number, number> | undefined;

function gb18030Table(): Map<number, number> {
    if (gb18030Codes) {
        return gb18030Codes;
    }
    const decoder = new TextDecoder('gb18030');
    const codes = new Map<number, number>();
    const learn = (bytes: Uint8Array, code: number): void => {
        const text = decoder.decode(bytes);
        const point = text.codePointAt(0);
        // One character of the basic plane for the whole sequence: a mapping. The lowest code stands for a character
        // that has several.
        if (text.length === 1 && point !== undefined && point !== 0xfffd && !codes.has(point)) {
            codes.set(point, code);
        }
    };
    const two = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xfe; lead++) {
        for (let trail = 0x40; trail <= 0xfe; trail++) {
            if (trail !== 0x7f) {
                two[0] = lead;
                two[1] = trail;
                learn(two, (lead << 8) | trail);
            }
        }
    }
    const four = new Uint8Array(4);
    for (let b1 = 0x81; b1 <= 0x84; b1++) {
        for (let b2 = 0x30; b2 <= 0x39; b2++) {
            for (let b3 = 0x81; b3 <= 0xfe; b3++) {
                for (let b4 = 0x30; b4 <= 0x39; b4++) {
                    four[0] = b1;
                    four[1] = b2;
                    four[2] = b3;
                    four[3] = b4;
                    learn(four, ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0);
                }
            }
        }
    }
    // The replacement character itself, which the pass above cannot tell from a sequence that failed to decode.
    codes.set(0xfffd, 0x8431a437);
    gb18030Codes = codes;
    return codes;
}

/** `text` in GB18030; throws for what the encoding cannot hold (half of a surrogate pair). */
function encodeGb18030(text: string): Buffer {
    const codes = gb18030Table();
    // Two bytes for most characters that are not ASCII; the buffer grows for a text with more four-byte ones.
    let bytes = Buffer.allocUnsafe(text.length * 2 + 16);
    let at = 0;
    for (let i = 0; i < text.length; i++) {
        if (at + 4 > bytes.length) {
            const grown = Buffer.allocUnsafe(bytes.length * 2);
            bytes.copy(grown, 0, 0, at);
            bytes = grown;
        }
        const point = text.codePointAt(i) ?? 0;
        if (point < 0x80) {
            bytes[at++] = point;
        } else if (point > 0xffff) {
            // The other planes follow one another in the four-byte codes from 0x90308130 on.
            let pointer = 189_000 + (point - 0x10000);
            const b4 = pointer % 10;
            pointer = Math.floor(pointer / 10);
            const b3 = pointer % 126;
            pointer = Math.floor(pointer / 126);
            bytes[at++] = Math.floor(pointer / 10) + 0x81;
            bytes[at++] = (pointer % 10) + 0x30;
            bytes[at++] = b3 + 0x81;
            bytes[at++] = b4 + 0x30;
            // Both halves of the pair are written.
            i++;
        } else {
            const code = codes.get(point);
            if (code === undefined) {
                throw new Error(`U+${point.toString(16).toUpperCase().padStart(4, '0')} cannot be written in GB18030`);
            }
            if (code > 0xffff) {
                bytes[at++] = code >>> 24;
                bytes[at++] = (code >>> 16) & 0xff;
                bytes[at++] = (code >>> 8) & 0xff;
                bytes[at++] = code & 0xff;
            } else {
                bytes[at++] = code >>> 8;
                bytes[at++] = code & 0xff;
            }
        }
    }
    return bytes.subarray(0, at);
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
        case 'gb18030':
            return encodeGb18030(text);
    }
}

/**
 * The text of a file's bytes; `null` when it is binary. This is where a file's encoding is decided, for the tools
 * that show it and the tools that rewrite it alike. A file is only taken for GB18030 when writing its text back
 * gives the same bytes, so an edit can never change what it did not touch; bytes that are not what their byte order
 * mark says, or text in no encoding known here, come back `lossy`.
 */
export function decodeFile(bytes: Uint8Array): TextFile | null {
    const marked = bomEncoding(bytes);
    if (marked !== undefined) {
        const text = decodeStrictly(bytes, LABELS[marked]);
        return text !== undefined
            ? { text, encoding: marked }
            : { text: decodeText(bytes, marked), encoding: marked, lossy: true };
    }
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) {
        return null;
    }
    const utf8 = decodeStrictly(bytes, 'utf-8');
    if (utf8 !== undefined) {
        return { text: utf8, encoding: 'utf8' };
    }
    const lossy = decodeText(bytes, 'utf8');
    const gb18030 = mostlyUtf8(lossy) ? undefined : decodeStrictly(bytes, 'gb18030');
    if (gb18030 !== undefined) {
        try {
            if (encodeGb18030(gb18030).equals(bytes)) {
                return { text: gb18030, encoding: 'gb18030' };
            }
        } catch {
            // Not text this encoding can write back.
        }
    }
    return { text: lossy, encoding: 'utf8', lossy: true };
}

/** Reads a text file; `null` when it is binary. Throws like `readFile` when it cannot be read. */
export async function readTextFile(file: string): Promise<TextFile | null> {
    return decodeFile(await readFile(file));
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
