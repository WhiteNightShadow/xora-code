import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    type HookConfig,
    HookConfigSchema,
    type HookHandler,
    type HookSource,
    loadHookConfigs,
    type MatchedHook,
    matchHooks,
    parseHookConfig,
    runHooks,
    substituteShellCommand,
} from '../src/index.ts';
import { isWindows, PROJECT_VAR, placeholder, ROOT_VAR, temporaryDir, writeTree } from './helpers.ts';

function hookSource(extra: Partial<HookSource> = {}): HookSource {
    return { path: 'settings.json', origin: 'user', trusted: true, ...extra };
}

function config(events: Record<string, unknown>, extra: Partial<HookSource> = {}): HookConfig {
    const parsed = parseHookConfig(events, hookSource(extra));
    expect(parsed.diagnostics).toEqual([]);
    return parsed.config;
}

function matched(handler: HookHandler, extra: Partial<HookSource> = {}): MatchedHook {
    return { event: 'PreToolUse', matcher: '', handler, source: hookSource(extra) };
}

function command(script: string, extra: Partial<Extract<HookHandler, { type: 'command' }>> = {}): HookHandler {
    return { type: 'command', command: script, ...extra };
}

/** Only PATH from this process, like a host that strips secrets. */
const baseEnv = { PATH: process.env.PATH };

describe('hook configuration', () => {
    it('validates the strict schema', () => {
        const valid = {
            hooks: {
                PreToolUse: [
                    {
                        matcher: 'Bash|Edit',
                        hooks: [
                            { type: 'command', command: 'echo hi', timeout: 30 },
                            { type: 'http', url: 'http://127.0.0.1:9/hook', headers: { 'x-a': 'b' } },
                        ],
                    },
                ],
            },
        };
        expect(HookConfigSchema.safeParse(valid).success).toBe(true);
        expect(HookConfigSchema.safeParse({ hooks: { PreToolUse: [{ hooks: [{ type: 'prompt' }] }] } }).success).toBe(
            false,
        );
        expect(HookConfigSchema.safeParse({ hooks: { Unknown: [] } }).success).toBe(false);
        expect(
            HookConfigSchema.safeParse({ hooks: { Stop: [{ hooks: [{ type: 'http', url: 'file:///etc/passwd' }] }] } })
                .success,
        ).toBe(false);
    });

    it('loads settings files leniently and reports what it skips', async () => {
        const root = await temporaryDir();
        await writeTree(root, {
            'settings.json': JSON.stringify({
                permissions: { allow: [] },
                hooks: {
                    PreToolUse: [
                        {
                            matcher: 'Bash',
                            hooks: [
                                { type: 'command', command: 'check.sh' },
                                { type: 'prompt', prompt: 'judge it' },
                                { type: 'command' },
                            ],
                        },
                        { matcher: '(unclosed', hooks: [{ type: 'command', command: 'x' }] },
                    ],
                    TeammateIdle: [{ hooks: [{ type: 'command', command: 'y' }] }],
                },
            }),
            'no-hooks.json': JSON.stringify({ model: 'x' }),
            'broken.json': '{ nope',
        });
        const { configs, diagnostics } = await loadHookConfigs([
            { path: path.join(root, 'settings.json'), origin: 'project', trusted: true },
            { path: path.join(root, 'no-hooks.json'), origin: 'user', trusted: true },
            { path: path.join(root, 'missing.json'), origin: 'user', trusted: true },
            { path: path.join(root, 'broken.json'), origin: 'user', trusted: true },
        ]);
        expect(configs).toHaveLength(1);
        expect(configs[0]?.groups).toEqual([
            { event: 'PreToolUse', matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh' }] },
        ]);
        expect(diagnostics.map((item) => [item.severity, item.message.replace(/:.*$/s, '')])).toEqual([
            ['warning', 'hooks.PreToolUse[0].hooks[1]'],
            ['error', 'hooks.PreToolUse[0].hooks[2]'],
            ['error', 'hooks.PreToolUse[1]'],
            ['warning', 'unsupported hook event "TeammateIdle" ignored'],
            ['error', 'cannot read hooks'],
        ]);
    });
});

describe('matchHooks', () => {
    const configs = [
        config({
            PreToolUse: [
                { matcher: 'Bash|Edit', hooks: [{ type: 'command', command: 'list' }] },
                { matcher: '^Notebook', hooks: [{ type: 'command', command: 'regex' }] },
                { matcher: 'mcp__memory__.*', hooks: [{ type: 'command', command: 'mcp' }] },
                { matcher: '*', hooks: [{ type: 'command', command: 'star' }] },
                { hooks: [{ type: 'command', command: 'all' }] },
            ],
            UserPromptSubmit: [{ matcher: 'ignored', hooks: [{ type: 'command', command: 'prompt' }] }],
            SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'start' }] }],
        }),
        config({ PreToolUse: [{ hooks: [{ type: 'command', command: 'all' }] }] }),
        config(
            { PreToolUse: [{ hooks: [{ type: 'command', command: 'all' }] }] },
            { trusted: false, origin: 'project' },
        ),
    ];
    const commandsOf = (hooks: MatchedHook[]): string[] =>
        hooks.map((hook) => (hook.handler.type === 'command' ? hook.handler.command : hook.handler.url));

    it('treats simple matchers as exact names and others as regular expressions', () => {
        expect(commandsOf(matchHooks(configs, 'PreToolUse', 'Bash'))).toEqual(['list', 'star', 'all', 'all']);
        expect(commandsOf(matchHooks(configs, 'PreToolUse', 'BashOutput'))).toEqual(['star', 'all', 'all']);
        expect(commandsOf(matchHooks(configs, 'PreToolUse', 'NotebookEdit'))).toEqual(['regex', 'star', 'all', 'all']);
        expect(commandsOf(matchHooks(configs, 'PreToolUse', 'mcp__memory__write'))).toEqual([
            'mcp',
            'star',
            'all',
            'all',
        ]);
    });

    it('removes identical handlers but keeps untrusted copies apart', () => {
        const hooks = matchHooks(configs, 'PreToolUse', 'Read');
        expect(hooks.map((hook) => hook.source.trusted)).toEqual([true, true, false]);
    });

    it('ignores matchers on events without one and needs a target otherwise', () => {
        expect(commandsOf(matchHooks(configs, 'UserPromptSubmit'))).toEqual(['prompt']);
        expect(commandsOf(matchHooks(configs, 'SessionStart', 'startup'))).toEqual(['start']);
        expect(commandsOf(matchHooks(configs, 'SessionStart', 'resume'))).toEqual([]);
        expect(commandsOf(matchHooks(configs, 'SessionStart'))).toEqual([]);
        expect(commandsOf(matchHooks(configs, 'Stop'))).toEqual([]);
    });
});

