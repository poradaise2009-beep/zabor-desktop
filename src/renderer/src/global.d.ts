/// <reference types="vite/client" />

export {};

interface StreamAudioMetadata {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  releaseName: string;
  releaseNotes: string;
  publishedAt: string;
  downloadUrl: string;
  releaseUrl: string;
  fileSize: number;
}

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentVersion: string;
  updateInfo?: UpdateInfo;
  error?: string;
}

declare global {
  interface Window {
    electron: {
      process: {
        versions: Record<string, string>;
      };
    };
    windowControls: {
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      quit: () => void;
      wipeAppData: () => Promise<boolean>;
      getUserDataPath: () => Promise<string>;
      loadSileroModel: () => Promise<Uint8Array>;
      loadDeepFilterAsset: (assetPath: string) => Promise<Uint8Array | null>;
      getAutoLaunch: () => Promise<boolean>;
      setAutoLaunch: (enabled: boolean) => Promise<boolean>;
      getMinimizeToTray: () => Promise<boolean>;
      setMinimizeToTray: (enabled: boolean) => Promise<boolean>;
      saveSession: (data: string) => Promise<boolean>;
      loadSession: () => Promise<string | null>;
      clearSession: () => Promise<boolean>;
      getClientAttestation: () => Promise<string | null>;
      onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
      onBeforeQuit: (callback: () => void) => () => void;
      getDesktopSources: (options?: any) => Promise<any[]>;
      startStreamAudioCapture: (sourceId: string) => Promise<boolean>;
      stopStreamAudioCapture: () => Promise<boolean>;
      onStreamAudioData: (
        callback: (data: Uint8Array, metadata: StreamAudioMetadata) => void
      ) => () => void;
      getAppVersion: () => Promise<string>;
      checkForUpdates: () => Promise<UpdateCheckResult>;
      startUpdateDownload: (
        downloadUrl: string,
        version: string
      ) => Promise<{ success: boolean; filePath?: string; error?: string }>;
      cancelUpdateDownload: () => Promise<boolean>;
      installUpdate: () => Promise<{ success: boolean; message?: string; error?: string }>;
      openExternalUrl: (url: string) => Promise<boolean>;
      onUpdateAvailable: (callback: (info: UpdateInfo) => void) => () => void;
      onUpdateDownloadProgress: (callback: (progress: UpdateProgress) => void) => () => void;
      onUpdateDownloaded: (callback: (data: { filePath: string }) => void) => () => void;
      onUpdateError: (callback: (error: string) => void) => () => void;
    };
  }
}

declare module '*.mp3' {
  const src: string;
  export default src;
}
