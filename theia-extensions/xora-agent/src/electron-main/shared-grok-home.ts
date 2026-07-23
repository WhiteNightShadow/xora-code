import * as os from 'os';
import * as path from 'path';

/**
 * Resolve the one Grok home shared by subscription CLI commands, ACP runtimes,
 * configuration editing and the filesystem observer.
 *
 * Electron launched from the Windows Start Menu can inherit a different HOME
 * shape from an interactive PowerShell. Grok Build also gives GROK_HOME higher
 * precedence than either HOME or USERPROFILE, so making it explicit prevents a
 * successful browser login from being written to a directory the ACP process
 * never reads.
 */
export function resolveSharedGrokHome(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory = os.homedir(),
    platform: NodeJS.Platform = process.platform
): string {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const configured = environment.GROK_HOME?.trim();
    if (configured && paths.isAbsolute(configured)) {
        return paths.normalize(configured);
    }
    return paths.join(homeDirectory, '.grok');
}

export function sharedGrokHome(): string {
    return resolveSharedGrokHome();
}
