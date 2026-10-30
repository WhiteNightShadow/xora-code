import path from 'node:path';
import { runProcess } from './process.ts';

/** Variables `git` needs to find itself, its config, credentials helpers and proxies. None of them is a key. */
const GIT_ENV_KEYS = [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'ProgramFiles',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'XDG_CONFIG_HOME',
    'SSH_AUTH_SOCK',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
];

/** A minimal environment for `git`, taken from this process: paths, locale, ssh agent and proxies only. */
export function defaultGitEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of GIT_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            env[key] = value;
        }
    }
    return env;
}

/**
 * Remote URLs `git clone` may use: https, http, ssh, git and file URLs, scp-like `user@host:path`, and absolute
 * local paths. Transport helpers such as `ext::` and anything starting with `-` are refused.
 */
export function isAllowedGitUrl(url: string): boolean {
    if (url.startsWith('-') || /\s/.test(url) || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) {
        return false;
    }
    if (/^(?:https?|ssh|git|file):\/\/./i.test(url)) {
        return true;
    }
    if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^/\\]/.test(url)) {
        return true;
    }
    return path.isAbsolute(url);
}

/** Removes passwords from `https://user:password@host/…` URLs in `text`, so it can be stored and shown. */
export function redactUrl(text: string): string {
    return text.replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):[^/@\s]*@/gi, '$1$2@');
}

export interface GitCloneOptions {
    readonly url: string;
    readonly dest: string;
    /** Branch or tag. */
    readonly ref?: string;
    /** Full commit to check out; fetched with history, since servers may not serve a commit by id. */
    readonly sha?: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly git?: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
}

/**
 * Clones without a shell and without prompting: `GIT_TERMINAL_PROMPT=0`, ssh in batch mode, `ext::` transports
 * disabled. Shallow unless a commit is requested. Returns the checked-out commit.
 */
export async function gitClone(options: GitCloneOptions): Promise<{ commit: string }> {
    const { url, dest, ref, sha } = options;
    if (!isAllowedGitUrl(url)) {
        throw new Error(`unsupported git url: ${redactUrl(url)}`);
    }
    if (ref !== undefined && (ref.startsWith('-') || /\s/.test(ref))) {
        throw new Error(`invalid git ref: ${ref}`);
    }
    if (sha !== undefined && !/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(`invalid commit: ${sha}`);
    }
    const env = {
        ...options.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_SSH_COMMAND: options.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
    };
    const git = options.git ?? 'git';
    const run = async (args: string[], cwd: string): Promise<string> => {
        const result = await runProcess(git, ['-c', 'protocol.ext.allow=never', ...args], {
            cwd,
            env,
            timeoutMs: options.timeoutMs ?? 120_000,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (result.exitCode !== 0) {
            const why = result.spawnError ?? (result.timedOut ? 'timed out' : result.stderr.trim().slice(-2000));
            throw new Error(`git ${args[0]} failed: ${redactUrl(why)}`);
        }
        return result.stdout;
    };
    const parent = path.dirname(dest);
    if (sha === undefined) {
        await run(['clone', '--depth', '1', '--no-tags', ...(ref ? ['--branch', ref] : []), '--', url, dest], parent);
    } else {
        await run(['clone', '--no-checkout', ...(ref ? ['--branch', ref] : []), '--', url, dest], parent);
        await run(['checkout', '--detach', sha], dest);
    }
    const commit = (await run(['rev-parse', 'HEAD'], dest)).trim();
    if (sha !== undefined && commit !== sha) {
        throw new Error(`checked out ${commit} instead of ${sha}`);
    }
    return { commit };
}
