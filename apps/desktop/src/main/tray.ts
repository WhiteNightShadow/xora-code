import path from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';

export interface TrayEntry {
    readonly threadId: string;
    readonly title: string;
    readonly status: string;
}

/**
 * Tray presence while work runs in the background (03 §1, 04 §6): closing the window with running turns hides
 * it instead of quitting, and the tray lists what is still running.
 */
export class AppTray {
    readonly #iconPath: string;
    readonly #show: (threadId?: string) => void;
    readonly #quit: () => void;
    #tray: Tray | undefined;
    #running: readonly TrayEntry[] = [];
    #hidden = false;

    constructor(options: { iconPath: string; show: (threadId?: string) => void; quit: () => void }) {
        this.#iconPath = options.iconPath;
        this.#show = options.show;
        this.#quit = options.quit;
    }

    get running(): readonly TrayEntry[] {
        return this.#running;
    }

    update(running: readonly TrayEntry[]): void {
        this.#running = running;
        this.#render();
    }

    setHidden(hidden: boolean): void {
        this.#hidden = hidden;
        this.#render();
    }

    #render(): void {
        const wanted = this.#running.length > 0 || this.#hidden;
        if (!wanted) {
            this.#tray?.destroy();
            this.#tray = undefined;
            return;
        }
        if (!this.#tray) {
            const image = nativeImage.createFromPath(this.#iconPath).resize({ width: 16, height: 16 });
            this.#tray = new Tray(image);
            this.#tray.on('click', () => this.#show());
        }
        this.#tray.setToolTip(
            this.#running.length > 0 ? `Xora Code：${this.#running.length}个任务在运行` : 'Xora Code',
        );
        const items: Electron.MenuItemConstructorOptions[] = [{ label: '显示Xora Code', click: () => this.#show() }];
        if (this.#running.length > 0) {
            items.push({ type: 'separator' }, { label: `运行中（${this.#running.length}）`, enabled: false });
            for (const entry of this.#running.slice(0, 15)) {
                const mark = entry.status === 'awaiting_approval' ? '◐ ' : '● ';
                items.push({ label: `${mark}${entry.title}`.slice(0, 60), click: () => this.#show(entry.threadId) });
            }
        }
        items.push({ type: 'separator' }, { label: '退出', click: () => this.#quit() });
        this.#tray.setContextMenu(Menu.buildFromTemplate(items));
    }

    dispose(): void {
        this.#tray?.destroy();
        this.#tray = undefined;
    }
}

export function trayIconPath(): string {
    return path.join(__dirname, '..', 'static', 'tray.png');
}

/** Quitting from the tray must not be swallowed by the hide-on-close behaviour. */
export function forceQuit(): void {
    app.exit(0);
}
