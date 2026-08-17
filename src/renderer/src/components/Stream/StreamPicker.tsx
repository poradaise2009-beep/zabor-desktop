import React, { useState, useEffect, useMemo } from 'react'
import { X, Desktop, AppWindow, Camera, Check } from '@phosphor-icons/react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'framer-motion'

interface Source {
  id: string
  name: string
  thumbnail: string
  appIcon: string | null
}

interface StreamPickerProps {
  onClose: () => void
  onSelect: (sourceId: string, quality: 'low' | 'high' | 'camera', includeAudio: boolean) => void
}

const cleanName = (srcName: string, index: number, isScreen: boolean, screenLabel: string) => {
  if (isScreen) {
    return `${screenLabel} ${index + 1}`
  }
  const parts = srcName.split(' - ')
  if (parts.length > 1) {
    return parts[parts.length - 1].trim()
  }
  return srcName.trim()
}

export const StreamPicker = ({ onClose, onSelect }: StreamPickerProps) => {
  const { t } = useTranslation()
  const [sources, setSources] = useState<Source[]>([])
  const [activeTab, setActiveTab] = useState<'screen' | 'window' | 'camera'>('screen')
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  const [quality, setQuality] = useState<'low' | 'high'>('low')
  const [includeAudio, setIncludeAudio] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setSelectedSourceId(null)
    setSources([])
    setLoading(true)
  }, [activeTab])

  useEffect(() => {
    let active = true
    const fetchSources = async (isInitial = false) => {
      if (isInitial) {
        setLoading(true)
      }
      try {
        if (activeTab === 'camera') {
          try {
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true })
            tempStream.getTracks().forEach(track => track.stop())
          } catch { }
          const devices = await navigator.mediaDevices.enumerateDevices()
          const videoDevices = devices.filter(d => d.kind === 'videoinput')
          const mapped: Source[] = await Promise.all(
            videoDevices.map(async (d, idx) => {
              let thumbnail = ''
              try {
                const stream = await navigator.mediaDevices.getUserMedia({
                  video: { deviceId: { exact: d.deviceId }, width: 320, height: 180 }
                })
                const video = document.createElement('video')
                video.muted = true
                video.srcObject = stream
                await video.play()
                await new Promise((r) => setTimeout(r, 120))
                const canvas = document.createElement('canvas')
                canvas.width = 320
                canvas.height = 180
                const ctx = canvas.getContext('2d')
                if (ctx) {
                  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
                  thumbnail = canvas.toDataURL('image/jpeg', 0.8)
                }
                stream.getTracks().forEach((track) => track.stop())
              } catch { }
              return {
                id: `camera:${d.deviceId}`,
                name: d.label || `${t('stream.camera', 'Камера')} ${idx + 1}`,
                thumbnail,
                appIcon: null
              }
            })
          )
          if (active) {
            setSources(mapped)
          }
        } else {
          const res = await (window as any).windowControls.getDesktopSources({
            types: [activeTab],
            thumbnailSize: { width: 320, height: 180 },
            fetchWindowIcons: true
          })
          if (active) {
            setSources(res)
          }
        }
      } catch (e) {
        console.error(e)
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    fetchSources(true)
    const interval = setInterval(() => {
      fetchSources(false)
    }, 5000)

    return () => {
      active = false
      clearInterval(interval)
    }
  }, [activeTab])

  const pairedSources = useMemo(() => {
    const pairs: Source[][] = []
    for (let i = 0; i < sources.length; i += 2) {
      pairs.push(sources.slice(i, i + 2))
    }
    return pairs
  }, [sources])

  const getQualityDetailsText = () => {
    if (quality === 'high') {
      return '1920x1080 60fps (~6 Мбит/с)'
    }
    return '1280x720 30fps (~2.5 Мбит/с)'
  }

  return (
    <div className="bg-[#161618] border border-[#303035] rounded-3xl p-6 w-[540px] max-w-full shadow-2xl flex flex-col h-[600px]">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-white text-xl font-bold">{t('stream.pickerTitle', 'Выбор источника')}</h2>
        <button
          onClick={onClose}
          className="text-textMuted hover:text-white transition-colors duration-200 p-1.5 rounded-lg hover:bg-surface"
        >
          <X weight="bold" size={20} />
        </button>
      </div>

      <div className="flex gap-4 mb-6 border-b border-[#303035] pb-3 items-center">
        <button
          onClick={() => setActiveTab('screen')}
          className={`flex items-center gap-2 pb-2 px-1 font-bold text-sm transition-all relative ${activeTab === 'screen' ? 'text-[#FF007F]' : 'text-textMuted hover:text-white'
            }`}
        >
          <Desktop weight="bold" size={16} />
          {t('stream.screens', 'Экраны')}
          {activeTab === 'screen' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#FF007F] rounded-full" />
          )}
        </button>
        <button
          onClick={() => setActiveTab('window')}
          className={`flex items-center gap-2 pb-2 px-1 font-bold text-sm transition-all relative ${activeTab === 'window' ? 'text-[#FF007F]' : 'text-textMuted hover:text-white'
            }`}
        >
          <AppWindow weight="bold" size={16} />
          {t('stream.apps', 'Приложения')}
          {activeTab === 'window' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#FF007F] rounded-full" />
          )}
        </button>
        <button
          onClick={() => setActiveTab('camera')}
          className={`flex items-center gap-2 pb-2 px-1 font-bold text-sm transition-all relative ${activeTab === 'camera' ? 'text-[#FF007F]' : 'text-textMuted hover:text-white'
            }`}
        >
          <Camera weight="bold" size={16} />
          {t('stream.cameras', 'Камеры')}
          {activeTab === 'camera' && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#FF007F] rounded-full" />
          )}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-1 py-1 pr-2">
        {loading ? (
          <div className="grid grid-cols-2 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="bg-[#0B0B0F] border border-[#303035] rounded-2xl p-3 flex flex-col gap-2.5 animate-pulse"
              >
                <div className="aspect-video rounded-xl bg-[#161618] flex items-center justify-center">
                  <div className="w-6 h-6 border-2 border-[#FF007F] border-t-transparent rounded-full animate-spin opacity-60" />
                </div>
                <div className="h-4 bg-[#161618] rounded-md w-3/4" />
              </div>
            ))}
          </div>
        ) : sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full pt-16 text-textMuted text-sm font-medium">
            {t('stream.noSources', 'Источники не найдены')}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {pairedSources.map((pair, rowIndex) => {
              const isSelectedInPair = pair.some(src => src.id === selectedSourceId)
              return (
                <div key={`pair-${pair[0].id}`} className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-4">
                    {pair.map((src, colIndex) => {
                      const isSelected = selectedSourceId === src.id
                      const globalIndex = rowIndex * 2 + colIndex
                      return (
                        <button
                          key={src.id}
                          type="button"
                          onClick={() => setSelectedSourceId(src.id)}
                          className={`group bg-[#0B0B0F] border rounded-2xl p-3 flex flex-col items-stretch text-left transition-all duration-200 hover:-translate-y-0.5 relative ${isSelected
                              ? 'border-[#FF007F] shadow-[0_0_15px_rgba(255,0,127,0.25)] ring-1 ring-[#FF007F]'
                              : 'border-[#303035] hover:border-[#FF007F]/60'
                            }`}
                        >
                          <div className="relative aspect-video rounded-xl overflow-hidden bg-black mb-2.5 flex items-center justify-center border border-[#252528]">
                            {src.thumbnail ? (
                              <img
                                src={src.thumbnail}
                                alt={src.name}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                              />
                            ) : (
                              <div className="flex flex-col items-center gap-1.5 text-textMuted group-hover:text-white transition-colors">
                                <Camera weight="bold" size={28} className="text-[#FF007F]" />
                                <span className="text-[10px] font-bold tracking-wider">
                                  {t('stream.camera', 'Камера')}
                                </span>
                              </div>
                            )}
                            {src.appIcon && (
                              <img
                                src={src.appIcon}
                                alt=""
                                className="absolute bottom-2 left-2 w-6 h-6 rounded-md bg-[#161618] p-0.5 border border-[#303035]"
                              />
                            )}
                            {isSelected && (
                              <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#FF007F] text-white flex items-center justify-center shadow-md">
                                <Check weight="bold" size={12} />
                              </div>
                            )}
                          </div>
                          <span className="text-white text-xs font-bold truncate" title={src.name}>
                            {cleanName(src.name, globalIndex, activeTab === 'screen', t('stream.screen', 'Экран'))}
                          </span>
                        </button>
                      )
                    })}
                    {pair.length === 1 && <div />}
                  </div>

                  <AnimatePresence initial={false}>
                    {isSelectedInPair && !selectedSourceId?.startsWith('camera:') && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                        className="overflow-hidden"
                      >
                        <div className="bg-[#0B0B0F] border border-[#303035] rounded-2xl p-4 flex flex-col gap-3 my-0.5 shadow-inner">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-textMuted uppercase tracking-wider">
                              {t('stream.shareAudio', 'Передавать звук?')}
                            </span>
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={includeAudio}
                                onChange={(e) => setIncludeAudio(e.target.checked)}
                                className="sr-only peer"
                              />
                              <div className="w-8 h-5 bg-[#161618] border border-[#303035] rounded-full relative transition-colors peer-checked:bg-[#FF007F] peer-checked:border-[#FF007F] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[#303035] after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:after:translate-x-3 peer-checked:after:bg-white" />
                            </label>
                          </div>

                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-textMuted uppercase tracking-wider">
                              {t('stream.quality', 'Качество')}
                            </span>
                            <div className="flex items-center bg-[#161618] border border-[#303035] rounded-full p-1 relative shrink-0 w-28 h-8">
                              <button
                                type="button"
                                onClick={() => setQuality('low')}
                                className={`flex-1 flex items-center justify-center h-full rounded-full text-xs font-bold z-10 transition-all duration-200 ${quality === 'low' ? 'text-white' : 'text-textMuted hover:text-white'
                                  }`}
                              >
                                Low
                              </button>
                              <button
                                type="button"
                                onClick={() => setQuality('high')}
                                className={`flex-1 flex items-center justify-center h-full rounded-full text-xs font-bold z-10 transition-all duration-200 ${quality === 'high' ? 'text-white' : 'text-textMuted hover:text-white'
                                  }`}
                              >
                                High
                              </button>
                              <div
                                style={{
                                  transform: quality === 'low' ? 'translateX(0)' : 'translateX(100%)',
                                  willChange: 'transform'
                                }}
                                className="absolute top-1 bottom-1 left-1 w-[calc(50%-4px)] bg-[#FF007F] rounded-full transition-transform duration-200 ease-out"
                              />
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="mt-4 pt-4 border-t border-[#303035] flex flex-col items-center">
        {selectedSourceId && !selectedSourceId.startsWith('camera:') && (
          <span className="text-[11px] text-textMuted font-bold mb-3 tracking-wide text-center">
            {getQualityDetailsText()}
          </span>
        )}
        <button
          type="button"
          disabled={!selectedSourceId}
          onClick={() => {
            if (selectedSourceId) {
              const isCam = selectedSourceId.startsWith('camera:')
              onSelect(selectedSourceId, isCam ? 'camera' : quality, isCam ? false : includeAudio)
            }
          }}
          className={`w-full py-3 rounded-2xl font-bold text-sm transition-all duration-200 hover:scale-[1.01] active:scale-[0.98] ${selectedSourceId
            ? 'bg-[#FF007F] hover:bg-[#D80073] text-white shadow-[0_0_15px_rgba(255,0,127,0.35)]'
            : 'bg-[#1C1C1F] text-textMuted border border-[#303035] cursor-not-allowed'
            }`}
        >
          {t('stream.confirm', 'Поехали')}
        </button>
      </div>
    </div>
  )
}

