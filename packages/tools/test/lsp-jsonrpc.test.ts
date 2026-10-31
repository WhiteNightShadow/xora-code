import { describe, expect, it } from 'vitest';
import {
    ConnectionClosedError,
    encodeMessage,
    FramingError,
    JsonRpcConnection,
    MessageReader,
    RequestTimeoutError,
    ResponseError,
} from '../src/index.ts';

const MESSAGES = [
    { jsonrpc: '2.0', id: 1, result: { text: 'plain' } },
    { jsonrpc: '2.0', method: 'note', params: { text: '多字节字符 and emoji 🚀 split anywhere' } },
    { jsonrpc: '2.0', id: 'x', result: null },
];

function stream(): Buffer {
    return Buffer.concat(MESSAGES.map((message) => encodeMessage(message)));
}

function parsedFrom(results: ReturnType<MessageReader['push']>): unknown[] {
    return results.map((result) => (result.ok ? result.message : result.error));
}

describe('LSP framing', () => {
    it('counts the body in bytes, not characters', () => {
        const frame = encodeMessage({ text: 'é' }).toString('utf8');
        expect(frame).toBe('Content-Length: 13\r\n\r\n{"text":"é"}');
    });

    it('reads messages split at every possible point, inside headers and characters too', () => {
        const bytes = stream();
        for (let cut = 1; cut < bytes.length; cut++) {
            const reader = new MessageReader();
            const out = [
                ...parsedFrom(reader.push(bytes.subarray(0, cut))),
                ...parsedFrom(reader.push(bytes.subarray(cut))),
            ];
            expect(out).toEqual(MESSAGES);
            expect(reader.buffered).toBe(0);
        }
    });

    it('reads a byte at a time and several messages from one chunk', () => {
        const bytes = stream();
        const reader = new MessageReader();
        const out: unknown[] = [];
        for (const byte of bytes) {
            out.push(...parsedFrom(reader.push(Buffer.from([byte]))));
        }
        expect(out).toEqual(MESSAGES);
        const merged = new MessageReader();
        const first = encodeMessage(MESSAGES[0]);
        // Two whole messages and half of the third arrive together.
        const chunk = Buffer.concat([first, encodeMessage(MESSAGES[1]), encodeMessage(MESSAGES[2]).subarray(0, 10)]);
        expect(parsedFrom(merged.push(chunk))).toEqual(MESSAGES.slice(0, 2));
        expect(parsedFrom(merged.push(encodeMessage(MESSAGES[2]).subarray(10)))).toEqual([MESSAGES[2]]);
    });

    it('accepts other headers and any case', () => {
        const body = '{"ok":true}';
        const reader = new MessageReader();
        const frame = `content-length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`;
        expect(parsedFrom(reader.push(Buffer.from(frame)))).toEqual([{ ok: true }]);
    });

    it('skips a body that is not JSON and stays in step', () => {
        const reader = new MessageReader();
        const bad = Buffer.from('Content-Length: 5\r\n\r\n{nope');
        const results = reader.push(Buffer.concat([bad, encodeMessage({ after: 1 })]));
        expect(results[0]?.ok).toBe(false);
        expect(results[1]).toEqual({ ok: true, message: { after: 1 } });
    });

    it('refuses broken headers and oversized messages', () => {
        expect(() => new MessageReader().push(Buffer.from('Content-Type: x\r\n\r\n{}'))).toThrow(FramingError);
        expect(() => new MessageReader().push(Buffer.from('Content-Length: twelve\r\n\r\n'))).toThrow(FramingError);
        expect(() => new MessageReader().push(Buffer.from('hello world\r\n\r\n'))).toThrow(FramingError);
        expect(() => new MessageReader(100).push(Buffer.from('Content-Length: 101\r\n\r\n'))).toThrow(/over the limit/);
        expect(() => new MessageReader().push(Buffer.alloc(9000, 'a'))).toThrow(/no message header/);
    });
});

