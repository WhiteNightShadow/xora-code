import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    type AuthProvider,
    auth,
    type FetchLike,
    type OAuthClientMetadata,
    type OAuthClientProvider,
    type OAuthDiscoveryState,
    type StoredOAuthClientInformation,
    type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { errorMessage, McpError } from './errors.ts';
import { redactText } from './secrets.ts';

/**
 * OAuth 2.1 with PKCE for remote MCP servers (09 §2), on top of the SDK's `auth()` flow: discovery (RFC 9728,
 * RFC 8414), dynamic client registration, the authorization code exchange and refresh. Tokens live only in the
 * injected storage, which the host backs with the OS keychain (10 §6); no token is ever logged or put in an error.
 */

/** Secret storage, e.g. the host's keychain. Values are opaque strings. */
export interface McpSecretStorage {
    get(key: string): Promise<string | undefined> | string | undefined;
    set(key: string, value: string): Promise<void> | void;
    delete(key: string): Promise<void> | void;
}

export interface AuthorizeOptions {
    readonly storage: McpSecretStorage;
    /** Opens the authorization URL in the user's browser. */
    readonly openBrowser: (url: string) => void | Promise<void>;
    /** Shown on the consent screen; default `Xora Code`. */
    readonly clientName?: string;
    readonly signal?: AbortSignal;
    /** How long to wait for the browser to come back; default 5 minutes. */
    readonly timeoutMs?: number;
    readonly scope?: string;
    readonly fetch?: FetchLike;
    /** Ask the user again even when the stored tokens could be refreshed. */
    readonly force?: boolean;
}

export interface TokenOptions {
    readonly fetch?: FetchLike;
    readonly signal?: AbortSignal;
}

/** What the host may show about an authorization; never the tokens themselves. */
export interface AuthorizationInfo {
    readonly authorized: boolean;
    /** Epoch ms; absent when the server did not say. */
    readonly expiresAt?: number;
    readonly scope?: string;
    readonly issuer?: string;
    /** A refresh token is stored. */
    readonly refreshable: boolean;
}

export const AUTHORIZE_TIMEOUT_MS = 5 * 60 * 1000;
/** Tokens this close to expiry are refreshed before use. */
const REFRESH_MARGIN_MS = 60_000;
const CALLBACK_PATH = '/callback';
const DEFAULT_CLIENT_NAME = 'Xora Code';

interface OAuthRecord {
    v: 1;
    client?: StoredOAuthClientInformation;
    tokens?: StoredOAuthTokens;
    expiresAt?: number;
    discovery?: OAuthDiscoveryState;
}

/** One storage entry per server, keyed without query or fragment so URL parameters never become a key. */
export function oauthStorageKey(serverUrl: string): string {
    const url = new URL(serverUrl);
    return `mcp-oauth:${url.origin}${url.pathname}`;
}

async function loadRecord(storage: McpSecretStorage, key: string): Promise<OAuthRecord> {
    const raw = await storage.get(key);
    if (raw === undefined || raw === '') {
        return { v: 1 };
    }
    try {
        const parsed = JSON.parse(raw) as Partial<OAuthRecord>;
        return parsed?.v === 1 ? (parsed as OAuthRecord) : { v: 1 };
    } catch {
        return { v: 1 };
    }
}

const locks = new WeakMap<McpSecretStorage, Map<string, Promise<unknown>>>();

/** Serializes flows per server so that two refreshes never spend the same rotating refresh token. */
async function withLock<T>(storage: McpSecretStorage, key: string, task: () => Promise<T>): Promise<T> {
    let map = locks.get(storage);
    if (!map) {
        map = new Map();
        locks.set(storage, map);
    }
    const previous = map.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const settled = run.catch(() => undefined);
    map.set(key, settled);
    try {
        return await run;
    } finally {
        if (map.get(key) === settled) {
            map.delete(key);
        }
    }
}

