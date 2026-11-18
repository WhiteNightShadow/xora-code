import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { nextJobId, ShellJob } from '../jobs.ts';
import type { OutputLimits } from '../shell.ts';
import { renderTerminalText } from '../terminal.ts';
import { truncateMiddle } from '../truncate.ts';
import type { BackgroundJob, ToolContext, ToolDefinition, ToolResult } from '../types.ts';
import { errorResult } from './shared.ts';

/** How long `bash` waits for a command before it leaves it running as a background job. */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
/** Output beyond this is cut in the middle for the model; the full text goes to an artifact. */
export const BASH_MAX_OUTPUT_CHARS = 30_000;
/** Output kept in memory of a command `bash` waits for: its first and its newest four million characters. */
const FOREGROUND_OUTPUT: OutputLimits = { head: 4_000_000, tail: 4_000_000 };
/** How long a stopped job gets to exit before the answer goes out; the escalation to SIGKILL comes after two seconds. */
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

interface ShownOutput {
    /** What the model gets: as a terminal would show it, its middle cut out when it is long. */
    readonly text: string;
    /** Rendered terminal text before `BASH_MAX_OUTPUT_CHARS` cuts the middle out. */
    readonly fullText: string;
    readonly truncated: boolean;
    /** Where all of it is, when it was cut and could be saved. */
    readonly artifactPath?: string;
    /** What to tell the model about the cut; empty when there is none. */
    readonly note: string;
}

/**
 * A command's output as the model gets it. Whatever is cut out of it is saved whole first, on every way an output
 * reaches the model (a command that ended, one left running, a job being checked on): the part that was cut is not
 * handed out a second time.
 */
async function shownOutput(
    ctx: ToolContext,
    raw: string,
    produced: { readonly chars: number; readonly dropped: boolean },
    what = 'The output',
): Promise<ShownOutput> {
    const full = renderTerminalText(raw);
    const text = truncateMiddle(full, BASH_MAX_OUTPUT_CHARS);
    const truncated = text.length < full.length || produced.dropped;
    if (!truncated) {
        return { text, fullText: full, truncated, note: '' };
    }
    const size = produced.dropped ? produced.chars : full.length;
    try {
        const artifactPath = await ctx.artifacts.save(`bash-output-${Date.now()}.log`, full);
        return {
            text,
            fullText: full,
            truncated,
            artifactPath,
            note: `${what} had ${size} characters, so its middle was cut. The full output is in ${artifactPath}; read it with the read tool (offset/limit) or search it with grep.`,
        };
    } catch {
        // The excerpt still goes out; only the pointer to the full text is missing.
        return { text, fullText: full, truncated, note: `${what} had ${size} characters, so its middle was cut.` };
    }
}

/**
 * The job a `bash` result says its command runs on as: one started in the background, or left running because it
 * took long. For whoever keeps a record of commands from their results (the engine's task ledger): such a result is
 * no outcome yet.
 */
export function backgroundJobOf(content: string): string | undefined {
    return /(?:carries on in the background as|Started background job) (job-\d+)/.exec(content)?.[1];
}

/**
 * What a `bash_output` or `bash_kill` result says of its job: still `running`, `ended` by itself (the result is an
 * error when it failed), or `stopped` on request. Nothing for a result that says none of these.
 */
export function jobStateIn(content: string): 'running' | 'ended' | 'stopped' | undefined {
    const said =
        /^Job job-\d+ (is running|was stopped with bash_kill|exited|was terminated|could not start)|^(Stopped|Sent) job job-\d+/.exec(
            content,
        );
    if (!said) {
        return undefined;
    }
    if (said[1] === 'is running' || said[2] === 'Sent') {
        return 'running';
    }
    return said[1] === 'was stopped with bash_kill' || said[2] === 'Stopped' ? 'stopped' : 'ended';
}

