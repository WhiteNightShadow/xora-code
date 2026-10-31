import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { type JSONRPCMessage, ReadBuffer, serializeMessage, type Transport } from '@modelcontextprotocol/client';
import spawn from 'cross-spawn';

/**
 * Variables a stdio server gets when the caller passes no base environment: enough to find executables, a home
 * and temp directory, the locale and a proxy, and nothing that usually holds credentials.
 */
const SAFE_ENV_NAMES =
    process.platform === 'win32'
        ? [
              'APPDATA',
              'COMSPEC',
              'HOMEDRIVE',
              'HOMEPATH',
              'LOCALAPPDATA',
              'PATH',
              'PATHEXT',
              'PROCESSOR_ARCHITECTURE',
              'PROGRAMDATA',
              'PROGRAMFILES',
              'PROGRAMFILES(X86)',
              'PROGRAMW6432',
              'SYSTEMDRIVE',
              'SYSTEMROOT',
              'TEMP',
              'TMP',
              'USERNAME',
              'USERPROFILE',
              'WINDIR',
              'HTTP_PROXY',
              'HTTPS_PROXY',
              'NO_PROXY',
          ]
        : [
              'HOME',
              'LOGNAME',
              'PATH',
              'SHELL',
              'TERM',
              'USER',
              'TMPDIR',
              'LANG',
              'LC_ALL',
              'LC_CTYPE',
              'HTTP_PROXY',
              'HTTPS_PROXY',
              'NO_PROXY',
              'http_proxy',
              'https_proxy',
              'no_proxy',
          ];

/** The allowlisted part of `env` (default `process.env`); see {@link SAFE_ENV_NAMES}. */
export function safeBaseEnv(env: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
    const out: Record<string, string> = {};
    const lookup = new Map(
        Object.keys(env).map((key) => [process.platform === 'win32' ? key.toUpperCase() : key, key]),
    );
    for (const name of SAFE_ENV_NAMES) {
        const key = lookup.get(name);
        const value = key === undefined ? undefined : env[key];
        // Skip exported bash functions, as the SDK's default environment does.
        if (key !== undefined && value !== undefined && !value.startsWith('()')) {
            out[key] = value;
        }
    }
    return out;
}

/** `extra` over `base`; on Windows names are case-insensitive, so `Path` in `extra` replaces `PATH` in `base`. */
export function mergeEnv(
    base: Readonly<Record<string, string | undefined>>,
    extra: Readonly<Record<string, string>>,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        if (value !== undefined) {
            out[key] = value;
        }
    }
    for (const [key, value] of Object.entries(extra)) {
        if (process.platform === 'win32') {
            for (const existing of Object.keys(out)) {
                if (existing.toUpperCase() === key.toUpperCase()) {
                    delete out[existing];
                }
            }
        }
        out[key] = value;
    }
    return out;
}

export interface ProcessTransportOptions {
    readonly command: string;
    readonly args: readonly string[];
    /** The complete environment of the server process; nothing else is inherited. */
    readonly env: Readonly<Record<string, string>>;
    readonly cwd?: string;
    /** Decoded stderr, one call per complete line. */
    readonly onStderr?: (line: string) => void;
}

export interface ProcessExit {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
}

function exited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (exited(child)) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            child.off('exit', onExit);
            resolve(false);
        }, timeoutMs);
        const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
        };
        child.once('exit', onExit);
    });
}

/**
 * Signals the whole process tree. On POSIX the server leads its own process group (`detached`), so wrappers such
 * as `npx` or `uvx` and the processes they start go together; on Windows `taskkill /T` walks the tree, which only
 * works while the server itself is still alive.
 */
async function killTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    if (process.platform === 'win32') {
        if (exited(child)) {
            return;
        }
        await new Promise<void>((resolve) => {
            const killer = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
            });
            killer.once('error', () => {
                child.kill();
                resolve();
            });
            killer.once('exit', () => resolve());
        });
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        // The group is gone; fall back to the process itself in case it never became a group leader.
        if (!exited(child)) {
            try {
                child.kill(signal);
            } catch {
                // Already gone.
            }
        }
    }
}

/**
 * MCP stdio transport for one server process. Unlike the SDK's `StdioClientTransport` it passes exactly the given
 * environment, keeps stderr for diagnostics, reports the exit status and terminates the whole process tree.
 */