function registeredRedirect(record: OAuthRecord): string | undefined {
    const uris = (record.client as { redirect_uris?: unknown } | undefined)?.redirect_uris;
    return Array.isArray(uris) && typeof uris[0] === 'string' ? uris[0] : undefined;
}

function registeredPort(record: OAuthRecord): number | undefined {
    const uri = registeredRedirect(record);
    if (!uri) {
        return undefined;
    }
    try {
        const url = new URL(uri);
        return url.hostname === '127.0.0.1' && url.port !== '' ? Number(url.port) : undefined;
    } catch {
        return undefined;
    }
}

function infoOf(record: OAuthRecord): AuthorizationInfo {
    const tokens = record.tokens;
    return {
        authorized: tokens !== undefined,
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
        ...(tokens?.scope === undefined ? {} : { scope: tokens.scope }),
        ...(tokens?.issuer === undefined ? {} : { issuer: tokens.issuer }),
        refreshable: tokens?.refresh_token !== undefined,
    };
}

interface ProviderOptions {
    readonly key: string;
    readonly storage: McpSecretStorage;
    readonly record: OAuthRecord;
    readonly redirectUrl: string;
    readonly clientName: string;
    /** Every credential the flow sees goes in here, so errors can be scrubbed of them. */
    readonly secrets: Set<string>;
    readonly state?: string;
    /** Absent for refreshes: then a needed redirect means the user has to authorize again. */
    readonly onRedirect?: (url: URL) => Promise<void>;
}

/** The SDK's `OAuthClientProvider`, persisting one {@link OAuthRecord} per server. */
class StoredProvider implements OAuthClientProvider {
    readonly #options: ProviderOptions;
    #verifier: string | undefined;

    constructor(options: ProviderOptions) {
        this.#options = options;
        this.#remember(options.record);
    }

    get record(): OAuthRecord {
        return this.#options.record;
    }

    get redirectUrl(): string {
        return this.#options.redirectUrl;
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            client_name: this.#options.clientName,
            redirect_uris: [this.#options.redirectUrl],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            software_id: 'xora-code',
        };
    }

    state(): string {
        return this.#options.state ?? randomBytes(32).toString('base64url');
    }

    clientInformation(): StoredOAuthClientInformation | undefined {
        return this.record.client;
    }

    async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
        this.record.client = info;
        await this.#persist();
    }

    tokens(): StoredOAuthTokens | undefined {
        return this.record.tokens;
    }

    async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
        this.record.tokens = tokens;
        if (typeof tokens.expires_in === 'number' && tokens.expires_in > 0) {
            this.record.expiresAt = Date.now() + tokens.expires_in * 1000;
        } else {
            delete this.record.expiresAt;
        }
        await this.#persist();
    }

    async redirectToAuthorization(url: URL): Promise<void> {
        if (!this.#options.onRedirect) {
            throw new McpError('unauthorized', 'the server requires authorization');
        }
        await this.#options.onRedirect(url);
    }

    saveCodeVerifier(verifier: string): void {
        this.#verifier = verifier;
        this.#options.secrets.add(verifier);
    }

    codeVerifier(): string {
        if (this.#verifier === undefined) {
            throw new McpError('oauth', 'no PKCE code verifier for this flow');
        }
        return this.#verifier;
    }

    async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
        if (scope === 'all' || scope === 'client') {
            delete this.record.client;
        }
        if (scope === 'all' || scope === 'tokens') {
            delete this.record.tokens;
            delete this.record.expiresAt;
        }
        if (scope === 'all' || scope === 'discovery') {
            delete this.record.discovery;
        }
        if (scope === 'all' || scope === 'verifier') {
            this.#verifier = undefined;
        }
        await this.#persist();
    }

    async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
        this.record.discovery = state;
        await this.#persist();
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        return this.record.discovery;
    }

    #remember(record: OAuthRecord): void {
        for (const value of [
            record.tokens?.access_token,
            record.tokens?.refresh_token,
            record.tokens?.id_token,
            record.client?.client_secret,
        ]) {
            if (value) {
                this.#options.secrets.add(value);
            }
        }
    }

    async #persist(): Promise<void> {
        this.#remember(this.record);
        await this.#options.storage.set(this.#options.key, JSON.stringify(this.record));
    }
}

