import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type JSONRPCMessage, McpServer, type Transport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { McpSecretStorage, McpServerConfigInput } from '../src/index.ts';

const require = createRequire(import.meta.url);

export async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'xora-mcp-'));
    return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * A stdio MCP server built with the SDK's server classes. It runs from a temp dir, so it loads the SDK by absolute
 * path. Env switches: `CRASH_MARKER` (refuse to start while that file exists), `MY_API_KEY` (echoed to stderr).
 */
export async function writeStdioServer(dir: string): Promise<string> {
    const file = path.join(dir, 'server.cjs');
    const source = `'use strict';
const { McpServer } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/server'))});
const { serveStdio } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/server/stdio'))});
const { z } = require(${JSON.stringify(require.resolve('zod'))});
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const marker = process.env.CRASH_MARKER;
if (marker && fs.existsSync(marker)) {
    process.stderr.write('refusing to start: crash marker present\\n');
    process.exit(1);
}
process.stderr.write('test server starting\\n');
if (process.env.MY_API_KEY) {
    process.stderr.write('using key ' + process.env.MY_API_KEY + '\\n');
}

function build() {
    const server = new McpServer({ name: 'stdio-test', version: '1.2.3' });
    server.registerTool('echo', { description: 'Echoes text', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } },
        async ({ text }) => ({ content: [{ type: 'text', text }] }));
    server.registerTool('big', { description: 'Returns bytes of A then B', inputSchema: z.object({ bytes: z.number() }) },
        async ({ bytes }) => ({ content: [{ type: 'text', text: 'A'.repeat(bytes / 2) + 'B'.repeat(bytes / 2) }] }));
    server.registerTool('sleep', { description: 'Waits', inputSchema: z.object({ ms: z.number() }) },
        async ({ ms }) => { await new Promise((r) => setTimeout(r, ms)); return { content: [{ type: 'text', text: 'slept' }] }; });
    server.registerTool('fail', { description: 'Reports a failure' },
        async () => ({ content: [{ type: 'text', text: 'it broke' }], isError: true }));
    server.registerTool('crash', { description: 'Exits the process' }, async () => {
        if (marker) fs.writeFileSync(marker, 'x');
        setTimeout(() => process.exit(3), 10);
        return { content: [{ type: 'text', text: 'bye' }] };
    });
    server.registerTool('die', { description: 'Exits without answering' }, async () => process.exit(4));
    server.registerTool('env', { description: 'Reads an env var', inputSchema: z.object({ name: z.string() }) },
        async ({ name }) => ({ content: [{ type: 'text', text: process.env[name] === undefined ? '<unset>' : process.env[name] }] }));
    server.registerTool('grow', { description: 'Adds a tool' }, async () => {
        server.registerTool('grown', { description: 'Added later' }, async () => ({ content: [{ type: 'text', text: 'new' }] }));
        return { content: [{ type: 'text', text: 'grew' }] };
    });
    server.registerTool('grandchild', { description: 'Starts a long-running child process' }, async () => {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        return { content: [{ type: 'text', text: String(child.pid) }] };
    });
    server.registerResource('readme', 'file:///readme.md', { mimeType: 'text/markdown', description: 'Read me' },
        async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# hello' }] }));
    server.registerPrompt('greet', { description: 'Greets', argsSchema: z.object({ name: z.string() }) },
        ({ name }) => ({ messages: [{ role: 'user', content: { type: 'text', text: 'Hello ' + name } }] }));
    return server;
}

serveStdio(build);
`;
    await writeFile(file, source);
    return file;
}

export function stdioConfig(script: string, fields: Partial<McpServerConfigInput> = {}): McpServerConfigInput {
    return {
        name: 'local',
        transport: 'stdio',
        command: process.execPath,
        args: [script],
        enabled: true,
        origin: 'global',
        trusted: true,
        ...fields,
    } as McpServerConfigInput;
}

/** The same tools as the stdio server, for servers in this process. */
export function buildTestServer(name = 'http-test'): McpServer {
    const server = new McpServer({ name, version: '2.0.0' });
    server.registerTool(
        'echo',
        {
            description: 'Echoes text',
            inputSchema: z.object({ text: z.string() }),
            annotations: { readOnlyHint: true },
        },
        async ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    server.registerTool(
        'big',
        { description: 'Returns bytes of A then B', inputSchema: z.object({ bytes: z.number() }) },
        async ({ bytes }) => ({ content: [{ type: 'text', text: 'A'.repeat(bytes / 2) + 'B'.repeat(bytes / 2) }] }),
    );
    server.registerTool(
        'sleep',
        { description: 'Waits', inputSchema: z.object({ ms: z.number() }) },
        async ({ ms }) => {
            await new Promise((resolve) => setTimeout(resolve, ms));
            return { content: [{ type: 'text', text: 'slept' }] };
        },
    );
    return server;
}

export interface TestHttpServer {
    readonly base: string;
    readonly server: Server;
    close(): Promise<void>;
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestHttpServer> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        base: `http://127.0.0.1:${port}`,
        server,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            }),
    };
}

