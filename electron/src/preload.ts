import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  saveCsv: (
    filename: string,
    csv: string
  ): Promise<{ saved: boolean; path?: string }> =>
    ipcRenderer.invoke('csv:save', { filename, csv }),
  onExportCsv: (callback: () => void): (() => void) => {
    const listener = (_event: IpcRendererEvent) => callback();
    ipcRenderer.on('menu:export-csv', listener);
    return () => ipcRenderer.removeListener('menu:export-csv', listener);
  },
});
