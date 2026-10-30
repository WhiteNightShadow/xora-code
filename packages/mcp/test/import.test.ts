import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImportedServer, type ImportResult, importServers } from '../src/index.ts';
import { makeTempDir } from './helpers.ts';

const SECRETS = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'sk-live-1234567890abcdef',
    'abc.def.ghi-signature',
    's3cr3t-value',
    'user:pass',
    'pass@docs',
    'value-123',
    'c7-0123456789abcdef0123456789',
    'hunter2hunter2',
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
];

// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal Cursor variable reference, not a template
const WORKSPACE_BIN = '${workspaceFolder}/bin';

let home: string;
let project: string;
let cleanup: () => Promise<void>;
let result: ImportResult;

async function put(file: string, content: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

function find(tool: string, name: string): ImportedServer {
    const found = result.servers.find((server) => server.source.tool === tool && server.source.name === name);
    if (!found) {
        throw new Error(`${tool}/${name} was not imported`);
    }
    return found;
}

beforeAll(async () => {
    const temp = await makeTempDir();
    cleanup = temp.cleanup;
    home = path.join(temp.dir, 'home');
    project = path.join(temp.dir, 'project');
    await mkdir(project, { recursive: true });

    await put(path.join(home, '.claude.json'), {
        numStartups: 3,
        mcpServers: {
            github: {
                type: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
                env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRETS[0], LOG_LEVEL: 'debug' },
            },
            'remote api': {
                type: 'http',
                url: `https://mcp.example.com/mcp?api_key=${SECRETS[1]}&region=eu`,
                headers: { Authorization: `Bearer ${SECRETS[2]}`, 'X-Team': 'core' },
            },
            ide: { type: 'sse-ide', url: 'http://localhost:1234' },
        },
        projects: {
            [project]: {
                mcpServers: {
                    'local-db': {
                        command: 'uvx',
                        args: ['mcp-sqlite', '--db-path', './db.sqlite', '--token', SECRETS[3]],
                    },
                },
            },
            '/some/other/project': { mcpServers: { other: { command: 'x' } } },
        },
    });
    await put(path.join(project, '.mcp.json'), {
        mcpServers: {
            docs: { type: 'sse', url: `https://${SECRETS[4]}@docs.example.com/sse` },
            broken: { type: 'stdio' },
        },
    });
    await put(path.join(home, '.cursor', 'mcp.json'), {
        mcpServers: {
            browser: { command: 'npx', args: ['@playwright/mcp@latest'] },
            legacy: { url: 'http://localhost:8080/sse' },
            api: { url: 'https://api.example.com/mcp', headers: { API_KEY: SECRETS[6] } },
        },
    });
    await put(path.join(project, '.cursor', 'mcp.json'), {
        mcpServers: {
            proj: {
                command: 'node',
                args: ['server.js', SECRETS[9]],
                env: { PATH_EXTRA: WORKSPACE_BIN },
            },
        },
    });
    await put(
        path.join(project, '.vscode', 'mcp.json'),
        `{
  // MCP servers for this workspace
  "inputs": [{ "type": "promptString", "id": "api-key", "description": "API key", "password": true }],
  "servers": {
    "fetch": { "type": "stdio", "command": "uvx", "args": ["mcp-server-fetch"], "env": { "API_KEY": "\${input:api-key}", }, },
    "remote": { "type": "http", "url": "https://remote.example.com/mcp", "headers": { "X-Custom": "ok" } }, /* trailing */
    "ws": { "type": "ws", "url": "ws://localhost:9000" },
  },
}`,
    );
    await put(
        path.join(home, '.codex', 'config.toml'),
        `model = "gpt-5"
model_reasoning_effort = "high"

[profiles.fast]
model = "o4-mini"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env = { "CONTEXT7_API_KEY" = "${SECRETS[7]}", "DEBUG" = "1" }
startup_timeout_sec = 20
tool_timeout_sec = 90
enabled_tools = ["resolve-library-id", "get-library-docs"]

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Figma-Region" = "us-east-1" }
env_http_headers = { "X-Org-Id" = "FIGMA_ORG_ID" }

[mcp_servers."with spaces"]
command = 'C:\\tools\\server.exe'
args = [
  "--flag",  # comment
  "value",
]
env_vars = ["LOCAL_TOKEN"]
disabled_tools = ["dangerous"]

[mcp_servers.with_env_table]
command = "python"
args = ["-m", "server"]

[mcp_servers.with_env_table.env]
PYTHONUNBUFFERED = "1"
SECRET_PASSWORD = "${SECRETS[8]}"

[[weird]]
x = 1
bad line here
`,
    );
    result = await importServers({ home, projectDir: project });
});

afterAll(async () => {
    await cleanup();
});

