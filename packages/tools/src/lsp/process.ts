import { type ChildProcess, spawn as nodeSpawn, spawnSync } from 'node:child_process';
import spawn from 'cross-spawn';

/**
 * Language server processes, started and stopped the way MCP stdio servers are (packages/mcp/src/process.ts): on
 * POSIX each server leads its own process group, so wrappers and the processes they start (tsserver under
 * typescript-language-server, cargo under rust-analyzer) go together; on Windows `taskkill /T` walks the tree.
 * cross-spawn runs the `.cmd` shims that npm puts in `node_modules/.bin` and on PATH on Windows.
 */

export interface ServerProcessOptions {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    /** The complete environment of the server. */
    readonly env: Readonly<Record<string, string>>;
}

/** Servers still running in this process, killed synchronously when it exits. */
const live = new Set<ChildProcess>();
let exitHook = false;

export function startServerProcess(options: ServerProcessOptions): ChildProcess {
    const child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        shell: false,
    });
    live.add(child);
    child.once('close', () => live.delete(child));
    if (!exitHook) {
        exitHook = true;
        // The engine exits when its connection to the host closes; servers must not outlive it.
        process.on('exit', () => {
            for (const server of live) {
                killTreeSync(server);
            }
        });
    }
    return child;
}

export function hasExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves `true` once the process has exited, or `false` after `timeoutMs`. */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (hasExited(child)) {
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

/** Signals the whole process tree of a server; on Windows only while the server itself is alive. */
export async function killTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    if (process.platform === 'win32') {
        if (hasExited(child)) {
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
        // The group is gone; the process itself may never have led one.
        if (!hasExited(child)) {
            try {
                child.kill(signal);
            } catch {
                // Already gone.
            }
        }
    }
}

/** For the exit hook, where nothing asynchronous runs any more. */
function killTreeSync(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) {
        return;
    }
    try {
        if (process.platform === 'win32') {
            if (!hasExited(child)) {
                spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
                    windowsHide: true,
                    stdio: 'ignore',
                    timeout: 3000,
                });
            }
        } else {
            process.kill(-pid, 'SIGKILL');
        }
    } catch {
        // Already gone.
    }
}
