import {
    type BootState,
    consumeSafeModeRequest,
    decideBoot,
    loadState,
    markBad,
    reconcile,
    recordAborted,
    recordFailure,
    recordGood,
    recordInvalid,
    recordLaunch,
    requestSafeMode,
    saveState,
    type TrustedKeys,
} from '@xora/updater';
import { app } from 'electron';
import { relaunchArgs } from './args.ts';
import type { ShellEnv } from './env.ts';
import { candidateDir, readInventory, verifyCandidate } from './inventory.ts';
import type { BootLog } from './log.ts';
import type { DataPaths, ShellFiles } from './paths.ts';
import { BundleRuntime } from './runtime.ts';
import { openSafeMode } from './safe-mode.ts';

/** Launches that may start without reaching "good" before a candidate is given up. */
export const MAX_ATTEMPTS = 2;
const MAX_ROUNDS = 8;

export interface BootDeps {
    readonly env: ShellEnv;
    readonly log: BootLog;
    readonly paths: DataPaths;
    readonly files: ShellFiles;
    readonly factoryDir: string;
    readonly trustedKeys: TrustedKeys;
    readonly shellVersion: string;
    readonly forceSafeMode: boolean;
}

let activeRuntime: BundleRuntime | undefined;

export function activeWindow() {
    return activeRuntime?.window;
}

/** Records the request and restarts the app; the next boot opens the repair page. */
export async function restartIntoSafeMode(deps: Pick<BootDeps, 'paths' | 'log'>): Promise<void> {
    const { state } = await loadState(deps.paths.stateFile);
    await saveState(deps.paths.stateFile, requestSafeMode(state));
    deps.log.info('restarting into safe mode on request');
    app.relaunch({ args: relaunchArgs(process.argv) });
    app.exit(0);
}

/**
 * The boot loop: pick a candidate, verify it, launch it, and record the outcome. Failures fall through to the
 * next candidate in the same process; when nothing is left the repair page opens.
 */
export async function boot(deps: BootDeps): Promise<void> {
    const { log, paths, env } = deps;
    const sources = {
        factoryDir: deps.factoryDir,
        slotsDir: paths.slotsDir,
        trustedKeys: deps.trustedKeys,
        shellVersion: deps.shellVersion,
    };
    const loaded = await loadState(paths.stateFile);
    if (loaded.recoveredFrom) {
        log.warn(`boot state was unreadable and was moved to ${loaded.recoveredFrom}`);
    }
    let state: BootState = loaded.state;
    const persist = async (next: BootState) => {
        state = next;
        await saveState(paths.stateFile, state);
    };

    let forceSafeMode = deps.forceSafeMode;
    for (let round = 0; round < MAX_ROUNDS; round++) {
        const inventory = await readInventory(sources);
        if (!inventory.factory) {
            log.error(`factory bundle is missing or unreadable at ${deps.factoryDir}`);
        }
        state = reconcile(state, inventory);
        const { decision, exhausted } = decideBoot(state, inventory, { maxAttempts: MAX_ATTEMPTS, forceSafeMode });
        forceSafeMode = false;
        for (const id of exhausted) {
            log.warn(`${id} started ${MAX_ATTEMPTS} times without finishing its boot; marking it bad`);
            state = markBad(state, id, 'unfinished-launches');
        }

        if (decision.kind === 'safe-mode') {
            await persist(consumeSafeModeRequest(state, decision.reason));
            log.warn(`entering safe mode: ${decision.reason}`);
            activeRuntime = undefined;
            await openSafeMode({ ...deps, sources, reason: decision.reason });
            return;
        }

        const { candidate } = decision;
        const check = await verifyCandidate(sources, candidate);
        if (!check.ok) {
            log.error(`${candidate.id} failed verification (${check.reason}); it will not be launched again`);
            await persist(recordInvalid(state, candidate.id, check.reason));
            continue;
        }

        await persist(recordLaunch(state, candidate.id));
        log.info(`launching ${candidate.id} (${decision.reason}) from ${candidateDir(sources, candidate)}`);
        const runtime = new BundleRuntime({
            env,
            log,
            dataDir: paths.root,
            shellVersion: deps.shellVersion,
            preloadPath: deps.files.preloadApp,
            bundleDir: candidateDir(sources, candidate),
            manifest: check.manifest,
            candidate,
            onCrashLoop: (component) => {
                log.error(`${component} keeps crashing after a good boot; restarting into safe mode`);
                void restartIntoSafeMode(deps);
            },
            onSafeModeRequest: () => void restartIntoSafeMode(deps),
        });
        activeRuntime = runtime;
        const outcome = await runtime.start();

        switch (outcome.kind) {
            case 'good':
            case 'good-then-closed':
                await persist(recordGood(state, candidate));
                log.info(`${candidate.id} is good`);
                if (outcome.kind === 'good-then-closed' || env.exitAfterGood) {
                    runtime.dispose();
                    app.quit();
                }
                return;
            case 'closed':
                await persist(recordAborted(state, candidate.id));
                log.info(`${candidate.id}: window closed before the UI was ready`);
                app.quit();
                return;
            case 'safe-mode-requested':
                await persist(requestSafeMode(recordAborted(state, candidate.id)));
                continue;
            case 'rollback-requested':
                log.warn(`${candidate.id}: user asked to roll back (${outcome.reason})`);
                await persist(markBad(state, candidate.id, `user-rollback:${outcome.reason}`));
                continue;
            case 'failed':
                log.error(`${candidate.id} failed: ${outcome.reason}`);
                await persist(recordFailure(state, candidate.id, outcome.reason, MAX_ATTEMPTS));
                continue;
        }
    }

    await persist(consumeSafeModeRequest(state, 'boot-loop'));
    log.error('too many boot rounds; entering safe mode');
    activeRuntime = undefined;
    await openSafeMode({ ...deps, sources, reason: 'boot-loop' });
}
