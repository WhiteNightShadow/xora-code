import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { RpcError, RpcErrorCode } from '@xora/protocol';
import type { Bus } from './bus.ts';
import { newId } from './ids.ts';
import type { Logger } from './log.ts';

/** The part of node-pty the host uses; node-pty itself ships with the shell because it is a native module. */
interface PtyProcess {
    readonly pid: number;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
}

interface PtyModule {
    spawn(
        file: string,
        args: string[],
        options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
    ): PtyProcess;
}

const SCROLLBACK_LIMIT = 256 * 1024;
const TREE_KILL_MS = 3_000;

/**
 * Ends a terminal and what runs in it. On Windows node-pty finds the console's processes with
 * `child_process.fork`, which throws now that the RunAsNode fuse is off; `taskkill /T` ends the shell's process
 * tree first (while the shell still links it together), then node-pty closes the pseudoconsole.
 */
function endPty(pty: PtyProcess): void {
    if (process.platform !== 'win32' || pty.pid <= 0) {
        pty.kill();
        return;
    }
    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pty.kill();
    };
    const timer = setTimeout(finish, TREE_KILL_MS);
    try {
        const killer = spawn('taskkill', ['/pid', String(pty.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', finish);
        killer.once('exit', finish);
    } catch {
        finish();
    }
}

interface Terminal {
    readonly id: string;
    readonly key: string;
    readonly cwd: string;
    readonly shell: string;
    readonly pty: PtyProcess;
    scrollback: string;
}

function defaultShell(): { file: string; args: string[] } {
    if (process.platform === 'win32') {
        return {
            file: process.env.COMSPEC?.toLowerCase().includes('powershell') ? process.env.COMSPEC : 'powershell.exe',
            args: ['-NoLogo'],
        };
    }
    return { file: process.env.SHELL || '/bin/bash', args: ['-l'] };
}

/**
 * Interactive terminals for the terminal panel (04 §5): a real pty per thread, in the thread's working
 * directory, with the user's own environment. Output is kept as scrollback so a reopened panel can replay it.
 */
export class TerminalService {
    readonly #bus: Bus;
    readonly #log: Logger;
    readonly #modulesDir: () => Promise<string>;
    readonly #terminals = new Map<string, Terminal>();
    #pty: PtyModule | null | undefined;

    constructor(options: { bus: Bus; log: Logger; modulesDir: () => Promise<string> }) {
        this.#bus = options.bus;
        this.#log = options.log;
        this.#modulesDir = options.modulesDir;
    }

    async #module(): Promise<PtyModule> {
        if (this.#pty === undefined) {
            const candidates = [process.env.XORA_NODE_PTY_DIR, await this.#modulesDir()].filter((dir): dir is string =>
                Boolean(dir),
            );
            this.#pty = null;
            for (const dir of candidates) {
                try {
                    if (!existsSync(dir)) continue;
                    this.#pty = createRequire(path.join(dir, 'noop.js'))('node-pty') as PtyModule;
                    break;
                } catch (error) {
                    this.#log.warn(
                        `node-pty not loadable from ${dir}: ${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
        }
        if (!this.#pty) {
            throw new RpcError(RpcErrorCode.Rejected, '这个安装没有终端组件（node-pty）');
        }
        return this.#pty;
    }

    /** Opens, or reattaches to, the terminal for `key` (a thread or project id). */
    async open(
        key: string,
        cwd: string,
        cols: number,
        rows: number,
    ): Promise<{ terminalId: string; cwd: string; shell: string; scrollback: string }> {
        const existing = [...this.#terminals.values()].find((terminal) => terminal.key === key);
        if (existing) {
            existing.pty.resize(cols, rows);
            return {
                terminalId: existing.id,
                cwd: existing.cwd,
                shell: existing.shell,
                scrollback: existing.scrollback,
            };
        }
        const pty = await this.#module();
        const shell = defaultShell();
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(process.env)) {
            if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value;
        }
        env.TERM = 'xterm-256color';
        env.COLORTERM = 'truecolor';
        env.TERM_PROGRAM = 'XoraCode';
        const process_ = pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd, env });
        const terminal: Terminal = { id: newId('term'), key, cwd, shell: shell.file, pty: process_, scrollback: '' };
        this.#terminals.set(terminal.id, terminal);
        process_.onData((data) => {
            terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_LIMIT);
            this.#bus.broadcast('terminal.output', { terminalId: terminal.id, data });
        });
        process_.onExit(({ exitCode }) => {
            this.#terminals.delete(terminal.id);
            this.#bus.broadcast('terminal.exit', { terminalId: terminal.id, exitCode });
        });
        this.#log.info(`terminal ${terminal.id} opened in ${cwd}`);
        return { terminalId: terminal.id, cwd, shell: shell.file, scrollback: '' };
    }

    #get(terminalId: string): Terminal {
        const terminal = this.#terminals.get(terminalId);
        if (!terminal) {
            throw new RpcError(RpcErrorCode.NotFound, 'terminal has exited');
        }
        return terminal;
    }

    write(terminalId: string, data: string): void {
        this.#get(terminalId).pty.write(data);
    }

    resize(terminalId: string, cols: number, rows: number): void {
        this.#get(terminalId).pty.resize(cols, rows);
    }

    close(terminalId: string): void {
        const terminal = this.#terminals.get(terminalId);
        if (terminal) {
            this.#terminals.delete(terminalId);
            endPty(terminal.pty);
        }
    }

    dispose(): void {
        for (const terminal of this.#terminals.values()) {
            endPty(terminal.pty);
        }
        this.#terminals.clear();
    }
}
