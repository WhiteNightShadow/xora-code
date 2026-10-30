import { type BrowserWindow, type Rectangle, session, shell, WebContentsView } from 'electron';
import type { BootLog } from './log.ts';

const PARTITION = 'persist:xora-preview';

/** Highlight used while the user picks an element; inserted with insertCSS so page CSP cannot block it. */
const PICKER_CSS =
    '.__xora_pick { outline: 2px solid #3d5afe !important; outline-offset: 1px !important; cursor: crosshair !important; }';

/** Runs in the previewed page: lets the user click one element and returns a description of it. */
const PICKER_SCRIPT = `new Promise((resolve) => {
    let last = null;
    const path = (el) => {
        const parts = [];
        while (el && el.nodeType === 1 && parts.length < 6) {
            let part = el.tagName.toLowerCase();
            if (el.id) { part += '#' + el.id; parts.unshift(part); break; }
            const cls = [...el.classList].filter((c) => c !== '__xora_pick').slice(0, 2);
            if (cls.length) part += '.' + cls.join('.');
            const parent = el.parentElement;
            if (parent) {
                const same = [...parent.children].filter((c) => c.tagName === el.tagName);
                if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
            }
            parts.unshift(part);
            el = el.parentElement;
        }
        return parts.join(' > ');
    };
    const over = (event) => { last?.classList.remove('__xora_pick'); last = event.target; last.classList.add('__xora_pick'); };
    const done = (value) => {
        document.removeEventListener('mouseover', over, true);
        document.removeEventListener('click', click, true);
        document.removeEventListener('keydown', key, true);
        last?.classList.remove('__xora_pick');
        resolve(value);
    };
    const click = (event) => {
        event.preventDefault();
        event.stopPropagation();
        const el = event.target;
        const rect = el.getBoundingClientRect();
        done({
            selector: path(el),
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || '').trim().slice(0, 400),
            html: el.outerHTML.slice(0, 1200),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            url: location.href,
            title: document.title,
        });
    };
    const key = (event) => { if (event.key === 'Escape') { event.preventDefault(); done(null); } };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
})`;

export interface PreviewAnnotation {
    readonly selector: string;
    readonly tag: string;
    readonly text: string;
    readonly html: string;
    readonly rect: { x: number; y: number; width: number; height: number };
    readonly url: string;
    readonly title: string;
    /** PNG of the element as a data URL. */
    readonly image?: string;
}

/**
 * The preview browser (04 §5): a sandboxed WebContentsView laid over the panel area of the main window, in its
 * own session without the app's preload, so previewed pages can never reach Xora's APIs.
 */
export class PreviewController {
    readonly #window: BrowserWindow;
    readonly #log: BootLog;
    readonly #emit: (
        event: { type: 'navigated'; url: string; title: string; canGoBack: boolean } | { type: 'closed' },
    ) => void;
    #view: WebContentsView | undefined;

    constructor(window: BrowserWindow, log: BootLog, emit: PreviewController['emit']) {
        this.#window = window;
        this.#log = log;
        this.#emit = emit;
    }

    get emit() {
        return this.#emit;
    }

    #ensure(): WebContentsView {
        if (this.#view && !this.#view.webContents.isDestroyed()) {
            return this.#view;
        }
        const previewSession = session.fromPartition(PARTITION);
        previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        const view = new WebContentsView({
            webPreferences: { session: previewSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        const contents = view.webContents;
        contents.setWindowOpenHandler(({ url }) => {
            if (/^https?:\/\//.test(url)) {
                void contents.loadURL(url);
            }
            return { action: 'deny' };
        });
        contents.on('will-navigate', (event, url) => {
            if (!/^https?:\/\//.test(url) && !url.startsWith('about:')) {
                event.preventDefault();
            }
        });
        const report = () =>
            this.#emit({
                type: 'navigated',
                url: contents.getURL(),
                title: contents.getTitle(),
                canGoBack: contents.navigationHistory.canGoBack(),
            });
        contents.on('did-navigate', report);
        contents.on('did-navigate-in-page', report);
        contents.on('page-title-updated', report);
        this.#window.contentView.addChildView(view);
        this.#view = view;
        return view;
    }

    open(url: string, bounds: Rectangle): void {
        if (!/^https?:\/\//.test(url)) {
            throw new Error('only http(s) pages can be previewed');
        }
        const view = this.#ensure();
        view.setBounds(bounds);
        view.setVisible(true);
        void view.webContents
            .loadURL(url)
            .catch((error: unknown) => this.#log.warn(`preview load failed: ${String(error)}`));
    }

    setBounds(bounds: Rectangle): void {
        this.#view?.setBounds(bounds);
    }

    setVisible(visible: boolean): void {
        this.#view?.setVisible(visible);
    }

    reload(): void {
        this.#view?.webContents.reload();
    }

    back(): void {
        if (this.#view?.webContents.navigationHistory.canGoBack()) {
            this.#view.webContents.navigationHistory.goBack();
        }
    }

    devtools(): void {
        this.#view?.webContents.openDevTools({ mode: 'detach' });
    }

    openExternal(): void {
        const url = this.#view?.webContents.getURL();
        if (url && /^https?:\/\//.test(url)) {
            void shell.openExternal(url);
        }
    }

    async capture(): Promise<string | undefined> {
        const image = await this.#view?.webContents.capturePage();
        return image && !image.isEmpty() ? image.toDataURL() : undefined;
    }

    /** Lets the user pick an element; resolves with its description and a screenshot of it, or null. */
    async annotate(): Promise<PreviewAnnotation | null> {
        const view = this.#view;
        if (!view) {
            return null;
        }
        const contents = view.webContents;
        const key = await contents.insertCSS(PICKER_CSS);
        try {
            contents.focus();
            const picked = (await contents.executeJavaScript(PICKER_SCRIPT, true)) as Omit<
                PreviewAnnotation,
                'image'
            > | null;
            if (!picked) {
                return null;
            }
            const { rect } = picked;
            let image: string | undefined;
            if (rect.width > 0 && rect.height > 0) {
                const shot = await contents.capturePage({
                    x: Math.max(0, rect.x),
                    y: Math.max(0, rect.y),
                    width: rect.width,
                    height: rect.height,
                });
                image = shot.isEmpty() ? undefined : shot.toDataURL();
            }
            return { ...picked, ...(image ? { image } : {}) };
        } finally {
            await contents.removeInsertedCSS(key).catch(() => undefined);
        }
    }

    close(): void {
        const view = this.#view;
        this.#view = undefined;
        if (view) {
            this.#window.contentView.removeChildView(view);
            view.webContents.close();
            this.#emit({ type: 'closed' });
        }
    }
}
