export {};

declare global {
  interface Window {
    windowControls: {
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      quit: () => void;
      wipeAppData: () => Promise<boolean>;
      getUserDataPath: () => Promise<string>;
      getAutoLaunch: () => Promise<boolean>;
      setAutoLaunch: (enabled: boolean) => Promise<boolean>;
      onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
    };
  }
}