export class ProcessTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;

    readonly #options: ProcessTransportOptions;
    readonly #readBuffer = new ReadBuffer();
    readonly #stderrDecoder = new StringDecoder('utf8');
    #stderrPartial = '';
    #child: ChildProcess | undefined;
    #exit: ProcessExit | undefined;
    #notFound: Error | undefined;
    #closed = false;
    #closing: Promise<void> | undefined;

    constructor(options: ProcessTransportOptions) {
        this.#options = options;
    }

    get pid(): number | undefined {
        return this.#child?.pid;
    }

    /** Set once the process has exited. */
    get exit(): ProcessExit | undefined {
        return this.#exit;
    }

    /**
     * Set when the command turned out not to exist after the process had started: on Windows cross-spawn runs a
     * command it cannot resolve through cmd.exe and reports it missing (ENOENT) only once cmd.exe exits.
     */
    get notFound(): Error | undefined {
        return this.#notFound;
    }

    start(): Promise<void> {
        if (this.#child) {
            return Promise.reject(new Error('the server process was already started'));
        }
        const { command, args, env, cwd } = this.#options;
        if (cwd !== undefined && !existsSync(cwd)) {
            // spawn would report this as the command not being found.
            const error: NodeJS.ErrnoException = new Error(`the working directory ${cwd} does not exist`);
            error.code = 'ENOENT';
            error.syscall = 'spawn';
            return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
            let spawned = false;
            const child = spawn(command, [...args], {
                env: { ...env },
                ...(cwd === undefined ? {} : { cwd }),
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
                windowsHide: true,
                shell: false,
            });
            this.#child = child;
            const reportError = (error: Error): void => {
                if (spawned) {
                    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                        this.#notFound = error;
                    }
                    this.onerror?.(error);
                } else {
                    reject(error);
                }
            };
            child.once('spawn', () => {
                spawned = true;
                resolve();
            });
            child.on('error', reportError);
            child.once('exit', (code, signal) => {
                this.#exit = { code, signal };
            });
            child.once('close', (code, signal) => {
                this.#exit ??= { code, signal };
                this.#flushStderr();
                this.#closed = true;
                // Descendants that outlived the server, e.g. a browser it started, go too.
                void killTree(child, 'SIGKILL');
                this.onclose?.();
            });
            child.stdout?.on('data', (chunk: Buffer) => {
                try {
                    this.#readBuffer.append(chunk);
                } catch (error) {
                    // A message over the buffer limit: the stream cannot be resynchronised.
                    this.onerror?.(error instanceof Error ? error : new Error(String(error)));
                    void this.close();
                    return;
                }
                this.#drain();
            });
            child.stdout?.on('error', reportError);
            child.stderr?.on('data', (chunk: Buffer) => this.#onStderr(this.#stderrDecoder.write(chunk)));
            child.stderr?.on('error', reportError);
            child.stdin?.on('error', reportError);
        });
    }

    send(message: JSONRPCMessage): Promise<void> {
        const stdin = this.#child?.stdin;
        if (!stdin || stdin.destroyed || this.#closed) {
            return Promise.reject(new Error('the server process is not running'));
        }
        return new Promise((resolve, reject) => {
            stdin.write(serializeMessage(message), (error) => (error ? reject(error) : resolve()));
        });
    }

    /** Closes stdin, then sends SIGTERM and finally SIGKILL to the process tree, 1.5 s apart. */
    close(): Promise<void> {
        const child = this.#child;
        if (!child) {
            return Promise.resolve();
        }
        this.#closing ??= (async () => {
            if (!exited(child)) {
                try {
                    child.stdin?.end();
                } catch {
                    // The pipe is already broken; the signals below still apply.
                }
                if (!(await waitForExit(child, 1500))) {
                    await killTree(child, 'SIGTERM');
                    if (!(await waitForExit(child, 1500))) {
                        await killTree(child, 'SIGKILL');
                        await waitForExit(child, 2000);
                    }
                }
            }
            await killTree(child, 'SIGKILL');
            this.#readBuffer.clear();
        })();
        return this.#closing;
    }

    #drain(): void {
        for (;;) {
            let message: JSONRPCMessage | null;
            try {
                message = this.#readBuffer.readMessage();
            } catch (error) {
                // Valid JSON that is not JSON-RPC; the line is consumed, so carry on with the next one.
                this.onerror?.(error instanceof Error ? error : new Error(String(error)));
                continue;
            }
            if (message === null) {
                return;
            }
            this.onmessage?.(message);
        }
    }

    #onStderr(text: string): void {
        const lines = (this.#stderrPartial + text).split(/\r?\n/);
        this.#stderrPartial = lines.pop() ?? '';
        for (const line of lines) {
            this.#options.onStderr?.(line);
        }
    }

    #flushStderr(): void {
        const rest = this.#stderrPartial + this.#stderrDecoder.end();
        this.#stderrPartial = '';
        if (rest !== '') {
            this.#options.onStderr?.(rest);
        }
    }
}
