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

contextBridge.exposeInMainWorld('xoraShell', {
    requestPort: () => ipcRenderer.send('xora:request-port'),
    signalReady: () => ipcRenderer.send('xora:ui-ready'),
    shellInfo: () => ipcRenderer.invoke('xora:shell-info'),
    restartToSafeMode: () => ipcRenderer.send('xora:restart-safe-mode'),
    onHostRestarted: (listener: () => void) => {
        hostRestartedListeners.add(listener);
        return () => {
            hostRestartedListeners.delete(listener);
        };
    },
});
