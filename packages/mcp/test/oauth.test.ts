import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    authHeaders,
    authorize,
    clearAuthorization,
    getAuthorization,
    McpConnection,
    McpManager,
    type McpSecretStorage,
    oauthAuthProvider,
    oauthStorageKey,
} from '../src/index.ts';
import { browser, memoryStorage, type OAuthTestServer, startOAuthServer, waitFor } from './helpers.ts';

let server: OAuthTestServer;

beforeAll(async () => {
    server = await startOAuthServer();
});

afterAll(async () => {
    await server.close();
});

afterEach(() => {
    server.tokenMode = 'normal';
    server.expiresIn = 3600;
    vi.restoreAllMocks();
});

function stored(storage: ReturnType<typeof memoryStorage>): {
    tokens?: { access_token: string; refresh_token?: string };
    client?: { client_id: string; redirect_uris: string[] };
    expiresAt?: number;
} {
    return JSON.parse(storage.data.get(oauthStorageKey(server.mcpUrl)) ?? '{}');
}

/** Moves the stored expiry close to now, as if the token were about to run out. */
function expireSoon(storage: ReturnType<typeof memoryStorage>): void {
    const key = oauthStorageKey(server.mcpUrl);
    const record = JSON.parse(storage.data.get(key) ?? '{}') as Record<string, unknown>;
    storage.data.set(key, JSON.stringify({ ...record, expiresAt: Date.now() + 1000 }));
}

async function signIn(storage: McpSecretStorage): Promise<void> {
    await authorize(server.mcpUrl, { storage, openBrowser: browser() });
}

