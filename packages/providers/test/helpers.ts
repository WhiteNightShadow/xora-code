import { type MockModelServer, type MockModelServerOptions, startMockModelServer } from '@xora/test-kit';
import { afterAll, afterEach, beforeAll } from 'vitest';
import {
    type AssistantMessage,
    type AssistantPart,
    completeModel,
    getPreset,
    type ModelEvent,
    type ModelRequest,
    type ProviderConnection,
    type ProviderPreset,
    type StreamOptions,
    type ToolResultMessage,
    type ToolSpec,
    type UserMessage,
} from '../src/index.ts';

/** Starts one mock model server for the test file and resets it between tests. */
export function useMockServer(options?: MockModelServerOptions): () => MockModelServer {
    let server: MockModelServer | undefined;
    beforeAll(async () => {
        server = await startMockModelServer(options);
    });
    afterEach(() => {
        server?.reset();
    });
    afterAll(async () => {
        await server?.close();
    });
    return () => {
        if (server === undefined) {
            throw new Error('mock server not started');
        }
        return server;
    };
}

export function preset(id: string): ProviderPreset {
    const found = getPreset(id);
    if (found === undefined) {
        throw new Error(`unknown preset ${id}`);
    }
    return found;
}

/** A connection to a preset whose endpoint is redirected to the mock server. */
export function connect(
    presetId: string,
    server: MockModelServer,
    overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
    return { preset: preset(presetId), apiKey: 'test-key', baseUrl: server.url, ...overrides };
}

export function user(text: string): UserMessage {
    return { role: 'user', content: [{ type: 'text', text }] };
}

export function assistant(provider: string, model: string, content: readonly AssistantPart[]): AssistantMessage {
    return { role: 'assistant', provider, model, content };
}

export function toolResult(toolCallId: string, text: string, isError?: boolean): ToolResultMessage {
    return {
        role: 'tool',
        toolCallId,
        toolName: 'read',
        content: [{ type: 'text', text }],
        ...(isError !== undefined ? { isError } : {}),
    };
}

export const READ_TOOL: ToolSpec = {
    name: 'read',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

export function request(model: string, overrides: Partial<ModelRequest> = {}): ModelRequest {
    return { model, system: ['You are a test.'], messages: [user('hi')], ...overrides };
}

export async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
    const events: ModelEvent[] = [];
    for await (const event of stream) {
        events.push(event);
    }
    return events;
}

/** Runs a request against the mock server and returns the `done` event with the body the server received. */
export async function roundTrip(
    server: MockModelServer,
    connection: ProviderConnection,
    modelRequest: ModelRequest,
    options?: StreamOptions,
): Promise<{ done: Extract<ModelEvent, { type: 'done' }>; body: Record<string, unknown> }> {
    const done = await completeModel(connection, modelRequest, options);
    return { done, body: lastBody(server) };
}

export function lastBody(server: MockModelServer): Record<string, unknown> {
    const last = server.requests[server.requests.length - 1];
    if (last === undefined) {
        throw new Error('no request recorded');
    }
    return last.body as Record<string, unknown>;
}

/** Messages of the last request body, typed loosely for assertions. */
export function sentMessages(server: MockModelServer): Array<Record<string, unknown>> {
    return lastBody(server).messages as Array<Record<string, unknown>>;
}
