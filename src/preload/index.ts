import { contextBridge, ipcRenderer } from 'electron'

interface StreamAudioMetadata {
  sampleRate: number
  channels: number
  bitsPerSample: number
  isFloat: boolean
}

const windowControls = {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  quit: () => ipcRenderer.send('app-quit'),
  wipeAppData: () => ipcRenderer.invoke('wipe-app-data'),
  getUserDataPath: () => ipcRenderer.invoke('get-userdata-path'),
  loadSileroModel: (): Promise<Uint8Array> => ipcRenderer.invoke('load-silero-model'),
  loadDeepFilterAsset: (assetPath: string): Promise<Uint8Array | null> =>
    ipcRenderer.invoke('load-deepfilter-asset', assetPath),
  getAutoLaunch: (): Promise<boolean> => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('set-auto-launch', enabled),
  getMinimizeToTray: (): Promise<boolean> => ipcRenderer.invoke('get-minimize-to-tray'),
  setMinimizeToTray: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('set-minimize-to-tray', enabled),
  saveSession: (data: string): Promise<boolean> => ipcRenderer.invoke('save-session', data),
  loadSession: (): Promise<string | null> => ipcRenderer.invoke('load-session'),
  clearSession: (): Promise<boolean> => ipcRenderer.invoke('clear-session'),
  getClientAttestation: (): Promise<string | null> => ipcRenderer.invoke('get-client-attestation'),
  onBeforeQuit: (callback: () => void) => {
    ipcRenderer.on('before-quit', callback)
    return () => { ipcRenderer.removeAllListeners('before-quit') }
  },
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => {
    ipcRenderer.on('window-maximized', () => callback(true))
    ipcRenderer.on('window-unmaximized', () => callback(false))
    return () => {
      ipcRenderer.removeAllListeners('window-maximized')
      ipcRenderer.removeAllListeners('window-unmaximized')
    }
  },
  getDesktopSources: (options?: any) => ipcRenderer.invoke('get-desktop-sources', options),
  startStreamAudioCapture: (sourceId: string): Promise<boolean> =>
    ipcRenderer.invoke('start-stream-audio-capture', sourceId),
  stopStreamAudioCapture: (): Promise<boolean> => ipcRenderer.invoke('stop-stream-audio-capture'),
  onStreamAudioData: (callback: (data: Uint8Array, metadata: StreamAudioMetadata) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: Uint8Array, metadata: StreamAudioMetadata) => {
      callback(data, metadata)
    }
    ipcRenderer.on('stream-audio-data', listener)
    return () => { ipcRenderer.removeListener('stream-audio-data', listener) }
  },
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: (): Promise<any> => ipcRenderer.invoke('check-for-updates'),
  startUpdateDownload: (downloadUrl: string, version: string): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke('start-update-download', downloadUrl, version),
  cancelUpdateDownload: (): Promise<boolean> => ipcRenderer.invoke('cancel-update-download'),
  installUpdate: (): Promise<{ success: boolean; message?: string; error?: string }> =>
    ipcRenderer.invoke('install-update'),
  openExternalUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('open-external-url', url),
  onUpdateAvailable: (callback: (info: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, info: any) => callback(info)
    ipcRenderer.on('update-available', listener)
    return () => { ipcRenderer.removeListener('update-available', listener) }
  },
  onUpdateDownloadProgress: (callback: (progress: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: any) => callback(progress)
    ipcRenderer.on('update-download-progress', listener)
    return () => { ipcRenderer.removeListener('update-download-progress', listener) }
  },
  onUpdateDownloaded: (callback: (data: { filePath: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('update-downloaded', listener)
    return () => { ipcRenderer.removeListener('update-downloaded', listener) }
  },
  onUpdateError: (callback: (error: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, error: string) => callback(error)
    ipcRenderer.on('update-error', listener)
    return () => { ipcRenderer.removeListener('update-error', listener) }
  }
}

contextBridge.exposeInMainWorld('windowControls', windowControls)
