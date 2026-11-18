import { alternateOperationUrl, endpointFor, findModel, operationUrl } from './catalog.ts';
import { lowestEffort } from './effort.ts';
import { classifyError, ProviderError, requestIdFrom } from './errors.ts';
import { buildHeaders, Exchange } from './http.ts';
import { asNumber, asString, isRecord, type JsonObject, parseJson } from './json.ts';
import { completeModel } from './stream.ts';
import type { ErrorClass, ModelInfo, ProviderConnection, StreamOptions, Usage } from './types.ts';

/** Listing requests are short; they fail after this long without data unless `idleTimeoutMs` says otherwise. */
const LIST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 50;

/** A model as the vendor's `/models` endpoint reports it. */
export interface RemoteModel {
    readonly id: string;
    readonly name?: string;
    readonly contextWindow?: number;
    readonly maxOutput?: number;
}

async function getJson(
    connection: ProviderConnection,
    url: string,
    exchange: Exchange,
    headers: Record<string, string>,
): Promise<unknown> {
    const provider = connection.preset.id;
    const response = await exchange.fetch(url, { method: 'GET', headers });
    const text = await exchange.text(response);
    const requestId = requestIdFrom(response.headers);
    if (!response.ok) {
        throw classifyError({
            provider,
            status: response.status,
            body: text,
            headers: response.headers,
            quirks: connection.preset.quirks,
            ...(requestId ? { requestId } : {}),
        });
    }
    const payload = parseJson(text);
    if (!isRecord(payload) && !Array.isArray(payload)) {
        throw new ProviderError('the model list is not a JSON object', { errorClass: 'server', provider });
    }
    return payload;
}

function remoteModel(entry: unknown): RemoteModel | undefined {
    if (typeof entry === 'string') {
        const trimmed = entry.trim();
        return trimmed ? { id: trimmed } : undefined;
    }
    if (!isRecord(entry)) {
        return undefined;
    }
    const id = asString(entry.id) ?? asString(entry.model);
    if (!id) {
        return undefined;
    }
    const name = asString(entry.display_name) ?? asString(entry.name);
    // anthropic: max_input_tokens / max_tokens; openrouter and some others: context_length.
    const contextWindow = asNumber(entry.max_input_tokens) ?? asNumber(entry.context_length);
    const maxOutput = asNumber(entry.max_tokens);
    return {
        id,
        ...(name ? { name } : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutput !== undefined ? { maxOutput } : {}),
    };
}

function extractEntries(payload: unknown): unknown[] {
    if (Array.isArray(payload)) return payload;
    if (isRecord(payload)) {
        if (Array.isArray(payload.data)) return payload.data;
        if (Array.isArray(payload.models)) return payload.models;
    }
    return [];
}

/**
 * Lists the models an endpoint serves: `GET /models` (falling back to `/v1/models` on 404 when a bare host was
 * configured) on the openai wire, `GET /v1/models` with pagination on the anthropic wire.
 */
export async function listModels(connection: ProviderConnection, options: StreamOptions = {}): Promise<RemoteModel[]> {
    const endpoint = endpointFor(connection);
    const headers = buildHeaders(connection, connection.preset.quirks, endpoint.wire, {
        accept: 'application/json',
        json: false,
        ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    });
    const exchange = new Exchange(connection.preset.id, options, LIST_TIMEOUT_MS);
    const url = operationUrl(endpoint, 'models');
    const fallbackUrl = alternateOperationUrl(endpoint, 'models');
    const models: RemoteModel[] = [];
    try {
        if (endpoint.wire === 'openai_chat') {
            let payload: unknown;
            try {
                payload = await getJson(connection, url, exchange, headers);
            } catch (error) {
                if (fallbackUrl && error instanceof ProviderError && error.status === 404) {
                    payload = await getJson(connection, fallbackUrl, exchange, headers);
                } else {
                    throw error;
                }
            }
            return extractEntries(payload).flatMap((entry) => remoteModel(entry) ?? []);
        }
        let activeUrl = url;
        let after: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const query = new URLSearchParams({ limit: '1000', ...(after ? { after_id: after } : {}) });
            let payload: unknown;
            try {
                payload = await getJson(connection, `${activeUrl}?${query}`, exchange, headers);
            } catch (error) {
                if (page === 0 && fallbackUrl && error instanceof ProviderError && error.status === 404) {
                    activeUrl = fallbackUrl;
                    payload = await getJson(connection, `${activeUrl}?${query}`, exchange, headers);
                } else {
                    throw error;
                }
            }
            const data = extractEntries(payload);
            models.push(...data.flatMap((entry) => remoteModel(entry) ?? []));
            const record: JsonObject = isRecord(payload) ? payload : {};
            const last = asString(record.last_id) ?? models[models.length - 1]?.id;
            if (record.has_more !== true || last === undefined || last === after || data.length === 0) {
                break;
            }
            after = last;
        }
        return models;
    } finally {
        exchange.dispose();
    }
}

export interface ModelComparison {
    /** Catalog model ids the endpoint does not list: misspelled, retired or not on the user's plan. */
    readonly missing: readonly string[];
    /** Listed models the catalog has no facts for. */
    readonly unknown: readonly RemoteModel[];
}

/**
 * Checks catalog model ids against `/models`. Matters most where a wrong id fails silently, as on kimi code, which
 * falls back to a non-thinking model.
 */
export function compareModels(connection: ProviderConnection, remote: readonly RemoteModel[]): ModelComparison {
    const listed = new Set(remote.map((model) => model.id));
    const known = [...(connection.extraModels ?? []), ...connection.preset.models];
    const knownIds = new Set(known.map((model) => model.id));
    return {
        missing: [...knownIds].filter((id) => !listed.has(id)),
        unknown: remote.filter((model) => !knownIds.has(model.id)),
    };
}

export interface ConnectionTest {
    readonly ok: boolean;
    readonly latencyMs: number;
    readonly ttftMs?: number;
    readonly model: string;
    readonly usage?: Usage;
    readonly error?: { readonly errorClass: ErrorClass; readonly message: string };
}

/**
 * Sends one minimal streaming request ("ping", 16 output tokens, the weakest effort) and reports whether the
 * connection works. Never throws.
 */
export async function testConnection(
    connection: ProviderConnection,
    modelId: string,
    options: StreamOptions = {},
): Promise<ConnectionTest> {
    const started = performance.now();
    const model: ModelInfo = findModel(connection, modelId);
    const effort = lowestEffort(model);
    try {
        const done = await completeModel(
            connection,
            {
                model: modelId,
                system: [],
                messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
                maxOutputTokens: 16,
                ...(effort !== undefined ? { effort } : {}),
            },
            options,
        );
        return {
            ok: true,
            latencyMs: done.latencyMs,
            ...(done.ttftMs !== undefined ? { ttftMs: done.ttftMs } : {}),
            model: modelId,
            ...(done.usage !== undefined ? { usage: done.usage } : {}),
        };
    } catch (error) {
        const failure =
            error instanceof ProviderError
                ? error
                : new ProviderError(error instanceof Error ? error.message : String(error), {
                      errorClass: 'unknown',
                      provider: connection.preset.id,
                      cause: error,
                  });
        return {
            ok: false,
            latencyMs: Math.round(performance.now() - started),
            model: modelId,
            error: { errorClass: failure.errorClass, message: failure.message },
        };
    }
}
