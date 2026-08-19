import { BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';

export function registerIpcHandlers(
  getAllowedOrigin: () => string | null
): void {
  ipcMain.handle(
    'csv:save',
    async (event, payload: { filename: string; csv: string }) => {
      const allowed = getAllowedOrigin();
      const senderUrl = event.senderFrame?.url ?? '';
      if (!allowed || !senderUrl || new URL(senderUrl).origin !== allowed) {
        throw new Error('csv:save denied: sender origin not allowed');
      }
      if (
        typeof payload?.filename !== 'string' ||
        typeof payload?.csv !== 'string'
      ) {
        throw new Error('csv:save denied: invalid payload');
      }

      const win = BrowserWindow.fromWebContents(event.sender);
      const result = win
        ? await dialog.showSaveDialog(win, {
            title: 'Export transactions',
            defaultPath: payload.filename,
            filters: [{ name: 'CSV', extensions: ['csv'] }],
          })
        : await dialog.showSaveDialog({
            title: 'Export transactions',
            defaultPath: payload.filename,
            filters: [{ name: 'CSV', extensions: ['csv'] }],
          });

      if (result.canceled || !result.filePath) return { saved: false };
      await writeFile(result.filePath, payload.csv, 'utf8');
      return { saved: true, path: result.filePath };
    }
  );
}
