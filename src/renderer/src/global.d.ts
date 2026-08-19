/// <reference types="vite/client" />

export {};

interface StreamAudioMetadata {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  isFloat: boolean;
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
    };
  }
}

declare module '*.mp3' {
  const src: string;
  export default src;
}