/**
 * The fetch used for every OAuth request: honours `signal`, and scrubs known credentials from error bodies before
 * the SDK can quote them in an error or a console warning (a token endpoint may echo the request).
 */
function guardedFetch(base: FetchLike, secrets: ReadonlySet<string>, signal?: AbortSignal): FetchLike {
    return async (input, init) => {
        const signals = [init?.signal, signal].filter((item): item is AbortSignal => item instanceof AbortSignal);
        const merged = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        const response = await base(input, { ...init, ...(merged ? { signal: merged } : {}) });
        if (response.status < 400) {
            return response;
        }
        const body = redactText(await response.text(), secrets);
        const headers = new Headers(response.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');
        return new Response(body, { status: response.status, statusText: response.statusText, headers });
    };
}

function scrubbed(error: unknown, secrets: ReadonlySet<string>): McpError {
    if (error instanceof McpError) {
        return new McpError(error.code, redactText(error.message, secrets), error.rpcCode);
    }
    const code = (error as { code?: unknown }).code;
    const prefix = typeof code === 'string' && /^[a-z_]+$/.test(code) ? `${code}: ` : '';
    return new McpError('oauth', redactText(`${prefix}${errorMessage(error)}`, secrets));
}

function constantTimeEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

interface Callback {
    readonly code: string;
    readonly iss?: string;
}

interface Loopback {
    readonly redirectUrl: string;
    readonly result: Promise<Callback>;
    close(): Promise<void>;
}

const PAGE_STYLE = 'font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.6';

function sendPage(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        connection: 'close',
    });
    res.end(`<!doctype html><meta charset="utf-8"><title>Xora Code</title><p style="${PAGE_STYLE}">${message}</p>`);
}

function listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
    });
}

/**
 * The redirect target (RFC 8252 loopback): `http://127.0.0.1:<port>/callback`, on the port of an earlier
 * registration when it is free and a random one otherwise. The first callback with the right `state` settles
 * `result`; one with a wrong `state` fails the flow.
 */
