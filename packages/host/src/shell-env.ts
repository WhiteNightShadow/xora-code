import { execFile } from 'node:child_process';

/**
 * Apps started from the Dock or a desktop launcher inherit a minimal PATH, so agents could not find git,
 * node or package managers. Like editors do, ask the user's login shell once for its PATH and merge it in.
 */
export function resolveLoginPath(timeoutMs = 5000): Promise<string | undefined> {
    if (process.platform === 'win32') {
        return Promise.resolve(undefined);
    }
    const shell = process.env.SHELL || '/bin/bash';
    const marker = '__XORA_PATH__';
    return new Promise((resolve) => {
        execFile(
            shell,
            ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
            { timeout: timeoutMs, env: { ...process.env, TERM: 'dumb' } },
            (error, stdout) => {
                if (error) {
                    resolve(undefined);
                    return;
                }
                const match = new RegExp(`${marker}(.*)${marker}`).exec(stdout);
                resolve(match?.[1] || undefined);
            },
        );
    });
}

/** Merges the login shell's PATH entries in front of the current ones, without duplicates. */
export function mergePath(current: string | undefined, login: string | undefined): string | undefined {
    if (!login) {
        return current;
    }
    const seen = new Set<string>();
    const entries: string[] = [];
    for (const entry of [...login.split(':'), ...(current ?? '').split(':')]) {
        if (entry && !seen.has(entry)) {
            seen.add(entry);
            entries.push(entry);
        }
    }
    return entries.join(':');
}