describe('shell placeholders', () => {
    it('quotes values for where they stand', () => {
        const values = { CLAUDE_PLUGIN_ROOT: "/data/Application Support/it's" };
        expect(substituteShellCommand(`${ROOT_VAR}/run.sh`, values, 'darwin')).toBe(
            `'/data/Application Support/it'\\''s'/run.sh`,
        );
        expect(substituteShellCommand(`"${ROOT_VAR}"/run.sh`, values, 'linux')).toBe(
            `"/data/Application Support/it's"/run.sh`,
        );
        expect(
            substituteShellCommand(`echo '\${CLAUDE_PLUGIN_ROOT}' \\\${CLAUDE_PLUGIN_ROOT} \${OTHER}`, values, 'linux'),
        ).toBe(`echo '/data/Application Support/it'\\''s' \\\${CLAUDE_PLUGIN_ROOT} \${OTHER}`);
        expect(substituteShellCommand(`${ROOT_VAR}\\run.cmd`, { CLAUDE_PLUGIN_ROOT: 'C:\\A B' }, 'win32')).toBe(
            '"C:\\A B"\\run.cmd',
        );
        expect(substituteShellCommand(`${ROOT_VAR}/x`, { CLAUDE_PLUGIN_ROOT: '/plain/path' }, 'linux')).toBe(
            '/plain/path/x',
        );
    });
});

