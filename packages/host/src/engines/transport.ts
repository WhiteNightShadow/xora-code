import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { portStream } from '@xora/engine';
import type { ShellEngine } from '../shell.ts';

/** A child process that speaks ACP on stdio: external agents, and the xora engine outside the app. */
export interface StdioLaunch {
    readonly kind: 'stdio';
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly cwd?: string;
}

/** The xora engine in the app: a utility process the bootstrap forks from the bundle, with ACP over a port. */
export interface UtilityLaunch {
    readonly kind: 'utility';
    /** Bundle-relative POSIX path, e.g. `engine/index.cjs`. */
    readonly entry: string;
    readonly env: Readonly<Record<string, string | undefined>>;
}

export type EngineLaunch = StdioLaunch | UtilityLaunch;

/** A started engine process, however it was started: its ACP stream and its lifetime. */
export interface EngineTransport {
    readonly stream: acp.Stream;
    /** Resolves once the process has ended, with its exit code or signal. */
    readonly exited: Promise<string>;
    kill(): void;
}

export async function spawnStdio(launch: StdioLaunch, onOutput: (text: string) => void): Promise<EngineTransport> {
    const child = spawn(launch.command, [...launch.args], {
        env: launch.env as NodeJS.ProcessEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(launch.cwd ? { cwd: launch.cwd } : {}),
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', onOutput);
    const exited = new Promise<string>((resolve) => {
        child.once('exit', (code, signal) => resolve(String(signal ?? code)));
    });
    await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
    });
    if (!child.stdin || !child.stdout) {
        throw new Error(`${launch.command} has no stdio`);
    }
    return {
        stream: acp.ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
        exited,
        kill: () => {
            if (child.exitCode === null && !child.killed) {
                child.kill();
            }
        },
    };
}

export function overPort(engine: ShellEngine): EngineTransport {
    return {
        stream: portStream(engine.port),
        exited: engine.exited.then(String),
        kill: () => engine.stop(),
    };
}
