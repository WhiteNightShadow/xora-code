import { describe, expect, it } from 'vitest';
import {
    fromAcpMcpServer,
    type McpServerConfig,
    parseServerConfig,
    toAcpMcpServer,
    toAcpMcpServers,
} from '../src/index.ts';

function config(raw: unknown): McpServerConfig {
    const checked = parseServerConfig(raw);
    if (!checked.ok) {
        throw new Error(checked.reason);
    }
    return checked.config;
}

const stdio = config({
    name: 'files',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/work'],
    env: { LOG_LEVEL: 'debug', API_KEY: 'k' },
    cwd: '/work',
    enabled: true,
    origin: 'project',
    trusted: true,
    toolFilter: { allow: ['read_*'], deny: ['read_secret'] },
    timeoutMs: 30_000,
    maxOutputBytes: 50_000,
});

const http = config({
    name: 'web',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer t' },
    enabled: true,
    origin: 'global',
    trusted: true,
});

const sse = config({
    name: 'old',
    transport: 'sse',
    url: 'https://old.example.com/sse',
    enabled: true,
    origin: 'plugin',
    trusted: true,
});

describe('ACP conversion', () => {
    it('produces the session/new shapes', () => {
        expect(toAcpMcpServer(stdio)).toEqual({
            name: 'files',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/work'],
            env: [
                { name: 'LOG_LEVEL', value: 'debug' },
                { name: 'API_KEY', value: 'k' },
            ],
            _meta: {
                xora: {
                    origin: 'project',
                    cwd: '/work',
                    toolFilter: { allow: ['read_*'], deny: ['read_secret'] },
                    timeoutMs: 30_000,
                    maxOutputBytes: 50_000,
                },
            },
        });
        expect(toAcpMcpServer(http)).toEqual({
            type: 'http',
            name: 'web',
            url: 'https://mcp.example.com/mcp',
            headers: [{ name: 'Authorization', value: 'Bearer t' }],
            _meta: { xora: { origin: 'global' } },
        });
        expect(toAcpMcpServer(sse)).toMatchObject({ type: 'sse', name: 'old', headers: [] });
    });

    it('round-trips every transport', () => {
        for (const original of [stdio, http, sse]) {
            expect(fromAcpMcpServer(JSON.parse(JSON.stringify(toAcpMcpServer(original))))).toEqual(original);
        }
    });

    it('reads servers from other ACP clients, without our _meta and with odd names', () => {
        expect(
            fromAcpMcpServer({
                type: 'stdio',
                name: 'My Server!',
                command: 'node',
                args: ['s.js'],
                env: [
                    { name: 'A', value: '1' },
                    { name: 'A', value: '2' },
                ],
            }),
        ).toEqual({
            name: 'My-Server',
            transport: 'stdio',
            command: 'node',
            args: ['s.js'],
            env: { A: '2' },
            enabled: true,
            origin: 'global',
            trusted: true,
        });
        expect(
            fromAcpMcpServer({ type: 'http', name: 'x', url: 'http://localhost/mcp' }, { origin: 'project' }),
        ).toEqual({
            name: 'x',
            transport: 'http',
            url: 'http://localhost/mcp',
            headers: {},
            enabled: true,
            origin: 'project',
            trusted: true,
        });
    });

    it('rejects what is not a usable server', () => {
        expect(() => fromAcpMcpServer({ name: 'x' })).toThrow(/invalid ACP MCP server/);
        expect(() => fromAcpMcpServer({ type: 'http', name: 'x', url: 'ftp://nope' })).toThrow(/http or https/);
        expect(() => fromAcpMcpServer('nope')).toThrow(expect.objectContaining({ code: 'invalid-config' }));
    });

    it('sends only approved servers over transports the agent supports', () => {
        const disabled = { ...stdio, name: 'disabled', enabled: false };
        const untrusted = { ...stdio, name: 'untrusted', trusted: false };
        expect(toAcpMcpServers([stdio, http, sse, disabled, untrusted])).toEqual({
            servers: [toAcpMcpServer(stdio)],
            skipped: [
                { name: 'web', reason: 'unsupported' },
                { name: 'old', reason: 'unsupported' },
                { name: 'disabled', reason: 'disabled' },
                { name: 'untrusted', reason: 'untrusted' },
            ],
        });
        expect(toAcpMcpServers([stdio, http, sse], { http: true }).servers.map((server) => server.name)).toEqual([
            'files',
            'web',
        ]);
    });
});
