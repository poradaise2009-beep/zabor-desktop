import { app, shell, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import { join } from 'path';
import { existsSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

// ═══════════════════════════════════════════════════════════
// App Settings — файл лежит в корне userData и НЕ удаляется
// при wipe-app-data (logout). Переживает смену аккаунтов.
// ═══════════════════════════════════════════════════════════
interface AppSettings {
  openAtLogin: boolean;
}

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json');
}

function loadAppSettings(): AppSettings {
  try {
    const filePath = getSettingsPath();
    if (existsSync(filePath)) {
      return { openAtLogin: false, ...JSON.parse(readFileSync(filePath, 'utf-8')) };
    }
  } catch {}
  return { openAtLogin: false };
}

function saveAppSettings(settings: AppSettings): void {
  try {
    writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  } catch {}
}

function applyAutoLaunch(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: enabled ? ['--autostart'] : [],
  });
}

// ═══════════════════════════════════
// Tray
// ═══════════════════════════════════
function createTray(): void {
  const iconPath = join(__dirname, '../../build/icon.ico');
  let trayIcon: Electron.NativeImage;

  if (existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('ZABOR');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Открыть ZABOR',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    { type: 'separator' },
    {
      label: 'Выйти',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// ═══════════════════════════════════
// Window
// ═══════════════════════════════════
function createWindow(startHidden = false): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#09090B',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!startHidden) {
      mainWindow?.show();
    }
  });

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window-maximized');
  });

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window-unmaximized');
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// ═══════════════════════════════════
// App lifecycle
// ═══════════════════════════════════
app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.zabor.app');

  // Применяем сохранённую настройку автозапуска
  const settings = loadAppSettings();
  applyAutoLaunch(settings.openAtLogin);

  // Если запущено через автозапуск Windows — стартуем скрыто в трей
  const isAutoStarted = process.argv.includes('--autostart');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // ── Window controls ──
  ipcMain.on('window-minimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize();
  });

  ipcMain.on('window-maximize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    mainWindow?.hide();
  });

  ipcMain.on('app-quit', () => {
    isQuitting = true;
    app.quit();
  });

   // ── Session persistence (файловое хранилище вместо localStorage) ──
  const SESSION_PATH = join(app.getPath('userData'), 'session.json');

  ipcMain.handle('save-session', (_event, data: string) => {
    try {
      writeFileSync(SESSION_PATH, data, 'utf-8');
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('load-session', () => {
    try {
      if (existsSync(SESSION_PATH)) {
        return readFileSync(SESSION_PATH, 'utf-8');
      }
    } catch {}
    return null;
  });

  ipcMain.handle('clear-session', () => {
    try {
      if (existsSync(SESSION_PATH)) {
        rmSync(SESSION_PATH, { force: true });
      }
    } catch {}
    return true;
  });

  ipcMain.handle('get-userdata-path', () => {
    return app.getPath('userData');
  });

  // ── Auto-launch ──
  ipcMain.handle('get-auto-launch', () => {
    return loadAppSettings().openAtLogin;
  });

  ipcMain.handle('set-auto-launch', (_event, enabled: boolean) => {
    const currentSettings = loadAppSettings();
    currentSettings.openAtLogin = enabled;
    saveAppSettings(currentSettings);
    applyAutoLaunch(enabled);
    return true;
  });

  createWindow(isAutoStarted);
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Ничего — живём в трее
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});