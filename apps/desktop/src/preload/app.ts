import { contextBridge, ipcRenderer } from 'electron';

/**
 * Bridge for the app bundle's UI. The page asks for a MessagePort, and the port it receives is connected
 * directly to the host. Nothing else from Node or Electron is exposed.
 */

ipcRenderer.on('xora:port', (event) => {
    window.postMessage({ type: 'xora:port' }, '*', event.ports);
});

const hostRestartedListeners = new Set<() => void>();
ipcRenderer.on('xora:host-restarted', () => {
    for (const listener of hostRestartedListeners) {
        listener();
    }
});

const previewListeners = new Set<(event: unknown) => void>();
ipcRenderer.on('xora:preview-event', (_event, payload: unknown) => {
    for (const listener of previewListeners) {
        listener(payload);
    }
});

const preview = (op: string, args?: unknown) => ipcRenderer.invoke('xora:preview', op, args);

contextBridge.exposeInMainWorld('xoraShell', {
    requestPort: () => ipcRenderer.send('xora:request-port'),
    signalReady: () => ipcRenderer.send('xora:ui-ready'),
    shellInfo: () => ipcRenderer.invoke('xora:shell-info'),
    restartToSafeMode: () => ipcRenderer.send('xora:restart-safe-mode'),
    setTheme: (theme: string) => ipcRenderer.send('xora:theme', theme),
    onHostRestarted: (listener: () => void) => {
        hostRestartedListeners.add(listener);
        return () => {
            hostRestartedListeners.delete(listener);
        };
    },
    preview: {
        open: (url: string, bounds: unknown) => preview('open', { url, bounds }),
        setBounds: (bounds: unknown) => preview('bounds', { bounds }),
        setVisible: (visible: boolean) => preview('visible', { visible }),
        reload: () => preview('reload'),
        back: () => preview('back'),
        devtools: () => preview('devtools'),
        openExternal: () => preview('external'),
        capture: () => preview('capture'),
        annotate: () => preview('annotate'),
        close: () => preview('close'),
        onEvent: (listener: (event: unknown) => void) => {
            previewListeners.add(listener);
            return () => {
                previewListeners.delete(listener);
            };
        },
    },
});
