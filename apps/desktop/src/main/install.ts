import path from 'node:path';
import { installSlot, loadState, saveState, stagePending, type TrustedKeys } from '@xora/updater';
import type { BootLog } from './log.ts';
import type { DataPaths } from './paths.ts';

/**
 * `--install-bundle <dir>`: verifies a bundle, installs it as a slot and stages it as the pending update.
 * Used by the rollback drill and for testing builds by hand; online updates reuse the same steps in M2.
 */
export async function installBundleFromCli(options: {
    readonly source: string;
    readonly paths: DataPaths;
    readonly trustedKeys: TrustedKeys;
    readonly shellVersion: string;
    readonly log: BootLog;
}): Promise<number> {
    try {
        const { version } = await installSlot(path.resolve(options.source), options.paths.slotsDir, {
            trustedKeys: options.trustedKeys,
            shellVersion: options.shellVersion,
        });
        const { state } = await loadState(options.paths.stateFile);
        await saveState(options.paths.stateFile, stagePending(state, version));
        options.log.info(`installed bundle ${version} as the pending update`);
        process.stdout.write(`${JSON.stringify({ installed: version })}\n`);
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.log.error(`bundle install failed: ${message}`);
        process.stderr.write(`${JSON.stringify({ error: message })}\n`);
        return 1;
    }
}
