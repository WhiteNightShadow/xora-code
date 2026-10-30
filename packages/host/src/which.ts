import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/** Finds an executable on PATH (with PATHEXT on Windows), without spawning a shell. */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (command.includes('/') || command.includes('\\')) {
        return command;
    }
    const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
    for (const dir of (env.PATH ?? '').split(path.delimiter)) {
        if (!dir) continue;
        for (const extension of extensions) {
            const candidate = path.join(dir, command + extension);
            try {
                accessSync(candidate, constants.X_OK);
                return candidate;
            } catch {
                // keep looking
            }
        }
    }
    return undefined;
}
