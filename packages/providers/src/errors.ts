import { asNumber, asString, isRecord, parseJson } from './json.ts';
import type { ErrorClass, Quirks } from './types.ts';

const RETRYABLE: ReadonlySet<ErrorClass> = new Set(['rate_limit', 'overloaded', 'server', 'network', 'timeout']);

export function isRetryable(errorClass: ErrorClass): boolean {
    return RETRYABLE.has(errorClass);
}

export interface ProviderErrorInit {
    readonly errorClass: ErrorClass;
    /** Preset id of the connection that failed. */
    readonly provider: string;
    readonly status?: number;
    /** Vendor business code or error type, e.g. glm `1302` or `overloaded_error`. */
    readonly code?: string;
    readonly retryAfterMs?: number;
    readonly requestId?: string;
    readonly cause?: unknown;
}

/** Every failure of a model call, normalised so the engine can decide on retries, fallbacks and messages. */
export class ProviderError extends Error {
    readonly errorClass: ErrorClass;
    readonly provider: string;
    readonly status?: number;
    readonly code?: string;
    readonly retryAfterMs?: number;
    readonly requestId?: string;
    /** Rate limits, overloads, server and network failures and timeouts are worth retrying. */
    readonly retryable: boolean;

    constructor(message: string, init: ProviderErrorInit) {
        super(message, init.cause === undefined ? undefined : { cause: init.cause });
        this.name = 'ProviderError';
        this.errorClass = init.errorClass;
        this.provider = init.provider;
        this.status = init.status;
        this.code = init.code;
        this.retryAfterMs = init.retryAfterMs;
        this.requestId = init.requestId;
        this.retryable = isRetryable(init.errorClass);
    }
}

type HeaderSource = Headers | Readonly<Record<string, string>>;

function header(headers: HeaderSource | undefined, name: string): string | undefined {
    if (headers === undefined) {
        return undefined;
    }
    // Duck-typed so a Headers object from another fetch implementation works too.
    if (typeof (headers as { get?: unknown }).get === 'function') {
        return (headers as Headers).get(name) ?? undefined;
    }
    const record = headers as Readonly<Record<string, string>>;
    const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name);
    return key === undefined ? undefined : record[key];
}

/** Reads `retry-after-ms`, then `retry-after` in seconds or as an HTTP date. */
export function parseRetryAfter(headers: HeaderSource | undefined, now = Date.now()): number | undefined {
    const millis = header(headers, 'retry-after-ms')?.trim();
    if (millis) {
        const value = Number(millis);
        if (Number.isFinite(value) && value >= 0) {
            return Math.round(value);
        }
    }
    const raw = header(headers, 'retry-after')?.trim();
    if (!raw) {
        return undefined;
    }
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) {
        return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
    }
    const date = Date.parse(raw);
    return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const REQUEST_ID_HEADERS = ['x-request-id', 'request-id', 'x-trace-id', 'trace-id'];

export function requestIdFrom(headers: HeaderSource | undefined): string | undefined {
    for (const name of REQUEST_ID_HEADERS) {
        const value = header(headers, name);
        if (value) {
            return value;
        }
    }
    return undefined;
}

/** Error types shared by the openai and anthropic protocols; vendor-specific codes live in preset quirks. */
const STANDARD_TYPES: Readonly<Record<string, ErrorClass>> = {
    authentication_error: 'auth',
    invalid_api_key: 'auth',
    permission_error: 'permission',
    not_found_error: 'not_found',
    model_not_found: 'not_found',
    rate_limit_error: 'rate_limit',
    rate_limit_exceeded: 'rate_limit',
    overloaded_error: 'overloaded',
    api_error: 'server',
    server_error: 'server',
    timeout_error: 'timeout',
    request_too_large: 'context_length',
    context_length_exceeded: 'context_length',
    billing_error: 'quota',
    insufficient_quota: 'quota',
};

const CONTEXT_PATTERN =
    /context[ _-]?(length|window|size)|maximum context|too many tokens|prompt is too long|prompt too long|token length too long|exceeded model token limit|maximum prompt length|exceeds the maximum number of tokens|total message size|超长|超出.{0,8}上下文|上下文.{0,8}(超|过长)/i;
const QUOTA_PATTERN =
    /insufficient[_ -]?(quota|balance|funds)|exceeded your current quota|\bquota\b|\bbalance\b|\bcredits?\b|billing|usage limit|limit exhausted|余额|欠费|额度|配额/i;
const RATE_PATTERN =
    /rate[ _-]?limit|per[ -]?(minute|second)|\b(rpm|tpm|rps|qps)\b|concurren|too many requests|try again in|retry in|retry after/i;
const OVERLOAD_PATTERN = /overload|capacity|busy|过载|繁忙|访问量过大/i;
const CONTENT_PATTERN =
    /content[_ ]?(filter|policy)|safety (system|filter)|high risk|unsafe content|sensitive content|敏感|不安全/i;

interface ErrorBody {
    readonly message?: string;
    /** Codes to look up, most specific first. */
    readonly codes: readonly string[];
}

function codeText(value: unknown): string | undefined {
    const number = asNumber(value);
    return number === undefined ? asString(value) || undefined : String(number);
}