describe('OAuth for remote servers', { timeout: 30_000 }, () => {
    it('authorizes with PKCE through the loopback redirect and stores the tokens', async () => {
        const storage = memoryStorage();
        const opened: string[] = [];
        const pages: string[] = [];
        const info = await authorize(server.mcpUrl, {
            storage,
            openBrowser: async (url) => {
                opened.push(url);
                await browser(undefined, (status, text) => pages.push(`${status} ${text}`))(url);
            },
        });
        expect(pages).toHaveLength(1);
        expect(pages[0]).toMatch(/^200 .*授权完成/);
        expect(info).toMatchObject({ authorized: true, scope: 'mcp', refreshable: true, issuer: server.base });
        expect(info.expiresAt).toBeGreaterThan(Date.now());

        const authUrl = new URL(opened[0] ?? '');
        expect(authUrl.origin + authUrl.pathname).toBe(`${server.base}/authorize`);
        expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authUrl.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        expect(authUrl.searchParams.get('state')?.length).toBeGreaterThanOrEqual(32);

        const record = stored(storage);
        const accessToken = server.issuedAccessTokens.at(-1) ?? '';
        expect(record.tokens?.access_token).toBe(accessToken);
        expect(record.client?.client_id).toMatch(/^client-\d+$/);
        expect(record.client?.redirect_uris).toEqual([authUrl.searchParams.get('redirect_uri')]);
        expect(await authHeaders(server.mcpUrl, storage)).toEqual({ Authorization: `Bearer ${accessToken}` });
        expect(await getAuthorization(server.mcpUrl, storage)).toEqual(info);
    });

    it('lets the manager reach a protected server with the stored token', async () => {
        const storage = memoryStorage();
        await signIn(storage);
        const config = {
            name: 'secured',
            transport: 'http' as const,
            url: server.mcpUrl,
            enabled: true,
            origin: 'global' as const,
            trusted: true,
        };

        const anonymous = new McpConnection();
        await expect(anonymous.connect(config)).rejects.toMatchObject({ code: 'unauthorized' });

        const manager = new McpManager({
            authProvider: (server) =>
                server.transport === 'stdio' ? undefined : oauthAuthProvider(server.url, storage),
        });
        try {
            await manager.start([config]);
            expect(manager.status('secured')?.status).toBe('running');
            const result = await manager.callTool('mcp__secured__echo', { text: 'authorized' });
            expect(result.content).toEqual([{ type: 'text', text: 'authorized' }]);
        } finally {
            await manager.stopAll();
        }
    });

    it('refreshes a token that is about to expire, once for concurrent callers', async () => {
        const storage = memoryStorage();
        await signIn(storage);
        const first = server.issuedAccessTokens.at(-1);
        const grants = server.grants.length;
        expireSoon(storage);

        const [a, b] = await Promise.all([authHeaders(server.mcpUrl, storage), authHeaders(server.mcpUrl, storage)]);
        expect(server.grants.slice(grants)).toEqual(['refresh_token']);
        const second = server.issuedAccessTokens.at(-1);
        expect(second).not.toBe(first);
        expect(a).toEqual({ Authorization: `Bearer ${second}` });
        expect(b).toEqual(a);
        expect(stored(storage).tokens?.access_token).toBe(second);
        expect(stored(storage).expiresAt).toBeGreaterThan(Date.now() + 60_000);
    });

    it('forgets tokens the server no longer accepts and asks for a new authorization', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const storage = memoryStorage();
        await signIn(storage);
        const refreshToken = stored(storage).tokens?.refresh_token ?? '';
        server.revokeRefreshTokens();
        expireSoon(storage);

        expect(await authHeaders(server.mcpUrl, storage)).toEqual({});
        expect(await getAuthorization(server.mcpUrl, storage)).toMatchObject({ authorized: false });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(refreshToken);
    });

    it('keeps tokens out of errors and warnings when the token endpoint echoes the request', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const storage = memoryStorage();
        await signIn(storage);
        const { access_token: accessToken, refresh_token: refreshToken } = stored(storage).tokens ?? {
            access_token: '',
        };
        server.tokenMode = 'echo';
        expireSoon(storage);
        expect(await authHeaders(server.mcpUrl, storage)).toEqual({});
        const warnings = JSON.stringify(warn.mock.calls);
        expect(warnings).toContain('[redacted]');
        expect(warnings).not.toContain(refreshToken ?? 'missing');
        expect(warnings).not.toContain(accessToken);

        const fresh = memoryStorage();
        let callbackCode = '';
        const error = await authorize(server.mcpUrl, {
            storage: fresh,
            openBrowser: browser((callback) => {
                callbackCode = callback.searchParams.get('code') ?? '';
            }),
        }).catch((caught: unknown) => caught as Error);
        expect(error).toMatchObject({ name: 'McpError', code: 'oauth' });
        expect(callbackCode).not.toBe('');
        expect((error as Error).message).not.toContain(callbackCode);
        expect((error as Error).message).toContain('[redacted]');
    });

    it('keeps answering token lookups while the user is in the browser', async () => {
        const storage = memoryStorage();
        await signIn(storage);
        let resume: (() => Promise<void>) | undefined;
        const pending = authorize(server.mcpUrl, {
            storage,
            force: true,
            openBrowser: (url) => {
                resume = () => browser()(url);
            },
        });
        await waitFor(() => resume !== undefined);
        expect(await authHeaders(server.mcpUrl, storage)).toEqual({
            Authorization: `Bearer ${stored(storage).tokens?.access_token}`,
        });
        await resume?.();
        await expect(pending).resolves.toMatchObject({ authorized: true });
        expect(stored(storage).tokens?.access_token).toBe(server.issuedAccessTokens.at(-1));
    });

    it('rejects a callback whose state does not match', async () => {
        const storage = memoryStorage();
        const pages: number[] = [];
        await expect(
            authorize(server.mcpUrl, {
                storage,
                openBrowser: browser(
                    (callback) => callback.searchParams.set('state', 'forged'),
                    (status) => pages.push(status),
                ),
            }),
        ).rejects.toMatchObject({ code: 'oauth', message: expect.stringContaining('state mismatch') });
        expect(pages).toEqual([400]);
        expect(await getAuthorization(server.mcpUrl, storage)).toMatchObject({ authorized: false });
    });

    it('gives up when the browser never comes back, or when cancelled', async () => {
        const storage = memoryStorage();
        await expect(
            authorize(server.mcpUrl, { storage, openBrowser: () => undefined, timeoutMs: 200 }),
        ).rejects.toMatchObject({ code: 'timeout' });

        const controller = new AbortController();
        const pending = authorize(server.mcpUrl, {
            storage,
            openBrowser: () => controller.abort(),
            signal: controller.signal,
        });
        await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    });

    it('reuses the client registration, refreshes instead of asking again, and signs out', async () => {
        const storage = memoryStorage();
        await signIn(storage);
        const client = stored(storage).client;
        const grants = server.grants.length;

        await authorize(server.mcpUrl, { storage, openBrowser: () => Promise.reject(new Error('not expected')) });
        expect(server.grants.slice(grants)).toEqual(['refresh_token']);

        await authorize(server.mcpUrl, { storage, openBrowser: browser(), force: true });
        expect(server.grants.slice(grants)).toEqual(['refresh_token', 'authorization_code']);
        expect(stored(storage).client).toEqual(client);

        await clearAuthorization(server.mcpUrl, storage);
        expect(storage.data.size).toBe(0);
        expect(await authHeaders(server.mcpUrl, storage)).toEqual({});
    });
});
