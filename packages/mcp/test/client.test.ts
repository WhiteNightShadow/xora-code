import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ContentBlock, McpConnection, type McpLogLine, type McpStatus, safeBaseEnv } from '../src/index.ts';
import {
    isAlive,
    makeTempDir,
    startHttpServer,
    startSseServer,
    stdioConfig,
    type TestHttpServer,
    waitFor,
    writeStdioServer,
} from './helpers.ts';

let dir: string;
let cleanup: () => Promise<void>;
let script: string;
const open: McpConnection[] = [];

function connection(): McpConnection {
    const created = new McpConnection();
    open.push(created);
    return created;
}

function text(result: { content: readonly ContentBlock[] }): string {
    return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}

beforeAll(async () => {
    ({ dir, cleanup } = await makeTempDir());
    script = await writeStdioServer(dir);
});

afterEach(async () => {
    await Promise.all(open.splice(0).map((item) => item.close()));
});

afterAll(async () => {
    await cleanup();
});

describe('McpConnection over stdio', { timeout: 30_000 }, () => {
    it('connects, lists and calls tools, reads resources and prompts', async () => {
        const statuses: McpStatus[] = [];
        const conn = connection();
        await conn.connect(stdioConfig(script), { onStatus: (status) => statuses.push(status) });
        expect(conn.status).toBe('running');
        expect(conn.serverInfo).toMatchObject({ name: 'stdio-test', version: '1.2.3' });
        expect(conn.pid).toBeTypeOf('number');

        const tools = await conn.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(['echo', 'big', 'sleep', 'fail', 'crash', 'die', 'env', 'grow', 'grandchild']),
        );
        const echo = tools.find((tool) => tool.name === 'echo');
        expect(echo?.annotations?.readOnlyHint).toBe(true);
        expect(echo?.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });

        const result = await conn.callTool('echo', { text: '你好, mcp' });
        expect(result).toEqual({ content: [{ type: 'text', text: '你好, mcp' }], isError: false, truncated: false });

        const failed = await conn.callTool('fail');
        expect(failed.isError).toBe(true);
        expect(text(failed)).toBe('it broke');

        expect((await conn.listResources()).map((resource) => resource.uri)).toEqual(['file:///readme.md']);
        expect(await conn.readResource('file:///readme.md')).toEqual({
            contents: [{ uri: 'file:///readme.md', mimeType: 'text/markdown', text: '# hello' }],
            truncated: false,
        });
        expect((await conn.listPrompts()).map((prompt) => prompt.name)).toEqual(['greet']);
        const prompt = await conn.getPrompt('greet', { name: 'Ada' });
        expect(prompt.messages[0]?.content).toEqual({ type: 'text', text: 'Hello Ada' });

        await conn.close();
        expect(conn.status).toBe('stopped');
        expect(statuses).toEqual(['starting', 'running', 'stopped']);
    });

    it('passes only the base environment and the config env to the server', async () => {
        process.env.XORA_TEST_LEAK_TOKEN = 'must-not-leak';
        try {
            const conn = connection();
            await conn.connect(stdioConfig(script, { env: { FROM_CONFIG: 'yes' } }), {
                // Windows needs more than PATH (SYSTEMROOT and friends) for node to run, hence the safe base.
                baseEnv: { ...safeBaseEnv(), FROM_BASE: 'base' },
            });
            expect(text(await conn.callTool('env', { name: 'FROM_CONFIG' }))).toBe('yes');
            expect(text(await conn.callTool('env', { name: 'FROM_BASE' }))).toBe('base');
            expect(text(await conn.callTool('env', { name: 'XORA_TEST_LEAK_TOKEN' }))).toBe('<unset>');
            await conn.close();

            const defaults = connection();
            await defaults.connect(stdioConfig(script));
            expect(text(await defaults.callTool('env', { name: 'XORA_TEST_LEAK_TOKEN' }))).toBe('<unset>');
            expect(text(await defaults.callTool('env', { name: 'PATH' }))).not.toBe('<unset>');
        } finally {
            delete process.env.XORA_TEST_LEAK_TOKEN;
        }
    });

    it('captures stderr in the log ring buffer with secrets redacted', async () => {
        const secret = 'sk-test-0123456789abcdefghij';
        const lines: McpLogLine[] = [];
        const conn = connection();
        await conn.connect(
            stdioConfig(script, { args: [script, '--token', 'short-pw'], env: { MY_API_KEY: secret } }),
            { onLog: (line) => lines.push(line), logLimit: 5 },
        );
        await waitFor(() => conn.logs.some((line) => line.text.startsWith('using key')));
        const stderr = conn.logs.filter((line) => line.source === 'stderr').map((line) => line.text);
        expect(stderr).toContain('using key [redacted]');
        expect(lines[0]?.text).toBe(`starting ${process.execPath} ${script} --token [redacted]`);
        expect(JSON.stringify(conn.logs)).not.toContain(secret);
        expect(JSON.stringify(lines)).not.toMatch(new RegExp(`${secret}|short-pw`));
        expect(lines.some((line) => line.source === 'client' && line.text.startsWith('connected'))).toBe(true);
        for (let i = 0; i < 10; i += 1) {
            conn.note('debug', `note ${i}`);
        }
        expect(conn.logs).toHaveLength(5);
        expect(conn.logs.at(-1)?.text).toBe('note 9');
    });

    it('truncates large output to maxOutputBytes, keeping head and tail', async () => {
        const conn = connection();
        await conn.connect(stdioConfig(script, { maxOutputBytes: 4096 }));
        const result = await conn.callTool('big', { bytes: 200_000 });
        const output = text(result);
        expect(result.truncated).toBe(true);
        expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4096);
        expect(output.startsWith('A'.repeat(1000))).toBe(true);
        expect(output.endsWith('B'.repeat(1000))).toBe(true);
        expect(output).toMatch(/\[\.\.\. \d+ bytes truncated \.\.\.\]/);

        const small = await conn.callTool('big', { bytes: 100 });
        expect(small.truncated).toBe(false);
        expect(text(small)).toHaveLength(100);
    });

    it('times out slow calls and keeps the connection usable', async () => {
        const conn = connection();
        await conn.connect(stdioConfig(script, { timeoutMs: 200 }));
        await expect(conn.callTool('sleep', { ms: 2000 })).rejects.toMatchObject({
            name: 'McpError',
            code: 'timeout',
        });
        await expect(conn.callTool('sleep', { ms: 2000 }, { timeoutMs: 50 })).rejects.toMatchObject({
            code: 'timeout',
        });
        expect(text(await conn.callTool('sleep', { ms: 10 }))).toBe('slept');

        const controller = new AbortController();
        const pending = conn.callTool('sleep', { ms: 2000 }, { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: 'aborted' });
        expect(conn.status).toBe('running');
    });

    it('reports a server that exits as failed, with the exit code and last stderr line', async () => {
        const closed: string[] = [];
        const conn = connection();
        await conn.connect(stdioConfig(script), { onClose: (error) => closed.push(error.message) });
        await conn.callTool('crash');
        await waitFor(() => conn.status === 'failed');
        expect(conn.lastError?.code).toBe('closed');
        expect(conn.lastError?.message).toBe('server process exited with code 3: test server starting');
        expect(closed).toEqual([conn.lastError?.message]);
        await expect(conn.callTool('echo', { text: 'x' })).rejects.toMatchObject({ code: 'not-running' });
    });

    it('fails a call whose server dies while answering', async () => {
        const conn = connection();
        await conn.connect(stdioConfig(script));
        await expect(conn.callTool('die')).rejects.toMatchObject({
            code: 'closed',
            message: 'tool die failed: server process exited with code 4: test server starting',
        });
        expect(conn.status).toBe('failed');
    });

    it('stops a server that is still starting', async () => {
        const conn = connection();
        const pending = conn.connect(stdioConfig(script, { args: ['-e', 'setInterval(() => {}, 1000)'] }));
        await waitFor(() => conn.pid !== undefined);
        const pid = conn.pid as number;
        await conn.close();
        await expect(pending).rejects.toMatchObject({ code: 'aborted' });
        expect(conn.status).toBe('stopped');
        await waitFor(() => !isAlive(pid));
    });

    it('kills the whole process tree on close', async () => {
        const conn = connection();
        await conn.connect(stdioConfig(script));
        const pid = Number(text(await conn.callTool('grandchild')));
        expect(isAlive(pid)).toBe(true);
        await conn.close();
        await waitFor(() => !isAlive(pid));
    });

    it('fails with spawn-failed for a missing command and with invalid-config for a bad config', async () => {
        const conn = connection();
        await expect(
            conn.connect(stdioConfig(script, { command: 'xora-no-such-command-12345' })),
        ).rejects.toMatchObject({
            code: 'spawn-failed',
        });
        expect(conn.status).toBe('failed');
        expect(conn.lastError?.code).toBe('spawn-failed');

        await expect(conn.connect(stdioConfig(script, { cwd: path.join(dir, 'missing') }))).rejects.toMatchObject({
            code: 'spawn-failed',
            message: expect.stringContaining('does not exist'),
        });

        await expect(conn.connect(stdioConfig(script, { name: 'bad name' }))).rejects.toMatchObject({
            code: 'invalid-config',
        });
    });

    it('fails when the server exits during the handshake', async () => {
        const conn = connection();
        await expect(
            conn.connect(stdioConfig(script, { args: ['-e', 'process.stderr.write("nope\\n"); process.exit(2)'] })),
        ).rejects.toMatchObject({ code: 'connect-failed', message: 'server process exited with code 2: nope' });
    });
});

