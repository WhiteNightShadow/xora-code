/** One server-sent event. `event` is absent for the default `message` type. */
export interface SseEvent {
    readonly event?: string;
    readonly data: string;
    readonly id?: string;
}

/**
 * Incremental SSE decoder over text. Lines may end in LF, CR or CRLF and may be split anywhere between pushes;
 * a trailing CR is held back until the next push shows whether an LF follows.
 */
export class SseDecoder {
    #buffer = '';
    #data: string[] = [];
    #event: string | undefined;
    #id: string | undefined;

    /** Feeds decoded text and returns the events it completes. */
    push(text: string): SseEvent[] {
        this.#buffer += text;
        const events: SseEvent[] = [];
        const terminator = /\r\n|\r|\n/g;
        let consumed = 0;
        for (;;) {
            const match = terminator.exec(this.#buffer);
            if (match === null) {
                break;
            }
            if (match[0] === '\r' && match.index === this.#buffer.length - 1) {
                // Possibly the first half of a CRLF split across chunks.
                break;
            }
            this.#line(this.#buffer.slice(consumed, match.index), events);
            consumed = match.index + match[0].length;
        }
        this.#buffer = this.#buffer.slice(consumed);
        return events;
    }

    /** Flushes the last line and delivers an unterminated final event, which some servers send. */
    end(): SseEvent[] {
        const events: SseEvent[] = [];
        const rest = this.#buffer.endsWith('\r') ? this.#buffer.slice(0, -1) : this.#buffer;
        this.#buffer = '';
        if (rest !== '') {
            this.#line(rest, events);
        }
        this.#dispatch(events);
        return events;
    }

    #line(line: string, events: SseEvent[]): void {
        if (line === '') {
            this.#dispatch(events);
            return;
        }
        if (line.startsWith(':')) {
            // Comment, e.g. `: keep-alive` sent by deepseek while a request is queued.
            return;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) {
            value = value.slice(1);
        }
        if (field === 'data') {
            this.#data.push(value);
        } else if (field === 'event') {
            this.#event = value;
        } else if (field === 'id' && !value.includes('\0')) {
            this.#id = value;
        }
    }

    #dispatch(events: SseEvent[]): void {
        if (this.#data.length > 0) {
            events.push({
                data: this.#data.join('\n'),
                ...(this.#event ? { event: this.#event } : {}),
                ...(this.#id !== undefined ? { id: this.#id } : {}),
            });
        }
        this.#data = [];
        this.#event = undefined;
        this.#id = undefined;
    }
}

/**
 * Parses a server-sent event stream. Chunk boundaries may fall anywhere, including inside a multi-byte UTF-8
 * sequence or a CRLF; comment lines and events without data are skipped. Stopping the iteration early cancels the
 * underlying stream.
 */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
    const reader = stream.getReader();
    const text = new TextDecoder();
    const decoder = new SseDecoder();
    let finished = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            for (const event of decoder.push(text.decode(value, { stream: true }))) {
                yield event;
            }
        }
        for (const event of [...decoder.push(text.decode()), ...decoder.end()]) {
            yield event;
        }
        finished = true;
    } finally {
        if (!finished) {
            await reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
    }
}
