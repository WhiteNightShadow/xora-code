import { describe, expect, it } from 'vitest';
import { classifyError, type ErrorClass, type ErrorInput, ProviderError, parseRetryAfter } from '../src/index.ts';
import { preset } from './helpers.ts';

function classify(status: number | undefined, body: unknown, extra: Partial<ErrorInput> = {}): ProviderError {
    return classifyError({ provider: 'test', ...(status !== undefined ? { status } : {}), body, ...extra });
}

const message = (text: string, extra: Record<string, unknown> = {}) => ({ error: { message: text, ...extra } });

describe('classifyError by status', () => {
    it('maps HTTP statuses to error classes', () => {
        const cases: Array<[number, ErrorClass]> = [
            [400, 'invalid_request'],
            [401, 'auth'],
            [402, 'quota'],
            [403, 'permission'],
            [404, 'not_found'],
            [408, 'timeout'],
            [413, 'context_length'],
            [418, 'invalid_request'],
            [422, 'invalid_request'],
            [429, 'rate_limit'],
            [500, 'server'],
            [502, 'server'],
            [503, 'overloaded'],
            [504, 'server'],
            [529, 'overloaded'],
        ];
        for (const [status, expected] of cases) {
            const error = classify(status, message('failure'));
            expect([status, error.errorClass]).toEqual([status, expected]);
            expect(error.status).toBe(status);
            expect(error.retryable).toBe(['rate_limit', 'overloaded', 'server', 'timeout'].includes(expected));
        }
    });

    it('tells an exhausted quota or balance from a rate limit by the wording', () => {
        const quota = [
            message('You exceeded your current quota, please check your plan and billing details.', {
                type: 'insufficient_quota',
            }),
            message('余额不足，请充值'),
            message('Your credit balance is insufficient.'),
            message("You've reached your 5-hour usage limit."),
            'insufficient_quota',
        ];
        for (const body of quota) {
            expect(classify(429, body).errorClass).toBe('quota');
        }
        expect(classify(429, message('Rate limit reached for requests, please try again in 2s')).errorClass).toBe(
            'rate_limit',
        );
        expect(classify(429, message("You've reached your concurrent request limit.")).errorClass).toBe('rate_limit');
        expect(classify(429, message('The engine is currently overloaded, please try again later')).errorClass).toBe(
            'overloaded',
        );
        expect(classify(400, message('Your credit balance is too low to access the Anthropic API.')).errorClass).toBe(
            'quota',
        );
    });

    it('recognises context length errors among bad requests', () => {
        const overflow = [
            message("This model's maximum context length is 131072 tokens. However, you requested 140000 tokens."),
            {
                type: 'error',
                error: {
                    type: 'invalid_request_error',
                    message: 'prompt is too long: 1050000 tokens > 1000000 maximum',
                },
            },
            message('Invalid request: Your request exceeded model token limit: 262144'),
            message('Input token length too long', { type: 'invalid_request_error' }),
            message('the request exceeds the available context size, try increasing it'),
            message('', { code: 'context_length_exceeded' }),
        ];
        for (const body of overflow) {
            expect(classify(400, body).errorClass).toBe('context_length');
        }
        const other = classify(400, {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'messages: roles must alternate' },
        });
        expect(other).toMatchObject({ errorClass: 'invalid_request', code: 'invalid_request_error' });
        expect(classify(400, message('The request was rejected because it was considered high risk')).errorClass).toBe(
            'content_filter',
        );
    });

    it('keeps plain-text bodies as the message', () => {
        expect(classify(502, '<html>Bad Gateway</html>')).toMatchObject({
            errorClass: 'server',
            message: '<html>Bad Gateway</html>',
        });
        expect(classify(500, '')).toMatchObject({ errorClass: 'server', message: 'HTTP 500' });
    });
});

