/** What the bootstrap's preload script exposes as `window.xoraShell`. */
export interface ShellInfo {
    readonly shellVersion: string;
    readonly bundleVersion: string;
    readonly candidate: string;
    readonly dataDir: string;
    readonly platform: string;
}

export interface PreviewAnnotation {
    readonly selector: string;
    readonly tag: string;
    readonly text: string;
    readonly html: string;
    readonly rect: { x: number; y: number; width: number; height: number };
    readonly url: string;
    readonly title: string;
    readonly image?: string;
}

export interface PreviewBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export type PreviewEvent = { type: 'navigated'; url: string; title: string; canGoBack: boolean } | { type: 'closed' };

export interface PreviewApi {
    open(url: string, bounds: PreviewBounds): Promise<boolean>;
    setBounds(bounds: PreviewBounds): Promise<boolean>;
    setVisible(visible: boolean): Promise<boolean>;
    reload(): Promise<boolean>;
    back(): Promise<boolean>;
    devtools(): Promise<boolean>;
    openExternal(): Promise<boolean>;
    capture(): Promise<string | undefined>;
    annotate(): Promise<PreviewAnnotation | null>;
    close(): Promise<boolean>;
    onEvent(listener: (event: PreviewEvent) => void): () => void;
}

export interface XoraShellApi {
    requestPort(): void;
    signalReady(): void;
    shellInfo(): Promise<ShellInfo>;
    restartToSafeMode(): void;
    /** Older shells lack it. */
    setTheme?(theme: 'system' | 'light' | 'dark'): void;
    onHostRestarted(listener: () => void): () => void;
    readonly preview?: PreviewApi;
}

declare global {
    interface Window {
        readonly xoraShell?: XoraShellApi;
    }
}

/** Resolves with the next MessagePort the preload forwards to the page. */
export function nextPort(): Promise<MessagePort> {
    return new Promise((resolve) => {
        const onMessage = (event: MessageEvent) => {
            const data = event.data as { type?: unknown } | null;
            const port = event.ports[0];
            if (event.source === window && data?.type === 'xora:port' && port) {
                window.removeEventListener('message', onMessage);
                resolve(port);
            }
        };
        window.addEventListener('message', onMessage);
    });
}
