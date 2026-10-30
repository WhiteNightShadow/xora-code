import { type ChildProcess, spawn } from 'node:child_process';

export interface RunProcessOptions {
    readonly cwd: string;
    /** The complete environment of the child; nothing is inherited from this process. */
    readonly env: Readonly<Record<string, string | undefined>>;
    /** Written to stdin, which is then closed. */
    readonly input?: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    /** Cap for each of stdout and stderr; the rest is drained and dropped. */
    readonly maxOutputBytes?: number;
    readonly windowsVerbatimArguments?: boolean;
}

export interface ProcessResult {
    /** `null` when the process was killed by a signal or never started. */
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly aborted: boolean;
    /** Why the process could not be started. */
    readonly spawnError?: string;
    readonly durationMs: number;
}

/** How long to wait for output pipes after the process exited; grandchildren may keep them open. */
const PIPE_GRACE_MS = 200;
const DEFAULT_MAX_OUTPUT = 1024 * 1024;

class OutputBuffer {
    readonly #limit: number;
    readonly #chunks: Buffer[] = [];
    #size = 0;

    constructor(limit: number) {
        this.#limit = limit;
    }

    push(chunk: Buffer): void {
        const room = this.#limit - this.#size;
        if (room <= 0) {
            return;
        }
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
        this.#chunks.push(kept);
        this.#size += kept.length;
    }

    text(): string {
        return Buffer.concat(this.#chunks).toString('utf8');
    }
}

/** Kills the process and everything it started: its process group on POSIX, `taskkill /T` on Windows. */
export function killProcessTree(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => child.kill('SIGKILL'));
        return;
    }
    try {
        process.kill(-pid, 'SIGKILL');
    } catch {
        child.kill('SIGKILL');
    }
}

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Runs a program without a shell. On POSIX the child leads its own process group, so a timeout or an abort kills
 * the whole tree it started. Never rejects: failures are reported in the result.
 */
export function runProcess(file: string, args: readonly string[], options: RunProcessOptions): Promise<ProcessResult> {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    return new Promise((resolve) => {
        if (options.signal?.aborted) {
            resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, aborted: true, durationMs: 0 });
            return;
        }
        let child: ChildProcess;
        try {
            child = spawn(file, [...args], {
                cwd: options.cwd,
                env: definedEnv(options.env),
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
                windowsHide: true,
                windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
            });
        } catch (error) {
            const spawnError = error instanceof Error ? error.message : String(error);
            resolve({
                exitCode: null,
                stdout: '',
                stderr: '',
                timedOut: false,
                aborted: false,
                spawnError,
                durationMs: elapsed(),
            });
            return;
        }
        const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
        const stdout = new OutputBuffer(limit);
        const stderr = new OutputBuffer(limit);
        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        let timedOut = false;
        let aborted = false;
        let settled = false;
        let exitCode: number | null = null;
        let grace: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
        }, options.timeoutMs);
        const onAbort = (): void => {
            aborted = true;
            killProcessTree(child);
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const finish = (spawnError?: string): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            clearTimeout(grace);
            options.signal?.removeEventListener('abort', onAbort);
            resolve({
                exitCode,
                stdout: stdout.text(),
                stderr: stderr.text(),
                timedOut,
                aborted,
                ...(spawnError === undefined ? {} : { spawnError }),
                durationMs: elapsed(),
            });
        };
        child.on('error', (error) => {
            if (child.pid === undefined) {
                finish(error.message);
            }
        });
        child.on('exit', (code) => {
            exitCode = code;
            grace = setTimeout(() => {
                child.stdout?.destroy();
                child.stderr?.destroy();
                finish();
            }, PIPE_GRACE_MS);
        });
        child.on('close', (code) => {
            exitCode ??= code;
            finish();
        });
        // The child may exit without reading its input.
        child.stdin?.on('error', () => {});
        child.stdin?.end(options.input ?? '');
    });
}

/** The platform shell running `command`: `/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows. */
export function shellInvocation(
    command: string,
    env: Readonly<Record<string, string | undefined>>,
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
    if (process.platform === 'win32') {
        const shell = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
        return { file: shell, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
    }
    return { file: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false };
}