const BashInput = z.object({
    command: z.string().min(1).describe('The command to run'),
    timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
            `Stop the command after this many milliseconds (at most ${BASH_MAX_TIMEOUT_MS}). Leave it out unless the command must not run longer: without it a command that takes long is not stopped but carries on as a background job`,
        ),
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

/** Another name for a time limit, and the unit it counts in; 0: the unit depends on the number. */
type LimitName = readonly [name: string, unit: number];

/** A bare number of this size or less can only be seconds: as milliseconds it is no time to run anything in. */
const SECONDS_AT_MOST = BASH_MAX_TIMEOUT_MS / 1000;
/** A bare number from here on can only be milliseconds: as seconds it is hours, with ten minutes the most allowed. */
const MILLISECONDS_FROM = 10_000;

/**
 * Brings a time limit sent the way other shell tools take it to `parameter`, in milliseconds. A bare `timeout` is
 * milliseconds in Claude Code's Bash and seconds in most others, so the number has to tell: up to 600 it is seconds,
 * from 10 000 on milliseconds. In between it reads both ways (`900`: fifteen minutes, or under a second), and
 * stopping a build after 0.9 seconds is not a guess to make; like a value that is no number (`"30s"`) it stays as it
 * was sent, a parameter the tool does not have, and the model is told. Zero and less mean no limit.
 */
function timeLimit(parameter: string, names: readonly LimitName[]) {
    return (input: Record<string, unknown>): Record<string, unknown> => {
        const rest = { ...input };
        for (const [name, unit] of names) {
            if (!Object.hasOwn(rest, name)) {
                continue;
            }
            const sent =
                typeof rest[name] === 'string' ? Number((rest[name] as string).trim() || Number.NaN) : rest[name];
            // Sent under its own name as well: that one stands.
            const own = rest[parameter] !== undefined && rest[parameter] !== null;
            if (own || rest[name] === null || rest[name] === '') {
                delete rest[name];
                continue;
            }
            if (typeof sent !== 'number' || !Number.isFinite(sent)) {
                continue;
            }
            const scale =
                unit !== 0 ? unit : sent <= SECONDS_AT_MOST ? 1000 : sent >= MILLISECONDS_FROM ? 1 : undefined;
            if (sent > 0 && scale === undefined) {
                continue;
            }
            delete rest[name];
            if (sent > 0 && scale !== undefined) {
                rest[parameter] = Math.min(Math.round(sent * scale), BASH_MAX_TIMEOUT_MS);
            }
        }
        return rest;
    };
}

const SECONDS: readonly LimitName[] = ['timeout_seconds', 'timeoutSeconds', 'timeout_secs', 'timeout_sec'].map(
    (name) => [name, 1000] as const,
);

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
            background: { jobId: id, running: true },
        },
    };
}

export interface BashToolOptions {
    /** How long a command without `timeoutMs` is waited for before it carries on in the background. */
    readonly foregroundMs?: number;
}

/**
 * Runs the command and waits for it (21 §4.3). A command given a `timeoutMs` is stopped when the time is up; one
 * given none is not: the model did not say how long it may take, and stopping a build or a test run at an arbitrary
 * point throws its work away. It carries on as a background job instead, with its output so far as the answer.
 */
