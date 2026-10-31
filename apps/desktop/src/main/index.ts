import { app, dialog, session } from 'electron';
import { handleAppScheme, registerAppScheme } from './app-protocol.ts';
import { parseArgs } from './args.ts';
import { boot, restartIntoSafeMode, revealActiveWindow } from './boot.ts';
import { readShellEnv } from './env.ts';
import { installBundleFromCli } from './install.ts';
import { BootLog } from './log.ts';
import { installMenu } from './menu.ts';
import { dataPaths, resolveDataDir, resolveFactoryDir, shellFiles } from './paths.ts';
import { safeModeWindow } from './safe-mode.ts';
import { KEYCHAIN_APP_NAME } from './secrets.ts';

/**
 * The bootstrap: the only code that ships frozen inside the installer. Everything else (UI, host, engine)
 * lives in a signed app bundle that can be updated and rolled back. Keep this layer small.
 */

// The keychain entry takes its name from `app.name` once this script has loaded (see KEYCHAIN_APP_NAME). The
// product name comes back before anything shows it: menus, windows and, on Linux, the audio stream name.
const productName = app.name;
app.name = KEYCHAIN_APP_NAME;
app.once('will-finish-launching', () => {
    app.name = productName;
});

registerAppScheme();

const args = parseArgs(process.argv);
const env = readShellEnv();
const paths = dataPaths(resolveDataDir());
app.setPath('userData', paths.electronDir);
const log = new BootLog(paths.logsDir);
const trustedKeys = __XORA_TRUSTED_KEYS__;

async function main(): Promise<void> {
    handleAppScheme();
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    if (env.hideWindows) {
        app.dock?.hide();
    }
    const shellVersion = app.getVersion();
    log.info(
        `xora code shell ${shellVersion} on ${process.platform}-${process.arch}, electron ${process.versions.electron}`,
    );

    if (args.installBundle) {
        const code = await installBundleFromCli({ source: args.installBundle, paths, trustedKeys, shellVersion, log });
        app.exit(code);
        return;
    }

    installMenu({ restartIntoSafeMode: () => void restartIntoSafeMode({ paths, log }), logsDir: paths.logsDir });
    await boot({
        env,
        log,
        paths,
        files: shellFiles(),
        factoryDir: resolveFactoryDir(),
        trustedKeys,
        shellVersion,
        forceSafeMode: args.safeMode,
    });
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    const reveal = () => {
        if (revealActiveWindow()) {
            return;
        }
        const window = safeModeWindow();
        if (window && !window.isDestroyed()) {
            if (window.isMinimized()) {
                window.restore();
            }
            window.focus();
        }
    };
    app.on('second-instance', reveal);
    app.on('activate', reveal);
    // Quitting is explicit: the boot loop replaces windows while it falls back between bundles.
    app.on('window-all-closed', () => undefined);
    app.whenReady()
        .then(main)
        .catch((error: unknown) => {
            const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
            log.error(`fatal: ${message}`);
            dialog.showErrorBox('Xora Code无法启动', message);
            app.exit(1);
        });
}
