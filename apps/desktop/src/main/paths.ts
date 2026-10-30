import path from 'node:path';
import { app } from 'electron';

/**
 * The data directory is deliberately not "Xora Code": that is where the legacy 0.2.x app keeps its state,
 * and the rewrite must not read or overwrite it.
 */
export const DATA_DIR_NAME = 'xora-code';

export interface DataPaths {
    readonly root: string;
    readonly appDir: string;
    readonly slotsDir: string;
    readonly stateFile: string;
    readonly logsDir: string;
    /** Chromium profile data (caches, storage), kept apart from Xora's own files. */
    readonly electronDir: string;
}

export function resolveDataDir(): string {
    const override = process.env.XORA_DATA_DIR?.trim();
    return override ? path.resolve(override) : path.join(app.getPath('appData'), DATA_DIR_NAME);
}

export function dataPaths(root: string): DataPaths {
    const appDir = path.join(root, 'app');
    return {
        root,
        appDir,
        slotsDir: path.join(appDir, 'slots'),
        stateFile: path.join(appDir, 'state.json'),
        logsDir: path.join(root, 'logs'),
        electronDir: path.join(root, 'electron'),
    };
}

/** The bundle shipped with the installer. `XORA_FACTORY_BUNDLE` only applies to unpackaged development runs. */
export function resolveFactoryDir(): string {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'app-bundle');
    }
    const override = process.env.XORA_FACTORY_BUNDLE?.trim();
    return override ? path.resolve(override) : path.resolve(app.getAppPath(), '..', '..', 'dist', 'app-bundle');
}

export interface ShellFiles {
    readonly preloadApp: string;
    readonly preloadSafe: string;
    readonly safeModePage: string;
}

export function shellFiles(): ShellFiles {
    return {
        preloadApp: path.join(__dirname, 'preload-app.cjs'),
        preloadSafe: path.join(__dirname, 'preload-safe.cjs'),
        safeModePage: path.join(__dirname, '..', 'static', 'safe-mode', 'index.html'),
    };
}
