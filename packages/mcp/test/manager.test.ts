import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { McpManager, type McpServerStatus } from '../src/index.ts';
import {
    makeTempDir,
    startHttpServer,
    stdioConfig,
    type TestHttpServer,
    waitFor,
    writeStdioServer,
} from './helpers.ts';

let dir: string;
let cleanup: () => Promise<void>;
let script: string;
let http: TestHttpServer;
const managers: McpManager[] = [];

function manager(options: ConstructorParameters<typeof McpManager>[0] = {}): McpManager {
    const created = new McpManager({ reconnect: { baseDelayMs: 20, maxDelayMs: 50 }, ...options });
    managers.push(created);
    return created;
}

function statusOf(mgr: McpManager, name: string): McpServerStatus {
    const status = mgr.status(name);
    if (!status) {
        throw new Error(`no status for ${name}`);
    }
    return status;
}

beforeAll(async () => {
    ({ dir, cleanup } = await makeTempDir());
    script = await writeStdioServer(dir);
    http = await startHttpServer();
});

afterEach(async () => {
    await Promise.all(managers.splice(0).map((item) => item.stopAll()));
});

afterAll(async () => {
    await http.close();
    await cleanup();
});

describe('McpManager', { timeout: 30_000 }, () => {
    it('starts enabled and trusted servers only and exposes their tools under qualified names', async () => {
        const mgr = manager();
        await mgr.start([
            stdioConfig(script, { name: 'files', toolFilter: { deny: ['sleep', 'c*'] } }),
            {
                name: 'web',
                transport: 'http',
                url: `${http.base}/mcp`,
                enabled: true,
                origin: 'project',
                trusted: true,
            },
            stdioConfig(script, { name: 'off', enabled: false }),
            stdioConfig(script, { name: 'unvetted', origin: 'project', trusted: false }),
        ]);
        expect(mgr.statuses().map(({ name, status, skipped }) => ({ name, status, skipped }))).toEqual([
            { name: 'files', status: 'running', skipped: undefined },
            { name: 'web', status: 'running', skipped: undefined },
            { name: 'off', status: 'stopped', skipped: 'disabled' },
            { name: 'unvetted', status: 'stopped', skipped: 'untrusted' },
        ]);
        expect(statusOf(mgr, 'files')).toMatchObject({ transport: 'stdio', origin: 'global', toolCount: 7 });
        expect(statusOf(mgr, 'files').serverInfo).toMatchObject({ name: 'stdio-test' });

        const tools = mgr.tools();
        expect(tools.map((tool) => tool.qualifiedName)).toEqual([
            'mcp__files__echo',
            'mcp__files__big',
            'mcp__files__fail',
            'mcp__files__die',
            'mcp__files__env',
            'mcp__files__grow',
            'mcp__files__grandchild',
            'mcp__web__echo',
            'mcp__web__big',
            'mcp__web__sleep',
        ]);
        const echo = tools[0];
        expect(echo).toMatchObject({
            server: 'files',
            name: 'echo',
            description: 'Echoes text',
            annotations: { readOnlyHint: true },
        });
        expect(echo?.inputSchema.type).toBe('object');

        const result = await mgr.callTool('mcp__web__echo', { text: 'hi' });
        expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
        await expect(mgr.callTool('mcp__files__crash')).rejects.toMatchObject({ code: 'tool-not-allowed' });
        await expect(mgr.callTool('mcp__files__nope')).rejects.toMatchObject({ code: 'tool-not-found' });
        await expect(mgr.callTool('mcp__off__echo')).rejects.toMatchObject({ code: 'not-running' });
        await expect(mgr.callTool('read_file')).rejects.toMatchObject({ code: 'tool-not-found' });

        await mgr.stop('web');
        expect(statusOf(mgr, 'web').status).toBe('stopped');
        expect(mgr.tools().some((tool) => tool.server === 'web')).toBe(false);
        await expect(mgr.callTool('mcp__web__echo', { text: 'hi' })).rejects.toMatchObject({ code: 'not-running' });
    });

    it('follows tool list changes announced by a server', async () => {
        let changes = 0;
        const mgr = manager({ onToolsChanged: () => (changes += 1) });
        await mgr.start([stdioConfig(script)]);
        expect(mgr.tools().some((tool) => tool.name === 'grown')).toBe(false);
        const before = changes;
        await mgr.callTool('mcp__local__grow');
        await waitFor(() => mgr.tools().some((tool) => tool.qualifiedName === 'mcp__local__grown'));
        expect(changes).toBeGreaterThan(before);
        expect(statusOf(mgr, 'local').toolCount).toBe(10);
        expect((await mgr.callTool('mcp__local__grown')).content).toEqual([{ type: 'text', text: 'new' }]);
    });

    it('rejects invalid configs and duplicate names before changing anything', async () => {
        const mgr = manager();
        await expect(mgr.start([stdioConfig(script), stdioConfig(script)])).rejects.toMatchObject({
            code: 'invalid-config',
        });
        await expect(mgr.start([stdioConfig(script, { name: 'a__b' })])).rejects.toMatchObject({
            code: 'invalid-config',
        });
        expect(mgr.statuses()).toEqual([]);
    });

    it('reconnects a stdio server that dies while running', async () => {
        const statuses: McpServerStatus[] = [];
        let toolEvents = 0;
        const mgr = manager({ onStatus: (status) => statuses.push(status), onToolsChanged: () => (toolEvents += 1) });
        await mgr.start([stdioConfig(script)]);
        const firstPid = statusOf(mgr, 'local').pid;
        await mgr.callTool('mcp__local__crash');
        await waitFor(() => {
            const status = statusOf(mgr, 'local');
            return (
                status.pid !== firstPid && status.status === 'running' && !status.reconnecting && status.toolCount === 9
            );
        });
        expect(statusOf(mgr, 'local').reconnects).toBe(1);
        expect(statuses.some((status) => status.status === 'failed' && status.reconnecting)).toBe(true);
        expect(toolEvents).toBeGreaterThan(0);
        expect((await mgr.callTool('mcp__local__echo', { text: 'back' })).content).toEqual([
            { type: 'text', text: 'back' },
        ]);
        expect(mgr.logs('local').some((line) => line.text.startsWith('reconnecting in'))).toBe(true);
    });

    it('gives up after three reconnect attempts', async () => {
        const marker = path.join(dir, 'crash-marker');
        await rm(marker, { force: true });
        const mgr = manager();
        await mgr.start([stdioConfig(script, { env: { CRASH_MARKER: marker } })]);
        await mgr.callTool('mcp__local__crash');
        await waitFor(() => {
            const status = statusOf(mgr, 'local');
            return status.status === 'failed' && !status.reconnecting && status.reconnects === 3;
        });
        const status = statusOf(mgr, 'local');
        expect(status.errorCode).toBe('connect-failed');
        expect(status.error).toContain('refusing to start');
        expect(mgr.logs('local').at(-1)?.text).toBe('gave up after 3 reconnect attempts');
        expect(mgr.tools()).toEqual([]);

        await rm(marker);
        expect(await mgr.restart('local')).toMatchObject({ status: 'running', reconnects: 0 });
    });

    it('does not restart a server that failed to start', async () => {
        const marker = path.join(dir, 'start-marker');
        await writeFile(marker, 'x');
        const mgr = manager();
        await mgr.start([stdioConfig(script, { env: { CRASH_MARKER: marker } })]);
        expect(statusOf(mgr, 'local')).toMatchObject({ status: 'failed', reconnects: 0, reconnecting: false });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(statusOf(mgr, 'local')).toMatchObject({ status: 'failed', reconnects: 0 });
        await rm(marker);
        expect((await mgr.restart('local')).status).toBe('running');
    });

    it('applies a new server list: keeps unchanged servers, restarts changed ones, stops removed ones', async () => {
        const mgr = manager();
        await mgr.start([stdioConfig(script, { name: 'keep' }), stdioConfig(script, { name: 'change' })]);
        const keepPid = statusOf(mgr, 'keep').pid;
        const changePid = statusOf(mgr, 'change').pid;
        const removed = mgr.connection('change');

        await mgr.start([
            stdioConfig(script, { name: 'keep' }),
            stdioConfig(script, { name: 'change', env: { FLAVOUR: 'new' } }),
            stdioConfig(script, { name: 'added' }),
        ]);
        expect(statusOf(mgr, 'keep').pid).toBe(keepPid);
        expect(statusOf(mgr, 'change').pid).not.toBe(changePid);
        expect(statusOf(mgr, 'added').status).toBe('running');
        expect((await mgr.callTool('mcp__change__env', { name: 'FLAVOUR' })).content).toEqual([
            { type: 'text', text: 'new' },
        ]);

        await mgr.start([stdioConfig(script, { name: 'added' })]);
        expect(mgr.statuses().map((status) => status.name)).toEqual(['added']);
        expect(mgr.connection('keep')).toBeUndefined();
        expect(removed?.status).toBe('stopped');
    });
});
