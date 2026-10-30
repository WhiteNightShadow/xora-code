import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Optional use of a system ripgrep. Xora does not ship `rg` (`@vscode/ripgrep` only downloads the binary of the
 * machine that installs it, and all six targets are packaged on one mac), so `grep` has a JavaScript engine and only
 * switches to `rg` when one is on PATH.
 */

let detected: Promise<string | null> | undefined;

/** Absolute path of the `rg` on PATH, or `null`. Looked up once per process. */
export function findRipgrep(): Promise<string | null> {
    detected ??= locate(process.env.PATH ?? '');
    return detected;
}

async function locate(searchPath: string): Promise<string | null> {
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg';
    for (const dir of searchPath.split(path.delimiter)) {
        if (dir === '' || !path.isAbsolute(dir)) {
            continue;
        }
        const candidate = path.join(dir, name);
        try {
            await access(candidate, constants.X_OK);
            if (!(await stat(candidate)).isFile()) {
                continue;
            }
        } catch {
            continue;
        }
        if (await isRipgrep(candidate)) {
            return candidate;
        }
    }
    return null;
}

/** Runs `--version` to make sure the binary is ripgrep and works. */
export function isRipgrep(file: string): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(file, ['--version'], { timeout: 5000, windowsHide: true }, (error, stdout) => {
            resolve(error === null && /^ripgrep \d/.test(String(stdout)));
        });
    });
}
