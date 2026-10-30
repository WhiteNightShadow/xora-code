/** What the bootstrap's preload script exposes as `window.xoraShell`. */
export interface ShellInfo {
    readonly shellVersion: string;
    readonly bundleVersion: string;
    readonly candidate: string;
    readonly dataDir: string;
    readonly platform: string;
}

export interface XoraShellApi {
    requestPort(): void;
    signalReady(): void;
    shellInfo(): Promise<ShellInfo>;
    restartToSafeMode(): void;
    onHostRestarted(listener: () => void): () => void;
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
