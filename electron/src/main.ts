import { app, BrowserWindow, Menu, shell } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { startStaticServer, type RunningServer } from './server';
import { buildMenu } from './menu';
import { registerIpcHandlers } from './ipc';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let server: RunningServer | null = null;
let allowedOrigin: string | null = null;

function resolveDistRoot(): string {
  // packaged: resources/app.asar/dist; dev: <repo>/dist
  const packaged = join(process.resourcesPath, 'app.asar', 'dist');
  if (existsSync(packaged)) return packaged;
  return join(__dirname, '..', '..', 'dist');
}

async function createWindow() {
  const distRoot = resolveDistRoot();
  if (!existsSync(distRoot)) {
    throw new Error(
      `Web bundle not found at ${distRoot}. Run \`npx expo export -p web\` first.`,
    );
  }

  server = await startStaticServer(distRoot);
  allowedOrigin = new URL(server.url).origin;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 768,
    minHeight: 600,
    title: 'Nestworth',
    backgroundColor: '#9CB47E',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('will-navigate', (event, navUrl) => {
    if (new URL(navUrl).origin !== allowedOrigin) {
      event.preventDefault();
      void shell.openExternal(navUrl);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(server.url);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(buildMenu());
  registerIpcHandlers(() => allowedOrigin);
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (server) {
    await server.close();
    server = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  if (server) {
    await server.close();
    server = null;
  }
});
