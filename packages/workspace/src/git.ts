import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** Thrown when no git executable can be found, so the host can tell the user to install git. */
export class GitUnavailableError extends Error {
    constructor(message = 'git was not found on PATH') {
        super(message);
        this.name = 'GitUnavailableError';
    }
}

/** A git command that exited with a status its caller did not expect. */
export class GitError extends Error {
    readonly args: readonly string[];
    readonly code: number;
    readonly stderr: string;

    constructor(args: readonly string[], code: number, stderr: string) {
        const command = args.slice(0, 3).join(' ') + (args.length > 3 ? ' …' : '');
        const detail = stderr.trim().split('\n').slice(-2).join(' | ');
        super(`git ${command} exited with ${code}${detail ? `: ${detail}` : ''}`);
        this.name = 'GitError';
        this.args = args;
        this.code = code;
        this.stderr = stderr;
    }
}

let cachedGit: string | undefined;

/**
 * Locates the git executable on PATH (`git.exe` on Windows). A hit is cached; `refresh` looks again, for example
 * after the user installed git. Returns undefined when git is missing.
 */
export function findGit(options: { readonly refresh?: boolean } = {}): string | undefined {
    if (cachedGit && !options.refresh) {
        return cachedGit;
    }
    cachedGit = undefined;
    const name = process.platform === 'win32' ? 'git.exe' : 'git';
    for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
        const dir = entry.trim().replace(/^"(.*)"$/, '$1');
        // Relative PATH entries would resolve against whatever directory the host runs in; never trust them.
        if (!dir || !path.isAbsolute(dir)) {
            continue;
        }
        const candidate = path.join(dir, name);
        if (isExecutableFile(candidate)) {
            cachedGit = candidate;
            return candidate;
        }
    }
    return undefined;
}

function isExecutableFile(file: string): boolean {
    try {
        if (!statSync(file).isFile()) {
            return false;
        }
        if (process.platform !== 'win32') {
            accessSync(file, constants.X_OK);
        }
        return true;
    } catch {
        return false;
    }
}

export interface GitRunOptions {
    readonly cwd: string;
    /** Extra environment variables; `undefined` removes one. */
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly input?: string | Uint8Array;
    /** Largest stdout accepted, in bytes (default 256 MiB); the command is killed beyond it. */
    readonly maxBuffer?: number;
    readonly signal?: AbortSignal;
    /**
     * `raw` (default) forces `core.autocrlf=false` and `core.safecrlf=false` so content passes byte for byte.
     * `user` keeps the user's end-of-line settings, which commands that diff, patch or check out the user's own
     * files need: with `autocrlf=true` (the Git for Windows default) a raw diff would flag every line.
     */
    readonly eol?: 'raw' | 'user';
}

export interface GitResult {
    readonly stdout: Buffer;
    readonly stderr: string;
    readonly code: number;
}

const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

/**
 * Inherited variables that would point git at another repository, index or object store, or change how
 * pathspecs and diffs are interpreted. They are set when the host itself was started from a git hook or alias.
 */
const REDIRECTING_ENV = [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_ATTR_SOURCE',
    'GIT_COMMON_DIR',
    'GIT_CONFIG',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
    'GIT_DIFF_OPTS',
    'GIT_DIR',
    'GIT_EXTERNAL_DIFF',
    'GIT_GLOB_PATHSPECS',
    'GIT_GRAFT_FILE',
    'GIT_ICASE_PATHSPECS',
    'GIT_IMPLICIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_LITERAL_PATHSPECS',
    'GIT_NAMESPACE',
    'GIT_NOGLOB_PATHSPECS',
    'GIT_NO_REPLACE_OBJECTS',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PREFIX',
    'GIT_QUARANTINE_PATH',
    'GIT_REPLACE_REF_BASE',
    'GIT_SHALLOW_FILE',
    'GIT_WORK_TREE',
];

function gitEnv(extra: Readonly<Record<string, string | undefined>> | undefined): NodeJS.ProcessEnv {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of REDIRECTING_ENV) {
        delete env[name];
    }
    for (const name of Object.keys(env)) {
        if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) {
            delete env[name];
        }
    }
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_OPTIONAL_LOCKS = '0';
    env.LC_ALL = 'C';
    for (const [name, value] of Object.entries(extra ?? {})) {
        if (value === undefined) {
            delete env[name];
        } else {
            env[name] = value;
        }
    }
    return env;
}

