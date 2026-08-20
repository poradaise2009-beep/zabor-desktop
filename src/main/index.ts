import { app, shell, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron';
import { join } from 'path';
import { existsSync, rmSync, readFileSync, writeFileSync, promises as fsPromises } from 'fs';
import { createHmac, randomBytes } from 'crypto';

/**
 * Подпись сборки для сервера ZABOR.
 *
 * Секрет внедряется на этапе сборки только в main-бандл (см. electron.vite.config.ts)
 * и в репозиторий не попадает: на CI он берётся из GitHub Actions secrets. Сборка,
 * собранная без секрета, подпись не отправляет и считается неофициальной.
 *
 * Это НЕ криптографический барьер: клиент распространяется по GPL-3.0, поэтому секрет
 * извлекаем из установленного приложения. Задача механизма — отличать официальные сборки
 * от посторонних, задавать норму и делать нарушение TERMS.md доказуемым.
 * Подробности и порядок ротации: docs/client-attestation.md
 */
declare const __ZABOR_CLIENT_SECRET__: string;
declare const __ZABOR_CLIENT_CHANNEL__: string;

const CLIENT_SECRET = typeof __ZABOR_CLIENT_SECRET__ === 'string' ? __ZABOR_CLIENT_SECRET__ : '';
const CLIENT_CHANNEL = typeof __ZABOR_CLIENT_CHANNEL__ === 'string' ? __ZABOR_CLIENT_CHANNEL__ : 'unofficial';
const ATTESTATION_SCHEME = 'v1';

function buildClientAttestation(): string | null {
  if (!CLIENT_SECRET) return null;
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(8).toString('hex');
  const payload = `${ATTESTATION_SCHEME}:${CLIENT_CHANNEL}:${app.getVersion()}:${timestamp}:${nonce}`;
  const signature = createHmac('sha256', CLIENT_SECRET).update(payload).digest('base64url');
  return `${payload}:${signature}`;
}

interface StreamAudioMetadata {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
}

interface NativeScreenShareAudio {
  startCapture: (
    processId: number,
    isIncludeMode: boolean,
    onData: (data: Buffer, metadata: StreamAudioMetadata) => void
  ) => boolean;
  stopCapture: () => boolean;
  getPidFromWindowHandle: (windowHandle: number) => number;
  isAvailable: () => boolean;
  getLoadError: () => string | null;
}

const nativeScreenShareAudio = require('electron-native-screenshare') as NativeScreenShareAudio;


if (app) {
  // Аппаратное ускорение включено. Раньше здесь безусловно стоял
  // app.disableHardwareAcceleration(): весь интерфейс растеризовался и
  // композитился на CPU, поэтому переключатели, слайдеры и ripple тем сильнее
  // дёргались, чем слабее процессор, — а во время звонка аудиотракт борется за
  // тот же CPU, и подлагивало у всех. С GPU-композитингом transform/opacity
  // анимации идут отдельным слоем и не зависят от загрузки основного потока.
  // Аварийный выход для сломанного драйвера — без пересборки: переменная
  // окружения ZABOR_DISABLE_GPU=1 (или штатный флаг Chromium --disable-gpu).
  if (process.env.ZABOR_DISABLE_GPU === '1') {
    app.disableHardwareAcceleration();
  }

  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('ignore-certificate-errors');


  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

  if (!app.isPackaged) {
    const port = process.env.REMOTE_DEBUGGING_PORT || '9222';
    app.commandLine.appendSwitch('remote-debugging-port', port);
  }
}

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let quitRequested = false;
let streamAudioOwnerId: number | null = null;

function stopStreamAudioCapture(): void {
  if (streamAudioOwnerId === null) return;
  streamAudioOwnerId = null;
  try {
    if (nativeScreenShareAudio.isAvailable()) nativeScreenShareAudio.stopCapture();
  } catch (error) {
    console.warn('[StreamAudio] Failed to stop native audio capture:', error);
  }
}

function getWindowHandle(sourceId: string): number | null {
  const match = /^window:(\d+):\d+$/.exec(sourceId);
  if (!match) return null;
  const handle = Number(match[1]);
  return Number.isSafeInteger(handle) && handle > 0 ? handle : null;
}

function getMainWindowHandle(): string | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const handle = mainWindow.getNativeWindowHandle();
  if (handle.length >= 8) return handle.readBigUInt64LE().toString();
  if (handle.length >= 4) return String(handle.readUInt32LE());
  return null;
}

