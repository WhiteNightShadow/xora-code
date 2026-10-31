import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Candidate, factoryId, loadState, parseCandidateId, rollbackTo, saveState, slotId } from '@xora/updater';
import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, ipcMain, shell } from 'electron';
import { SAFE_MODE_URL } from './app-protocol.ts';
import { relaunchArgs } from './args.ts';
import type { ShellEnv } from './env.ts';
import { type InventorySources, readInventory, verifyCandidate } from './inventory.ts';
import type { BootLog } from './log.ts';
import type { DataPaths, ShellFiles } from './paths.ts';
import { shellStrings } from './strings.ts';

export interface SafeModeDeps {
    readonly env: ShellEnv;
    readonly log: BootLog;
    readonly paths: DataPaths;
    readonly files: ShellFiles;
    readonly sources: InventorySources;
    readonly shellVersion: string;
    readonly reason: string;
}

interface CandidateStatus {
    readonly id: string;
    readonly kind: 'slot' | 'factory';
    readonly version: string;
    readonly ok: boolean;
    readonly problem?: string;
    readonly roles: string[];
    readonly bad?: { readonly reason: string; readonly at: string };
}

let safeWindow: BrowserWindow | undefined;

export function safeModeWindow(): BrowserWindow | undefined {
    return safeWindow;
}

async function collectStatus(deps: SafeModeDeps) {
    const { state } = await loadState(deps.paths.stateFile);
    const inventory = await readInventory(deps.sources);
    const candidates: Candidate[] = [
        ...inventory.slots.map((version) => ({ id: slotId(version), kind: 'slot' as const, version })),
        ...(inventory.factory
            ? [
                  {
                      id: factoryId(inventory.factory.version),
                      kind: 'factory' as const,
                      version: inventory.factory.version,
                  },
              ]
            : []),
    ];
    const statuses: CandidateStatus[] = [];
    for (const candidate of candidates) {
        const check = await verifyCandidate(deps.sources, candidate);
        const roles: string[] = [];
        if (candidate.kind === 'slot') {
            if (state.current === candidate.version) roles.push('current');
            if (state.previous === candidate.version) roles.push('previous');
            if (state.pending === candidate.version) roles.push('pending');
        } else {
            roles.push('factory');
        }
        if (state.lastGood === candidate.id) roles.push('lastGood');
        const mark = state.bad.find((entry) => entry.id === candidate.id);
        statuses.push({
            ...candidate,
            ok: check.ok,
            ...(check.ok ? {} : { problem: check.reason }),
            roles,
            ...(mark ? { bad: { reason: mark.reason, at: mark.at } } : {}),
        });
    }
    return {
        reason: deps.reason,
        shellVersion: deps.shellVersion,
        platform: `${process.platform}-${process.arch}`,
        versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
        dataDir: deps.paths.root,
        logsDir: deps.paths.logsDir,
        factoryMissing: !inventory.factory,
        candidates: statuses,
        lastFailure: state.lastFailure ?? null,
        // Extensions arrive in M4 and settings in M1; the page shows these actions as not yet available.
        features: { disableExtensions: false, resetSettings: false },
    };
}

function relaunchNormally(log: BootLog): void {
    log.info('leaving safe mode: relaunching');
    app.relaunch({ args: relaunchArgs(process.argv) });
    app.exit(0);
}

export async function openSafeMode(deps: SafeModeDeps): Promise<void> {
    const { env, log, paths, files } = deps;
    if (env.exitOnSafeMode) {
        log.info('safe mode reached; exiting because XORA_TEST_EXIT_ON_SAFE_MODE is set');
        app.quit();
        return;
    }
    const window = new BrowserWindow({
        width: 820,
        height: 680,
        minWidth: 640,
        minHeight: 480,
        show: false,
        title: shellStrings().safeModeTitle,
        webPreferences: {
            preload: files.preloadSafe,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
        },
    });
    safeWindow = window;
    window.once('ready-to-show', () => {
        if (!env.hideWindows) {
            window.show();
        }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());

    const handle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        ipcMain.handle(channel, (event, ...args) => {
            if (event.sender !== window.webContents) {
                throw new Error('forbidden');
            }
            return handler(event, ...args);
        });
    };

    handle('safe:status', () => collectStatus(deps));
    handle('safe:rollback', async (_event, target) => {
        const parsed = typeof target === 'string' ? parseCandidateId(target) : undefined;
        if (!parsed) {
            throw new Error('unknown candidate');
        }
        const candidate: Candidate = { id: target as string, ...parsed };
        const check = await verifyCandidate(deps.sources, candidate);
        if (!check.ok) {
            throw new Error(shellStrings().cannotLaunch(check.reason));
        }
        const { state } = await loadState(paths.stateFile);
        await saveState(paths.stateFile, rollbackTo(state, candidate));
        log.warn(`safe mode: user rolled back to ${candidate.id}`);
        relaunchNormally(log);
        return true;
    });
    handle('safe:open-logs', async () => {
        const error = await shell.openPath(paths.logsDir);
        return error === '' ? true : error;
    });
    handle('safe:export-diagnostics', async () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const result = await dialog.showSaveDialog(window, {
            title: shellStrings().exportDiagnostics,
            defaultPath: path.join(app.getPath('downloads'), `xora-diagnostics-${stamp}.json`),
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (result.canceled || !result.filePath) {
            return null;
        }
        const { state } = await loadState(paths.stateFile);
        const report = {
            generatedAt: new Date().toISOString(),
            status: await collectStatus(deps),
            state,
            bootstrapLog: log.tail(400),
        };
        await writeFile(result.filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        log.info(`diagnostics exported to ${result.filePath}`);
        return result.filePath;
    });
    handle('safe:restart-normal', async () => {
        const { state } = await loadState(paths.stateFile);
        await saveState(paths.stateFile, { ...state, safeModeRequested: false });
        relaunchNormally(log);
        return true;
    });
    handle('safe:quit', () => {
        app.quit();
        return true;
    });

    window.on('closed', () => {
        safeWindow = undefined;
        app.quit();
    });
    if (process.env.XORA_TEST_SAFE_MODE_PROBE === '1') {
        probeAfterLoad(window, deps);
    }
    await window.loadURL(SAFE_MODE_URL);
}

/** Drill hook: reports what the repair page rendered, then quits. Proves the page, its CSP and IPC all work. */
function probeAfterLoad(window: BrowserWindow, deps: SafeModeDeps): void {
    window.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
            const rendered = await window.webContents
                .executeJavaScript(
                    '({ state: document.body.dataset.state, candidates: Number(document.body.dataset.candidates ?? 0), reason: document.getElementById("reason")?.textContent ?? "" })',
                )
                .catch((error: unknown) => ({ state: 'probe-failed', error: String(error) }));
            await writeFile(
                path.join(deps.paths.root, 'safe-mode-probe.json'),
                `${JSON.stringify(rendered)}\n`,
                'utf8',
            );
            deps.log.info(`safe mode probe: ${JSON.stringify(rendered)}`);
            app.quit();
        }, 1500);
    });
}