describe('classifyError with vendor codes', () => {
    it('maps glm business codes from preset data', () => {
        const quirks = preset('glm-cn').quirks;
        const cases: Array<[string, number, ErrorClass]> = [
            ['1000', 401, 'auth'],
            ['1113', 429, 'quota'],
            ['1211', 400, 'not_found'],
            ['1261', 400, 'context_length'],
            ['1301', 400, 'content_filter'],
            ['1302', 429, 'rate_limit'],
            ['1305', 429, 'overloaded'],
            ['1308', 429, 'quota'],
            ['1309', 429, 'quota'],
            ['1310', 429, 'quota'],
            ['1311', 429, 'permission'],
            ['1313', 429, 'rate_limit'],
            ['1316', 429, 'quota'],
        ];
        for (const [code, status, expected] of cases) {
            const error = classify(status, { error: { code, message: `glm ${code}` } }, { quirks });
            expect([code, error.errorClass, error.code]).toEqual([code, expected, code]);
        }
        // Numeric codes work too.
        expect(classify(429, { error: { code: 1302, message: 'x' } }, { quirks }).errorClass).toBe('rate_limit');
    });

    it('maps kimi error types from preset data', () => {
        const quirks = preset('kimi-cn').quirks;
        const kimi = (status: number, type: string) => classify(status, message('x', { type }), { quirks }).errorClass;
        expect(kimi(429, 'engine_overloaded_error')).toBe('overloaded');
        expect(kimi(429, 'exceeded_current_quota_error')).toBe('quota');
        expect(kimi(429, 'rate_limit_reached_error')).toBe('rate_limit');
        expect(kimi(400, 'content_filter')).toBe('content_filter');
        expect(kimi(401, 'invalid_authentication_error')).toBe('auth');
    });

    it('treats a kimi code 403 as a plan permission problem unless the preset says otherwise', () => {
        const body = message('Your current subscription does not have access to k3.1-pro.');
        expect(classify(403, body, { quirks: preset('kimi-code-cn').quirks }).errorClass).toBe('permission');
        expect(classify(403, body, { quirks: { errorCodes: { 'http:403': 'quota' } } }).errorClass).toBe('quota');
        // A business code still wins over the status override.
        expect(
            classify(403, message('x', { code: 'other' }), {
                quirks: { errorCodes: { other: 'auth', 'http:403': 'quota' } },
            }).errorClass,
        ).toBe('auth');
    });

    it('maps the standard anthropic error types of mid-stream error events', () => {
        const event = (type: string) => classify(undefined, { type: 'error', error: { type, message: type } });
        expect(event('overloaded_error').errorClass).toBe('overloaded');
        expect(event('api_error').errorClass).toBe('server');
        expect(event('rate_limit_error').errorClass).toBe('rate_limit');
        expect(event('authentication_error').errorClass).toBe('auth');
        expect(event('request_too_large').errorClass).toBe('context_length');
        expect(event('something_else').errorClass).toBe('unknown');
    });
});

describe('classifyError for thrown errors', () => {
    it('reports fetch failures as retryable network errors', () => {
        const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
        const error = classifyError({ provider: 'test', cause: new TypeError('fetch failed', { cause }) });
        expect(error).toMatchObject({ errorClass: 'network', retryable: true });
        expect(error.message).toContain('ECONNREFUSED');
    });

    it('tells cancellation and idle timeouts apart', () => {
        expect(classifyError({ provider: 'test', cause: new DOMException('aborted', 'AbortError') }).errorClass).toBe(
            'cancelled',
        );
        expect(classifyError({ provider: 'test', aborted: true }).errorClass).toBe('cancelled');
        expect(classifyError({ provider: 'test', idleTimeoutMs: 5 })).toMatchObject({
            errorClass: 'timeout',
            retryable: true,
        });
    });

    it('passes provider errors through unchanged', () => {
        const original = new ProviderError('x', { errorClass: 'quota', provider: 'p' });
        expect(classifyError({ provider: 'other', cause: original })).toBe(original);
    });
});

describe('parseRetryAfter', () => {
    it('reads milliseconds, seconds and HTTP dates', () => {
        const now = Date.parse('2026-10-30T00:00:00Z');
        expect(parseRetryAfter(new Headers({ 'retry-after': '2' }), now)).toBe(2000);
        expect(parseRetryAfter(new Headers({ 'retry-after': '1.5' }), now)).toBe(1500);
        expect(parseRetryAfter(new Headers({ 'retry-after': '3', 'retry-after-ms': '150' }), now)).toBe(150);
        expect(parseRetryAfter({ 'Retry-After': 'Fri, 30 Oct 2026 00:00:05 GMT' }, now)).toBe(5000);
        expect(parseRetryAfter(new Headers({ 'retry-after': 'soon' }), now)).toBeUndefined();
        expect(parseRetryAfter(new Headers({ 'retry-after': '-1' }), now)).toBeUndefined();
        expect(parseRetryAfter(undefined, now)).toBeUndefined();
    });

    it('is attached to classified errors', () => {
        const error = classify(429, message('slow down'), { headers: new Headers({ 'retry-after': '7' }) });
        expect(error.retryAfterMs).toBe(7000);
    });
});
