import {
    closeSync,
    existsSync,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    truncateSync,
    writeSync,
} from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';

/** One persisted event. The log adds `seq` and a crc; everything else is the caller's. */
export interface LoggedEvent {
    readonly seq: number;
    readonly ts: number;
    readonly kind: string;
    readonly turnId?: string;
    readonly itemId?: string;
    readonly payload: unknown;
}

export type NewEvent = Omit<LoggedEvent, 'seq'>;

export const EVENT_LOG_FILE = 'events.v1.jsonl';

export interface ReadReport {
    readonly events: LoggedEvent[];
    /** Lines that failed the crc or did not parse; they are skipped, never repaired. */
    readonly corrupt: number;
}

function checksum(body: string): string {
    return crc32(body).toString(16).padStart(8, '0');
}

/** `{"crc":"…","e":{…}}` — the crc covers the exact bytes of the event object. */
function encode(event: LoggedEvent): string {
    const body = JSON.stringify(event);
    return `{"crc":"${checksum(body)}","e":${body}}\n`;
}

function decode(line: string): LoggedEvent | undefined {
    const match = /^\{"crc":"([0-9a-f]{8})","e":(.*)\}$/.exec(line);
    if (!match?.[1] || match[2] === undefined) {
        return undefined;
    }
    if (checksum(match[2]) !== match[1]) {
        return undefined;
    }
    try {
        const event = JSON.parse(match[2]) as LoggedEvent;
        return typeof event.seq === 'number' && typeof event.kind === 'string' ? event : undefined;
    } catch {
        return undefined;
    }
}

export function readEventFile(file: string, afterSeq = 0): ReadReport {
    if (!existsSync(file)) {
        return { events: [], corrupt: 0 };
    }
    const text = readFileSync(file, 'utf8');
    const events: LoggedEvent[] = [];
    let corrupt = 0;
    let lastSeq = 0;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? '';
        if (line.length === 0) {
            continue;
        }
        const event = decode(line);
        // A torn last line (crash mid-write) is expected; anything else counts as corruption.
        if (!event || event.seq <= lastSeq) {
            if (index < lines.length - 1 || text.endsWith('\n')) {
                corrupt++;
            }
            continue;
        }
        lastSeq = event.seq;
        if (event.seq > afterSeq) {
            events.push(event);
        }
    }
    return { events, corrupt };
}

const TAIL_CHUNK_BYTES = 64 * 1024;

/**
 * Append-only, per-thread event log (`events.v1.jsonl`). Each line carries a monotonically increasing `seq`
 * and a crc32, so readers skip damaged lines and a torn final line from a crash is cut off on open. A format
 * change writes `events.v2.jsonl` next to it; this file is never rewritten.
 */
export class EventLog {
    readonly file: string;
    #fd: number | undefined;
    #lastSeq: number;

    private constructor(file: string, fd: number, lastSeq: number) {
        this.file = file;
        this.#fd = fd;
        this.#lastSeq = lastSeq;
    }

    static open(dir: string): EventLog {
        mkdirSync(dir, { recursive: true });
        const file = path.join(dir, EVENT_LOG_FILE);
        const lastSeq = EventLog.#prepare(file);
        const fd = openSync(file, 'a');
        return new EventLog(file, fd, lastSeq);
    }

    /**
     * Cuts off a final line without a newline (left behind by a crash during append) and reads `lastSeq` from the
     * tail chunk instead of scanning the entire multi-MB log on every open. Done before opening the append handle:
     * on Windows an append-only handle cannot truncate.
     */
    static #prepare(file: string): number {
        if (!existsSync(file)) {
            return 0;
        }
        let effectiveSize = 0;
        let fileSize = 0;
        let lastSeq = 0;
        const rfd = openSync(file, 'r');
        try {
            fileSize = fstatSync(rfd).size;
            if (fileSize === 0) {
                return 0;
            }
            effectiveSize = fileSize;
            const lastByte = Buffer.allocUnsafe(1);
            readSync(rfd, lastByte, 0, 1, fileSize - 1);
            if (lastByte[0] !== 0x0a) {
                effectiveSize = 0;
                let end = fileSize;
                while (end > 0) {
                    const len = Math.min(end, TAIL_CHUNK_BYTES);
                    const start = end - len;
                    const buf = Buffer.allocUnsafe(len);
                    const read = readSync(rfd, buf, 0, len, start);
                    const nl = buf.subarray(0, read).lastIndexOf(0x0a);
                    if (nl >= 0) {
                        effectiveSize = start + nl + 1;
                        break;
                    }
                    end = start;
                }
            }
            let window = TAIL_CHUNK_BYTES;
            while (effectiveSize > 0) {
                const len = Math.min(effectiveSize, window);
                const offset = effectiveSize - len;
                const buf = Buffer.allocUnsafe(len);
                const read = readSync(rfd, buf, 0, len, offset);
                const slice = buf.subarray(0, read);
                const firstNl = offset > 0 ? slice.indexOf(0x0a) : -1;
                if (offset === 0 || firstNl >= 0) {
                    const body = (offset > 0 ? slice.subarray(firstNl + 1) : slice).toString('utf8');
                    const lines = body.split('\n');
                    let found: number | undefined;
                    for (let index = lines.length - 1; index >= 0; index--) {
                        const line = lines[index] ?? '';
                        if (line.length === 0) continue;
                        const event = decode(line);
                        if (event && event.seq > 0) {
                            found = event.seq;
                            break;
                        }
                    }
                    if (found !== undefined || offset === 0) {
                        lastSeq = found ?? 0;
                        break;
                    }
                }
                window *= 2;
            }
        } finally {
            closeSync(rfd);
        }
        if (effectiveSize < fileSize) {
            truncateSync(file, effectiveSize);
        }
        return lastSeq;
    }

    get lastSeq(): number {
        return this.#lastSeq;
    }

    append(event: NewEvent): LoggedEvent {
        if (this.#fd === undefined) {
            throw new Error(`event log ${this.file} is closed`);
        }
        const logged: LoggedEvent = { ...event, seq: this.#lastSeq + 1 };
        writeSync(this.#fd, encode(logged));
        this.#lastSeq = logged.seq;
        return logged;
    }

    read(afterSeq = 0): ReadReport {
        return readEventFile(this.file, afterSeq);
    }

    close(): void {
        if (this.#fd !== undefined) {
            closeSync(this.#fd);
            this.#fd = undefined;
        }
    }
}