async function startLoopback(options: {
    readonly state: string;
    readonly preferredPort: number | undefined;
    readonly timeoutMs: number;
    readonly signal: AbortSignal | undefined;
}): Promise<Loopback> {
    let resolveResult: (callback: Callback) => void = () => undefined;
    let rejectResult: (error: Error) => void = () => undefined;
    const result = new Promise<Callback>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
    });
    // The caller may not be awaiting yet when the timer or a bad callback rejects.
    result.catch(() => undefined);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    function finish(error: Error | undefined, callback?: Callback): void {
        if (settled) {
            return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (error || !callback) {
            rejectResult(error ?? new McpError('oauth', 'authorization failed'));
        } else {
            resolveResult(callback);
        }
    }
    function onAbort(): void {
        finish(new McpError('aborted', 'authorization was cancelled'));
    }

    const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
            res.writeHead(404, { 'content-type': 'text/plain', connection: 'close' }).end('not found');
            return;
        }
        if (settled) {
            sendPage(res, 409, '这次授权已经结束，可以关闭此页面。This authorization has already finished.');
            return;
        }
        const params = url.searchParams;
        const state = params.get('state');
        if (state === null || !constantTimeEqual(state, options.state)) {
            sendPage(res, 400, '授权失败：响应与本次请求不匹配。Authorization failed: the response does not match.');
            finish(new McpError('oauth', 'the authorization response did not match this request (state mismatch)'));
            return;
        }
        const denied = params.get('error');
        if (denied !== null) {
            const description = params.get('error_description');
            sendPage(res, 400, '授权没有完成，可以关闭此页面。Authorization was not completed.');
            finish(
                new McpError(
                    'oauth',
                    redactText(`authorization failed: ${denied}${description ? ` (${description})` : ''}`),
                ),
            );
            return;
        }
        const code = params.get('code');
        if (!code) {
            sendPage(res, 400, '授权失败：缺少授权码。Authorization failed: no code.');
            finish(new McpError('oauth', 'the authorization response has no code'));
            return;
        }
        const iss = params.get('iss');
        sendPage(res, 200, '授权完成，可以关闭此页面并回到xora code。Authorization complete; you can close this page.');
        finish(undefined, { code, ...(iss === null ? {} : { iss }) });
    });

    try {
        await listen(server, options.preferredPort ?? 0);
    } catch (error) {
        if (options.preferredPort === undefined || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
            throw error;
        }
        await listen(server, 0);
    }
    const { port } = server.address() as AddressInfo;
    timer = setTimeout(() => {
        const minutes = Math.round(options.timeoutMs / 60_000);
        const span = minutes >= 1 ? `${minutes} minutes` : `${options.timeoutMs} ms`;
        finish(new McpError('timeout', `no authorization response within ${span}`));
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
        onAbort();
    }
    return {
        redirectUrl: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        result,
        close: () =>
            new Promise<void>((resolve) => {
                finish(new McpError('aborted', 'authorization was closed'));
                // Let the browser receive the page it is being sent, then drop whatever is left.
                server.close(() => resolve());
                server.closeIdleConnections();
                setTimeout(() => server.closeAllConnections(), 1000).unref();
            }),
    };
}

/**
 * Signs in to a remote MCP server: discovers its authorization server, registers Xora Code as a client if needed,
 * opens the browser and waits on a loopback redirect for the code (state checked, 5 minute timeout), then exchanges
 * it with the PKCE verifier and stores the tokens. Stored tokens that can be refreshed are refreshed instead,
 * unless `force` is set.
 */
export async function authorize(serverUrl: string, options: AuthorizeOptions): Promise<AuthorizationInfo> {
    const { storage } = options;
    const key = oauthStorageKey(serverUrl);
    const secrets = new Set<string>();
    const state = randomBytes(32).toString('base64url');
    const loopback = await startLoopback({
        state,
        preferredPort: registeredPort(await loadRecord(storage, key)),
        timeoutMs: options.timeoutMs ?? AUTHORIZE_TIMEOUT_MS,
        signal: options.signal,
    });
    const fetchFn = guardedFetch(options.fetch ?? fetch, secrets, options.signal);
    try {
        // The lock is held while talking to the authorization server, not while the user is in the browser, so
        // token lookups for this server keep working meanwhile.
        const { provider, first } = await withLock(storage, key, async () => {
            const record = await loadRecord(storage, key);
            const registered = registeredRedirect(record);
            if (record.client && registered && registered !== loopback.redirectUrl) {
                // Registered for another port; register again rather than rely on the server ignoring the port.
                delete record.client;
            }
            const provider = new StoredProvider({
                key,
                storage,
                record,
                redirectUrl: loopback.redirectUrl,
                clientName: options.clientName ?? DEFAULT_CLIENT_NAME,
                secrets,
                state,
                onRedirect: async (url) => {
                    await options.openBrowser(url.href);
                },
            });
            const first = await auth(provider, {
                serverUrl,
                fetchFn,
                ...(options.scope === undefined ? {} : { scope: options.scope }),
                ...(options.force ? { forceReauthorization: true } : {}),
            });
            return { provider, first };
        });
        if (first === 'REDIRECT') {
            const callback = await loopback.result;
            secrets.add(callback.code);
            const second = await withLock(storage, key, () =>
                auth(provider, {
                    serverUrl,
                    fetchFn,
                    authorizationCode: callback.code,
                    ...(callback.iss === undefined ? {} : { iss: callback.iss }),
                }),
            );
            if (second !== 'AUTHORIZED') {
                throw new McpError('oauth', 'the authorization server did not issue tokens');
            }
        }
        return infoOf(provider.record);
    } catch (error) {
        throw scrubbed(error, secrets);
    } finally {
        await loopback.close();
    }
}

