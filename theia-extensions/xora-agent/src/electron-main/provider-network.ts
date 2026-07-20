import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DNS_ANSWERS = 64;

const BLOCKED_METADATA_HOSTS = new Set([
    'instance-data',
    'metadata',
    'metadata.google.internal',
    'metadata.goog'
]);

const BLOCKED_IPV4_HOSTS = new Set([
    // Alibaba Cloud ECS metadata and Azure's privileged WireServer address.
    '100.100.100.200',
    '168.63.129.16'
]);

const BLOCKED_IPV6_BYTES = new Set([
    // AWS EC2 IMDS and Google Cloud metadata IPv6 endpoints.
    'fd000ec2000000000000000000000254',
    'fd2000ce000000000000000000000254'
]);

export interface ResolvedProviderAddress {
    address: string;
    family: 4 | 6;
}

export type ProviderAddressResolver = (hostname: string) => Promise<readonly ResolvedProviderAddress[]>;

export type ProviderRequestFactory = (
    endpoint: URL,
    options: https.RequestOptions,
    onResponse: (response: http.IncomingMessage) => void
) => http.ClientRequest;

export interface ProviderNetworkOptions {
    resolver?: ProviderAddressResolver;
    requestFactory?: ProviderRequestFactory;
    timeoutMs?: number;
    maxResponseBytes?: number;
}

/**
 * Validates and normalizes a user-entered Provider Base URL. Hostnames are
 * resolved again immediately before every request; this synchronous check is
 * intentionally limited to URL structure, known metadata names and IP
 * literals.
 */
export function normalizeProviderBaseUrl(value: string): string {
    let baseUrl: URL;
    try {
        baseUrl = new URL(value);
    } catch {
        throw new Error('Provider Base URL is invalid.');
    }

    const hostname = normalizedHostname(baseUrl.hostname);
    if (!hostname) {
        throw new Error('Provider Base URL must contain a hostname.');
    }
    if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
        throw new Error('Provider Base URL cannot contain credentials, query parameters or fragments.');
    }
    assertAllowedMetadataHostname(hostname);

    const literalFamily = net.isIP(hostname);
    if (literalFamily !== 0) {
        assertSafeProviderAddress(hostname);
    }

    const explicitLoopback = hostname === 'localhost' || (literalFamily !== 0 && isLoopbackAddress(hostname));
    if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && explicitLoopback)) {
        throw new Error('Provider endpoints must use HTTPS; HTTP is allowed only for an explicit loopback address.');
    }

    // URL keeps brackets around IPv6 hostnames and canonicalizes alternative
    // IPv4 spellings, which is useful when this value is persisted.
    return baseUrl.toString().replace(/\/$/, '');
}

export function providerModelsEndpoint(baseUrl: string): URL {
    return new URL(`${normalizeProviderBaseUrl(baseUrl).replace(/\/$/, '')}/models`);
}

/** Returns a stable, user-safe reason when an address must not be contacted. */
export function forbiddenProviderAddressReason(address: string): string | undefined {
    const hostname = normalizedHostname(address);
    const family = net.isIP(hostname);
    if (family === 4) {
        return forbiddenIpv4Reason(parseIpv4(hostname));
    }
    if (family !== 6) {
        return 'invalid address';
    }

    const bytes = parseIpv6(hostname);
    if (!bytes) return 'invalid address';
    const hexadecimal = Buffer.from(bytes).toString('hex');
    if (BLOCKED_IPV6_BYTES.has(hexadecimal)) return 'cloud metadata address';
    if (bytes.every(byte => byte === 0)) return 'unspecified address';
    if (bytes[0] === 0xff) return 'multicast address';
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return 'link-local address';

    // IPv4-compatible and IPv4-mapped IPv6 forms. URL canonicalization turns
    // dotted suffixes into hex, so inspect bytes rather than text.
    if (bytes.slice(0, 10).every(byte => byte === 0) &&
        ((bytes[10] === 0 && bytes[11] === 0) || (bytes[10] === 0xff && bytes[11] === 0xff))) {
        const embedded = bytes.slice(12, 16);
        if (embedded[0] === 0 && embedded[1] === 0 && embedded[2] === 0 && embedded[3] === 1) return undefined;
        return forbiddenIpv4Reason(embedded);
    }

    // Reject transition forms that could tunnel a blocked IPv4 destination
    // past the DNS/IP check. They are not expected model API endpoints.
    if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return 'IPv4 translation address';
    if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return 'IPv4 translation address';
    if (startsWith(bytes, [0x20, 0x02])) {
        return forbiddenIpv4Reason(bytes.slice(2, 6)) ? 'IPv4 transition address' : undefined;
    }
    if (startsWith(bytes, [0x20, 0x01, 0, 0])) return 'IPv4 transition address';
    return undefined;
}

