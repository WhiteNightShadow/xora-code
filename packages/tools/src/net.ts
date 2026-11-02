import { lookup } from 'node:dns/promises';
import net from 'node:net';

/**
 * HTTP requests for the web tools. Only public http(s) addresses are reached: every hop of a redirect is checked
 * again, and a host whose name resolves to a loopback, private, link-local or multicast address is refused, so a page
 * cannot point the agent at the user's machine or local network. The check resolves the name itself and `fetch`
 * resolves it again, so a DNS server that answers differently the second time is not caught; behind a fake-ip DNS
 * (Clash, Surge) every name resolves to 198.18.0.0/15 and the proxy connects on its own, out of sight of this check.
 */

export const WEB_TIMEOUT_MS = 30_000;
/** Bodies are read up to this size; the rest is dropped. */
export const WEB_MAX_BYTES = 5 * 1024 * 1024;
export const WEB_MAX_REDIRECTS = 5;
export const WEB_USER_AGENT = 'Mozilla/5.0 (compatible; XoraCode/1.0)';

const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** A refusal or failure the model reads as it is. */
export class WebError extends Error {
    override name = 'WebError';
}

/** Checks a URL before it is requested: absolute, http or https, without a user name or password. */
export function parseWebUrl(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new WebError(`Not a valid URL: ${raw}. Give an absolute http or https URL.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new WebError(`Only http and https URLs can be fetched, not ${url.protocol.slice(0, -1)} ones.`);
    }
    if (url.username !== '' || url.password !== '') {
        throw new WebError('URLs with a user name or password are refused; do not put credentials in a URL.');
    }
    return url;
}

function privateV4(bytes: readonly number[]): boolean {
    const [a = 0, b = 0, c = 0, d = 0] = bytes;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a >= 224 && a <= 239) ||
        (a === 255 && b === 255 && c === 255 && d === 255)
    );
}

/** The eight 16-bit groups of a valid IPv6 address, an embedded IPv4 tail included. */
function v6Groups(address: string): number[] {
    let text = address;
    const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
    if (tail) {
        const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
        text = `${text.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const [left = '', right] = text.split('::');
    const head = left === '' ? [] : left.split(':');
    const rest = right === undefined || right === '' ? [] : right.split(':');
    const groups =
        right === undefined ? head : [...head, ...Array<string>(8 - head.length - rest.length).fill('0'), ...rest];
    return groups.map((group) => Number.parseInt(group, 16));
}

/**
 * Whether an IP address is one the web tools must not reach: unspecified, loopback, private (RFC 1918, IPv6 unique
 * local), link-local, multicast or broadcast, also as IPv4-mapped, IPv4-compatible or NAT64 IPv6 addresses. Shared
 * address space (100.64.0.0/10, used by Tailscale) and the benchmark range (198.18.0.0/15, used by fake-ip DNS) stay
 * reachable. Anything that is not an IP address is not private.
 */
export function isPrivateAddress(address: string): boolean {
    const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
    const family = net.isIP(bare);
    if (family === 4) {
        return privateV4(bare.split('.').map(Number));
    }
    if (family !== 6) {
        return false;
    }
    const groups = v6Groups(bare);
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
    const embedded = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
    const zeroTo = (end: number) => groups.slice(0, end).every((group) => group === 0);
    if (zeroTo(6)) {
        // `::`, `::1` and the deprecated IPv4-compatible form `::a.b.c.d`.
        return (g6 === 0 && (g7 === 0 || g7 === 1)) || privateV4(embedded);
    }
    if (zeroTo(5) && g5 === 0xffff) {
        return privateV4(embedded);
    }
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
        return privateV4(embedded);
    }
    return (
        (g0 & 0xfe00) === 0xfc00 || // unique local
        (g0 & 0xffc0) === 0xfe80 || // link-local
        (g0 & 0xffc0) === 0xfec0 || // site-local, deprecated
        (g0 & 0xff00) === 0xff00 // multicast
    );
}

/** Rejects with the signal's reason once it aborts; `dns.lookup` itself cannot be cancelled. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(signal.reason);
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/** Refuses a URL whose host is, or resolves to, an address the web tools must not reach. */
export async function checkDestination(url: URL, signal: AbortSignal): Promise<void> {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) !== 0) {
        if (isPrivateAddress(host)) {
            throw new WebError(
                `${host} is a local or private network address; the web tools only reach public addresses.`,
            );
        }
        return;
    }
    let addresses: Array<{ address: string }>;
    try {
        addresses = await abortable(lookup(host, { all: true, verbatim: true }), signal);
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }
        const code = (error as NodeJS.ErrnoException).code;
        throw new WebError(`Cannot resolve ${host}${code ? ` (${code})` : ''}.`);
    }
    const local = addresses.find((entry) => isPrivateAddress(entry.address));
    if (local) {
        throw new WebError(
            `${host} resolves to ${local.address}, a local or private network address; the web tools only reach public addresses.`,
        );
    }
    if (addresses.length === 0) {
        throw new WebError(`Cannot resolve ${host}.`);
    }
}