describe.skipIf(isWindows)('runHooks with command hooks', () => {
    const options = async () => ({ cwd: await temporaryDir(), env: baseEnv });

    it('blocks on exit 0 with a JSON block decision', async () => {
        const outcome = await runHooks(
            'PreToolUse',
            [matched(command(`echo '{"decision":"block","reason":"no rm"}'`))],
            { tool_name: 'Bash' },
            await options(),
        );
        expect(outcome).toMatchObject({ blocked: true, reason: 'no rm', decision: 'deny', stop: false });
        expect(outcome.results[0]).toMatchObject({ exitCode: 0, timedOut: false, output: { decision: 'block' } });
    });

    it('blocks on exit 2 with stderr as the reason', async () => {
        const outcome = await runHooks(
            'PreToolUse',
            [matched(command('echo "dangerous command" >&2; exit 2'))],
            {},
            await options(),
        );
        expect(outcome).toMatchObject({ blocked: true, reason: 'dangerous command', decision: 'deny' });
        expect(outcome.results[0]?.error).toBeUndefined();
    });

    it('treats other exit codes as non-blocking errors unless onFailure is block', async () => {
        const outcome = await runHooks(
            'PreToolUse',
            [matched(command('echo oops >&2; exit 1')), matched(command('exit 3', { onFailure: 'block' }))],
            {},
            await options(),
        );
        expect(outcome.results.map((result) => [result.exitCode, result.error, result.stderr])).toEqual([
            [1, 'exit code 1', 'oops\n'],
            [3, 'exit code 3', ''],
        ]);
        expect(outcome).toMatchObject({ blocked: true, reason: 'hook failed: exit code 3' });
        const lenient = await runHooks('PreToolUse', [matched(command('exit 1'))], {}, await options());
        expect(lenient.blocked).toBe(false);
        expect(lenient.decision).toBeUndefined();
    });

    it('does not block events that cannot be blocked', async () => {
        const outcome = await runHooks(
            'Notification',
            [matched(command('echo nope >&2; exit 2'))],
            {},
            await options(),
        );
        expect(outcome.blocked).toBe(false);
        expect(outcome.messages).toEqual(['nope']);
    });

    it('combines permission decisions, context, input changes and stop requests', async () => {
        const allow = `echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"ctx one"}}'`;
        const ask = `echo '{"hookSpecificOutput":{"permissionDecision":"ask","updatedInput":{"command":"ls -la"}},"systemMessage":"careful"}'`;
        const outcome = await runHooks(
            'PreToolUse',
            [matched(command(allow)), matched(command(ask))],
            {},
            await options(),
        );
        expect(outcome).toMatchObject({
            blocked: false,
            decision: 'ask',
            additionalContext: 'ctx one',
            updatedInput: { command: 'ls -la' },
            messages: ['careful'],
        });
        const deny = `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"policy"}}'`;
        const denied = await runHooks(
            'PreToolUse',
            [matched(command(ask)), matched(command(deny))],
            {},
            await options(),
        );
        expect(denied).toMatchObject({ blocked: true, decision: 'deny', reason: 'policy' });
        const legacy = await runHooks(
            'PreToolUse',
            [matched(command(`echo '{"decision":"approve"}'`))],
            {},
            await options(),
        );
        expect(legacy.decision).toBe('allow');
        const stop = await runHooks(
            'PostToolUse',
            [matched(command(`echo '{"continue":false,"stopReason":"enough"}'`))],
            {},
            await options(),
        );
        expect(stop).toMatchObject({ stop: true, stopReason: 'enough', blocked: false });
        const invalid = await runHooks('PreToolUse', [matched(command(`echo '{broken'`))], {}, await options());
        expect(invalid.results[0]?.error).toBe('stdout is not a JSON object');
    });

    it('adds plain stdout as context on prompt submit', async () => {
        const outcome = await runHooks(
            'UserPromptSubmit',
            [matched(command('echo "This repo uses pnpm."'))],
            { prompt: 'hi' },
            await options(),
        );
        expect(outcome.additionalContext).toBe('This repo uses pnpm.');
        const elsewhere = await runHooks('PreToolUse', [matched(command('echo plain text'))], {}, await options());
        expect(elsewhere.additionalContext).toBeUndefined();
    });

    it('passes the event on stdin and only the given environment', async () => {
        const dir = await temporaryDir();
        process.env.XORA_TEST_SECRET = 'should-not-leak';
        try {
            const outcome = await runHooks(
                'PreToolUse',
                [
                    matched(
                        command(
                            'cat > "$CLAUDE_PROJECT_DIR/input.json"; echo "secret=$XORA_TEST_SECRET visible=$VISIBLE root=$CLAUDE_PLUGIN_ROOT" > env.txt',
                        ),
                        { pluginRoot: '/plugins/a b', origin: 'plugin' },
                    ),
                ],
                { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } },
                { cwd: dir, env: { ...baseEnv, VISIBLE: 'yes' } },
            );
            expect(outcome.results[0]?.exitCode).toBe(0);
        } finally {
            delete process.env.XORA_TEST_SECRET;
        }
        expect(JSON.parse(await readFile(path.join(dir, 'input.json'), 'utf8'))).toEqual({
            session_id: 's1',
            tool_name: 'Bash',
            tool_input: { command: 'ls' },
            hook_event_name: 'PreToolUse',
            cwd: dir,
        });
        expect(await readFile(path.join(dir, 'env.txt'), 'utf8')).toBe('secret= visible=yes root=/plugins/a b\n');
    });

    it('fills placeholders in shell and exec forms', async () => {
        const dir = await temporaryDir();
        await writeTree(dir, { 'plugin dir/bin/tool.sh': 'echo "ran $1" > "$2"\n' });
        const root = path.join(dir, 'plugin dir');
        const shellForm = matched(command(`sh ${ROOT_VAR}/bin/tool.sh shell "${PROJECT_VAR}/shell.txt"`), {
            pluginRoot: root,
        });
        const execForm = matched(
            command('sh', { args: [`${ROOT_VAR}/bin/tool.sh`, 'exec', `${PROJECT_VAR}/exec.txt`] }),
            { pluginRoot: root },
        );
        const outcome = await runHooks('PostToolUse', [shellForm, execForm], {}, { cwd: dir, env: baseEnv });
        expect(outcome.results.map((result) => result.error)).toEqual([undefined, undefined]);
        expect(await readFile(path.join(dir, 'shell.txt'), 'utf8')).toBe('ran shell\n');
        expect(await readFile(path.join(dir, 'exec.txt'), 'utf8')).toBe('ran exec\n');
    });

    it('kills the whole process tree on timeout', async () => {
        const dir = await temporaryDir();
        const pidFile = path.join(dir, 'child.pid');
        const outcome = await runHooks(
            'PreToolUse',
            [matched(command(`sleep 30 & echo $! > "${pidFile}"; wait`, { timeout: 0.3 }))],
            {},
            { cwd: dir, env: baseEnv },
        );
        const result = outcome.results[0];
        expect(result).toMatchObject({ timedOut: true, error: 'timed out after 300 ms' });
        expect(result?.durationMs).toBeLessThan(5000);
        expect(outcome.blocked).toBe(false);
        const pid = Number((await readFile(pidFile, 'utf8')).trim());
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(() => process.kill(pid, 0)).toThrow();
    });

    it('uses the default timeout from the options and stops on abort', async () => {
        const dir = await temporaryDir();
        const timed = await runHooks(
            'Stop',
            [matched(command('sleep 5'))],
            {},
            { cwd: dir, env: baseEnv, timeoutMs: 200 },
        );
        expect(timed.results[0]?.timedOut).toBe(true);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        const aborted = await runHooks(
            'Stop',
            [matched(command('sleep 5'))],
            {},
            { cwd: dir, env: baseEnv, signal: controller.signal },
        );
        expect(aborted.results[0]).toMatchObject({ error: 'aborted', timedOut: false });
    });

    it('never runs untrusted hooks', async () => {
        const dir = await temporaryDir();
        const outcome = await runHooks(
            'PreToolUse',
            [matched(command('touch ran.txt; exit 2'), { trusted: false, origin: 'project' })],
            {},
            { cwd: dir, env: baseEnv },
        );
        expect(outcome.blocked).toBe(false);
        expect(outcome.results[0]).toMatchObject({ skipped: 'untrusted', exitCode: null, durationMs: 0 });
        await expect(readFile(path.join(dir, 'ran.txt'))).rejects.toThrow();
    });

    it('reports a missing program as a failure', async () => {
        const outcome = await runHooks(
            'PreToolUse',
            [matched(command('/definitely/missing/program', { args: [] }))],
            {},
            await options(),
        );
        expect(outcome.results[0]?.error).toMatch(/^could not start: /);
        expect(outcome.blocked).toBe(false);
    });
});

