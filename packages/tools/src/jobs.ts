import type { ChildProcess } from 'node:child_process';
import { readOutput, type SpawnShellOptions, spawnShell, terminateTree, waitForExit } from './shell.ts';
import type { BackgroundJob, JobRegistry } from './types.ts';

/** Characters of output a background job keeps; older output is dropped from the front. */
export const JOB_OUTPUT_LIMIT = 1_000_000;

/** Text that is only appended to, keeping the newest `max` characters and absolute offsets for incremental reads. */
class RollingText {
    readonly #max: number;
    #chunks: string[] = [];
    #length = 0;
    #total = 0;

    constructor(max: number) {
        this.#max = max;
    }

    append(text: string): void {
        this.#chunks.push(text);
        this.#length += text.length;
        this.#total += text.length;
        while (this.#chunks.length > 1 && this.#length - (this.#chunks[0]?.length ?? 0) >= this.#max) {
            this.#length -= this.#chunks.shift()?.length ?? 0;
        }
        const only = this.#chunks[0];
        if (this.#chunks.length === 1 && only !== undefined && only.length > this.#max) {
            this.#chunks[0] = only.slice(only.length - this.#max);
            this.#length = this.#max;
        }
    }

    get total(): number {
        return this.#total;
    }

    text(): string {
        return this.#chunks.join('');
    }

    /** Text from absolute offset `from` on; `dropped` counts characters after `from` that are no longer kept. */
    since(from: number): { readonly text: string; readonly dropped: number } {
        const start = this.#total - this.#length;
        if (from >= this.#total) {
            return { text: '', dropped: 0 };
        }
        const all = this.text();
        return from < start ? { text: all, dropped: start - from } : { text: all.slice(from - start), dropped: 0 };
    }
}

/** A shell command started by `bash` with `background: true`. */
export class ShellJob implements BackgroundJob {
    readonly id: string;
    readonly command: string;
    readonly startedAt: number;
    readonly #child: ChildProcess;
    readonly #output = new RollingText(JOB_OUTPUT_LIMIT);
    readonly #done: Promise<void>;
    #running = true;
    #exitCode: number | null = null;
    #signal: NodeJS.Signals | null = null;
    #endedAt: number | undefined;
    #killed = false;
    #cursor = 0;
    #error: string | undefined;

    /** Starts the command; throws if the shell cannot be spawned at all. */
    constructor(id: string, options: SpawnShellOptions) {
        this.id = id;
        this.command = options.command;
        this.startedAt = Date.now();
        this.#child = spawnShell(options);
        const flush = readOutput(this.#child, (text) => this.#output.append(text));
        this.#done = waitForExit(this.#child).then((exit) => {
            flush();
            if (exit.error !== undefined && this.#child.pid === undefined) {
                this.#error = exit.error.message;
            }
            this.#running = false;
            this.#exitCode = exit.code;
            this.#signal = exit.signal;
            this.#endedAt = Date.now();
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

    get endedAt(): number | undefined {
        return this.#endedAt;
    }

    /** Why the shell could not be started, if it could not. */
    get error(): string | undefined {
        return this.#error;
    }

    output(): string {
        return this.#output.text();
    }

    /** Output produced since the previous call; `dropped` counts characters lost to the buffer limit in between. */
    readNew(): { readonly text: string; readonly dropped: number } {
        const result = this.#output.since(this.#cursor);
        this.#cursor = this.#output.total;
        return result;
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
