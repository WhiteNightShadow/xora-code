import path from 'node:path';
import { installSlot, loadState, saveState, stagePending, type TrustedKeys } from '@xora/updater';
import type { BootLog } from './log.ts';
import type { DataPaths } from './paths.ts';

export interface StageOptions {
    readonly source: string;
    readonly paths: DataPaths;
    readonly trustedKeys: TrustedKeys;
    readonly shellVersion: string;
    readonly log: BootLog;
}

/**
 * Verifies a bundle (signature, every file hash, shell compatibility), installs it as a slot and stages it as
 * the pending update. The next launch tries it under the usual health checks.
 */
export async function stageBundle(
    options: StageOptions,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
    try {
        const { version } = await installSlot(path.resolve(options.source), options.paths.slotsDir, {
            trustedKeys: options.trustedKeys,
            shellVersion: options.shellVersion,
        });
        const { state } = await loadState(options.paths.stateFile);
        await saveState(options.paths.stateFile, stagePending(state, version));
        options.log.info(`installed bundle ${version} as the pending update`);
        return { ok: true, version };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.log.error(`bundle install failed: ${message}`);
        return { ok: false, error: message };
    }
}

/** `--install-bundle <dir>`: the drill and manual testing use the same path as online updates. */
export async function installBundleFromCli(options: StageOptions): Promise<number> {
    const result = await stageBundle(options);
    if (result.ok) {
        process.stdout.write(`${JSON.stringify({ installed: result.version })}\n`);
        return 0;
    }
    process.stderr.write(`${JSON.stringify({ error: result.error })}\n`);
    return 1;
}