describe('runHooks with http hooks', () => {
    let close: (() => Promise<void>) | undefined;

    afterEach(async () => {
        await close?.();
        close = undefined;
    });

    async function serve(
        handler: (request: IncomingMessage, body: string, response: ServerResponse) => void,
    ): Promise<string> {
        const server = createServer((request, response) => {
            let body = '';
            request.on('data', (chunk: Buffer) => {
                body += chunk.toString('utf8');
            });
            request.on('end', () => handler(request, body, response));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        close = () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            });
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    it('posts the event and applies the JSON answer', async () => {
        const seen: { body?: unknown; headers?: IncomingMessage['headers'] } = {};
        const url = await serve((request, body, response) => {
            seen.body = JSON.parse(body);
            seen.headers = request.headers;
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ decision: 'block', reason: 'remote policy' }));
        });
        const hook = matched({
            type: 'http',
            url: `${url}/hook`,
            headers: { authorization: 'Bearer $HOOK_TOKEN', 'x-other': `${placeholder('NOT_ALLOWED')}x` },
            allowedEnvVars: ['HOOK_TOKEN'],
        });
        const outcome = await runHooks(
            'PreToolUse',
            [hook],
            { tool_name: 'Edit' },
            { cwd: '/work', env: { HOOK_TOKEN: 'abc', NOT_ALLOWED: 'leak' } },
        );
        expect(outcome).toMatchObject({ blocked: true, reason: 'remote policy' });
        expect(outcome.results[0]).toMatchObject({ status: 200, exitCode: null });
        expect(seen.body).toEqual({ tool_name: 'Edit', hook_event_name: 'PreToolUse', cwd: '/work' });
        expect(seen.headers?.authorization).toBe('Bearer abc');
        expect(seen.headers?.['x-other']).toBe('x');
        expect(seen.headers?.['content-type']).toBe('application/json');
    });

    it('treats bad statuses, redirects and plain text as non-blocking errors', async () => {
        const url = await serve((request, _body, response) => {
            if (request.url === '/fail') {
                response.writeHead(500).end('boom');
            } else if (request.url === '/redirect') {
                response.writeHead(302, { location: '/ok' }).end();
            } else if (request.url === '/text') {
                response.writeHead(200).end('not json');
            } else {
                response.writeHead(200).end();
            }
        });
        const outcome = await runHooks(
            'PreToolUse',
            ['/fail', '/redirect', '/text', '/ok'].map((route) => matched({ type: 'http', url: `${url}${route}` })),
            {},
            { cwd: '/work', env: {} },
        );
        expect(outcome.blocked).toBe(false);
        expect(outcome.results.map((result) => [result.status, result.error])).toEqual([
            [500, 'HTTP 500'],
            [302, 'HTTP 302'],
            [200, 'response is not a JSON object'],
            [200, undefined],
        ]);
    });

    it('times out a server that does not answer', async () => {
        const url = await serve(() => {
            // Never answers.
        });
        const outcome = await runHooks(
            'Stop',
            [matched({ type: 'http', url, timeout: 0.2, onFailure: 'block' })],
            {},
            { cwd: '/work', env: {} },
        );
        expect(outcome.results[0]).toMatchObject({ timedOut: true, error: 'timed out after 200 ms' });
        expect(outcome).toMatchObject({ blocked: true, reason: 'hook failed: timed out after 200 ms' });
    });

    it('does not call untrusted http hooks', async () => {
        let called = false;
        const url = await serve((_request, _body, response) => {
            called = true;
            response.end();
        });
        const outcome = await runHooks(
            'PreToolUse',
            [matched({ type: 'http', url }, { trusted: false })],
            {},
            { cwd: '/work', env: {} },
        );
        expect(outcome.results[0]?.skipped).toBe('untrusted');
        expect(called).toBe(false);
    });
});

it('returns a neutral outcome when no hook matched', async () => {
    const dir = await temporaryDir();
    const outcome = await runHooks('Stop', [], {}, { cwd: dir, env: {} });
    expect(outcome).toEqual({ blocked: false, stop: false, messages: [], results: [] });
});