describe('McpConnection over http and sse', { timeout: 30_000 }, () => {
    let http: TestHttpServer;
    let modern: TestHttpServer;
    let sse: TestHttpServer;

    beforeAll(async () => {
        [http, modern, sse] = await Promise.all([
            startHttpServer(),
            startHttpServer({ legacy: 'reject' }),
            startSseServer('let-me-in'),
        ]);
    });

    afterAll(async () => {
        await Promise.all([http.close(), modern.close(), sse.close()]);
    });

    const remote = (url: string, fields: Record<string, unknown> = {}) => ({
        name: 'remote',
        transport: 'http' as const,
        url,
        enabled: true,
        origin: 'global' as const,
        trusted: true,
        ...fields,
    });

    it('connects to a streamable http server', async () => {
        const conn = connection();
        await conn.connect(remote(`${http.base}/mcp`));
        expect(conn.serverInfo?.name).toBe('http-test');
        expect(conn.protocolVersion).toMatch(/^2025-/);
        expect((await conn.listTools()).map((tool) => tool.name)).toEqual(['echo', 'big', 'sleep']);
        expect(await conn.callTool('echo', { text: 'over http' })).toMatchObject({
            content: [{ type: 'text', text: 'over http' }],
            isError: false,
        });
        const big = await conn.callTool('big', { bytes: 300_000 });
        expect(big.truncated).toBe(true);
        expect(Buffer.byteLength(text(big))).toBeLessThanOrEqual(100 * 1024);
    });

    it('negotiates the protocol with a server that rejects the 2025 handshake', async () => {
        const conn = connection();
        await conn.connect(remote(`${modern.base}/mcp`));
        expect(conn.status).toBe('running');
        expect(conn.protocolVersion).toBe('2026-07-28');
        expect(text(await conn.callTool('echo', { text: 'modern' }))).toBe('modern');
        expect(conn.logs.some((line) => line.text.includes('negotiating the protocol version'))).toBe(true);
    });

    it('connects to a legacy sse server with the configured headers', async () => {
        const conn = connection();
        await conn.connect(remote(`${sse.base}/sse`, { transport: 'sse', headers: { 'x-test-header': 'let-me-in' } }));
        expect(conn.serverInfo?.name).toBe('sse-test');
        expect(text(await conn.callTool('echo', { text: 'over sse' }))).toBe('over sse');
    });

    it('fails cleanly when nothing listens', async () => {
        const unused = await startHttpServer();
        await unused.close();
        const conn = connection();
        await expect(conn.connect(remote(`${unused.base}/mcp`), { connectTimeoutMs: 5000 })).rejects.toMatchObject({
            code: 'connect-failed',
            message: expect.stringContaining('ECONNREFUSED'),
        });
        expect(conn.status).toBe('failed');
    });
});
