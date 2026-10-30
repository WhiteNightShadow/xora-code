import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { nextJobId, ShellJob } from '../jobs.ts';
import { type CommandRun, runCommand } from '../shell.ts';
import { truncateMiddle } from '../truncate.ts';
import type { BackgroundJob, ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { errorResult } from './shared.ts';

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
/** Output beyond this is cut in the middle for the model; the full text goes to an artifact. */
export const BASH_MAX_OUTPUT_CHARS = 30_000;
/** Output kept in memory per command; see `OutputCapture`. */
const CAPTURE_LIMIT = 8_000_000;
/** How long `bash_kill` waits for a job to exit; the escalation to SIGKILL happens after two seconds. */
const KILL_WAIT_MS = 3000;

function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms} ms`;
    }
    const seconds = ms / 1000;
    if (seconds < 60) {
        return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
    }
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}m ${total % 60}s`;
}

function describeEnd(run: CommandRun, timeoutMs: number): string | null {
    if (run.timedOut) {
        return `The command timed out after ${formatDuration(timeoutMs)} and was stopped. Run long-lived processes with background: true.`;
    }
    if (run.aborted) {
        return 'The command was aborted.';
    }
    if (run.signal !== null) {
        return `The command was terminated by ${run.signal}.`;
    }
    return run.exitCode === 0 ? null : `Exit code ${run.exitCode}`;
}

const BashInput = z.object({
    command: z.string().min(1).describe('The command to run'),
    timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Timeout in milliseconds (default ${BASH_DEFAULT_TIMEOUT_MS}, at most ${BASH_MAX_TIMEOUT_MS})`),
    description: z
        .string()
        .optional()
        .describe('What the command does in a few words, shown to the user, e.g. "Run the unit tests"'),
    background: z
        .boolean()
        .optional()
        .describe('Start the command as a background job and return at once, for servers and watchers'),
});

export type BashInput = z.infer<typeof BashInput>;

function startJob(input: BashInput, ctx: ToolContext): ToolResult {
    const id = nextJobId(ctx.jobs);
    let job: ShellJob;
    try {
        job = new ShellJob(id, { command: input.command, cwd: ctx.cwd, env: ctx.env, shell: ctx.shell });
    } catch (error) {
        return errorResult(`Could not start the shell: ${error instanceof Error ? error.message : String(error)}`);
    }
    ctx.jobs.add(job);
    return {
        content: `Started background job ${id}. Read its output with bash_output (jobId "${id}") and stop it with bash_kill.`,
        display: {
            kind: 'command',
            command: input.command,
            exitCode: null,
            output: '',
            truncated: false,
            durationMs: 0,
            background: { jobId: id },
        },
    };
}

async function runBash(input: BashInput, ctx: ToolContext): Promise<ToolResult> {
    try {
        if (!(await stat(ctx.cwd)).isDirectory()) {
            return errorResult(`The working directory ${ctx.cwd} is not a directory.`);
        }
    } catch {
        return errorResult(`The working directory ${ctx.cwd} does not exist.`);
    }
    if (ctx.signal.aborted) {
        return errorResult('Aborted before the command started.');
    }
    if (input.background === true) {
        return startJob(input, ctx);
    }
    const timeoutMs = Math.min(input.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS);
    const run = await runCommand({
        command: input.command,
        cwd: ctx.cwd,
        env: ctx.env,
        shell: ctx.shell,
        timeoutMs,
        signal: ctx.signal,
        onOutput: ctx.onOutput,
        captureLimit: CAPTURE_LIMIT,
    });
    if (run.error !== undefined) {
        return errorResult(`Could not start the shell: ${run.error}`);
    }
    const truncated = run.output.length > BASH_MAX_OUTPUT_CHARS || run.outputChars > run.output.length;
    let artifactPath: string | undefined;
    if (truncated) {
        try {
            artifactPath = await ctx.artifacts.save(`bash-output-${Date.now()}.log`, run.output);
        } catch {
            // The excerpt still goes out; only the pointer to the full text is missing.
        }
    }
    const shown = truncateMiddle(run.output, BASH_MAX_OUTPUT_CHARS);
    const parts = [shown.trimEnd() === '' ? '(no output)' : shown.trimEnd()];
    const end = describeEnd(run, timeoutMs);
    if (end !== null) {
        parts.push(end);
    }
    if (artifactPath !== undefined) {
        parts.push(
            `The output had ${run.outputChars} characters, so its middle was cut. The full output is in ${artifactPath}; read it with the read tool (offset/limit) or search it with grep.`,
        );
    }
    return {
        content: parts.join('\n\n'),
        isError: run.timedOut || run.aborted || run.exitCode !== 0,
        display: {
            kind: 'command',
            command: input.command,
            exitCode: run.exitCode,
            output: shown,
            truncated,
            ...(artifactPath === undefined ? {} : { artifactPath }),
            durationMs: run.durationMs,
        },
    };
}

export const bashTool: ToolDefinition<BashInput> = {
    name: 'bash',
    description: [
        `Run a shell command in the working directory (bash or zsh on macOS and Linux, PowerShell on Windows) and return its stdout and stderr, interleaved. Each call starts a new shell, so \`cd\` and variables do not carry over: use absolute paths or \`cd dir && …\`. Default timeout ${BASH_DEFAULT_TIMEOUT_MS} ms (at most ${BASH_MAX_TIMEOUT_MS}); output over ${BASH_MAX_OUTPUT_CHARS} characters is cut in the middle and saved in full to a file you can read.`,
        '- Use the dedicated tools instead of shell equivalents: `read` rather than cat/head/tail, `grep` rather than grep/rg, `glob` or `list` rather than find/ls, `edit` or `write` rather than sed or echo redirection.',
        '- Commands get no input: avoid interactive programs and pass non-interactive flags (e.g. `--yes`). Quote paths that contain spaces; chain dependent commands with `&&`.',
        '- For servers, watchers and other long-running processes set `background: true` instead of appending `&`, then use `bash_output` to read their output and `bash_kill` to stop them.',
        '- Set `description` to a few words on what the command does.',
    ].join('\n'),
    kind: 'execute',
    schema: BashInput,
    readOnly: false,
    targets: () => [],
    title: (input) => {
        if (input.description !== undefined && input.description.trim() !== '') {
            return input.description.trim();
        }
        const firstLine = input.command.split('\n')[0] ?? '';
        const short = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
        return `Run ${short}${input.command.includes('\n') ? ' …' : ''}`;
    },
    run: runBash,
};

