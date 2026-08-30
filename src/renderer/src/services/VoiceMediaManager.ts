import { webrtc, classifyMicrophoneError } from './webrtc';
import { useAppStore } from '../store/useAppStore';
import i18n from '../i18n';

class VoiceMediaManager {
  private static instance: VoiceMediaManager;

  private constructor() { }

  public static getInstance(): VoiceMediaManager {
    if (!VoiceMediaManager.instance) {
      VoiceMediaManager.instance = new VoiceMediaManager();
    }
    return VoiceMediaManager.instance;
  }

  public async startLocalStream(deviceId?: string, useNS?: boolean): Promise<boolean> {
    try {
      const store = useAppStore.getState();
      const actualUseNS = useNS !== undefined ? useNS : store.noiseSuppression;

      const result = await webrtc.startLocalStream(deviceId, actualUseNS);
      return result;
    } catch (error: any) {
      console.error('[VoiceMediaManager] Failed to start local stream:', error);
      this.handleMicrophoneError(error);
      return false;
    }
  }

  public async updateSettings(deviceId: string, useNS: boolean): Promise<void> {
    try {
      useAppStore.getState().setNoiseSuppression(useNS);
      await webrtc.updateSettings(deviceId, useNS);
    } catch (error: any) {
      console.error('[VoiceMediaManager] Failed to update settings:', error);
      this.handleMicrophoneError(error);
    }
  }

  private handleMicrophoneError(error: any) {
    const store = useAppStore.getState();
    const message = error?.message || i18n.t('toasts.micUnknownError', 'неизвестная ошибка микрофона');

    // The shared classifier checks the concrete device states before the generic
    // MIC_ACCESS_FAILED wrapper, so a busy or missing microphone is no longer
    // reported as a permission problem.
    switch (classifyMicrophoneError(message)) {
      case 'micBusy':
        store.setSystemToast(i18n.t('toasts.micBusy', 'микрофон занят другим приложением.'));
        break;
      case 'micNotFound':
        store.setSystemToast(i18n.t('toasts.micNotFound', 'микрофон не найден. подключите устройство и попробуйте снова.'));
        break;
      case 'micNoAccess':
        store.setSystemToast(i18n.t('toasts.micNoAccess', 'нет доступа к микрофону. проверьте разрешения в ОС.'));
        break;
      default:
        store.setSystemToast(i18n.t('toasts.audioError', { message, defaultValue: `ошибка аудио: ${message}` }));
    }
  }
}

export const voiceMediaManager = VoiceMediaManager.getInstance();
