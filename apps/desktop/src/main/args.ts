export interface ShellArgs {
    /** `--safe-mode` or `--repair`: open the repair page instead of the app. */
    readonly safeMode: boolean;
    /** `--install-bundle <dir>`: verify a bundle, install it as the pending update and exit. */
    readonly installBundle?: string;
}

const SAFE_MODE_FLAGS = new Set(['--safe-mode', '--repair']);
const INSTALL_FLAG = '--install-bundle';

export function parseArgs(argv: readonly string[]): ShellArgs {
    let safeMode = false;
    let installBundle: string | undefined;
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === undefined) {
            continue;
        }
        if (SAFE_MODE_FLAGS.has(arg)) {
            safeMode = true;
        } else if (arg === INSTALL_FLAG) {
            installBundle = argv[++index];
        } else if (arg.startsWith(`${INSTALL_FLAG}=`)) {
            installBundle = arg.slice(INSTALL_FLAG.length + 1);
        }
    }
    return installBundle ? { safeMode, installBundle } : { safeMode };
}

/** Arguments for `app.relaunch()`: the current ones minus the one-shot flags. */
export function relaunchArgs(argv: readonly string[]): string[] {
    const kept: string[] = [];
    for (let index = 1; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === undefined || SAFE_MODE_FLAGS.has(arg) || arg.startsWith(`${INSTALL_FLAG}=`)) {
            continue;
        }
        if (arg === INSTALL_FLAG) {
            index++;
            continue;
        }
        kept.push(arg);
    }
    return kept;
}