export function assertSafeProviderAddress(address: string): void {
    const reason = forbiddenProviderAddressReason(address);
    if (reason) {
        throw new Error(`Provider endpoint resolved to a blocked ${reason}.`);
    }
}

export async function resolveSafeProviderTarget(
    endpoint: URL,
    resolver: ProviderAddressResolver = defaultProviderAddressResolver
): Promise<ResolvedProviderAddress> {
    // Re-validate in the request path even when a profile was loaded from disk.
    normalizeProviderBaseUrl(endpoint.toString());
    const hostname = normalizedHostname(endpoint.hostname);
    const literalFamily = net.isIP(hostname);
    const explicitLoopback = hostname === 'localhost' || (literalFamily !== 0 && isLoopbackAddress(hostname));
    let answers: readonly ResolvedProviderAddress[];
    try {
        answers = await resolver(hostname);
    } catch {
        throw new Error('Provider endpoint DNS lookup failed.');
    }
    if (!answers.length) {
        throw new Error('Provider endpoint DNS lookup returned no addresses.');
    }
    if (answers.length > MAX_DNS_ANSWERS) {
        throw new Error('Provider endpoint DNS lookup returned too many addresses.');
    }

    const unique = new Map<string, ResolvedProviderAddress>();
    for (const answer of answers) {
        const actualFamily = net.isIP(normalizedHostname(answer.address));
        if ((answer.family !== 4 && answer.family !== 6) || actualFamily !== answer.family) {
            throw new Error('Provider endpoint DNS lookup returned an invalid address.');
        }
        assertSafeProviderAddress(answer.address);
        const resolvedLoopback = isLoopbackAddress(answer.address);
        if (explicitLoopback !== resolvedLoopback) {
            throw new Error(explicitLoopback
                ? 'An explicit loopback Provider endpoint must resolve only to loopback addresses.'
                : 'A Provider hostname cannot resolve to loopback unless loopback was explicit in the Base URL.');
        }
        const normalized = normalizedHostname(answer.address);
        unique.set(`${answer.family}:${normalized}`, { address: normalized, family: answer.family });
    }
    return unique.values().next().value!;
}

export const defaultProviderAddressResolver: ProviderAddressResolver = async hostname => {
    const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return answers.map(answer => ({ address: answer.address, family: answer.family as 4 | 6 }));
};

/** Pins connection establishment to the address that was already validated. */
export function createPinnedLookup(target: ResolvedProviderAddress): net.LookupFunction {
    return (_hostname, options, callback) => {
        const requestedFamily = options.family;
        if (requestedFamily && requestedFamily !== target.family) {
            const error = Object.assign(new Error('Pinned Provider address does not match the requested family.'), { code: 'EAI_ADDRFAMILY' });
            callback(error, '', target.family);
            return;
        }
        if (options.all) {
            callback(null, [{ ...target }]);
        } else {
            callback(null, target.address, target.family);
        }
    };
}

/**
 * Performs a direct, non-redirecting JSON request after resolving and pinning a
 * safe destination. The same absolute deadline covers DNS and response reads.
 */
export async function requestProviderJson(
    endpoint: URL,
    headers: Readonly<Record<string, string>>,
    options: ProviderNetworkOptions = {}
): Promise<unknown> {
    const timeoutMs = positiveBoundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 60_000, 'timeout');
    const maxResponseBytes = positiveBoundedInteger(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 16 * 1024 * 1024, 'response limit');
    const startedAt = Date.now();
    const target = await withDeadline(
        resolveSafeProviderTarget(endpoint, options.resolver),
        timeoutMs,
        'Provider model request timed out during DNS lookup.'
    );
    const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    return requestPinnedJson(endpoint, headers, target, remainingMs, maxResponseBytes, options.requestFactory);
}