/** Streamable HTTP at `/mcp`; `legacy: 'reject'` makes it speak only the 2026-07-28 revision. */
export async function startHttpServer(options: { legacy?: 'stateless' | 'reject' } = {}): Promise<TestHttpServer> {
    const handler = toNodeHandler(createMcpHandler(() => buildTestServer(), { legacy: options.legacy ?? 'stateless' }));
    return listen((req, res) => {
        if (new URL(req.url ?? '/', 'http://x').pathname === '/mcp') {
            void handler(req, res);
        } else {
            res.writeHead(404).end();
        }
    });
}

/** Server side of the legacy HTTP+SSE transport, which the v2 server package no longer ships. */
class LegacySseServerTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    readonly sessionId = randomUUID();
    readonly #res: ServerResponse;

    constructor(res: ServerResponse) {
        this.#res = res;
    }

    async start(): Promise<void> {
        this.#res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        this.#res.write(`event: endpoint\ndata: /messages?sessionId=${this.sessionId}\n\n`);
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.#res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    }

    async close(): Promise<void> {
        this.#res.end();
        this.onclose?.();
    }

    receive(message: JSONRPCMessage): void {
        this.onmessage?.(message);
    }
}

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** Legacy SSE at `/sse`; checks `x-test-header` when `requiredHeader` is set. */
export async function startSseServer(requiredHeader?: string): Promise<TestHttpServer> {
    const sessions = new Map<string, LegacySseServerTransport>();
    return listen((req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (requiredHeader !== undefined && req.headers['x-test-header'] !== requiredHeader) {
            res.writeHead(403).end();
            return;
        }
        if (req.method === 'GET' && url.pathname === '/sse') {
            const transport = new LegacySseServerTransport(res);
            sessions.set(transport.sessionId, transport);
            void buildTestServer('sse-test').connect(transport);
            return;
        }
        if (req.method === 'POST' && url.pathname === '/messages') {
            const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
            void readBody(req).then((body) => {
                if (!transport) {
                    res.writeHead(404).end();
                    return;
                }
                res.writeHead(202).end('Accepted');
                transport.receive(JSON.parse(body) as JSONRPCMessage);
            });
            return;
        }
        res.writeHead(404).end();
    });
}

export function memoryStorage(): McpSecretStorage & { readonly data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
        data,
        get: (key) => data.get(key),
        set: (key, value) => {
            data.set(key, value);
        },
        delete: (key) => {
            data.delete(key);
        },
    };
}

export interface OAuthTestServer extends TestHttpServer {
    readonly mcpUrl: string;
    /** Grant types the token endpoint served, in order. */
    readonly grants: string[];
    readonly issuedAccessTokens: string[];
    readonly issuedRefreshTokens: string[];
    readonly lastVerifier: { value?: string; code?: string };
    expiresIn: number;
    /** `echo`: the token endpoint fails and quotes the request, as a careless server might. */
    tokenMode: 'normal' | 'echo';
    revokeRefreshTokens(): void;
}

function base64url(buffer: Buffer): string {
    return buffer.toString('base64url');
}

/**
 * A protected MCP endpoint (`/mcp`) plus a minimal OAuth 2.1 authorization server: RFC 9728 and RFC 8414 metadata,
 * dynamic client registration, an authorize endpoint that redirects straight back with a code, and a token endpoint
 * that checks PKCE (S256), the redirect URI and the client, and rotates refresh tokens.
 */
