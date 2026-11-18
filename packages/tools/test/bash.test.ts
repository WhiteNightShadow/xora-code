import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    BASH_MAX_OUTPUT_CHARS,
    backgroundJobOf,
    bashKillTool,
    bashOutputTool,
    bashTool,
    createBashTool,
    jobStateIn,
    renderTerminalText,
    ShellJob,
} from '../src/index.ts';
import { OutputLog, shellInvocation } from '../src/shell.ts';
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

describe('OutputLog', () => {
    it('keeps everything below the limits', () => {
        const log = new OutputLog({ head: 50, tail: 50 });
        log.append('abc');
        log.append('def');
        expect(log.text()).toBe('abcdef');
        expect(log.total).toBe(6);
        expect(log.dropped).toBe(false);
    });

    it('keeps the head and the tail beyond them', () => {
        const log = new OutputLog({ head: 5, tail: 5 });
        for (const chunk of ['01234', '56789', 'abcde', 'fghij', 'KLMNO']) {
            log.append(chunk);
        }
        expect(log.total).toBe(25);
        expect(log.dropped).toBe(true);
        expect(log.text()).toBe('01234\n[... 15 characters not kept ...]\nKLMNO');
    });

    it('gives what came after a point, and how much of that is gone', () => {
        const log = new OutputLog({ head: 0, tail: 6 });
        log.append('abc');
        expect(log.since(0)).toEqual({ text: 'abc', dropped: 0 });
        log.append('def');
        expect(log.since(3)).toEqual({ text: 'def', dropped: 0 });
        expect(log.since(6)).toEqual({ text: '', dropped: 0 });
        log.append('0123456789');
        expect(log.since(6)).toEqual({ text: '456789', dropped: 4 });
        // With a head: what is asked for may start in it.
        const both = new OutputLog({ head: 4, tail: 4 });
        both.append('head');
        both.append('-middle-');
        both.append('tail');
        expect(both.since(2)).toEqual({ text: 'adtail', dropped: 8 });
        expect(both.since(14)).toEqual({ text: 'il', dropped: 0 });
    });
});

