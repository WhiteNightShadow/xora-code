import type { ChildProcess } from 'node:child_process';
import {
    type OutputLimits,
    OutputLog,
    readOutput,
    type SpawnShellOptions,
    spawnShell,
    terminateTree,
    terminateTreeNow,
    waitForExit,
} from './shell.ts';
import type { BackgroundJob, JobRegistry } from './types.ts';

/** Output a background job keeps: the newest million characters; older output is dropped from the front. */
export const JOB_OUTPUT_LIMITS: OutputLimits = { head: 0, tail: 1_000_000 };

export interface ShellJobOptions extends SpawnShellOptions {
    /** How much output is kept; {@link JOB_OUTPUT_LIMITS} by default. */
    readonly keep?: OutputLimits | undefined;
    /** Gets the output as it arrives, until {@link ShellJob.detach}. */
    readonly onOutput?: ((chunk: string) => void) | undefined;
}

/** How a wait for a job ended: it exited, the time was up, or the wait was aborted. */
export type JobWait = 'exited' | 'timeout' | 'aborted';

/**
 * The jobs that are running. None may outlive the process: the host ends the engine without closing its sessions,
 * and a command in a process group of its own would carry on with no one left to read or stop it.
 */
const live = new Set<ShellJob>();
let exitHook = false;

/**
 * A shell command that is running or has run (21 §4.3). `bash` waits for one in the foreground and, when the
 * command outlasts the wait, leaves it running as a background job; with `background: true` it does not wait at
 * all. Either way it is the same thing, read with `bash_output` and stopped with `bash_kill`.
 */
export class ShellJob implements BackgroundJob {
    readonly id: string;
    readonly command: string;
    readonly startedAt: number;
    readonly #child: ChildProcess;
    readonly #output: OutputLog;
    readonly #done: Promise<void>;
    #listener: ((chunk: string) => void) | undefined;
    #running = true;
    #exitCode: number | null = null;
    #signal: NodeJS.Signals | null = null;
    #endedAt: number | undefined;
    #killed = false;
    #cursor = 0;
    #error: string | undefined;

    /** Starts the command; throws if the shell cannot be spawned at all. */
    constructor(id: string, options: ShellJobOptions) {
        this.id = id;
        this.command = options.command;
        this.startedAt = Date.now();
        this.#output = new OutputLog(options.keep ?? JOB_OUTPUT_LIMITS);
        this.#listener = options.onOutput;
        this.#child = spawnShell(options);
        live.add(this);
        if (!exitHook) {
            exitHook = true;
            process.on('exit', () => {
                for (const job of live) {
                    terminateTreeNow(job.#child);
                }
            });
        }
        const flush = readOutput(this.#child, (text) => {
            this.#output.append(text);
            try {
                this.#listener?.(text);
            } catch {
                // A failing listener must not break the command.
            }
        });
        this.#done = waitForExit(this.#child).then((exit) => {
            flush();
            if (exit.error !== undefined && this.#child.pid === undefined) {
                this.#error = exit.error.message;
            }
            this.#running = false;
            this.#exitCode = exit.code;
            this.#signal = exit.signal;
            this.#endedAt = Date.now();
            live.delete(this);
        });
    }

    get running(): boolean {
        return this.#running;
    }

    get exitCode(): number | null {
        return this.#exitCode;
    }

    /** The signal that ended the process, if one did. */
    get signal(): NodeJS.Signals | null {
        return this.#signal;
    }

    /** Whether `kill` was called while the job was running. */
    get killed(): boolean {
        return this.#killed;
    }

    /** Whether the command ended in a way that is not success: it could not start, a signal ended it, or its code is not 0. */
    get failed(): boolean {
        return (
            !this.#running &&
            !this.#killed &&
            (this.#error !== undefined || this.#signal !== null || this.#exitCode !== 0)
        );
    }

    get endedAt(): number | undefined {
        return this.#endedAt;
    }

    /** Why the shell could not be started, if it could not. */
    get error(): string | undefined {
        return this.#error;
    }

    /** Everything kept of the output; where part was dropped, a marker says how much. */
    output(): string {
        return this.#output.text();
    }

    /** Characters of output produced so far, kept or not. */
    get outputChars(): number {
        return this.#output.total;
    }

    /** Whether some of the output is no longer kept. */
    get outputDropped(): boolean {
        return this.#output.dropped;
    }

    /** Output produced since the previous call; `dropped` counts characters lost to the buffer limit in between. */
    readNew(): { readonly text: string; readonly dropped: number } {
        const result = this.#output.since(this.#cursor);
        this.#cursor = this.#output.total;
        return result;
    }

    /** Counts the output so far as read: the next {@link readNew} starts after it. */
    markRead(): void {
        this.#cursor = this.#output.total;
    }

    /** Stops passing the output on to the listener the job was started with. */
    detach(): void {
        this.#listener = undefined;
    }

    kill(): void {
        if (this.#running) {
            this.#killed = true;
            terminateTree(this.#child);
        }
    }

    /** Resolves once the process has exited and its output has been read. */
    wait(): Promise<void> {
        return this.#done;
    }

    /** Waits for the job to exit, for at most `ms`, or until `signal` aborts; says which came first. */
    waitFor(ms: number, signal?: AbortSignal): Promise<JobWait> {
        if (!this.#running) {
            return Promise.resolve('exited');
        }
        if (signal?.aborted) {
            return Promise.resolve('aborted');
        }
        return new Promise((resolve) => {
            const finish = (how: JobWait): void => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                resolve(how);
            };
            const onAbort = (): void => finish('aborted');
            const timer = setTimeout(() => finish('timeout'), ms);
            signal?.addEventListener('abort', onAbort, { once: true });
            void this.#done.then(() => finish('exited'));
        });
    }
}

export interface ManagedJobRegistry extends JobRegistry {
    /** Stops every running job, e.g. when the session closes. */
    killAll(): void;
}

/** A plain in-memory `JobRegistry` for one session. */
export function createJobRegistry(): ManagedJobRegistry {
    const jobs = new Map<string, BackgroundJob>();
    return {
        add(job) {
            if (jobs.has(job.id)) {
                throw new Error(`A job with id ${job.id} already exists`);
            }
            jobs.set(job.id, job);
        },
        get: (id) => jobs.get(id),
        list: () => [...jobs.values()],
        killAll() {
            for (const job of jobs.values()) {
                if (job.running) {
                    job.kill();
                }
            }
        },
    };
}

/** The next free id of the form `job-<n>`. */
export function nextJobId(jobs: JobRegistry): string {
    let n = jobs.list().length + 1;
    while (jobs.get(`job-${n}`) !== undefined) {
        n++;
    }
    return `job-${n}`;
}