export async function startOAuthServer(): Promise<OAuthTestServer> {
    const clients = new Map<string, { redirectUris: string[] }>();
    const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
    const accessTokens = new Set<string>();
    const refreshTokens = new Map<string, string>();
    const mcp = toNodeHandler(createMcpHandler(() => buildTestServer('oauth-test')));
    let base = '';

    const json = (res: ServerResponse, status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
    };

    const issue = (clientId: string): Record<string, unknown> => {
        const access = `at-${base64url(randomBytes(24))}`;
        const refresh = `rt-${base64url(randomBytes(24))}`;
        accessTokens.add(access);
        refreshTokens.set(refresh, clientId);
        state.issuedAccessTokens.push(access);
        state.issuedRefreshTokens.push(refresh);
        return {
            access_token: access,
            token_type: 'Bearer',
            expires_in: state.expiresIn,
            refresh_token: refresh,
            scope: 'mcp',
        };
    };

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const url = new URL(req.url ?? '/', base);
        if (url.pathname === '/mcp') {
            const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
            if (!token || !accessTokens.has(token)) {
                res.writeHead(401, {
                    'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
                });
                res.end();
                return;
            }
            await mcp(req, res);
            return;
        }
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
            json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['mcp'] });
            return;
        }
        if (url.pathname === '/.well-known/oauth-authorization-server') {
            json(res, 200, {
                issuer: base,
                authorization_endpoint: `${base}/authorize`,
                token_endpoint: `${base}/token`,
                registration_endpoint: `${base}/register`,
                response_types_supported: ['code'],
                grant_types_supported: ['authorization_code', 'refresh_token'],
                code_challenge_methods_supported: ['S256'],
                token_endpoint_auth_methods_supported: ['none'],
                authorization_response_iss_parameter_supported: true,
            });
            return;
        }
        if (url.pathname === '/register' && req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as { redirect_uris: string[] };
            const clientId = `client-${clients.size + 1}`;
            clients.set(clientId, { redirectUris: body.redirect_uris });
            json(res, 201, { ...body, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
            return;
        }
        if (url.pathname === '/authorize') {
            const params = url.searchParams;
            const client = clients.get(params.get('client_id') ?? '');
            const redirectUri = params.get('redirect_uri') ?? '';
            if (!client?.redirectUris.includes(redirectUri) || params.get('code_challenge_method') !== 'S256') {
                json(res, 400, { error: 'invalid_request' });
                return;
            }
            const code = base64url(randomBytes(16));
            codes.set(code, {
                clientId: params.get('client_id') ?? '',
                redirectUri,
                challenge: params.get('code_challenge') ?? '',
            });
            const target = new URL(redirectUri);
            target.searchParams.set('code', code);
            target.searchParams.set('state', params.get('state') ?? '');
            target.searchParams.set('iss', base);
            res.writeHead(302, { location: target.href }).end();
            return;
        }
        if (url.pathname === '/token' && req.method === 'POST') {
            const raw = await readBody(req);
            const form = new URLSearchParams(raw);
            if (state.tokenMode === 'echo') {
                res.writeHead(500, { 'content-type': 'text/plain' }).end(`cannot handle ${raw}`);
                return;
            }
            const clientId = form.get('client_id') ?? '';
            if (form.get('grant_type') === 'authorization_code') {
                const code = form.get('code') ?? '';
                const verifier = form.get('code_verifier') ?? '';
                const entry = codes.get(code);
                codes.delete(code);
                const challenge = base64url(createHash('sha256').update(verifier).digest());
                if (
                    !entry ||
                    entry.clientId !== clientId ||
                    entry.redirectUri !== form.get('redirect_uri') ||
                    entry.challenge !== challenge
                ) {
                    json(res, 400, { error: 'invalid_grant', error_description: 'bad code or verifier' });
                    return;
                }
                state.lastVerifier.value = verifier;
                state.lastVerifier.code = code;
                state.grants.push('authorization_code');
                json(res, 200, issue(clientId));
                return;
            }
            if (form.get('grant_type') === 'refresh_token') {
                const refresh = form.get('refresh_token') ?? '';
                if (refreshTokens.get(refresh) !== clientId) {
                    json(res, 400, { error: 'invalid_grant', error_description: 'refresh token is not valid' });
                    return;
                }
                refreshTokens.delete(refresh);
                state.grants.push('refresh_token');
                json(res, 200, issue(clientId));
                return;
            }
            json(res, 400, { error: 'unsupported_grant_type' });
            return;
        }
        res.writeHead(404).end();
    };

    const http = await listen((req, res) => {
        handle(req, res).catch(() => {
            res.writeHead(500).end();
        });
    });
    base = http.base;
    const state: OAuthTestServer = {
        ...http,
        mcpUrl: `${http.base}/mcp`,
        grants: [],
        issuedAccessTokens: [],
        issuedRefreshTokens: [],
        lastVerifier: {},
        expiresIn: 3600,
        tokenMode: 'normal',
        revokeRefreshTokens: () => refreshTokens.clear(),
    };
    return state;
}

/** Plays the browser: follows the authorization server's redirect to the loopback callback. */
export function browser(
    tamper?: (callback: URL) => void,
    onPage?: (status: number, text: string) => void,
): (url: string) => Promise<void> {
    return async (url) => {
        const response = await fetch(url, { redirect: 'manual' });
        const location = response.headers.get('location');
        if (!location) {
            throw new Error(`no redirect from the authorization endpoint (${response.status})`);
        }
        const callback = new URL(location);
        tamper?.(callback);
        const page = await fetch(callback);
        onPage?.(page.status, await page.text());
    };
}

export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error('condition not met in time');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

export function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}