describe('renderTerminalText', () => {
    it('leaves plain output as it is', () => {
        const text = 'one\n  two\t2\n\n\nthree\n';
        expect(renderTerminalText(text)).toBe(text);
    });

    it('plays out carriage returns, backspaces and erasing, as a terminal does', () => {
        expect(renderTerminalText('start\n\r 10%\r 50%\r100%\ndone')).toBe('start\n100%\ndone');
        // A shorter text over a longer one leaves its end, unless the line is erased first.
        expect(renderTerminalText('downloading\rdone')).toBe('doneloading');
        expect(renderTerminalText('downloading\r\x1b[Kdone')).toBe('done');
        expect(renderTerminalText('downloading\x1b[2K\rdone')).toBe('done');
        expect(renderTerminalText('working |\b/\b-\b\\\b ok')).toBe('working  ok');
        // The line ending of Windows is a line ending, not a return to the start of the line.
        expect(renderTerminalText('a\r\nb\r\n')).toBe('a\nb\n');
    });

    it('follows the cursor where a program moves it instead of returning the carriage', () => {
        // What `readline.clearLine` and `cursorTo(0)` write, a frame at a time.
        expect(renderTerminalText('\x1b[2K\x1b[1G 10%\x1b[2K\x1b[1G 50%\x1b[2K\x1b[1G100%\n')).toBe('100%\n');
        expect(renderTerminalText('\x1b[1Gdownloading\x1b[0K\x1b[1Gdone\x1b[0K')).toBe('done');
        expect(renderTerminalText('abcdef\x1b[3Dxy')).toBe('abcxyf');
        expect(renderTerminalText('ab\x1b[3Cc')).toBe('ab   c');
        expect(renderTerminalText('abcdef\x1b[4G\x1b[1K!')).toBe('   !ef');
        // As far right as it goes is the width of a terminal, not a billion columns.
        expect(renderTerminalText('a\x1b[999999999Cb').length).toBeLessThan(1000);
    });

    it('takes time in proportion to the output, however often a line is cleared', () => {
        // Frames that clear the line and never move back: each starts where the one before ended.
        const frames = (count: number): string => '\x1b[2Kframe 0123456789'.repeat(count);
        const timed = (count: number): number => {
            const started = performance.now();
            renderTerminalText(frames(count));
            return performance.now() - started;
        };
        timed(2000);
        const small = timed(20_000);
        const large = timed(80_000);
        // Four times the frames: four times the work, far from the sixteen of clearing the whole line every time.
        expect(large).toBeLessThan(Math.max(small * 10, 400));
        expect(renderTerminalText(frames(3)).trimStart()).toBe('frame 0123456789');
    });

    it('drops colour and other escape sequences and stray control characters', () => {
        expect(renderTerminalText('\x1b[1;31merror\x1b[0m: \x1b[4mfile\x1b[24m\x07')).toBe('error: file');
        expect(renderTerminalText('\x1b]0;window title\x07prompt\x1b(B')).toBe('prompt');
        expect(renderTerminalText('\x1b]8;;https://a.example\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
        expect(renderTerminalText('中文\x1b[32m 完成\x1b[0m 😀')).toBe('中文 完成 😀');
    });

    it('prints a line that comes many times in a row once, with the count', () => {
        expect(renderTerminalText('a\nretry\nretry\nretry\nb')).toBe('a\nretry\nretry\nretry\nb');
        expect(renderTerminalText(`a\n${'retry\n'.repeat(40)}b`)).toBe(
            'a\nretry\n[... the line above 40 times in a row; 39 repeats left out ...]\nb',
        );
        // Blank lines are layout, not repetition.
        expect(renderTerminalText('a\n\n\n\n\n\nb')).toBe('a\n\n\n\n\n\nb');
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
        // Checking on a job and stopping one never ask: they only touch what an allowed command started. Stopping
        // changes something all the same: it runs in its turn, not alongside the calls around it.
        expect(bashOutputTool.readOnly).toBe(true);
        expect(bashKillTool).toMatchObject({ readOnly: false, unasked: true });
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
                /^Job job-1 is running \(started .+ ago\)\.\nNew output since the last check:\nstarted\n\(Still running; bash_output with waitMs waits for it to finish\.\)$/,
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
            // How the command ended is what this call reports, as `bash` does for a command it waited for.
            expect(result.isError).toBe(true);
            expect(result.display).toMatchObject({ exitCode: 4, background: { jobId: 'job-1', running: false } });
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

        it('leaves a command that outlasts the wait running, and takes it up again as a job', async () => {
            const root = await temporaryDir();
            const ctx = await makeContext(root);
            const quick = createBashTool({ foregroundMs: 300 });
            const started = Date.now();
            const result = await runTool(quick, { command: 'echo first; sleep 1.2; echo second; exit 3' }, ctx);
            expect(Date.now() - started).toBeLessThan(1000);
            expect(result.isError).toBeUndefined();
            expect(result.content).toBe(
                'first\n\nThe command is still running after 300 ms: it was not stopped and carries on in the background as job-1. What is above is its output so far, not its result. Wait for it with bash_output (jobId "job-1" and waitMs, up to 600000), or stop it with bash_kill.',
            );
            expect(result.display).toMatchObject({
                kind: 'command',
                exitCode: null,
                background: { jobId: 'job-1', running: true },
            });
            expect(backgroundJobOf(result.content)).toBe('job-1');
            expect(ctx.jobs.get('job-1')?.running).toBe(true);
            // The call that waited gets no more of its output.
            const live = ctx.chunks.length;

            const early = await runTool(bashOutputTool, { jobId: 'job-1' }, ctx);
            expect(early.isError).toBeUndefined();
            expect(jobStateIn(early.content)).toBe('running');
            const done = await runTool(bashOutputTool, { jobId: 'job-1', waitMs: 10_000 }, ctx);
            expect(Date.now() - started).toBeLessThan(5000);
            expect(done.content).toMatch(
                /^Job job-1 exited with code 3 after .+\.\nNew output since the last check:\nsecond$/,
            );
            // The command failed: said by the call that learns of it.
            expect(done.isError).toBe(true);
            expect(jobStateIn(done.content)).toBe('ended');
            expect(done.display).toMatchObject({ exitCode: 3, background: { jobId: 'job-1', running: false } });
            expect(ctx.chunks.length).toBe(live);
            // The next command is another job.
            const next = await runTool(quick, { command: 'sleep 5' }, ctx);
            expect(next.display).toMatchObject({ background: { jobId: 'job-2' } });
        });

        it('saves output that is cut in full when the command is left running, and when a job is checked on', async () => {
            const ctx = await makeContext(await temporaryDir());
            const script =
                "process.stdout.write('a'.repeat(30000) + 'MIDDLE' + 'z'.repeat(30000)); setTimeout(() => process.stdout.write('b'.repeat(30000) + 'CENTRE' + 'y'.repeat(30000)), 900)";
            const result = await runTool(
                createBashTool({ foregroundMs: 400 }),
                { command: `"${process.execPath}" -e "${script}"` },
                ctx,
            );
            expect(result.content).not.toContain('MIDDLE');
            expect(result.content).toContain(
                `The output so far had 60006 characters, so its middle was cut. The full output is in ${ctx.saved[0]?.path}`,
            );
            expect(result.content).toContain('carries on in the background as job-1');
            expect(result.display).toMatchObject({ truncated: true, artifactPath: ctx.saved[0]?.path });
            expect(await readFile(ctx.saved[0]?.path ?? '', 'utf8')).toContain('aMIDDLEz');

            const done = await runTool(bashOutputTool, { jobId: 'job-1', waitMs: 10_000 }, ctx);
            expect(done.content).toMatch(/^Job job-1 exited with code 0/);
            expect(done.content).not.toContain('CENTRE');
            expect(done.content).toContain(
                `This output had 60006 characters, so its middle was cut. The full output is in ${ctx.saved[1]?.path}`,
            );
            expect(await readFile(ctx.saved[1]?.path ?? '', 'utf8')).toContain('bCENTREy');
            expect(done.display).toMatchObject({ truncated: true, artifactPath: ctx.saved[1]?.path });
        });

        it('stops what a turn left running when the turn is stopped, but not a job started for the background', async () => {
            const root = await temporaryDir();
            const pidFile = path.join(root, 'left.pid');
            const ctx = await makeContext(root);
            await runTool(bashTool, { command: 'sleep 30', background: true }, ctx);
            const left = await runTool(
                createBashTool({ foregroundMs: 300 }),
                { command: `sleep 30 & echo $! > "${pidFile}"; wait` },
                ctx,
            );
            expect(left.content).toContain('carries on in the background as job-2');
            const pid = await readPid(pidFile);
            expect(processExists(pid)).toBe(true);
            // The user stops the turn while the model is elsewhere.
            ctx.controller.abort();
            expect(await eventually(() => !processExists(pid))).toBe(true);
            expect(await eventually(() => ctx.jobs.get('job-2')?.running === false)).toBe(true);
            expect(ctx.jobs.get('job-1')?.running).toBe(true);
        });

        it('stops a command at its own timeout, however long the wait would be', async () => {
            const ctx = await makeContext(await temporaryDir());
            const result = await runTool(
                createBashTool({ foregroundMs: 30_000 }),
                { command: 'sleep 30', timeoutMs: 300 },
                ctx,
            );
            expect(result.isError).toBe(true);
            expect(result.content).toContain('The command timed out after 300 ms and was stopped.');
            expect(ctx.jobs.list()).toEqual([]);
        });

        it('waits for a job only as long as asked, and not at all for one that has ended', async () => {
            const ctx = await makeContext(await temporaryDir());
            await runTool(bashTool, { command: 'sleep 30', background: true }, ctx);
            const started = Date.now();
            const waiting = await runTool(bashOutputTool, { jobId: 'job-1', waitMs: 300 }, ctx);
            expect(Date.now() - started).toBeGreaterThanOrEqual(250);
            expect(Date.now() - started).toBeLessThan(3000);
            expect(waiting.content).toMatch(/^Job job-1 is running/);
            // A cancelled turn ends the wait.
            const pending = runTool(bashOutputTool, { jobId: 'job-1', waitMs: 60_000 }, ctx);
            ctx.controller.abort();
            expect((await pending).content).toMatch(/^Job job-1 is running/);
            expect(bashOutputTool.schema.safeParse({ jobId: 'job-1', waitMs: 600_001 }).success).toBe(false);
        });

        it('shows output as a terminal would, and keeps commands from waiting for a person', async () => {
            const ctx = await makeContext(await temporaryDir());
            const result = await runTool(
                bashTool,
                {
                    command:
                        "printf 'start\\n'; for i in 20 40 60 80 100; do printf '\\r%s%%' $i; done; printf '\\n\\033[31mred\\033[0m\\n'; for i in 1 2 3 4 5 6; do echo same; done",
                },
                ctx,
            );
            expect(result.content).toBe(
                'start\n100%\nred\nsame\n[... the line above 6 times in a row; 5 repeats left out ...]',
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
            expect(jobStateIn(result.content)).toBe('stopped');
            expect(result.display).toMatchObject({ background: { jobId: 'job-1', running: false } });
            expect(await eventually(() => !processExists(pid))).toBe(true);
            const status = await runTool(bashOutputTool, { jobId: 'job-1' }, ctx);
            expect(status.content).toMatch(/^Job job-1 was stopped with bash_kill after .+\./);
            expect(jobStateIn(status.content)).toBe('stopped');
            // Stopped on request is not a failure.
            expect(status.isError).toBeUndefined();
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
