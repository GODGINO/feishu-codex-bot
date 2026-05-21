import { app, BrowserWindow, ipcMain, Notification } from 'electron';
import * as path from 'path';
import { createTray, updateTrayIcon } from './tray';
import { connect, disconnect, getState, onStateChange, type ConnectionState } from './relay-client';
import { executeCommand } from './executor';
import { requestAllPermissions, showPermissionDialog } from './onboarding';
import Store from 'electron-store';

interface StoreSchema {
  sessions: Array<{ key: string; name: string; type: string }>;
  firstRunComplete?: boolean;
}

const store = new Store<StoreSchema>({
  defaults: { sessions: [], firstRunComplete: false },
});

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 340,
    height: 320,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Renderer files are in src/renderer/ (not compiled), resolve from project root
  win.loadFile(path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html'));

  // Hide instead of close
  win.on('close', (e) => {
    e.preventDefault();
    win.hide();
  });

  // Hide when losing focus
  win.on('blur', () => {
    win.hide();
  });

  return win;
}

app.whenReady().then(async () => {
  // Pure menubar/tray app — hide from Dock (macOS only)
  if (process.platform === 'darwin') app.dock?.hide();

  mainWindow = createWindow();

  createTray(mainWindow);

  // Request all permissions on every startup until all are granted.
  // macOS requires the user to manually grant each one in System Settings.
  const result = await requestAllPermissions();
  if (!result.accessibility || !result.screenRecording) {
    // Show dialog with link to System Settings after a short delay
    setTimeout(() => showPermissionDialog(result), 2000);
  }

  // Forward state changes to renderer
  onStateChange((state: ConnectionState) => {
    mainWindow?.webContents.send('stateChanged', state);
    updateTrayIcon(state.connected);
  });

  // ── IPC handlers ──

  ipcMain.handle('getState', () => getState());

  ipcMain.handle('getSessions', () => store.get('sessions'));

  ipcMain.handle('saveSessions', (_e, sessions) => {
    store.set('sessions', sessions);
  });

  ipcMain.handle('connect', (_e, relayUrl: string, sessionKeys: string[]) => {
    connect(relayUrl, sessionKeys, executeCommand);
    return getState();
  });

  ipcMain.handle('disconnect', () => {
    disconnect();
    return getState();
  });

  ipcMain.handle('resolveSessionName', async (_e, relayUrl: string, key: string) => {
    try {
      const res = await fetch(`${relayUrl}/api/session-names?keys=${encodeURIComponent(key)}`);
      if (!res.ok) return null;
      const data = await res.json() as Record<string, any>;
      return data[key] || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('notify', (_e, title: string, body: string) => {
    new Notification({ title, body }).show();
  });

  ipcMain.handle('requestPermissions', async () => {
    return await requestAllPermissions();
  });
});

app.on('window-all-closed', () => {
  // Keep app running as tray app — do nothing
});