async function runBash(input: BashInput, ctx: ToolContext, foregroundMs: number): Promise<ToolResult> {
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
    const waitMs = Math.min(input.timeoutMs ?? foregroundMs, BASH_MAX_TIMEOUT_MS);
    let job: ShellJob;
    try {
        job = new ShellJob(nextJobId(ctx.jobs), {
            command: input.command,
            cwd: ctx.cwd,
            env: ctx.env,
            shell: ctx.shell,
            keep: FOREGROUND_OUTPUT,
            onOutput: ctx.onOutput,
        });
    } catch (error) {
        return errorResult(`Could not start the shell: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A command that ends as the wait does has ended: nothing is stopped, and nothing is reported as stopped. A turn
    // stopped as the wait ends is stopped: its command is not left running.
    const waited = await job.waitFor(waitMs, ctx.signal);
    const ended = !job.running ? 'exited' : ctx.signal.aborted ? 'aborted' : waited;
    if (ended === 'timeout' && input.timeoutMs === undefined) {
        job.detach();
        const raw = job.output();
        job.markRead();
        ctx.jobs.add(job);
        // It was not asked to outlive the turn, as a job started with `background` is: when the user stops the
        // turn, what the turn left running stops with it.
        ctx.signal.addEventListener('abort', () => job.kill(), { once: true });
        const produced = { chars: job.outputChars, dropped: job.outputDropped };
        const shown = await shownOutput(ctx, raw, produced, 'The output so far');
        const runningNote = `The command is still running after ${formatDuration(waitMs)}: it was not stopped and carries on in the background as ${job.id}. What is above is its output so far, not its result. Wait for it with bash_output (jobId "${job.id}" and waitMs, up to ${BASH_MAX_TIMEOUT_MS}), or stop it with bash_kill.`;
        return {
            content: [
                shown.text.trimEnd() === '' ? '(no output yet)' : shown.text.trimEnd(),
                ...(shown.note ? [shown.note] : []),
                runningNote,
            ].join('\n\n'),
            ...(shown.truncated
                ? {
                      fullContent: [
                          shown.fullText.trimEnd() === '' ? '(no output yet)' : shown.fullText.trimEnd(),
                          runningNote,
                      ].join('\n\n'),
                  }
                : {}),
            display: {
                kind: 'command',
                command: input.command,
                exitCode: null,
                output: shown.text,
                truncated: shown.truncated,
                ...(shown.artifactPath === undefined ? {} : { artifactPath: shown.artifactPath }),
                durationMs: Date.now() - job.startedAt,
                background: { jobId: job.id, running: true },
            },
        };
    }
    if (ended !== 'exited') {
        job.kill();
        await Promise.race([job.wait(), delay(KILL_WAIT_MS, undefined, { ref: false })]);
    }
    job.detach();
    if (job.error !== undefined) {
        return errorResult(`Could not start the shell: ${job.error}`);
    }
    const shown = await shownOutput(ctx, job.output(), { chars: job.outputChars, dropped: job.outputDropped });
    const statusParts: string[] = [];
    if (ended === 'timeout') {
        statusParts.push(
            `The command timed out after ${formatDuration(waitMs)} and was stopped. Leave timeoutMs out to let a long command carry on in the background, or start it with background: true.`,
        );
    } else if (ended === 'aborted') {
        statusParts.push('The command was aborted.');
    } else if (job.signal !== null) {
        statusParts.push(`The command was terminated by ${job.signal}.`);
    } else if (job.exitCode !== 0) {
        statusParts.push(`Exit code ${job.exitCode}`);
    }
    const parts = [
        shown.text.trimEnd() === '' ? '(no output)' : shown.text.trimEnd(),
        ...statusParts,
        ...(shown.note ? [shown.note] : []),
    ];
    return {
        content: parts.join('\n\n'),
        ...(shown.truncated
            ? {
                  fullContent: [
                      shown.fullText.trimEnd() === '' ? '(no output)' : shown.fullText.trimEnd(),
                      ...statusParts,
                  ].join('\n\n'),
              }
            : {}),
        isError: ended !== 'exited' || job.exitCode !== 0,
        display: {
            kind: 'command',
            command: input.command,
            exitCode: job.exitCode,
            output: shown.text,
            truncated: shown.truncated,
            ...(shown.artifactPath === undefined ? {} : { artifactPath: shown.artifactPath }),
            durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
        },
    };
}

export function createBashTool(options: BashToolOptions = {}): ToolDefinition<BashInput> {
    const foregroundMs = options.foregroundMs ?? BASH_DEFAULT_TIMEOUT_MS;
    return {
        name: 'bash',
        description: [
            `Run a shell command in the working directory (bash or zsh on macOS and Linux, PowerShell on Windows) and return its stdout and stderr, interleaved, as a terminal would show them: progress bars down to their last state, colour codes removed. Each call starts a new shell, so \`cd\` and variables do not carry over: use absolute paths or \`cd dir && …\`. Output over ${BASH_MAX_OUTPUT_CHARS} characters is cut in the middle and saved in full to a file you can read.`,
            '- Use the dedicated tools instead of shell equivalents: `read` rather than cat/head/tail, `grep` rather than grep/rg, `glob` or `list` rather than find/ls, `edit` or `write` rather than sed or echo redirection.',
            '- Commands get no input: avoid interactive programs and pass non-interactive flags (e.g. `--yes`). Quote paths that contain spaces; chain dependent commands with `&&`.',
            `- A command still running after ${formatDuration(foregroundMs)} is not stopped: it carries on as a background job, and you get its output so far with the job's id. Follow a job with \`bash_output\`, which can wait for it to finish, and stop it with \`bash_kill\`. Set \`timeoutMs\` only when a command must be stopped after that long.`,
            '- For servers, watchers and other processes that do not end, set `background: true` instead of appending `&`.',
            '- Set `description` to a few words on what the command does.',
        ].join('\n'),
        kind: 'execute',
        schema: BashInput,
        readOnly: false,
        lenient: {
            aliases: {
                command: ['cmd', 'script', 'shell_command', 'bash_command'],
                background: ['run_in_background', 'is_background', 'in_background', 'detach', 'detached', 'async'],
                description: ['explanation', 'summary', 'title', 'purpose'],
            },
            adapt: timeLimit('timeoutMs', [['timeout', 0], ...SECONDS]),
        },
        targets: () => [],
        title: (input) => {
            if (input.description !== undefined && input.description.trim() !== '') {
                return input.description.trim();
            }
            const firstLine = input.command.split('\n')[0] ?? '';
            const short = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
            return `Run ${short}${input.command.includes('\n') ? ' …' : ''}`;
        },
        run: (input, ctx) => runBash(input, ctx, foregroundMs),
    };
}

export const bashTool: ToolDefinition<BashInput> = createBashTool();

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

function jobDisplay(
    job: BackgroundJob,
    shown: Pick<ShownOutput, 'text' | 'truncated' | 'artifactPath'>,
): ToolResult['display'] {
    return {
        kind: 'command',
        command: job.command,
        exitCode: job.exitCode,
        output: shown.text,
        truncated: shown.truncated,
        ...(shown.artifactPath === undefined ? {} : { artifactPath: shown.artifactPath }),
        durationMs: Date.now() - job.startedAt,
        background: { jobId: job.id, running: job.running },
    };
}