describe('importServers', () => {
    it('never copies a secret value', () => {
        const serialized = JSON.stringify(result);
        for (const secret of SECRETS) {
            expect(serialized).not.toContain(secret);
        }
    });

    it('imports everything disabled, untrusted and marked as imported', () => {
        expect(result.servers).toHaveLength(14);
        for (const server of result.servers) {
            expect(server.config).toMatchObject({ enabled: false, trusted: false, origin: 'imported' });
        }
    });

    it('reads Claude Code user, local and project servers', () => {
        expect(find('claude', 'github')).toEqual({
            config: {
                name: 'github',
                transport: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-github'],
                env: { GITHUB_PERSONAL_ACCESS_TOKEN: '', LOG_LEVEL: 'debug' },
                enabled: false,
                origin: 'imported',
                trusted: false,
            },
            source: { tool: 'claude', file: path.join(home, '.claude.json'), scope: 'user', name: 'github' },
            secretKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
        });
        expect(find('claude', 'remote api')).toMatchObject({
            config: {
                name: 'remote-api',
                transport: 'http',
                url: 'https://mcp.example.com/mcp?api_key=&region=eu',
                headers: { Authorization: '', 'X-Team': 'core' },
            },
            secretKeys: ['url:api_key', 'Authorization'],
        });
        expect(find('claude', 'local-db')).toMatchObject({
            config: { command: 'uvx', args: ['mcp-sqlite', '--db-path', './db.sqlite', '--token', ''] },
            source: { scope: 'local' },
            secretKeys: ['args[4]'],
        });
        expect(find('claude', 'docs')).toMatchObject({
            config: { transport: 'sse', url: 'https://docs.example.com/sse' },
            source: { scope: 'project', file: path.join(project, '.mcp.json') },
            secretKeys: ['url:userinfo'],
        });
        expect(result.servers.some((server) => server.source.name === 'other')).toBe(false);
    });

    it('reads Cursor user and project servers, inferring the transport from the url', () => {
        expect(find('cursor', 'browser').config).toMatchObject({
            transport: 'stdio',
            args: ['@playwright/mcp@latest'],
        });
        expect(find('cursor', 'legacy').config).toMatchObject({ transport: 'sse', url: 'http://localhost:8080/sse' });
        expect(find('cursor', 'api')).toMatchObject({
            config: { transport: 'http', headers: { API_KEY: '' } },
            secretKeys: ['API_KEY'],
        });
        expect(find('cursor', 'proj')).toMatchObject({
            config: { args: ['server.js', ''], env: { PATH_EXTRA: WORKSPACE_BIN } },
            source: { scope: 'project' },
            secretKeys: ['args[1]'],
        });
    });

    it('reads VS Code servers from JSON with comments', () => {
        expect(find('vscode', 'fetch')).toMatchObject({
            config: { transport: 'stdio', command: 'uvx', env: { API_KEY: '' } },
            secretKeys: ['API_KEY'],
        });
        expect(find('vscode', 'remote').config).toMatchObject({
            transport: 'http',
            headers: { 'X-Custom': 'ok' },
        });
    });

    it('reads Codex servers, tool filters and timeouts from TOML', () => {
        expect(find('codex', 'context7')).toMatchObject({
            config: {
                env: { CONTEXT7_API_KEY: '', DEBUG: '1' },
                toolFilter: { allow: ['resolve-library-id', 'get-library-docs'] },
                timeoutMs: 90_000,
            },
            secretKeys: ['CONTEXT7_API_KEY'],
        });
        expect(find('codex', 'figma')).toMatchObject({
            config: {
                transport: 'http',
                url: 'https://mcp.figma.com/mcp',
                headers: { 'X-Figma-Region': 'us-east-1', 'X-Org-Id': '', Authorization: '' },
            },
            secretKeys: ['X-Org-Id', 'Authorization'],
        });
        expect(find('codex', 'with spaces')).toMatchObject({
            config: {
                name: 'with-spaces',
                command: 'C:\\tools\\server.exe',
                args: ['--flag', 'value'],
                env: { LOCAL_TOKEN: '' },
                toolFilter: { deny: ['dangerous'] },
            },
            secretKeys: ['LOCAL_TOKEN'],
        });
        expect(find('codex', 'with_env_table')).toMatchObject({
            config: { env: { PYTHONUNBUFFERED: '1', SECRET_PASSWORD: '' } },
            secretKeys: ['SECRET_PASSWORD'],
        });
    });

    it('explains what it skipped', () => {
        const messages = result.warnings.map(
            (warning) => `${warning.tool}/${warning.server ?? '-'}: ${warning.message}`,
        );
        expect(messages).toEqual(
            expect.arrayContaining([
                'claude/ide: skipped: unsupported type sse-ide',
                'claude/broken: skipped: stdio server without a command',
                `cursor/proj: PATH_EXTRA refers to a variable (${WORKSPACE_BIN}) that Xora Code does not expand`,
                'vscode/ws: skipped: unsupported type ws',
                'codex/-: line 40: expected =',
            ]),
        );
        expect(result.warnings).toHaveLength(5);
    });

    it('reads only the requested tools and ignores missing files', async () => {
        const codexOnly = await importServers({ home, projectDir: project, tools: ['codex'] });
        expect(new Set(codexOnly.servers.map((server) => server.source.tool))).toEqual(new Set(['codex']));
        const empty = await importServers({ home: path.join(home, 'nobody'), projectDir: path.join(project, 'none') });
        expect(empty).toEqual({ servers: [], warnings: [] });
    });
});
