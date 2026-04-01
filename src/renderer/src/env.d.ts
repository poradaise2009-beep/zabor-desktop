/// <reference types="vite/client" />

declare interface Window {
  windowControls: {
    minimize: () => void
    maximize: () => void
    close: () => void
    quit: () => void
    wipeAppData: () => Promise<boolean>
    getUserDataPath: () => Promise<string>
    getAutoLaunch: () => Promise<boolean>
    setAutoLaunch: (enabled: boolean) => Promise<boolean>
    saveSession: (data: string) => Promise<boolean>
    loadSession: () => Promise<string | null>
    clearSession: () => Promise<boolean>
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
    onBeforeQuit: (callback: () => void) => () => void;
saveSession: (data: string) => Promise<boolean>;
loadSession: () => Promise<string | null>;
clearSession: () => Promise<boolean>;
  }
}
declare module '*.mp3' {
  const src: string;
  export default src;
}