function requestQuit(): void {
  if (isQuitting || quitRequested) return;
  quitRequested = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('before-quit');
    } catch {}
    setTimeout(() => {
      isQuitting = true;
      app.quit();
    }, 1500);
    return;
  }
  isQuitting = true;
  app.quit();
}




const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}




interface AppSettings {
  openAtLogin: boolean;
  minimizeToTray: boolean;
}

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'app-settings.json');
}

function loadAppSettings(): AppSettings {
  let parsed: Partial<AppSettings> = {};
  try {
    const filePath = getSettingsPath();
    if (existsSync(filePath)) {
      parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    }
  } catch {}

  return {
    openAtLogin: parsed.openAtLogin !== undefined
      ? parsed.openAtLogin
      : (isDev ? false : app.getLoginItemSettings({ args: ['--autostart'] }).openAtLogin),
    minimizeToTray: parsed.minimizeToTray !== undefined
      ? parsed.minimizeToTray
      : true
  };
}

function saveAppSettings(settings: AppSettings): void {
  try {
    writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  } catch {}
}

function applyAutoLaunch(enabled: boolean): void {
  if (isDev) {
    app.setLoginItemSettings({ openAtLogin: false });
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    args: enabled ? ['--autostart'] : [],
  });
}




interface WindowState {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isMaximized?: boolean;
}

function getWindowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState | null {
  try {
    const filePath = getWindowStatePath();
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveWindowState(state: WindowState): void {
  try {
    writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2), 'utf-8');
  } catch {}
}

let stateSaveTimer: NodeJS.Timeout | null = null;
function scheduleWindowStateSave() {
  if (stateSaveTimer) clearTimeout(stateSaveTimer);
  stateSaveTimer = setTimeout(() => {
    if (!mainWindow) return;
    try {
      const state: WindowState = {
        isMaximized: mainWindow.isMaximized(),
      };
      const bounds = mainWindow.getNormalBounds();
      state.x = bounds.x;
      state.y = bounds.y;
      state.width = bounds.width;
      state.height = bounds.height;
      saveWindowState(state);
    } catch {}
  }, 500);
}




function createTray(): void {
  const iconPath = isDev
    ? join(__dirname, '../../build/icon.ico')
    : join(process.resourcesPath, 'icon.ico');

  let trayIcon: Electron.NativeImage;

  if (existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
    trayIcon = trayIcon.resize({ width: 16, height: 16 });
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('ZABOR');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Открыть ZABOR',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Выйти',
      click: requestQuit
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
    }
  });
}




