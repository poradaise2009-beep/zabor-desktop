import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Sliders, Sparkle } from '@phosphor-icons/react';
import { Md3Switch } from '../Shared/Md3Switch';
import { webrtc } from '../../services/webrtc';

export type NoiseSuppressionMode = 'smart' | 'manual';
export type CalibrationPhase = 'idle' | 'preparing' | 'silence' | 'speech' | 'checking';

export interface NoiseSuppressionSettingsProps {
  isEnabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  mode: NoiseSuppressionMode;
  onModeChange: (mode: NoiseSuppressionMode) => void;
  manualThreshold: number;
  onManualThresholdChange: (val: number) => void;
  onStartCalibration?: () => void;
  isCalibrating?: boolean;
  calibrationCountdown?: number;
  calibrationPhase?: CalibrationPhase;
  calibrationSuccess?: boolean;
  liveMicLevel?: number;
  className?: string;
}

const MIN_THRESHOLD_DB = -60;
const MAX_THRESHOLD_DB = -12;

export function NoiseSuppressionSettings({
  isEnabled,
  onEnabledChange,
  mode,
  onModeChange,
  manualThreshold,
  onManualThresholdChange,
  onStartCalibration,
  isCalibrating = false,
  calibrationPhase = 'idle',
  calibrationSuccess = false,
  liveMicLevel: externalMicLevel,
  className = ''
}: NoiseSuppressionSettingsProps) {
  const { t } = useTranslation();
  const [internalMicLevelDb, setInternalMicLevelDb] = useState(-100);

  useEffect(() => {
    if (externalMicLevel !== undefined) return;
    return webrtc.subscribeMicLevel(setInternalMicLevelDb);
  }, [externalMicLevel]);

  const micLevelDb = Math.max(-100, Math.min(0, externalMicLevel ?? internalMicLevelDb));
  const threshold = Math.max(MIN_THRESHOLD_DB, Math.min(MAX_THRESHOLD_DB, manualThreshold));
  const phrase = t('settings.audio.calibrationPhrase', 'Сегодня тихий ветер шуршит в листве.');
  const calibrationText = calibrationPhase === 'silence'
    ? t('settings.audio.doNotSpeak', 'Молчите')
    : calibrationPhase === 'speech'
      ? t('settings.audio.sayPhraseButton', 'Скажи: "{{phrase}}"', { phrase })
      : calibrationPhase === 'checking'
        ? t('settings.audio.checking', 'Проверяем')
        : calibrationPhase === 'preparing'
          ? t('settings.audio.preparing', 'Подготовка')
          : t('settings.audio.calibrateButton', 'Определить шум');
  const meterPosition = Math.max(0, Math.min(100, ((micLevelDb - MIN_THRESHOLD_DB) / (MAX_THRESHOLD_DB - MIN_THRESHOLD_DB)) * 100));

  return (
    <section
      className={`overflow-hidden rounded-2xl border bg-surface transition-[border-color,background-color] duration-300 ${isEnabled ? 'border-[#35313a]' : 'border-[#26262B] hover:border-[#35353C]'
        } ${className}`}
    >
      <div className="flex min-h-[66px] items-center justify-between px-4">
        <span className="text-[15px] font-bold tracking-wide text-white">{t('settings.audio.noiseSuppression', 'Шумоподавление')}</span>
        <Md3Switch checked={isEnabled} onChange={onEnabledChange} />
      </div>

      <div
        aria-hidden={!isEnabled}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] ${isEnabled ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0'
          }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="space-y-4 border-t border-[#29282e] px-4 pb-4 pt-3">
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#0e0e12] p-1" role="radiogroup" aria-label={t('settings.audio.noiseSuppressionMode', 'Режим шумоподавления')}>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'smart'}
                onClick={() => onModeChange('smart')}
                className={`flex h-10 items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors duration-200 ${mode === 'smart'
                    ? 'bg-[#252229] text-white shadow-sm'
                    : 'text-textMuted hover:bg-white/[0.035] hover:text-white'
                  }`}
              >
                <Sparkle size={16} weight={mode === 'smart' ? 'fill' : 'regular'} className={mode === 'smart' ? 'text-[#FF007F]' : ''} />
                {t('settings.audio.smartMode', 'Умное')}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'manual'}
                onClick={() => onModeChange('manual')}
                className={`flex h-10 items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors duration-200 ${mode === 'manual'
                    ? 'bg-[#252229] text-white shadow-sm'
                    : 'text-textMuted hover:bg-white/[0.035] hover:text-white'
                  }`}
              >
                <Sliders size={16} weight="bold" className={mode === 'manual' ? 'text-[#FF007F]' : ''} />
                {t('settings.audio.manualMode', 'Вручную')}
              </button>
            </div>

            {mode === 'smart' && (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => !isCalibrating && !calibrationSuccess && onStartCalibration?.()}
                  disabled={isCalibrating || calibrationSuccess}
                  className={`relative flex min-h-10 w-full items-center justify-center overflow-hidden rounded-xl border px-3 py-2 text-xs font-bold transition-all duration-200 ${isCalibrating
                      ? 'cursor-default border-[#c70060]/25 bg-[#c70060]/10 text-[#ff7dbd]'
                      : calibrationSuccess
                        ? 'cursor-default border-[#FF007F]/40 bg-[#FF007F]/15 text-white select-none'
                        : 'border-[#c70060] bg-[#c70060] text-white hover:bg-[#d30068] active:scale-[0.99]'
                    }`}
                >
                  {isCalibrating ? (
                    <div className="flex items-center justify-center gap-2">
                      <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[#ff7dbd] border-t-transparent" />
                      <span className="text-center leading-snug">{calibrationText}</span>
                    </div>
                  ) : calibrationSuccess ? (
                    <>
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <Check size={52} weight="bold" className="animate-checkmark-pop text-[#FF007F]" />
                      </div>
                      <span className="relative z-10 font-bold tracking-wide text-white">{t('settings.audio.calibrationSuccess', 'Успешно')}</span>
                    </>
                  ) : (
                    <span>{t('settings.audio.calibrateButton', 'Определить шум')}</span>
                  )}
                </button>
              </div>
            )}

            {mode === 'manual' && (
              <div className="space-y-2">
                <div className="px-0.5 text-xs">
                  <span className="font-semibold text-textMuted">{t('settings.audio.threshold', 'Порог')}</span>
                </div>
                <div className="relative flex h-9 items-center">
                  <div className="absolute grid h-5 grid-cols-[repeat(32,minmax(0,1fr))] items-center gap-[2px]" style={{ left: '9px', right: '9px' }} aria-hidden="true">
                    {Array.from({ length: 32 }, (_, index) => {
                      const isActive = ((index + 0.5) / 32) * 100 <= meterPosition;
                      return (
                        <span
                          key={index}
                          className={`h-full rounded-[2px] transition-colors duration-75 ${isActive
                              ? index > 26 ? 'bg-[#ef4444]' : 'bg-[#22c55e]'
                              : 'bg-white/[0.08]'
                            }`}
                        />
                      );
                    })}
                  </div>
                  <input
                    type="range"
                    min={MIN_THRESHOLD_DB}
                    max={MAX_THRESHOLD_DB}
                    step={1}
                    value={threshold}
                    onChange={(event) => onManualThresholdChange(Number(event.target.value))}
                    aria-label={t('settings.audio.thresholdLabel', 'Microphone activation threshold')}
                    className="threshold-range absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent outline-none"
                  />
                </div>
                <div className="flex items-center justify-between px-0.5 text-[11px] font-medium text-textMuted">
                  <span>{MIN_THRESHOLD_DB} dB</span>
                  <span className="font-bold text-white">{threshold} dB</span>
                  <span>{MAX_THRESHOLD_DB} dB</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