function requestPinnedJson(
    endpoint: URL,
    headers: Readonly<Record<string, string>>,
    target: ResolvedProviderAddress,
    timeoutMs: number,
    maxResponseBytes: number,
    requestFactory?: ProviderRequestFactory
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let request: http.ClientRequest | undefined;
        const finish = (error?: Error, value?: unknown): void => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (error) reject(error); else resolve(value);
        };
        const transport = endpoint.protocol === 'https:' ? https : http;
        const deadline = setTimeout(() => {
            const error = new Error('Provider model request timed out.');
            finish(error);
            request?.destroy(error);
        }, timeoutMs);
        deadline.unref?.();
        const makeRequest: ProviderRequestFactory = requestFactory ?? ((url, requestOptions, onResponse) =>
            transport.request(url, requestOptions, onResponse));
        try {
            request = makeRequest(endpoint, {
                method: 'GET',
                headers,
                lookup: createPinnedLookup(target),
                family: target.family,
                // Do not reuse a socket whose destination was validated for an
                // earlier DNS result and do not delegate to a proxying global agent.
                agent: false
            }, response => {
                const status = response.statusCode ?? 0;
                if (status >= 300 && status < 400) {
                    response.resume();
                    finish(new Error('Provider model discovery refused an authenticated redirect.'));
                    return;
                }
                if (status < 200 || status >= 300) {
                    response.resume();
                    finish(new Error(`Provider model discovery failed with HTTP ${status}.`));
                    return;
                }
                const declaredLength = Number(response.headers['content-length']);
                if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
                    response.resume();
                    finish(new Error(`Provider model response exceeded ${formatByteLimit(maxResponseBytes)}.`));
                    request?.destroy();
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', chunk => {
                    const buffer = Buffer.from(chunk);
                    size += buffer.length;
                    if (size > maxResponseBytes) {
                        finish(new Error(`Provider model response exceeded ${formatByteLimit(maxResponseBytes)}.`));
                        request?.destroy();
                    } else {
                        chunks.push(buffer);
                    }
                });
                response.once('aborted', () => finish(new Error('Provider model response was aborted.')));
                response.once('error', error => finish(new Error(`Provider model response failed: ${error.message}`)));
                response.once('end', () => {
                    if (settled) return;
                    try {
                        finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch {
                        finish(new Error('Provider returned malformed model JSON.'));
                    }
                });
            });
            request.once('error', error => finish(error));
            request.end();
        } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

function assertAllowedMetadataHostname(hostname: string): void {
    const labels = hostname.split('.');
    if (BLOCKED_METADATA_HOSTS.has(hostname) ||
        hostname.endsWith('.metadata.google.internal') ||
        labels.includes('instance-data')) {
        throw new Error('Provider Base URL cannot target a cloud metadata hostname.');
    }
}

function isLoopbackAddress(address: string): boolean {
    const hostname = normalizedHostname(address);
    if (hostname === 'localhost') return true;
    if (net.isIPv4(hostname)) return parseIpv4(hostname)[0] === 127;
    const bytes = parseIpv6(hostname);
    return Boolean(bytes && bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1);
}

function forbiddenIpv4Reason(bytes: Uint8Array): string | undefined {
    const text = [...bytes].join('.');
    if (BLOCKED_IPV4_HOSTS.has(text)) return 'cloud metadata address';
    if (bytes[0] === 0) return 'unspecified address range';
    if (bytes[0] === 169 && bytes[1] === 254) return 'link-local address';
    if (bytes[0] >= 224 && bytes[0] <= 239) return 'multicast address';
    if (bytes[0] >= 240) return 'reserved address';
    return undefined;
}

function parseIpv4(address: string): Uint8Array {
    return Uint8Array.from(address.split('.').map(part => Number(part)));
}

function parseIpv6(address: string): Uint8Array | undefined {
    let normalized = normalizedHostname(address);
    if (!net.isIPv6(normalized)) return undefined;
    const dottedSuffix = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (dottedSuffix) {
        const ipv4 = parseIpv4(dottedSuffix[2]);
        normalized = `${dottedSuffix[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
    }
    const halves = normalized.split('::');
    if (halves.length > 2) return undefined;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
    const groups = [...left, ...Array(missing).fill('0'), ...right].map(group => Number.parseInt(group || '0', 16));
    if (groups.length !== 8 || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) return undefined;
    return Uint8Array.from(groups.flatMap(group => [group >>> 8, group & 0xff]));
}

function normalizedHostname(hostname: string): string {
    return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function startsWith(value: Uint8Array, prefix: readonly number[]): boolean {
    return prefix.every((byte, index) => value[index] === byte);
}

function positiveBoundedInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
    const actual = value ?? fallback;
    if (!Number.isSafeInteger(actual) || actual <= 0 || actual > maximum) {
        throw new Error(`Provider model ${label} is invalid.`);
    }
    return actual;
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
        promise.then(value => {
            clearTimeout(timer);
            resolve(value);
        }, error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

function formatByteLimit(value: number): string {
    return value === 2 * 1024 * 1024 ? '2 MiB' : `${value} bytes`;
}
