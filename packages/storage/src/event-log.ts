import { closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
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
        const { events } = readEventFile(file);
        const fd = openSync(file, 'a+');
        EventLog.#trimTornTail(fd);
        return new EventLog(file, fd, events.at(-1)?.seq ?? 0);
    }

    /** Drops a final line without a newline, left behind by a crash during append. */
    static #trimTornTail(fd: number): void {
        const size = fstatSync(fd).size;
        if (size === 0) {
            return;
        }
        const content = readFileSync(fd, 'utf8');
        if (content.endsWith('\n')) {
            return;
        }
        const keep = content.lastIndexOf('\n') + 1;
        ftruncateSync(fd, Buffer.byteLength(content.slice(0, keep), 'utf8'));
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