function pair(onRequest: (method: string, params: unknown) => unknown = () => null) {
    const sent: Array<Record<string, unknown>> = [];
    const reader = new MessageReader();
    const notifications: Array<{ method: string; params: unknown }> = [];
    const connection = new JsonRpcConnection(
        (frame) => {
            for (const result of reader.push(frame)) {
                if (result.ok) {
                    sent.push(result.message as Record<string, unknown>);
                }
            }
        },
        {
            onRequest,
            onNotification: (method, params) => notifications.push({ method, params }),
        },
    );
    return { connection, sent, notifications };
}

describe('JSON-RPC connection', () => {
    it('matches responses to requests by id, in any order', async () => {
        const { connection, sent } = pair();
        const first = connection.request<string>('a', { n: 1 });
        const second = connection.request<string>('b', undefined);
        expect(sent.map((message) => [message.id, message.method, 'params' in message])).toEqual([
            [1, 'a', true],
            [2, 'b', false],
        ]);
        connection.receive({ jsonrpc: '2.0', id: 2, result: 'two' });
        connection.receive({ jsonrpc: '2.0', id: 1, result: 'one' });
        await expect(first).resolves.toBe('one');
        await expect(second).resolves.toBe('two');
        expect(connection.pending).toBe(0);
    });

    it('turns error responses into ResponseError', async () => {
        const { connection } = pair();
        const request = connection.request('x', {});
        connection.receive({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no such method' } });
        await expect(request).rejects.toMatchObject({ name: 'ResponseError', code: -32601 });
        await expect(request).rejects.toBeInstanceOf(ResponseError);
    });

    it('times out, cancels on the other side and drops the late answer', async () => {
        const { connection, sent } = pair();
        const request = connection.request('slow', {}, { timeoutMs: 20 });
        await expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
        expect(sent.at(-1)).toMatchObject({ method: '$/cancelRequest', params: { id: 1 } });
        connection.receive({ jsonrpc: '2.0', id: 1, result: 'late' });
        expect(connection.pending).toBe(0);
    });

    it('aborts with the signal', async () => {
        const { connection, sent } = pair();
        const controller = new AbortController();
        const request = connection.request('slow', {}, { signal: controller.signal });
        controller.abort();
        await expect(request).rejects.toThrow(/cancelled/);
        expect(sent.at(-1)).toMatchObject({ method: '$/cancelRequest' });
    });

    it('answers requests from the other side and passes notifications on', async () => {
        const { connection, sent, notifications } = pair((method, params) => {
            if (method === 'workspace/configuration') {
                return (params as { items: unknown[] }).items.map(() => null);
            }
            throw new ResponseError(-32601, `no ${method}`);
        });
        connection.receive({
            jsonrpc: '2.0',
            id: 'c1',
            method: 'workspace/configuration',
            params: { items: [{}, {}] },
        });
        connection.receive({ jsonrpc: '2.0', id: 'c2', method: 'unknown/thing' });
        connection.receive({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'hi' } });
        await new Promise((resolve) => setImmediate(resolve));
        // Answers may go out in any order; JSON-RPC matches them by id.
        sent.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        expect(sent).toEqual([
            { jsonrpc: '2.0', id: 'c1', result: [null, null] },
            { jsonrpc: '2.0', id: 'c2', error: { code: -32601, message: 'no unknown/thing' } },
        ]);
        expect(notifications).toEqual([{ method: 'window/logMessage', params: { message: 'hi' } }]);
    });

    it('fails pending requests when closed and refuses new ones', async () => {
        const { connection } = pair();
        const request = connection.request('x', {});
        connection.close(new ConnectionClosedError('server exited with code 1'));
        await expect(request).rejects.toThrow('server exited with code 1');
        await expect(connection.request('y', {})).rejects.toBeInstanceOf(ConnectionClosedError);
    });
});