/** Extracts the message and the codes from the error layouts vendors use. */
export function readErrorBody(body: unknown): ErrorBody {
    const value = typeof body === 'string' ? (parseJson(body) ?? body) : body;
    if (typeof value === 'string') {
        const text = value.trim();
        return { codes: [], ...(text ? { message: text.slice(0, 2000) } : {}) };
    }
    if (!isRecord(value)) {
        return { codes: [] };
    }
    const nested = isRecord(value.error) ? value.error : undefined;
    const codes = [
        codeText(nested?.code),
        codeText(nested?.type),
        codeText(value.code),
        // Anthropic wraps errors in `{type: 'error', error: {...}}`.
        value.type === 'error' ? undefined : codeText(value.type),
        codeText(value.error_code),
    ].filter((code): code is string => code !== undefined);
    const message =
        asString(nested?.message) ??
        asString(value.message) ??
        asString(value.error) ??
        asString(value.msg) ??
        asString(value.detail);
    return { codes, ...(message ? { message } : {}) };
}

export interface ErrorInput {
    /** Preset id of the connection. */
    readonly provider: string;
    readonly status?: number;
    /** Response body text, or an already parsed error payload such as an SSE `error` event. */
    readonly body?: unknown;
    readonly headers?: HeaderSource;
    readonly quirks?: Quirks;
    readonly requestId?: string;
    /** A thrown value: a fetch failure or an abort. Only consulted when neither `status` nor `body` is given. */
    readonly cause?: unknown;
    /** The caller's signal aborted the request. */
    readonly aborted?: boolean;
    /** The idle timer abandoned the request after this many milliseconds without data. */
    readonly idleTimeoutMs?: number;
}

function errorName(value: unknown): string | undefined {
    return isRecord(value) || value instanceof Error ? asString((value as { name?: unknown }).name) : undefined;
}

function classifyByStatus(status: number | undefined, text: string): ErrorClass {
    switch (status) {
        case 401:
            return 'auth';
        case 402:
            return 'quota';
        case 403:
            return 'permission';
        case 404:
            return 'not_found';
        case 408:
            return 'timeout';
        case 413:
            return 'context_length';
        case 429:
            if (OVERLOAD_PATTERN.test(text)) {
                return 'overloaded';
            }
            return QUOTA_PATTERN.test(text) && !RATE_PATTERN.test(text) ? 'quota' : 'rate_limit';
        case 503:
        case 529:
            return 'overloaded';
        default:
            break;
    }
    if (status === undefined || status === 400 || status === 422) {
        if (CONTEXT_PATTERN.test(text)) {
            return 'context_length';
        }
        if (QUOTA_PATTERN.test(text) && !RATE_PATTERN.test(text)) {
            return 'quota';
        }
        if (CONTENT_PATTERN.test(text)) {
            return 'content_filter';
        }
        if (status === undefined) {
            if (OVERLOAD_PATTERN.test(text)) {
                return 'overloaded';
            }
            return RATE_PATTERN.test(text) ? 'rate_limit' : 'unknown';
        }
        return 'invalid_request';
    }
    if (status >= 500) {
        return 'server';
    }
    return status >= 400 ? 'invalid_request' : 'unknown';
}

/**
 * Turns a failed response, an error payload or a thrown fetch error into a {@link ProviderError}. Preset
 * `errorCodes` win over the standard protocol error types, which win over status-based rules; quota and context
 * length are recognised from the message where vendors share a status with other failures.
 */
export function classifyError(input: ErrorInput): ProviderError {
    const { provider, status, quirks, requestId } = input;
    if (input.cause instanceof ProviderError) {
        return input.cause;
    }
    const base = { provider, ...(requestId ? { requestId } : {}) };
    if (input.aborted) {
        return new ProviderError('request cancelled', { ...base, errorClass: 'cancelled', cause: input.cause });
    }
    if (input.idleTimeoutMs !== undefined) {
        return new ProviderError(`no data received for ${input.idleTimeoutMs} ms`, {
            ...base,
            errorClass: 'timeout',
            cause: input.cause,
        });
    }
    if (status === undefined && input.body === undefined) {
        const name = errorName(input.cause);
        const errorClass: ErrorClass =
            name === 'AbortError' ? 'cancelled' : name === 'TimeoutError' ? 'timeout' : 'network';
        const detail = input.cause instanceof Error ? describeCause(input.cause) : String(input.cause);
        return new ProviderError(detail, { ...base, errorClass, cause: input.cause });
    }
    const body = readErrorBody(input.body);
    const codes = quirks?.errorCodes ?? {};
    let errorClass: ErrorClass | undefined;
    let code: string | undefined;
    for (const candidate of body.codes) {
        if (Object.hasOwn(codes, candidate)) {
            errorClass = codes[candidate];
            code = candidate;
            break;
        }
    }
    if (errorClass === undefined && status !== undefined) {
        errorClass = codes[`http:${status}`];
    }
    if (errorClass === undefined) {
        code = body.codes.find((candidate) => Object.hasOwn(STANDARD_TYPES, candidate));
        errorClass = code === undefined ? undefined : STANDARD_TYPES[code];
    }
    code ??= body.codes[0];
    errorClass ??= classifyByStatus(status, `${body.codes.join(' ')} ${body.message ?? ''}`);
    const retryAfterMs = parseRetryAfter(input.headers);
    const message = body.message ?? (status === undefined ? `${errorClass} error` : `HTTP ${status}`);
    return new ProviderError(message, {
        ...base,
        errorClass,
        ...(status !== undefined ? { status } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
}

function describeCause(error: Error): string {
    const cause = error.cause;
    if (cause instanceof Error) {
        const code = asString((cause as { code?: unknown }).code);
        return `${error.message}: ${code ? `${code} ` : ''}${cause.message}`.trim();
    }
    return error.message;
}