/** Drops a body that will not be read, without waiting for the connection to close. */
export function discard(response: Response): void {
    void response.body?.cancel().catch(() => undefined);
}

export interface WebResponse {
    /** The URL that answered, after redirects. */
    readonly url: URL;
    readonly response: Response;
}

export interface WebRequestOptions {
    readonly signal: AbortSignal;
    readonly accept: string;
}

/**
 * GETs `url`, following up to {@link WEB_MAX_REDIRECTS} redirects, each checked like the first request. The body of
 * the returned response is unread.
 */
export async function webRequest(url: URL, options: WebRequestOptions): Promise<WebResponse> {
    let current = url;
    for (let redirects = 0; ; redirects++) {
        try {
            await checkDestination(current, options.signal);
        } catch (error) {
            throw redirects > 0 && error instanceof WebError
                ? new WebError(`Redirected to ${current.href}: ${error.message}`)
                : error;
        }
        const response = await fetch(current.href, {
            redirect: 'manual',
            signal: options.signal,
            headers: { 'user-agent': WEB_USER_AGENT, accept: options.accept, 'accept-language': 'en-US,en;q=0.9' },
        });
        const location = response.headers.get('location');
        if (!REDIRECTS.has(response.status) || location === null) {
            return { url: current, response };
        }
        discard(response);
        if (redirects >= WEB_MAX_REDIRECTS) {
            throw new WebError(
                `Too many redirects (more than ${WEB_MAX_REDIRECTS}); the last one pointed to ${location}.`,
            );
        }
        let next: URL;
        try {
            next = new URL(location, current);
        } catch {
            throw new WebError(`Redirected to an invalid URL: ${location}`);
        }
        try {
            current = parseWebUrl(next.href);
        } catch (error) {
            throw new WebError(`Redirected to ${next.href}: ${(error as Error).message}`);
        }
    }
}

/** Reads a body up to `maxBytes`; `cut` says there was more. */
export async function readBody(
    response: Response,
    maxBytes = WEB_MAX_BYTES,
): Promise<{ readonly bytes: Uint8Array; readonly cut: boolean }> {
    if (response.body === null) {
        return { bytes: new Uint8Array(0), cut: false };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            return { bytes: Buffer.concat(chunks, size), cut: false };
        }
        if (size + value.byteLength > maxBytes) {
            chunks.push(value.subarray(0, maxBytes - size));
            // Not awaited: the connection closes on its own time, the text read so far is all we need.
            void reader.cancel().catch(() => undefined);
            return { bytes: Buffer.concat(chunks, maxBytes), cut: true };
        }
        chunks.push(value);
        size += value.byteLength;
    }
}

/** A short reason a web request failed, for the model. */
export function describeWebError(error: unknown, signal: AbortSignal, timeoutMs = WEB_TIMEOUT_MS): string {
    if (signal.aborted) {
        return 'Aborted.';
    }
    if (error instanceof WebError) {
        return error.message;
    }
    if ((error as Error | undefined)?.name === 'TimeoutError') {
        return `The request timed out after ${Math.round(timeoutMs / 1000)}s.`;
    }
    const cause = (error as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
    const detail =
        typeof cause?.code === 'string'
            ? cause.code
            : typeof cause?.message === 'string'
              ? cause.message
              : error instanceof Error
                ? error.message
                : String(error);
    return `The request failed: ${detail}.`;
}