function jobStatus(job: BackgroundJob): string {
    if (job.running) {
        return `Job ${job.id} is running (started ${formatDuration(Date.now() - job.startedAt)} ago).`;
    }
    const ran =
        job instanceof ShellJob && job.endedAt !== undefined
            ? ` after ${formatDuration(job.endedAt - job.startedAt)}`
            : '';
    if (job instanceof ShellJob && job.error !== undefined) {
        return `Job ${job.id} could not start: ${job.error}.`;
    }
    if (job instanceof ShellJob && job.killed) {
        return `Job ${job.id} was stopped with bash_kill${ran}.`;
    }
    if (job instanceof ShellJob && job.signal !== null) {
        return `Job ${job.id} was terminated by ${job.signal}${ran}.`;
    }
    return `Job ${job.id} exited with code ${job.exitCode}${ran}.`;
}

function unknownJob(id: string, ctx: ToolContext): ToolResult {
    const known = ctx.jobs.list().map((job) => job.id);
    return errorResult(
        `There is no background job ${id}.${known.length > 0 ? ` Jobs of this session: ${known.join(', ')}.` : ''}`,
    );
}

function jobDisplay(job: BackgroundJob, output: string, truncated: boolean): ToolResult['display'] {
    return {
        kind: 'command',
        command: job.command,
        exitCode: job.exitCode,
        output,
        truncated,
        durationMs: Date.now() - job.startedAt,
        background: { jobId: job.id },
    };
}

const JobInput = z.object({
    jobId: z.string().min(1).describe('Id of the background job, as returned by bash'),
});

export type JobInput = z.infer<typeof JobInput>;

async function runBashOutput(input: JobInput, ctx: ToolContext): Promise<ToolResult> {
    const job = ctx.jobs.get(input.jobId);
    if (job === undefined) {
        return unknownJob(input.jobId, ctx);
    }
    const incremental = job instanceof ShellJob;
    const { text, dropped } = incremental ? job.readNew() : { text: job.output(), dropped: 0 };
    const shown = truncateMiddle(text, BASH_MAX_OUTPUT_CHARS);
    const lines = [jobStatus(job)];
    if (dropped > 0) {
        lines.push(`(${dropped} characters of output were discarded before they could be read.)`);
    }
    if (shown.trimEnd() === '') {
        lines.push(incremental ? 'No new output since the last check.' : 'No output yet.');
    } else {
        lines.push(incremental ? 'New output since the last check:' : 'Output so far:', shown.trimEnd());
    }
    return { content: lines.join('\n'), display: jobDisplay(job, shown, dropped > 0 || shown.length < text.length) };
}

export const bashOutputTool: ToolDefinition<JobInput> = {
    name: 'bash_output',
    description:
        'Check on a background job started by `bash` with `background: true`: returns whether it is still running (or its exit code) and the output it produced since the last check.',
    kind: 'execute',
    schema: JobInput,
    readOnly: true,
    targets: () => [],
    title: (input) => `Check ${input.jobId}`,
    run: runBashOutput,
};

async function runBashKill(input: JobInput, ctx: ToolContext): Promise<ToolResult> {
    const job = ctx.jobs.get(input.jobId);
    if (job === undefined) {
        return unknownJob(input.jobId, ctx);
    }
    if (!job.running) {
        return { content: `${jobStatus(job)} Nothing to stop.`, display: jobDisplay(job, '', false) };
    }
    job.kill();
    if (job instanceof ShellJob) {
        await Promise.race([job.wait(), delay(KILL_WAIT_MS, undefined, { ref: false })]);
    }
    return {
        content: job.running ? `Sent job ${job.id} a stop signal; it has not exited yet.` : `Stopped job ${job.id}.`,
        display: jobDisplay(job, '', false),
    };
}

export const bashKillTool: ToolDefinition<JobInput> = {
    name: 'bash_kill',
    description:
        'Stop a background job started by `bash` with `background: true`, together with the processes it started.',
    kind: 'execute',
    schema: JobInput,
    readOnly: false,
    targets: () => [],
    title: (input) => `Stop ${input.jobId}`,
    run: runBashKill,
};
