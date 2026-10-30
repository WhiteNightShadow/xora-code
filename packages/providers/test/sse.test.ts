import { describe, expect, it } from 'vitest';
import { parseSse, type SseEvent } from '../src/index.ts';

function streamOf(chunks: readonly Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            const chunk = chunks[index++];
            if (chunk === undefined) {
                controller.close();
            } else {
                controller.enqueue(chunk);
            }
        },
        cancel() {
            onCancel?.();
        },
    });
}

async function parse(chunks: readonly Uint8Array[]): Promise<SseEvent[]> {
    const events: SseEvent[] = [];
    for await (const event of parseSse(streamOf(chunks))) {
        events.push(event);
    }
    return events;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const SAMPLE = [
    ': keep-alive',
    '',
    'event: message_start',
    'data: {"text":"你好，世界 😀"}',
    '',
    '',
    ': another comment',
    'data: line one',
    'data: line two',
    'id: 7',
    '',
    'data:no-space',
    '',
    'data: [DONE]',
    '',
    '',
].join('\r\n');

const EXPECTED: SseEvent[] = [
    { event: 'message_start', data: '{"text":"你好，世界 😀"}' },
    { data: 'line one\nline two', id: '7' },
    { data: 'no-space' },
    { data: '[DONE]' },
];

describe('parseSse', () => {
    it('parses events, multi-line data, comments and blank lines', async () => {
        expect(await parse([encode(SAMPLE)])).toEqual(EXPECTED);
    });

    it('treats LF, CR and CRLF line endings alike', async () => {
        for (const ending of ['\n', '\r', '\r\n']) {
            expect(await parse([encode(SAMPLE.replaceAll('\r\n', ending))])).toEqual(EXPECTED);
        }
    });

    it('survives a chunk boundary at every byte, including inside UTF-8 sequences and CRLF', async () => {
        const bytes = encode(SAMPLE);
        expect(await parse([...bytes].map((byte) => Uint8Array.of(byte)))).toEqual(EXPECTED);
        for (let split = 1; split < bytes.length; split++) {
            expect(await parse([bytes.slice(0, split), bytes.slice(split)])).toEqual(EXPECTED);
        }
    });

    it('does not read a CR at the end of a chunk and an LF at the start of the next as two lines', async () => {
        const events = await parse([encode('data: a\r'), encode('\ndata: b\r'), encode('\n\r'), encode('\n')]);
        expect(events).toEqual([{ data: 'a\nb' }]);
    });

    it('drops events without data and delivers an unterminated last event', async () => {
        expect(await parse([encode('event: ping\n\nretry: 10\n\ndata: tail')])).toEqual([{ data: 'tail' }]);
        expect(await parse([encode('data: tail\r')])).toEqual([{ data: 'tail' }]);
    });

    it('keeps an empty data field and strips a byte order mark', async () => {
        expect(await parse([encode('﻿data:\n\ndata\n\n')])).toEqual([{ data: '' }, { data: '' }]);
    });

    it('cancels the stream when the consumer stops early', async () => {
        let cancelled = false;
        const stream = streamOf([encode('data: 1\n\n'), encode('data: 2\n\n'), encode('data: 3\n\n')], () => {
            cancelled = true;
        });
        for await (const event of parseSse(stream)) {
            expect(event.data).toBe('1');
            break;
        }
        expect(cancelled).toBe(true);
    });
});
