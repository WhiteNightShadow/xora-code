import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Running shell commands for `bash`: picking the shell, capturing output, and killing whole process trees. */

export interface ShellInvocation {
    readonly file: string;
    readonly args: readonly string[];
    /** Pass the arguments to Windows unquoted (needed for `cmd.exe /s /c "…"`). */
    readonly verbatim: boolean;
}

const POSIX_SHELLS: ReadonlySet<string> = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'mksh', 'ash']);

let fallbackShell: string | undefined;

/**
 * How to run `command`. `shell` wins when given. Otherwise unix uses `$SHELL` when it is a POSIX-style shell (bash,
 * zsh, …), else `/bin/bash` or `/bin/sh`, with `-c` (not a login shell, so profiles are not read); Windows uses
 * `powershell.exe -NoProfile -NonInteractive -EncodedCommand`, where the encoding sidesteps quoting rules.
 */
export function shellInvocation(
    command: string,
    shell: string | undefined,
    env: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform = process.platform,
): ShellInvocation {
    if (platform === 'win32') {
        const file = shell ?? 'powershell.exe';
        const name = path.win32
            .basename(file)
            .toLowerCase()
            .replace(/\.exe$/, '');
        if (name === 'powershell' || name === 'pwsh') {
            return {
                file,
                args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(command)],
                verbatim: false,
            };
        }
        if (name === 'cmd') {
            return { file, args: ['/d', '/s', '/c', `"${command}"`], verbatim: true };
        }
        return { file, args: ['-c', command], verbatim: false };
    }
    if (shell !== undefined) {
        return { file: shell, args: ['-c', command], verbatim: false };
    }
    const preferred = env.SHELL;
    if (preferred !== undefined && path.isAbsolute(preferred) && POSIX_SHELLS.has(path.basename(preferred))) {
        if (existsSync(preferred)) {
            return { file: preferred, args: ['-c', command], verbatim: false };
        }
    }
    fallbackShell ??= existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    return { file: fallbackShell, args: ['-c', command], verbatim: false };
}

/**
 * `-EncodedCommand` takes base64 of UTF-16LE. Output is switched to UTF-8 first so that non-ASCII text survives, and
 * progress records are off: with stderr redirected PowerShell writes them there as CLIXML (e.g. "Preparing modules
 * for first use").
 */
function encodePowerShell(command: string): string {
    const prelude =
        "$ProgressPreference = 'SilentlyContinue'\n" +
        'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}\n' +
        '$OutputEncoding = [System.Text.Encoding]::UTF8\n';
    return Buffer.from(prelude + command, 'utf16le').toString('base64');
}

/** How much of a command's output is kept: its first `head` characters and its newest `tail`. */
export interface OutputLimits {
    readonly head: number;
    readonly tail: number;
}

/**
 * The output of a command as it arrives. Only the first `head` characters and the newest `tail` are kept, so a
 * runaway command cannot exhaust memory, while the start of the output (what ran) and its end (the error, the
 * summary) are still there; what came after an earlier point can be asked for, for jobs read bit by bit.
 */
export class OutputLog {
    readonly #limits: OutputLimits;
    #head = '';
    #tail: string[] = [];
    #tailLength = 0;
    #total = 0;

    constructor(limits: OutputLimits) {
        this.#limits = limits;
    }

    append(text: string): void {
        this.#total += text.length;
        let rest = text;
        if (this.#head.length < this.#limits.head) {
            const room = this.#limits.head - this.#head.length;
            this.#head += rest.slice(0, room);
            rest = rest.slice(room);
        }
        if (rest === '') {
            return;
        }
        this.#tail.push(rest);
        this.#tailLength += rest.length;
        while (this.#tail.length > 1 && this.#tailLength - (this.#tail[0]?.length ?? 0) >= this.#limits.tail) {
            this.#tailLength -= this.#tail.shift()?.length ?? 0;
        }
        const only = this.#tail[0];
        if (this.#tail.length === 1 && only !== undefined && only.length > this.#limits.tail) {
            this.#tail[0] = only.slice(only.length - this.#limits.tail);
            this.#tailLength = this.#limits.tail;
        }
    }

    /** Characters received in total. */
    get total(): number {
        return this.#total;
    }

    /** Whether some of the output is no longer kept. */
    get dropped(): boolean {
        return this.#head.length + this.#tailLength < this.#total;
    }

