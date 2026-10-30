import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('xoraSafe', {
    status: () => ipcRenderer.invoke('safe:status'),
    rollback: (candidateId: string) => ipcRenderer.invoke('safe:rollback', candidateId),
    openLogs: () => ipcRenderer.invoke('safe:open-logs'),
    exportDiagnostics: () => ipcRenderer.invoke('safe:export-diagnostics'),
    restartNormal: () => ipcRenderer.invoke('safe:restart-normal'),
    quit: () => ipcRenderer.invoke('safe:quit'),
});