/** The stored access token, refreshed first when it is about to expire (or always, with `force`). */
async function accessToken(
    serverUrl: string,
    storage: McpSecretStorage,
    options: TokenOptions,
    force: boolean,
): Promise<string | undefined> {
    const key = oauthStorageKey(serverUrl);
    return withLock(storage, key, async () => {
        const record = await loadRecord(storage, key);
        const tokens = record.tokens;
        if (!tokens) {
            return undefined;
        }
        const now = Date.now();
        // Short-lived tokens get half their lifetime as margin, or they would be refreshed on every use.
        const lifetimeMs = typeof tokens.expires_in === 'number' ? tokens.expires_in * 1000 : Number.POSITIVE_INFINITY;
        const margin = Math.min(REFRESH_MARGIN_MS, lifetimeMs / 2);
        if (!force && (record.expiresAt === undefined || record.expiresAt - now > margin)) {
            return tokens.access_token;
        }
        if (!tokens.refresh_token) {
            return !force && record.expiresAt !== undefined && record.expiresAt > now ? tokens.access_token : undefined;
        }
        const secrets = new Set<string>();
        const provider = new StoredProvider({
            key,
            storage,
            record,
            // Only used to fill the client metadata; a refresh never redirects.
            redirectUrl: registeredRedirect(record) ?? `http://127.0.0.1${CALLBACK_PATH}`,
            clientName: DEFAULT_CLIENT_NAME,
            secrets,
        });
        try {
            const result = await auth(provider, {
                serverUrl,
                fetchFn: guardedFetch(options.fetch ?? fetch, secrets, options.signal),
            });
            return result === 'AUTHORIZED' ? provider.record.tokens?.access_token : undefined;
        } catch (error) {
            if (error instanceof McpError && error.code === 'unauthorized') {
                // Refreshing failed and only a new authorization would help; the caller sees "not authorized".
                return undefined;
            }
            throw scrubbed(error, secrets);
        }
    });
}

/**
 * `Authorization: Bearer …` for a server, refreshing the token when it is about to expire; `{}` when there is no
 * usable token, in which case the server will answer 401 and the host should offer {@link authorize}.
 */
export async function authHeaders(
    serverUrl: string,
    storage: McpSecretStorage,
    options: TokenOptions = {},
): Promise<Record<string, string>> {
    const token = await accessToken(serverUrl, storage, options, false);
    return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * An SDK `AuthProvider` for {@link McpConnection}: the stored token before every request, and one forced refresh
 * when the server still answers 401.
 */
export function oauthAuthProvider(
    serverUrl: string,
    storage: McpSecretStorage,
    options: TokenOptions = {},
): AuthProvider {
    return {
        token: () => accessToken(serverUrl, storage, options, false),
        onUnauthorized: async () => {
            const token = await accessToken(serverUrl, storage, options, true);
            if (!token) {
                throw new McpError('unauthorized', 'the server requires authorization');
            }
        },
    };
}

export async function getAuthorization(serverUrl: string, storage: McpSecretStorage): Promise<AuthorizationInfo> {
    return infoOf(await loadRecord(storage, oauthStorageKey(serverUrl)));
}

/** Signs out: forgets the tokens, the client registration and the discovery results. */
export async function clearAuthorization(serverUrl: string, storage: McpSecretStorage): Promise<void> {
    const key = oauthStorageKey(serverUrl);
    await withLock(storage, key, async () => {
        await storage.delete(key);
    });
}