/**
 * Runs git without a shell and collects its output. Resolves with the exit code whatever it is; rejects only when
 * git cannot be started, is aborted, is killed, or exceeds `maxBuffer`.
 */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    const git = findGit();
    if (!git) {
        return Promise.reject(new GitUnavailableError());
    }
    const config = ['-c', 'core.quotepath=false'];
    if (options.eol !== 'user') {
        config.push('-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false');
    }
    if (process.platform === 'win32') {
        config.push('-c', 'core.longpaths=true');
    }
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    return new Promise((resolve, reject) => {
        let child: ChildProcess;
        try {
            child = spawn(git, [...config, ...args], {
                cwd: options.cwd,
                env: gitEnv(options.env),
                stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
                windowsHide: true,
                signal: options.signal,
            });
        } catch (error) {
            reject(error);
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let stderr = '';
        let failure: Error | undefined;
        let settled = false;
        const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (failure) {
                reject(explainFailure(failure, git, options.cwd));
            } else if (code === null) {
                reject(new Error(`git ${args[0] ?? ''} was terminated by ${signal ?? 'a signal'}`));
            } else {
                resolve({ stdout: Buffer.concat(chunks), stderr, code });
            }
        };
        child.stdout?.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBuffer) {
                failure ??= new Error(`git ${args[0] ?? ''} produced more than ${maxBuffer} bytes`);
                child.kill();
                return;
            }
            chunks.push(chunk);
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            if (stderr.length < MAX_STDERR) {
                stderr += chunk;
            }
        });
        child.on('error', (error) => {
            failure ??= error;
            // A process that never started emits no reliable 'close'.
            if (child.pid === undefined) {
                finish(null, null);
            }
        });
        child.on('close', finish);
        if (options.input !== undefined && child.stdin) {
            // git may exit before reading everything (for example `apply --check` on a broken patch).
            child.stdin.on('error', () => undefined);
            child.stdin.end(options.input);
        }
    });
}

function explainFailure(error: Error, git: string, cwd: string): Error {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return error;
    }
    // spawn reports a missing working directory with the same ENOENT as a missing executable.
    if (!existsSync(cwd)) {
        return new Error(`cannot run git: directory does not exist: ${cwd}`);
    }
    if (!existsSync(git)) {
        cachedGit = undefined;
        return new GitUnavailableError(`git is no longer available at ${git}`);
    }
    return error;
}

/** Runs git and returns stdout, throwing {@link GitError} for any exit code outside `okCodes`. */
export async function gitOutput(
    args: readonly string[],
    options: GitRunOptions,
    okCodes: readonly number[] = [0],
): Promise<Buffer> {
    const result = await runGit(args, options);
    if (!okCodes.includes(result.code)) {
        throw new GitError(args, result.code, result.stderr);
    }
    return result.stdout;
}

/** stdout as text without the trailing newline git adds. */
export function outputLine(stdout: Buffer): string {
    return stdout.toString('utf8').replace(/\r?\n$/, '');
}

async function query(args: readonly string[], dir: string): Promise<string | undefined> {
    let result: GitResult;
    try {
        result = await runGit(args, { cwd: dir, eol: 'user' });
    } catch (error) {
        if (error instanceof GitUnavailableError) {
            throw error;
        }
        return undefined;
    }
    return result.code === 0 ? outputLine(result.stdout) : undefined;
}

/** Whether `dir` is inside the work tree of a git repository. */
export async function isGitRepo(dir: string): Promise<boolean> {
    return (await query(['rev-parse', '--is-inside-work-tree'], dir)) === 'true';
}

/** Top-level directory of the work tree containing `dir`, or undefined outside a repository. */
export async function gitRoot(dir: string): Promise<string | undefined> {
    const top = await query(['rev-parse', '--show-toplevel'], dir);
    return top ? path.resolve(top) : undefined;
}

/** Checked-out branch name, or undefined for a detached HEAD or outside a repository. */
export async function currentBranch(dir: string): Promise<string | undefined> {
    return (await query(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir)) || undefined;
}

/** Commit id of HEAD, or undefined before the first commit or outside a repository. */
export async function headCommit(dir: string): Promise<string | undefined> {
    return (await query(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], dir)) || undefined;
}

/** {@link gitRoot} that throws when `dir` is not inside a repository. */
export async function requireGitRoot(dir: string): Promise<string> {
    const root = await gitRoot(dir);
    if (!root) {
        throw new Error(`not a git repository: ${dir}`);
    }
    return root;
}

/** Rejects revisions that git would parse as an option. */
export function assertRevision(revision: string): void {
    if (!revision || revision.startsWith('-') || /[\0\n]/.test(revision)) {
        throw new Error(`invalid revision: ${JSON.stringify(revision)}`);
    }
}