function createWindow(): void {
  const isAutoStart = process.argv.includes('--autostart');

  let stateOptions: Partial<Electron.BrowserWindowConstructorOptions> = {};
  let savedState: WindowState | null = null;

  if (isAutoStart) {
    savedState = loadWindowState();
    if (savedState) {
      if (savedState.x !== undefined && savedState.y !== undefined) {
        const { screen } = require('electron');
        const displays = screen.getAllDisplays();
        const isVisible = displays.some((display: Electron.Display) => {
          const bounds = display.bounds;
          return (
            savedState!.x! >= bounds.x &&
            savedState!.y! >= bounds.y &&
            savedState!.x! < bounds.x + bounds.width &&
            savedState!.y! < bounds.y + bounds.height
          );
        });

        if (isVisible) {
          stateOptions = {
            x: savedState.x,
            y: savedState.y,
            width: savedState.width || 1280,
            height: savedState.height || 800,
          };
        } else if (savedState.width && savedState.height) {
          stateOptions = {
            width: savedState.width,
            height: savedState.height,
          };
        }
      } else {
        stateOptions = {
          width: savedState.width || 1280,
          height: savedState.height || 800,
        };
      }
    }
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#0C0C0E',
    ...stateOptions,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  if (isAutoStart && savedState?.isMaximized) {
    mainWindow.maximize();
  }


  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  mainWindow.once('ready-to-show', () => {
    clearTimeout(showFallbackTimer);
    showMainWindow();
    try {
      const pid = mainWindow?.webContents.getOSProcessId();
      if (pid) {
        const os = require('os');
        os.setPriority(pid, os.constants.priority.PRIORITY_HIGH);
      }
    } catch {}
  });


  const showFallbackTimer = setTimeout(showMainWindow, 3000);
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    clearTimeout(showFallbackTimer);
    showMainWindow();
    dialog.showErrorBox(
      'ZABOR не удалось запустить',
      `Не удалось загрузить интерфейс (${errorCode}): ${errorDescription}\n${validatedURL}`
    );
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox('ZABOR аварийно завершил работу', `Причина: ${details.reason}`);
  });

  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('move', scheduleWindowStateSave);

  mainWindow.on('maximize', () => {
    scheduleWindowStateSave();
    mainWindow?.webContents.send('window-maximized');
  });

  mainWindow.on('unmaximize', () => {
    scheduleWindowStateSave();
    mainWindow?.webContents.send('window-unmaximized');
  });

  mainWindow.on('close', (event) => {
    const settings = loadAppSettings();
    if (!isQuitting && settings.minimizeToTray) {
      event.preventDefault();
      scheduleWindowStateSave();
      mainWindow?.hide();
    } else {
      scheduleWindowStateSave();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const rendererLoad = isDev && process.env['ELECTRON_RENDERER_URL']
    ? mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    : mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  rendererLoad.catch(error => {
    clearTimeout(showFallbackTimer);
    showMainWindow();
    dialog.showErrorBox('ZABOR не удалось запустить', error instanceof Error ? error.message : String(error));
  });
}




app.whenReady().then(() => {
  try {
    const os = require('os');
    os.setPriority(os.constants.priority.PRIORITY_HIGH);
  } catch {}
  const settings = loadAppSettings();
  applyAutoLaunch(settings.openAtLogin);


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
    const settings = loadAppSettings();
    if (settings.minimizeToTray) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
      }
    } else {
      requestQuit();
    }
  });

  ipcMain.on('app-quit', () => {
    requestQuit();
  });


  ipcMain.handle('wipe-app-data', async () => {
    const userDataPath = app.getPath('userData');
    const dirsToKill = [
      'Local Storage',
      'Session Storage',
      'IndexedDB',
      'Cache',
      'Code Cache',
      'GPUCache',
      'Service Worker',
      'blob_storage'
    ];
    for (const dir of dirsToKill) {
      const fullPath = join(userDataPath, dir);
      try {
        if (existsSync(fullPath)) {
          rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {}
    }
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const ses = mainWindow.webContents.session;
        await ses.clearStorageData();
        await ses.clearCache();
      }
    } catch {}
    return true;
  });


  const SESSION_PATH = join(app.getPath('userData'), 'session.json');

  ipcMain.handle('save-session', async (_event, data: string) => {
    try { await fsPromises.writeFile(SESSION_PATH, data, 'utf-8'); return true; } catch { return false; }
  });

  ipcMain.handle('load-session', async () => {
    try {
      if (existsSync(SESSION_PATH)) return await fsPromises.readFile(SESSION_PATH, 'utf-8');
    } catch {}
    return null;
  });

  ipcMain.handle('clear-session', async () => {
    try { if (existsSync(SESSION_PATH)) await fsPromises.rm(SESSION_PATH, { force: true }); } catch {}
    return true;
  });

  ipcMain.handle('get-client-attestation', () => {
    try { return buildClientAttestation(); } catch { return null; }
  });

  ipcMain.handle('get-userdata-path', () => {
    return app.getPath('userData');
  });

  ipcMain.handle('load-silero-model', async () => {
    const modelPath = join(__dirname, '../renderer/silero_vad.onnx');
    const model = await fsPromises.readFile(modelPath);
    return new Uint8Array(model.buffer, model.byteOffset, model.byteLength);
  });

  // DeepFilterNet3 assets are bundled under renderer/deepfilternet3 (fetched at
  // build time). Serve them from the main process so the worklet can load them
  // offline and inside the packaged file:// app, where fetch() cannot read local
  // files. Only the two known assets are allowed to prevent path traversal.
  ipcMain.handle('load-deepfilter-asset', async (_event, assetPath: unknown) => {
    const allowed = new Set(['pkg/df_bg.wasm', 'models/DeepFilterNet3_onnx.tar.gz']);
    if (typeof assetPath !== 'string' || !allowed.has(assetPath)) return null;
    try {
      const filePath = join(__dirname, '../renderer/deepfilternet3', ...assetPath.split('/'));
      const data = await fsPromises.readFile(filePath);
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch {
      return null;
    }
  });

  ipcMain.handle('get-auto-launch', () => {
    if (isDev) return false;

    const osSetting = app.getLoginItemSettings({ args: ['--autostart'] }).openAtLogin;
    return osSetting;
  });

  ipcMain.handle('set-auto-launch', (_event, enabled: boolean) => {
    const currentSettings = loadAppSettings();
    currentSettings.openAtLogin = enabled;
    saveAppSettings(currentSettings);
    applyAutoLaunch(enabled);
    return true;
  });


  ipcMain.handle('get-minimize-to-tray', () => {
    return loadAppSettings().minimizeToTray;
  });

  ipcMain.handle('set-minimize-to-tray', (_event, enabled: boolean) => {
    const currentSettings = loadAppSettings();
    currentSettings.minimizeToTray = enabled;
    saveAppSettings(currentSettings);
    return true;
  });

  ipcMain.handle('get-desktop-sources', async (_event, options) => {
    const { desktopCapturer } = require('electron')
    const sources = await desktopCapturer.getSources(options)
    const ownWindowHandle = getMainWindowHandle()
    return sources
      .filter(src => ownWindowHandle === null || getWindowHandle(src.id)?.toString() !== ownWindowHandle)
      .map(src => ({
        id: src.id,
        name: src.name,
        thumbnail: src.thumbnail.toDataURL(),
        appIcon: src.appIcon ? src.appIcon.toDataURL() : null
      }))
  })

  ipcMain.handle('start-stream-audio-capture', (event, sourceId: unknown) => {
    if (typeof sourceId !== 'string') throw new TypeError('A desktop source id is required')
    if (!nativeScreenShareAudio.isAvailable()) {
      throw new Error(nativeScreenShareAudio.getLoadError() || 'Native stream audio capture is unavailable')
    }

    stopStreamAudioCapture()

    const windowHandle = getWindowHandle(sourceId)
    const isWindow = windowHandle !== null
    if (!isWindow && !sourceId.startsWith('screen:')) {
      throw new Error(`Unsupported desktop source: ${sourceId}`)
    }

    const targetProcessId = isWindow
      ? nativeScreenShareAudio.getPidFromWindowHandle(windowHandle)
      : process.pid
    if (!targetProcessId) throw new Error(`Unable to resolve the process for source ${sourceId}`)

    const sender = event.sender
    streamAudioOwnerId = sender.id
    try {
      const started = nativeScreenShareAudio.startCapture(targetProcessId, isWindow, (data, metadata) => {
        if (streamAudioOwnerId !== sender.id || sender.isDestroyed()) return
        sender.send('stream-audio-data', data, metadata)
      })
      if (started) return true
      throw new Error('Native stream audio capture did not start')
    } catch (error) {
      try {
        if (nativeScreenShareAudio.isAvailable()) nativeScreenShareAudio.stopCapture()
      } catch { }
      streamAudioOwnerId = null
      throw error
    }
  })

  ipcMain.handle('stop-stream-audio-capture', (event) => {
    if (streamAudioOwnerId === event.sender.id) stopStreamAudioCapture()
    return true
  })

  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    const settings = loadAppSettings();
    if (!settings.minimizeToTray) {
      app.quit();
    }
  }
});

app.on('before-quit', (event) => {
  stopStreamAudioCapture();
  if (!isQuitting) {
    event.preventDefault();
    requestQuit();
  }
});

app.on('quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});
