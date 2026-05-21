import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getState: () => ipcRenderer.invoke('getState'),
  getSessions: () => ipcRenderer.invoke('getSessions'),
  saveSessions: (sessions: any[]) => ipcRenderer.invoke('saveSessions', sessions),
  connect: (relayUrl: string, sessionKeys: string[]) => ipcRenderer.invoke('connect', relayUrl, sessionKeys),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  resolveSessionName: (relayUrl: string, key: string) => ipcRenderer.invoke('resolveSessionName', relayUrl, key),
  onStateChanged: (callback: (state: any) => void) => {
    ipcRenderer.on('stateChanged', (_event, state) => callback(state));
  },
});
