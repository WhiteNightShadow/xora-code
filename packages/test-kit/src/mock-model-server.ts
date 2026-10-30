import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/** A request the mock server received, kept for assertions. */
export interface RecordedRequest {
    readonly method: string;
    /** Path without the query string, e.g. `/v1/messages`. */
    readonly path: string;
    readonly query: Readonly<Record<string, string>>;
    /** Header names in lower case. */
    readonly headers: Readonly<Record<string, string>>;
    /** Parsed JSON body; `undefined` when the body is empty or not JSON. */
    readonly body: unknown;
    readonly rawBody: string;
}

/**
 * One response. With `events` the chunks are written one by one as an SSE stream (strings verbatim, byte arrays
 * as they are, so a test can split UTF-8 sequences or lines anywhere); otherwise `body` is sent, JSON-encoded
 * unless it is a string.
 */
export interface MockTurn {
    /** Defaults to 200. */
    readonly status?: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly events?: readonly (string | Uint8Array)[];
    readonly body?: unknown;
    /** Pause before each chunk, and before the body. */
    readonly delayMs?: number;
    /** Keep the connection open after the last chunk, for idle-timeout tests. */
    readonly hang?: boolean;
}

/** Answers a request from its content; `undefined` falls through to the queue. */
export type MockResponder = (request: RecordedRequest) => MockTurn | undefined | Promise<MockTurn | undefined>;

export interface MockModel {
    readonly id: string;
    readonly displayName?: string;
    readonly maxInputTokens?: number;
    readonly maxTokens?: number;
}

export interface MockModelServerOptions {
    /** Models served by `GET /models` and `GET /v1/models`. */
    readonly models?: readonly MockModel[];
    /** Page size cap for the anthropic model list, to exercise pagination. */
    readonly modelsPageSize?: number;
}

export interface MockModelServer {
    /** Base URL, e.g. `http://127.0.0.1:53124`. */
    readonly url: string;
    /** Every request received, in order. */
    readonly requests: readonly RecordedRequest[];
    /** Turns not consumed yet. */
    readonly pending: number;
    /** Queues turns for the generation endpoints, answered first in, first out. */
    enqueue(...turns: MockTurn[]): void;
    /** Answers requests from a function before the queue is consulted; `undefined` removes it. */
    respondWith(responder: MockResponder | undefined): void;
    /** Replaces the model list. */
    setModels(models: readonly MockModel[]): void;
    /** Forgets recorded requests, queued turns and the responder. */
    reset(): void;
    close(): Promise<void>;
}

const GENERATE_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/v1/messages']);
const MODEL_PATHS = new Set(['/models', '/v1/models']);
const DEFAULT_MODELS: readonly MockModel[] = [{ id: 'mock-model', displayName: 'Mock Model' }];

async function readRequest(request: IncomingMessage): Promise<RecordedRequest> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    try {
        body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
        body = undefined;
    }
    const url = new URL(request.url ?? '/', 'http://mock.invalid');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
            headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }
    }
    return {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        body,
        rawBody,
    };
}

function modelList(request: RecordedRequest, models: readonly MockModel[], pageSize: number | undefined): MockTurn {
    if (request.path === '/v1/models' && request.headers['anthropic-version'] !== undefined) {
        const limit = Math.min(Number(request.query.limit ?? 20) || 20, pageSize ?? Number.POSITIVE_INFINITY);
        const after = request.query.after_id;
        const start = after === undefined ? 0 : models.findIndex((model) => model.id === after) + 1;
        const page = models.slice(start, start + limit);
        return {
            body: {
                data: page.map((model) => ({
                    type: 'model',
                    id: model.id,
                    display_name: model.displayName ?? model.id,
                    created_at: '2026-10-01T00:00:00Z',
                    ...(model.maxInputTokens !== undefined ? { max_input_tokens: model.maxInputTokens } : {}),
                    ...(model.maxTokens !== undefined ? { max_tokens: model.maxTokens } : {}),
                })),
                has_more: start + limit < models.length,
                first_id: page[0]?.id ?? null,
                last_id: page[page.length - 1]?.id ?? null,
            },
        };
    }
    return {
        body: {
            object: 'list',
            data: models.map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: 'mock' })),
        },
    };
}

async function send(response: ServerResponse, turn: MockTurn, closed: () => boolean): Promise<void> {
    const status = turn.status ?? 200;
    if (turn.events !== undefined) {
        response.writeHead(status, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            ...turn.headers,
        });
        response.flushHeaders();
        for (const chunk of turn.events) {
            if (turn.delayMs) {
                await sleep(turn.delayMs);
            }
            if (closed()) {
                return;
            }
            response.write(chunk);
        }
    } else {
        if (turn.delayMs) {
            await sleep(turn.delayMs);
        }
        if (closed()) {
            return;
        }
        const text = typeof turn.body === 'string' ? turn.body : JSON.stringify(turn.body ?? {});
        response.writeHead(status, { 'content-type': 'application/json', ...turn.headers });
        response.write(text);
    }
    if (!turn.hang) {
        response.end();
    }
}

/**
 * Starts an HTTP server on `127.0.0.1` with a random port that speaks just enough of the openai chat and anthropic
 * messages protocols for record/replay tests. Generation requests are answered by the responder or the queue;
 * an unexpected request gets a 500 so a test fails loudly instead of hanging.
 */
export async function startMockModelServer(options: MockModelServerOptions = {}): Promise<MockModelServer> {
    const requests: RecordedRequest[] = [];
    const queue: MockTurn[] = [];
    let responder: MockResponder | undefined;
    let models = options.models ?? DEFAULT_MODELS;

    const server = createServer((request, response) => {
        let closed = false;
        response.on('close', () => {
            closed = true;
        });
        void (async () => {
            const recorded = await readRequest(request);
            requests.push(recorded);
            let turn = await responder?.(recorded);
            if (turn === undefined && recorded.method === 'POST' && GENERATE_PATHS.has(recorded.path)) {
                turn = queue.shift() ?? { status: 500, body: { error: { message: 'no mock turn queued' } } };
            }
            if (turn === undefined && recorded.method === 'GET' && MODEL_PATHS.has(recorded.path)) {
                turn = modelList(recorded, models, options.modelsPageSize);
            }
            await send(response, turn ?? { status: 404, body: { error: { message: 'not found' } } }, () => closed);
        })().catch((error: unknown) => {
            if (!response.headersSent) {
                response.writeHead(500, { 'content-type': 'application/json' });
            }
            response.end(JSON.stringify({ error: { message: String(error) } }));
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        get pending() {
            return queue.length;
        },
        enqueue: (...turns) => {
            queue.push(...turns);
        },
        respondWith: (next) => {
            responder = next;
        },
        setModels: (next) => {
            models = next;
        },
        reset: () => {
            requests.length = 0;
            queue.length = 0;
            responder = undefined;
            models = options.models ?? DEFAULT_MODELS;
        },
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}
