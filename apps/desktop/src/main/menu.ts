import { app, Menu, type MenuItemConstructorOptions, shell } from 'electron';

export interface MenuActions {
    readonly restartIntoSafeMode: () => void;
    readonly logsDir: string;
}

export function installMenu(actions: MenuActions): void {
    const help: MenuItemConstructorOptions = {
        label: '帮助',
        submenu: [
            { label: '重启到修复模式', click: () => actions.restartIntoSafeMode() },
            { label: '打开日志目录', click: () => void shell.openPath(actions.logsDir) },
        ],
    };
    const view: MenuItemConstructorOptions = {
        label: '视图',
        submenu: [
            { role: 'reload', label: '重新加载界面' },
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
            Menu.buildFromTemplate([{ label: '重启到修复模式', click: () => actions.restartIntoSafeMode() }]),
        );
    }
}
