import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASH_MAX_OUTPUT_CHARS, bashKillTool, bashOutputTool, bashTool, ShellJob } from '../src/index.ts';
import { OutputCapture, shellInvocation } from '../src/shell.ts';
import { eventually, isWindows, makeContext, processExists, runTool, temporaryDir } from './helpers.ts';

/** Reads a pid that a command wrote to `file`, waiting for it to appear. */
async function readPid(file: string): Promise<number> {
    let pid = Number.NaN;
    await eventually(async () => {
        pid = Number.parseInt(await readFile(file, 'utf8').catch(() => ''), 10);
        return Number.isInteger(pid);
    });
    return pid;
}

describe('shellInvocation', () => {
    it('runs PowerShell with an encoded command on Windows', () => {
        const invocation = shellInvocation('Get-ChildItem "C:\\a b" | Select -First 1', undefined, {}, 'win32');
        expect(invocation.file).toBe('powershell.exe');
        expect(invocation.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
        const script = Buffer.from(invocation.args[3] ?? '', 'base64').toString('utf16le');
        expect(script.endsWith('Get-ChildItem "C:\\a b" | Select -First 1')).toBe(true);
        expect(script).toContain('[System.Text.Encoding]::UTF8');
        expect(script).toContain("$ProgressPreference = 'SilentlyContinue'");
    });

    it('honours a configured shell', () => {
        expect(shellInvocation('dir', 'C:\\Windows\\System32\\cmd.exe', {}, 'win32')).toEqual({
            file: 'C:\\Windows\\System32\\cmd.exe',
            args: ['/d', '/s', '/c', '"dir"'],
            verbatim: true,
        });
        expect(shellInvocation('ls', 'C:\\Program Files\\Git\\bin\\bash.exe', {}, 'win32').args).toEqual(['-c', 'ls']);
        expect(shellInvocation('ls', '/opt/bin/zsh', {}, 'linux')).toEqual({
            file: '/opt/bin/zsh',
            args: ['-c', 'ls'],
            verbatim: false,
        });
    });

    it('falls back to bash or sh when $SHELL is not a POSIX shell', () => {
        const invocation = shellInvocation('ls', undefined, { SHELL: '/usr/local/bin/fish' }, 'linux');
        expect(['/bin/bash', '/bin/sh']).toContain(invocation.file);
        expect(invocation.args).toEqual(['-c', 'ls']);
    });
});

describe('OutputCapture', () => {
    it('keeps everything below the limit', () => {
        const capture = new OutputCapture(100);
        capture.append('abc');
        capture.append('def');
        expect(capture.text()).toBe('abcdef');
        expect(capture.total).toBe(6);
    });

    it('keeps the head and the tail beyond the limit', () => {
        const capture = new OutputCapture(10);
        for (const chunk of ['01234', '56789', 'abcde', 'fghij', 'KLMNO']) {
            capture.append(chunk);
        }
        expect(capture.total).toBe(25);
        expect(capture.text()).toBe('01234\n[... 15 characters not kept ...]\nKLMNO');
    });
});

describe('bash', () => {
    it('runs a command and reports its output', async () => {
        const root = await temporaryDir();
        const ctx = await makeContext(root);
        const result = await runTool(bashTool, { command: 'echo hello' }, ctx);
        expect(result.content).toBe('hello');
        expect(result.isError).toBe(false);
        expect(result.display).toMatchObject({ kind: 'command', command: 'echo hello', exitCode: 0, truncated: false });
        expect(ctx.chunks.join('')).toContain('hello');
    }, 30_000); // the first PowerShell start on a fresh Windows machine takes seconds

    it('reports a non-zero exit code', async () => {
        const result = await runTool(bashTool, { command: 'exit 3' }, await makeContext(await temporaryDir()));
        expect(result.isError).toBe(true);
        expect(result.content).toBe('(no output)\n\nExit code 3');
        expect(result.display).toMatchObject({ exitCode: 3 });
    });

    it('refuses to start when aborted or without a working directory', async () => {
        const root = await temporaryDir();
        const aborted = await makeContext(root);
        aborted.controller.abort();
        expect(await runTool(bashTool, { command: 'echo hi' }, aborted)).toMatchObject({
            isError: true,
            content: 'Aborted before the command started.',
        });
        const missing = await makeContext(path.join(root, 'gone'));
        expect((await runTool(bashTool, { command: 'echo hi' }, missing)).content).toContain('does not exist');
    });

    it('reports a shell that cannot be started', async () => {
        const root = await temporaryDir();
        const ctx = await makeContext(root, { shell: path.join(root, 'no-such-shell') });
        const result = await runTool(bashTool, { command: 'echo hi' }, ctx);
        expect(result.isError).toBe(true);
        expect(result.content).toContain('Could not start the shell');
    });

    it('describes itself', () => {
        expect(bashTool.title({ command: 'npm test', description: 'Run the tests' })).toBe('Run the tests');
        expect(bashTool.title({ command: 'npm test\nnpm run lint' })).toBe('Run npm test …');
        expect(bashTool.targets({ command: 'rm -rf /' }, { cwd: '/' })).toEqual([]);
        expect(bashTool.readOnly).toBe(false);
        expect(bashTool.schema.safeParse({ command: '' }).success).toBe(false);
    });

    describe.skipIf(isWindows)('on unix', () => {
        it('interleaves stdout and stderr in arrival order and runs in the working directory', async () => {
            const root = await temporaryDir();
            const ctx = await makeContext(root, { env: { ...process.env, XORA_TEST_VAR: 'from-env' } });
            const result = await runTool(
                bashTool,
                { command: 'echo out1; sleep 0.1; echo err1 >&2; sleep 0.1; echo out2; pwd; echo "$XORA_TEST_VAR"' },
                ctx,
            );
            expect(result.content).toBe(`out1\nerr1\nout2\n${root}\nfrom-env`);
        });

        it('kills the whole process tree on timeout', async () => {
            const root = await temporaryDir();
            const pidFile = path.join(root, 'child.pid');
            const started = Date.now();
            const result = await runTool(
                bashTool,
                { command: `sleep 30 & echo $! > "${pidFile}"; wait`, timeoutMs: 400 },
                await makeContext(root),
            );
            expect(Date.now() - started).toBeLessThan(5000);
            expect(result.isError).toBe(true);
            expect(result.content).toContain('The command timed out after 400 ms and was stopped.');
            const pid = await readPid(pidFile);
            expect(await eventually(() => !processExists(pid))).toBe(true);
        });

        it('kills the whole process tree on abort', async () => {
            const root = await temporaryDir();
            const pidFile = path.join(root, 'child.pid');
            const ctx = await makeContext(root);
            const pending = runTool(bashTool, { command: `sleep 30 & echo $! > "${pidFile}"; wait` }, ctx);
            const pid = await readPid(pidFile);
            ctx.controller.abort();
            const result = await pending;
            expect(result.isError).toBe(true);
            expect(result.content).toContain('The command was aborted.');
            expect(await eventually(() => !processExists(pid))).toBe(true);
        });

        it('cuts long output in the middle and saves the full text as an artifact', async () => {
            const root = await temporaryDir();
            const ctx = await makeContext(root);
            const script = "process.stdout.write('a'.repeat(30000) + 'MIDDLE' + 'z'.repeat(30000))";
            const result = await runTool(bashTool, { command: `"${process.execPath}" -e "${script}"` }, ctx);
            expect(result.display).toMatchObject({ kind: 'command', truncated: true, exitCode: 0 });
            const saved = ctx.saved[0];
            expect(saved).toBeDefined();
            expect(result.display).toMatchObject({ artifactPath: saved?.path });
            expect(await readFile(saved?.path ?? '', 'utf8')).toHaveLength(60006);
            expect(result.content).toContain('characters truncated');
            expect(result.content).not.toContain('MIDDLE');
            expect(result.content).toContain(
                `The output had 60006 characters, so its middle was cut. The full output is in ${saved?.path}`,
            );
            if (result.display?.kind === 'command') {
                expect(result.display.output.length).toBeLessThanOrEqual(BASH_MAX_OUTPUT_CHARS);
            }
        });

        it('runs background jobs and reports their output incrementally', async () => {
            const root = await temporaryDir();
            const ctx = await makeContext(root);
            const started = await runTool(
                bashTool,
                { command: 'echo started; sleep 1; echo finished', background: true },
                ctx,
            );
            expect(started.content).toBe(
                'Started background job job-1. Read its output with bash_output (jobId "job-1") and stop it with bash_kill.',
            );
            expect(started.display).toMatchObject({ kind: 'command', exitCode: null, background: { jobId: 'job-1' } });
            const job = ctx.jobs.get('job-1');
            expect(job).toBeInstanceOf(ShellJob);
            expect(await eventually(() => job?.output().includes('started') === true)).toBe(true);

            const early = await runTool(bashOutputTool, { jobId: 'job-1' }, ctx);
            expect(early.content).toMatch(
                /^Job job-1 is running \(started .+ ago\)\.\nNew output since the last check:\nstarted$/,
            );

            await (job as ShellJob).wait();
            const done = await runTool(bashOutputTool, { jobId: 'job-1' }, ctx);
            expect(done.content).toMatch(
                /^Job job-1 exited with code 0 after .+\.\nNew output since the last check:\nfinished$/,
            );
            expect(done.display).toMatchObject({ exitCode: 0, background: { jobId: 'job-1' } });
            const again = await runTool(bashOutputTool, { jobId: 'job-1' }, ctx);
            expect(again.content.endsWith('No new output since the last check.')).toBe(true);
            expect(job?.output()).toBe('started\nfinished\n');

            const kill = await runTool(bashKillTool, { jobId: 'job-1' }, ctx);
            expect(kill.content.endsWith('Nothing to stop.')).toBe(true);
        });

        it('reports how a failed background job ended', async () => {
            const ctx = await makeContext(await temporaryDir());
            await runTool(bashTool, { command: 'echo boom >&2; exit 4', background: true }, ctx);
            await (ctx.jobs.get('job-1') as ShellJob).wait();
            const result = await runTool(bashOutputTool, { jobId: 'job-1' }, ctx);
            expect(result.content).toMatch(
                /^Job job-1 exited with code 4 after .+\.\nNew output since the last check:\nboom$/,
            );
            expect(result.display).toMatchObject({ exitCode: 4, background: { jobId: 'job-1' } });
        });

        it('reports a background shell that cannot start', async () => {
            const root = await temporaryDir();
            const ctx = await makeContext(root, { shell: path.join(root, 'no-such-shell') });
            const started = await runTool(bashTool, { command: 'echo hi', background: true }, ctx);
            expect(started.content.startsWith('Started background job job-1.')).toBe(true);
            await (ctx.jobs.get('job-1') as ShellJob).wait();
            const result = await runTool(bashOutputTool, { jobId: 'job-1' }, ctx);
            expect(result.content).toMatch(
                /^Job job-1 could not start: .*ENOENT.*\.\nNo new output since the last check\.$/,
            );
        });

        it('stops a background job together with its children', async () => {
            const root = await temporaryDir();
            const pidFile = path.join(root, 'bg.pid');
            const ctx = await makeContext(root);
            await runTool(bashTool, { command: `sleep 30 & echo $! > "${pidFile}"; wait`, background: true }, ctx);
            const second = await runTool(bashTool, { command: 'sleep 30', background: true }, ctx);
            expect(second.display).toMatchObject({ background: { jobId: 'job-2' } });
            const pid = await readPid(pidFile);
            const result = await runTool(bashKillTool, { jobId: 'job-1' }, ctx);
            expect(result.content).toBe('Stopped job job-1.');
            expect(await eventually(() => !processExists(pid))).toBe(true);
            const status = await runTool(bashOutputTool, { jobId: 'job-1' }, ctx);
            expect(status.content).toMatch(/^Job job-1 was stopped with bash_kill after .+\./);
            expect(ctx.jobs.get('job-2')?.running).toBe(true);
        });
    });

    it('rejects unknown job ids', async () => {
        const ctx = await makeContext(await temporaryDir());
        expect(await runTool(bashOutputTool, { jobId: 'job-9' }, ctx)).toEqual({
            content: 'There is no background job job-9.',
            isError: true,
        });
        expect((await runTool(bashKillTool, { jobId: 'job-9' }, ctx)).isError).toBe(true);
    });

    it.runIf(isWindows)('runs PowerShell commands on Windows', async () => {
        const result = await runTool(
            bashTool,
            { command: 'Write-Output "héllo"; exit 2' },
            await makeContext(await temporaryDir()),
        );
        expect(result.content).toBe('héllo\n\nExit code 2');
    });
});