const NO_OUTPUT = { text: '', truncated: false } as const;

const JobInput = z.object({
    jobId: z.string().min(1).describe('Id of the background job, as returned by bash'),
});

export type JobInput = z.infer<typeof JobInput>;

const JOB_ALIASES = ['id', 'job', 'shell_id', 'bash_id', 'task_id'];

const JobOutputInput = z.object({
    jobId: z.string().min(1).describe('Id of the background job, as returned by bash'),
    waitMs: z
        .number()
        .int()
        .min(0)
        .max(BASH_MAX_TIMEOUT_MS)
        .optional()
        .describe(
            `Wait up to this many milliseconds for the job to finish before answering (at most ${BASH_MAX_TIMEOUT_MS}); without it the answer comes at once`,
        ),
});

export type JobOutputInput = z.infer<typeof JobOutputInput>;

async function runBashOutput(input: JobOutputInput, ctx: ToolContext): Promise<ToolResult> {
    const job = ctx.jobs.get(input.jobId);
    if (job === undefined) {
        return unknownJob(input.jobId, ctx);
    }
    const incremental = job instanceof ShellJob;
    if (incremental && job.running && (input.waitMs ?? 0) > 0) {
        await job.waitFor(input.waitMs ?? 0, ctx.signal);
    }
    const { text: raw, dropped } = incremental ? job.readNew() : { text: job.output(), dropped: 0 };
    const shown = await shownOutput(ctx, raw, { chars: raw.length, dropped: false }, 'This output');
    const buildLines = (body: string, note: string): string[] => {
        const out = [jobStatus(job)];
        if (dropped > 0) {
            out.push(`(${dropped} characters of output were discarded before they could be read.)`);
        }
        if (body.trimEnd() === '') {
            out.push(incremental ? 'No new output since the last check.' : 'No output yet.');
        } else {
            out.push(incremental ? 'New output since the last check:' : 'Output so far:', body.trimEnd());
        }
        if (note) {
            out.push(note);
        }
        if (job.running) {
            out.push('(Still running; bash_output with waitMs waits for it to finish.)');
        }
        return out;
    };
    return {
        content: buildLines(shown.text, shown.note).join('\n'),
        ...(shown.truncated ? { fullContent: buildLines(shown.fullText, '').join('\n') } : {}),
        // How the command ended is this call's news, as it is `bash`'s when the command ends while it waits.
        ...(job instanceof ShellJob && job.failed ? { isError: true } : {}),
        display: jobDisplay(job, { ...shown, truncated: shown.truncated || dropped > 0 }),
    };
}

export const bashOutputTool: ToolDefinition<JobOutputInput> = {
    name: 'bash_output',
    description:
        'Check on a background job: one started by `bash` with `background: true`, or a command `bash` left running because it took long. Returns whether it is still running (or its exit code) and the output it produced since the last check. ' +
        'With `waitMs` the call waits for the job to finish, up to that long, before it answers: use it for builds and test runs instead of checking repeatedly, and leave it out for servers, which do not finish.',
    kind: 'execute',
    schema: JobOutputInput,
    readOnly: true,
    lenient: {
        aliases: { jobId: JOB_ALIASES, waitMs: ['wait_ms', 'timeout_ms', 'block_ms'] },
        adapt: timeLimit('waitMs', [['timeout', 0], ['wait', 0], ['wait_seconds', 1000], ...SECONDS]),
    },
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
        return { content: `${jobStatus(job)} Nothing to stop.`, display: jobDisplay(job, NO_OUTPUT) };
    }
    job.kill();
    if (job instanceof ShellJob) {
        await Promise.race([job.wait(), delay(KILL_WAIT_MS, undefined, { ref: false })]);
    }
    return {
        content: job.running ? `Sent job ${job.id} a stop signal; it has not exited yet.` : `Stopped job ${job.id}.`,
        display: jobDisplay(job, NO_OUTPUT),
    };
}

export const bashKillTool: ToolDefinition<JobInput> = {
    name: 'bash_kill',
    description: 'Stop a background job of this session (see `bash_output`), together with the processes it started.',
    kind: 'execute',
    schema: JobInput,
    // It only ends what a command of this session started, which was allowed then: no one is asked again. It is not
    // read-only for that: it runs in its turn (a `bash_output` after it sees the job stopped).
    readOnly: false,
    unasked: true,
    lenient: { aliases: { jobId: JOB_ALIASES } },
    targets: () => [],
    title: (input) => `Stop ${input.jobId}`,
    run: runBashKill,
};