    /** The output; where its middle was dropped, a marker says how much. */
    text(): string {
        let tail = this.#tail.join('');
        if (this.#head.length + tail.length === this.#total) {
            return this.#head + tail;
        }
        tail = tail.slice(Math.max(0, tail.length - this.#limits.tail));
        const dropped = this.#total - this.#head.length - tail.length;
        return `${this.#head}\n[... ${dropped} characters not kept ...]\n${tail}`;
    }

    /** What arrived after the first `from` characters; `dropped` counts those of them that are no longer kept. */
    since(from: number): { readonly text: string; readonly dropped: number } {
        if (from >= this.#total) {
            return { text: '', dropped: 0 };
        }
        const tail = this.#tail.join('');
        const tailStart = this.#total - tail.length;
        if (from >= tailStart) {
            return { text: tail.slice(from - tailStart), dropped: 0 };
        }
        const head = from < this.#head.length ? this.#head.slice(from) : '';
        return { text: head + tail, dropped: tailStart - Math.max(from, this.#head.length) };
    }
}

/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2000;

function signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        // A negative pid addresses the whole process group, which `detached: true` gave the child.
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Already gone.
        }
    }
}

function taskkillPath(): string {
    const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const full = path.win32.join(root, 'System32', 'taskkill.exe');
    return existsSync(full) ? full : 'taskkill';
}

/**
 * Stops a child started by `spawnShell` together with everything it started: on unix SIGTERM to its process group
 * and SIGKILL after a grace period; on Windows `taskkill /T /F` plus pipe teardown so grandchildren holding inherited
 * named pipes open cannot wedge `waitForExit` after Stop.
 */
export function terminateTree(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    if (process.platform === 'win32') {
        const killer = spawn(taskkillPath(), ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
        });
        killer.on('error', () => {
            try {
                child.kill();
            } catch {
                // Already gone.
            }
        });
        setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            try {
                child.kill();
            } catch {
                // Already gone.
            }
        }, 1200).unref();
        return;
    }
    signalGroup(pid, 'SIGTERM');
    setTimeout(() => signalGroup(pid, 'SIGKILL'), KILL_GRACE_MS).unref();
}

/** {@link terminateTree} for the moment the process exits, where nothing asynchronous runs any more: at once, for good. */
export function terminateTreeNow(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    try {
        if (process.platform === 'win32') {
            spawnSync(taskkillPath(), ['/pid', String(pid), '/T', '/F'], {
                stdio: 'ignore',
                windowsHide: true,
                timeout: 3000,
            });
        } else {
            signalGroup(pid, 'SIGKILL');
        }
    } catch {
        // Already gone.
    }
}

export interface SpawnShellOptions {
    readonly command: string;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly shell?: string | undefined;
}

/**
 * Starts `command` in a shell, without stdin, in its own process group (unix) so the whole tree can be killed.
 * May throw synchronously, e.g. for an argument containing a NUL byte.
 */
export function spawnShell(options: SpawnShellOptions): ChildProcess {
    const invocation = shellInvocation(options.command, options.shell, options.env);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env)) {
        if (value !== undefined) {
            env[name] = value;
        }
    }
    return spawn(invocation.file, [...invocation.args], {
        cwd: options.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        windowsVerbatimArguments: invocation.verbatim,
    });
}

/**
 * Feeds stdout and stderr of `child` to `onText` in arrival order, decoding UTF-8 per stream so that characters split
 * across chunks stay intact. Returns a function that flushes the decoders.
 */
export function readOutput(child: ChildProcess, onText: (text: string) => void): () => void {
    const decoders: StringDecoder[] = [];
    for (const stream of [child.stdout, child.stderr]) {
        if (stream === null) {
            continue;
        }
        const decoder = new StringDecoder('utf8');
        decoders.push(decoder);
        stream.on('data', (chunk: Buffer) => {
            const text = decoder.write(chunk);
            if (text !== '') {
                onText(text);
            }
        });
    }
    return () => {
        for (const decoder of decoders) {
            const text = decoder.end();
            if (text !== '') {
                onText(text);
            }
        }
    };
}

/** How long to wait for remaining output after the shell exits, when descendants keep its pipes open. */
const DRAIN_MS = 250;

export interface ChildExit {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly error?: Error;
}

/**
 * Resolves when the child has exited and its output has been read. A background process the command left running
 * may hold the pipes open forever, so after the exit only a short drain period is granted.
 */
export function waitForExit(child: ChildProcess): Promise<ChildExit> {
    return new Promise((resolve) => {
        let settled = false;
        let exit: ChildExit | undefined;
        const finish = (result: ChildExit): void => {
            if (!settled) {
                settled = true;
                if (exit !== undefined) {
                    // Stop reading pipes that a leftover descendant still holds.
                    child.stdout?.destroy();
                    child.stderr?.destroy();
                }
                resolve(result);
            }
        };
        child.once('error', (error) => finish({ code: null, signal: null, error }));
        child.once('exit', (code, signal) => {
            exit = { code, signal };
            setTimeout(() => finish(exit ?? { code, signal }), DRAIN_MS).unref();
        });
        child.once('close', (code, signal) => finish(exit ?? { code, signal }));
    });
}
