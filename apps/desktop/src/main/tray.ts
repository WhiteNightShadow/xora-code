import path from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';
import { onLanguageChange, shellStrings } from './strings.ts';

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
    readonly #stopFollowingLanguage: () => void;

    constructor(options: { iconPath: string; show: (threadId?: string) => void; quit: () => void }) {
        this.#iconPath = options.iconPath;
        this.#show = options.show;
        this.#quit = options.quit;
        this.#stopFollowingLanguage = onLanguageChange(() => this.#render());
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
            // macOS: a template image (black drawing, its @2x beside it) that the menu bar tints; elsewhere the icon.
            const image =
                process.platform === 'darwin'
                    ? nativeImage.createFromPath(this.#iconPath)
                    : nativeImage.createFromPath(this.#iconPath).resize({ width: 16, height: 16 });
            if (process.platform === 'darwin') image.setTemplateImage(true);
            this.#tray = new Tray(image);
            this.#tray.on('click', () => this.#show());
        }
        const s = shellStrings();
        this.#tray.setToolTip(this.#running.length > 0 ? s.trayTooltip(this.#running.length) : 'Xora Code');
        const items: Electron.MenuItemConstructorOptions[] = [{ label: s.showApp, click: () => this.#show() }];
        if (this.#running.length > 0) {
            items.push({ type: 'separator' }, { label: s.trayRunning(this.#running.length), enabled: false });
            for (const entry of this.#running.slice(0, 15)) {
                const mark = entry.status === 'awaiting_approval' ? '◐ ' : '● ';
                items.push({ label: `${mark}${entry.title}`.slice(0, 60), click: () => this.#show(entry.threadId) });
            }
        }
        items.push({ type: 'separator' }, { label: s.quit, click: () => this.#quit() });
        this.#tray.setContextMenu(Menu.buildFromTemplate(items));
    }

    dispose(): void {
        this.#stopFollowingLanguage();
        this.#tray?.destroy();
        this.#tray = undefined;
    }
}

export function trayIconPath(): string {
    return path.join(__dirname, '..', 'static', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
}

/** Quitting from the tray must not be swallowed by the hide-on-close behaviour. */
export function forceQuit(): void {
    app.exit(0);
}
