import { app, Menu, type MenuItemConstructorOptions, shell } from 'electron';
import { onLanguageChange, shellStrings } from './strings.ts';

export interface MenuActions {
    readonly restartIntoSafeMode: () => void;
    readonly logsDir: string;
}

/** The application menu, and the dock menu on macOS; both follow the shell's language. */
export function installMenu(actions: MenuActions): void {
    buildMenu(actions);
    onLanguageChange(() => buildMenu(actions));
}

function buildMenu(actions: MenuActions): void {
    const s = shellStrings();
    const help: MenuItemConstructorOptions = {
        label: s.help,
        submenu: [
            { label: s.restartSafeMode, click: () => actions.restartIntoSafeMode() },
            { label: s.openLogs, click: () => void shell.openPath(actions.logsDir) },
        ],
    };
    const view: MenuItemConstructorOptions = {
        label: s.view,
        submenu: [
            { role: 'reload', label: s.reload },
            ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const]),
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
        ],
    };
    const template: MenuItemConstructorOptions[] = [
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
        { role: 'editMenu' },
        view,
        { role: 'windowMenu' },
        help,
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    if (process.platform === 'darwin') {
        app.dock?.setMenu(
            Menu.buildFromTemplate([{ label: s.restartSafeMode, click: () => actions.restartIntoSafeMode() }]),
        );
    }
}
