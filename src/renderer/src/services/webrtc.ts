import { signalRService } from './signalr'
import { useAppStore } from '../store/useAppStore'
import i18n from '../i18n'
import processorUrl from './deepfilter-processor?worker&url'
import streamAudioProcessorUrl from './stream-audio-processor?worker&url'
import VadWorker from './vad.worker?worker'

// DeepFilter requests its runtime assets through this sentinel base. The worklet
// has no real network stack (fetch is proxied to this thread), so we intercept
// these URLs and serve the bundled files via IPC, falling back to the CDN when
// the build-time download did not run and the machine is online.
const DEEPFILTER_LOCAL_BASE = 'zabor-local://deepfilternet3'
const DEEPFILTER_CDN_BASE = 'https://cdn.laptrinhai.id.vn/deepfilternet3'
const DEEPFILTER_ASSETS = new Set(['pkg/df_bg.wasm', 'models/DeepFilterNet3_onnx.tar.gz'])

// DeepFilterNet attenuation limit (dB). Higher = more noise removed. Manual mode
// keeps denoising minimal (the user's threshold gate does the work); smart mode
// scales up to an aggressive ceiling for a clean voice, with speech protection.
const DEEPFILTER_MIN_ATTEN = 5
const DEEPFILTER_MAX_ATTEN = 25
// Before the first successful calibration use only the library minimum. A higher
// value here would be an implicit fallback profile and could sound over-processed.
const DEEPFILTER_SMART_DEFAULT_ATTEN = DEEPFILTER_MIN_ATTEN
const OPUS_AUDIO_BITRATE = 128_000
const SAFE_VAD_ON_THRESHOLD = 0.10
const SAFE_VAD_OFF_THRESHOLD = 0.05

type SpeakingEntry = {
  timer: NodeJS.Timeout
  stream: MediaStream

  nodes: AudioNode[]
}

type CalibrationResult = {
  noiseFloor: number
  lowNoise: number
  peakNoise: number
  attenuationLimit: number
  zeroCrossingRate: number
  spectralTilt: number
  acceptedFrames: number
  rejectedSpeechFrames: number
  speechRms: number
  quietSpeechRms: number
  speechPeak: number
  speechFrames: number
  noiseVadHigh: number
  speechVadLow: number
  speechVadMedian: number
  speechVadFrames: number
}

type StoredEnvironmentProfile = {
  version: 28
  timestamp: number
  noiseFloor: number
  lowNoise: number
  peakNoise: number
  attenuationLimit: number
  zeroCrossingRate: number
  spectralTilt: number
  preGainDb?: number
  speechRms?: number
  quietSpeechRms?: number
  speechPeak?: number
  speechFrames?: number
  snrDb?: number
  noiseVadHigh?: number
  speechVadLow?: number
  speechVadMedian?: number
}

type AudioDevices = {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}

type AudioDeviceChangeResult = AudioDevices & {
  inputDeviceId: string
  outputDeviceId: string
}

function optimizeSDP(sdp: string): string {
  let lines = sdp.split('\r\n')

  const opusRegex = /a=rtpmap:(\d+)\s+opus\/48000\/2/i
  const audioMatch = sdp.match(opusRegex)
  if (audioMatch) {
    const pt = audioMatch[1]
    const opusFmtp = `useinbandfec=1;usedtx=0;maxaveragebitrate=${OPUS_AUDIO_BITRATE};maxplaybackrate=48000;sprop-maxcapturerate=48000;stereo=0;sprop-stereo=0;cbr=0;minptime=10`
    let fmtpFound = false
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(`a=fmtp:${pt}`)) {
        lines[i] = `a=fmtp:${pt} ${opusFmtp}`
        fmtpFound = true
        break
      }
    }
    if (!fmtpFound) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith(`a=rtpmap:${pt}`)) {
          lines.splice(i + 1, 0, `a=fmtp:${pt} ${opusFmtp}`)
          break
        }
      }
    }
    let audioSectionIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('m=audio')) {
        audioSectionIdx = i
        break
      }
    }
    if (audioSectionIdx !== -1) {
      // Put Opus first even if Chromium advertises legacy codecs ahead of it.
      const mediaParts = lines[audioSectionIdx].split(' ')
      const payloads = mediaParts.slice(3)
      lines[audioSectionIdx] = [...mediaParts.slice(0, 3), pt, ...payloads.filter(payload => payload !== pt)].join(' ')

      let audioSectionEnd = lines.length
      for (let i = audioSectionIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('m=')) {
          audioSectionEnd = i
          break
        }
      }
      for (let i = audioSectionEnd - 1; i > audioSectionIdx; i--) {
        if (/^b=(AS|TIAS):/i.test(lines[i]) || /^a=ptime:/i.test(lines[i])) lines.splice(i, 1)
      }
      audioSectionEnd = lines.length
      for (let i = audioSectionIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('m=')) {
          audioSectionEnd = i
          break
        }
      }
      let bandwidthInsertIndex = audioSectionEnd
      for (let i = audioSectionIdx + 1; i < audioSectionEnd; i++) {
        if (lines[i].startsWith('a=')) {
          bandwidthInsertIndex = i
          break
        }
      }
      // TIAS is the exact media bitrate; AS is kept for peers that only honor
      // the older SDP bandwidth field. The sender parameter below matches it.
      lines.splice(bandwidthInsertIndex, 0, 'b=AS:128', `b=TIAS:${OPUS_AUDIO_BITRATE}`, 'a=ptime:20')
    }
  }

  let videoSectionIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('m=video')) {
      videoSectionIdx = i
      break
    }
  }

  if (videoSectionIdx !== -1) {
    let h264Payloads: string[] = []
    let h264Fmtps: Record<string, string> = {}
    let h264RtpMaps: Record<string, string> = {}

    for (let i = videoSectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('m=')) break
      const rtpmapMatch = lines[i].match(/^a=rtpmap:(\d+)\s+H264\/90000/i)
      if (rtpmapMatch) {
        const pt = rtpmapMatch[1]
        h264Payloads.push(pt)
        h264RtpMaps[pt] = lines[i]
      }
      const fmtpMatch = lines[i].match(/^a=fmtp:(\d+)\s+(.+)/i)
      if (fmtpMatch) {
        const pt = fmtpMatch[1]
        h264Fmtps[pt] = lines[i]
      }
    }

    if (h264Payloads.length > 0) {
      let filteredLines: string[] = []
      let skipVideoTracks = false

      for (let i = 0; i < lines.length; i++) {
        if (i === videoSectionIdx) {
          const parts = lines[i].split(' ')
          const newVideoLine = `${parts[0]} ${parts[1]} ${parts[2]} ${h264Payloads.join(' ')}`
          filteredLines.push(newVideoLine)
          skipVideoTracks = true
          continue
        }
        if (skipVideoTracks && lines[i].startsWith('m=')) {
          skipVideoTracks = false
        }
        if (skipVideoTracks) {
          if (lines[i].startsWith('a=rtpmap:') || lines[i].startsWith('a=fmtp:') || lines[i].startsWith('a=rtcp-fb:')) {
            const ptMatch = lines[i].match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/i)
            if (ptMatch && h264Payloads.includes(ptMatch[1])) {
              filteredLines.push(lines[i])
            }
          } else {
            filteredLines.push(lines[i])
          }
        } else {
          filteredLines.push(lines[i])
        }
      }
      lines = filteredLines
    }
  }

  return lines.join('\r\n')
}

function createSilentAudioStream(): MediaStream {
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
  const dst = ctx.createMediaStreamDestination()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  gain.gain.value = 0
  osc.connect(gain)
  gain.connect(dst)
  osc.start()
  return dst.stream
}

export class WebRTCManager {
  private static readonly CALIBRATION_SCHEMA_VERSION = 28
  private static readonly CALIBRATION_SCHEMA_KEY = 'zabor_mic_calibration_schema'
  private static readonly CALIBRATION_PROFILE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
  private localStream: MediaStream | null = null
  private rawStream: MediaStream | null = null
  public localVideoStream: MediaStream | null = null
  private statsInterval: NodeJS.Timeout | null = null
  private streamGainNodes: Map<string, GainNode> = new Map()
  private streamSourceNodes: Map<string, MediaStreamAudioSourceNode> = new Map()
  private streamAudioElements: Map<string, HTMLAudioElement> = new Map()
  private streamCaptureContext: AudioContext | null = null
  private streamCaptureNode: AudioWorkletNode | null = null
  private streamCaptureDestination: MediaStreamAudioDestinationNode | null = null
  private removeStreamAudioListener: (() => void) | null = null

  private peerConnections: Map<string, RTCPeerConnection> = new Map()
  private audioElements: Map<string, HTMLAudioElement> = new Map()
  private lastPacketsLost: Map<string, number> = new Map()

  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map()

  private dcTimers: Map<string, NodeJS.Timeout> = new Map()

  private iceTimeoutTimers: Map<string, NodeJS.Timeout> = new Map()

  private retryCount: Map<string, number> = new Map()

  private iceRestartInFlight: Set<string> = new Set()

  private pendingRenegotiation: Set<string> = new Set()

  private static readonly MAX_ICE_RETRIES = 4

  private static readonly ICE_TIMEOUT_MS = 15000

  private static readonly DISCONNECTED_GRACE_MS = 10000

  private currentDeviceId = 'default'
  private currentStreamQuality: 'high' | 'low' | 'camera' = 'low'
  private currentOutputDeviceId = 'default'
  private noiseSuppression = true

  private inputVolume = 100
  private outputVolume = 100
  private isDeafened = false

  private processedContext: AudioContext | null = null
  private processedSource: MediaStreamAudioSourceNode | null = null
  private calibratedPreGainNode: GainNode | null = null
  private inputGainNode: GainNode | null = null
  private dfNode: AudioWorkletNode | null = null
  private dfNodeReady = false
  private vadWorker: Worker | null = null


  private calibratedAttenuationLimit = DEEPFILTER_SMART_DEFAULT_ATTEN
  private calibratedNoiseFloor = 0.003
  private calibratedPreGainDb = 0
  private calibratedVadOnThreshold = SAFE_VAD_ON_THRESHOLD
  private calibratedVadOffThreshold = SAFE_VAD_OFF_THRESHOLD
  private hasVoiceCalibration = false
  private calibrationDeviceId = 'default'
  private vadWorkerReady = false
  private calibrationInProgress = false
  private localSpeakingState = false
  private thresholdMode = localStorage.getItem('zabor_threshold_mode') || 'auto'
  private manualThresholdValue = this.normalizeManualThreshold(parseFloat(localStorage.getItem('zabor_manual_threshold_value') || '-42'))
  private activeStartPromise: Promise<boolean> | null = null

  private backgroundContext: AudioContext | null = null
  private backgroundSource: MediaStreamAudioSourceNode | null = null
  private backgroundAnalyser: AnalyserNode | null = null
  private micMeterInterval: NodeJS.Timeout | null = null
  private micLevelDb = -100
  private micLevelListeners = new Set<(db: number) => void>()

  private rawAnalyserNode: AnalyserNode | null = null
  private silenceMonitorInterval: NodeJS.Timeout | null = null
  private silenceCounterMs = 0
  private isSilenceWarningActive = false
  private speakingIntervals: Map<string, SpeakingEntry> = new Map()

  private outputMixContext: AudioContext | null = null
  private outputCompressor: DynamicsCompressorNode | null = null
  private mixAudioElement: HTMLAudioElement | null = null
  private userGainNodes: Map<string, GainNode> = new Map()
  private userSourceNodes: Map<string, MediaStreamAudioSourceNode> = new Map()
  private defaultInputFingerprint: string | null = null
  private defaultOutputFingerprint: string | null = null
  private deviceChangePromise: Promise<AudioDeviceChangeResult> | null = null

  private readonly config: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.twilio.com:3478' },

      { urls: 'turn:150.241.64.108:3478?transport=udp', username: 'zabor', credential: 'REDACTED-ROTATED-CREDENTIAL_turn' },
      { urls: 'turn:150.241.64.108:3478?transport=tcp', username: 'zabor', credential: 'REDACTED-ROTATED-CREDENTIAL_turn' }
    ],
    bundlePolicy: 'max-bundle',
    iceCandidatePoolSize: 4
  }



  private getThresholdParams(gainFactor: number) {
    // Manual mode keeps the denoiser minimal and relies on the user's threshold
    // gate; smart mode uses a calibrated, speech-safe attenuation ceiling.
    const activeAttenuationLimit = this.thresholdMode === 'manual'
      ? DEEPFILTER_MIN_ATTEN
      : this.calibratedAttenuationLimit
    return {
      attenuationLimit: activeAttenuationLimit,
      noiseFloor: this.calibratedNoiseFloor,
      thresholdMode: this.thresholdMode,
      manualThresholdValue: this.manualThresholdValue,
      vadOnThreshold: this.calibratedVadOnThreshold,
      vadOffThreshold: this.calibratedVadOffThreshold,
      // The neural suppressor is already the spectral processor. Its optional
      // post-filter is disabled to keep quiet consonants and breath texture intact.
      postFilterBeta: 0,
      // VAD and calibration run before all gain nodes, so their thresholds must
      // stay independent of the user's microphone volume and calibrated pre-gain.
      gainFactor: 1
    }
  }

  private inputVolumeToGain(volume: number): number {
    const normalized = Math.max(0, Math.min(200, Number.isFinite(volume) ? volume : 100))
    return normalized / 100
  }

  private normalizeManualThreshold(value: number): number {
    // Values from the previous UI represented denoiser attenuation, not dBFS.
    if (value >= 0) return -42
    return Math.max(-60, Math.min(-12, Number.isFinite(value) ? value : -42))
  }

  private calibrationStorageKey(deviceId: string): string {
    return `zabor_mic_calibration_v${WebRTCManager.CALIBRATION_SCHEMA_VERSION}:${encodeURIComponent(deviceId || 'default')}`
  }

  private migrateCalibrationStorage(): void {
    try {
      const currentVersion = Number(localStorage.getItem(WebRTCManager.CALIBRATION_SCHEMA_KEY)) || 0
      if (currentVersion === WebRTCManager.CALIBRATION_SCHEMA_VERSION) return

      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (key?.startsWith('zabor_mic_calibration_v') ||
          key === 'zabor_calibrated_noise_floor' || key === 'zabor_calibrated_attenuation') {
          localStorage.removeItem(key)
        }
      }
      localStorage.setItem(WebRTCManager.CALIBRATION_SCHEMA_KEY, String(WebRTCManager.CALIBRATION_SCHEMA_VERSION))
    } catch (error) {
      console.warn('[WebRTC] Failed to migrate microphone calibration profiles', error)
    }
  }

  private readEnvironmentProfiles(deviceId = this.calibrationDeviceId): StoredEnvironmentProfile[] {
    try {
      const raw = localStorage.getItem(this.calibrationStorageKey(deviceId))
      const parsed = raw ? JSON.parse(raw) : null
      if (!Array.isArray(parsed?.profiles)) return []
      const oldestAllowedTimestamp = Date.now() - WebRTCManager.CALIBRATION_PROFILE_MAX_AGE_MS
      return parsed.profiles.filter((profile: StoredEnvironmentProfile) =>
        profile?.version === WebRTCManager.CALIBRATION_SCHEMA_VERSION &&
        Number.isFinite(profile.timestamp) && profile.timestamp >= oldestAllowedTimestamp &&
        Number.isFinite(profile.noiseFloor) && Number.isFinite(profile.attenuationLimit) &&
        Number.isFinite(profile.zeroCrossingRate) && Number.isFinite(profile.spectralTilt)
      )
    } catch {
      return []
    }
  }

  private environmentDistance(
    profile: StoredEnvironmentProfile,
    noiseFloor: number,
    lowNoise: number,
    peakNoise: number,
    zeroCrossingRate: number,
    spectralTilt: number
  ): number {
    const db = (value: number) => 20 * Math.log10(Math.max(1e-5, value))
    const profileSpread = profile.peakNoise / Math.max(1e-5, profile.lowNoise)
    const measuredSpread = peakNoise / Math.max(1e-5, lowNoise)
    return Math.abs(db(profile.noiseFloor) - db(noiseFloor)) +
      Math.abs(Math.log2(Math.max(0.25, profileSpread) / Math.max(0.25, measuredSpread))) * 2 +
      Math.abs(profile.zeroCrossingRate - zeroCrossingRate) * 20 +
      Math.abs(Math.log2(Math.max(0.05, profile.spectralTilt) / Math.max(0.05, spectralTilt))) * 2
  }

  private calculateSpeechPreservingAttenuation(
    noiseFloor: number,
    speechRms?: number,
    quietSpeechRms?: number,
    stationarityRatio = 1,
    speechVadFrames = 0
  ): number {
    const noiseDb = 20 * Math.log10(Math.max(1e-5, noiseFloor))
    const clamp01 = (value: number) => Math.max(0, Math.min(1, value))

    // Use the complete 5-25 dB range instead of four coarse steps. A noise floor
    // at or below -68 dBFS maps to 5 dB, while -38 dBFS or louder maps to 25 dB.
    // Intermediate rooms receive every integer value between those endpoints.
    const noiseStrength = clamp01((noiseDb + 68) / 30)
    let attenuation = DEEPFILTER_MIN_ATTEN +
      noiseStrength * (DEEPFILTER_MAX_ATTEN - DEEPFILTER_MIN_ATTEN)

    // Use the median active-speech level for the main SNR decision. The previous
    // implementation passed the 20th percentile (quietSpeechRms) here, which
    // treated normal quiet consonants as if the whole voice had a poor SNR and
    // kept DeepFilter near its 5 dB minimum.
    let measuredSnrDb: number | null = null
    let speechSafeCeiling = DEEPFILTER_MAX_ATTEN
    if (speechRms && speechRms > 0) {
      const speechDb = 20 * Math.log10(Math.max(1e-5, speechRms))
      const snrDb = speechDb - noiseDb
      measuredSnrDb = snrDb

      // Continuous speech-safety ceiling. At poor SNR DeepFilter is restrained;
      // from 18 dB SNR onward the full 25 dB remains available. This makes 25 dB
      // reachable in a noisy room without applying it to barely distinguishable
      // speech where any suppressor could damage consonants.
      if (snrDb <= 6) speechSafeCeiling = 10
      else if (snrDb < 10) speechSafeCeiling = 10 + ((snrDb - 6) / 4) * 6
      else if (snrDb < 16) speechSafeCeiling = 16 + ((snrDb - 10) / 6) * 7
      else if (snrDb < 18) speechSafeCeiling = 23 + ((snrDb - 16) / 2) * 2
    }

    // A genuinely weak quiet-speech margin can still indicate that aggressive
    // suppression would damage fricatives. It is only a cap in this rare case;
    // ordinary quiet speech (for example 7 dB below the median) does not reduce
    // the calibrated strength.
    let quietMeasuredSnrDb: number | null = null
    if (quietSpeechRms && quietSpeechRms > 0) {
      quietMeasuredSnrDb = 20 * Math.log10(Math.max(1e-5, quietSpeechRms)) - noiseDb
      // Quiet-speech SNR is the most sensitive predictor of consonant damage.
      // Use a continuous cap instead of allowing a 12 dB step at ~4 dB SNR.
      if (quietMeasuredSnrDb < 4) {
        speechSafeCeiling = Math.min(speechSafeCeiling, 8 + Math.max(0, quietMeasuredSnrDb) * 0.5)
      } else if (quietMeasuredSnrDb < 8) {
        speechSafeCeiling = Math.min(speechSafeCeiling, 10 + (quietMeasuredSnrDb - 4) * 1.0)
      }
    }

    // Silero confidence and noise stationarity must not be hard prerequisites for
    // denoising strength: a successful calibration may also prove speech through
    // its measured acoustic separation from the background.
    const hasReliableSpeech = measuredSnrDb !== null && quietMeasuredSnrDb !== null &&
      (speechVadFrames >= 6 || (measuredSnrDb >= 10 && quietMeasuredSnrDb >= 5))
    if (hasReliableSpeech && measuredSnrDb !== null && quietMeasuredSnrDb !== null) {
      // Continuous speech-supported target. Quiet speech receives the larger weight
      // because weak consonants and word endings are the first parts damaged by an
      // excessive attenuation limit. Unlike the former 12/14/16/18/20 dB steps,
      // small measurement changes now produce small parameter changes. For example,
      // median/quiet SNR of 12/6 dB maps to about 14 dB instead of jumping to 16.
      const effectiveSpeechSnrDb = measuredSnrDb * 0.35 + quietMeasuredSnrDb * 0.65
      const speechSupportedTarget = Math.max(8, Math.min(22, 8 + effectiveSpeechSnrDb * 0.75))
      attenuation = Math.max(attenuation, speechSupportedTarget)
    }

    attenuation = Math.min(attenuation, speechSafeCeiling)

    // Penalize transient/unstable noise gradually instead of a sudden mode jump.
    // Stationary fan/room noise can reach 25 dB; clicks and keyboard bursts cannot
    // force maximum broadband suppression from a single calibration sample.
    const transientPenalty = 1 * clamp01((stationarityRatio - 4) / 4)
    attenuation -= transientPenalty

    return Math.round(Math.max(DEEPFILTER_MIN_ATTEN, Math.min(DEEPFILTER_MAX_ATTEN, attenuation)))
  }

  private calculateVadThresholds(noiseVadHigh: number, speechVadLow: number, speechVadMedian: number) {
    const safeNoiseHigh = Math.max(0, Math.min(0.5, noiseVadHigh))
    const safeSpeechLow = Math.max(0, Math.min(1, speechVadLow))
    const safeSpeechMedian = Math.max(0, Math.min(1, speechVadMedian))
    const separation = safeSpeechLow - safeNoiseHigh
    const medianSeparation = safeSpeechMedian - safeNoiseHigh
    let vadOnThreshold: number
    let vadOffThreshold: number
    if (separation >= 0.006 && medianSeparation >= 0.015) {
      // Put the opening threshold inside the measured gap. Quiet microphones often
      // produce low absolute Silero probabilities, so the gap matters more than a
      // global confidence constant.
      vadOnThreshold = safeNoiseHigh + separation * 0.34
      vadOffThreshold = safeNoiseHigh + separation * 0.10
    } else {
      // Do not derive a gate threshold from noise when calibration did not measure
      // a real Silero speech/noise gap. That can place the opening threshold above
      // every speech probability and mute the outgoing stream completely.
      vadOnThreshold = SAFE_VAD_ON_THRESHOLD
      vadOffThreshold = SAFE_VAD_OFF_THRESHOLD
    }
    // Calibration may lower Silero thresholds for a quiet microphone, but must
    // never raise them above the known audible defaults and mute the whole stream.
    vadOnThreshold = Math.max(0.025, Math.min(SAFE_VAD_ON_THRESHOLD, vadOnThreshold))
    vadOffThreshold = Math.max(0.012, Math.min(SAFE_VAD_OFF_THRESHOLD, vadOnThreshold - 0.008, vadOffThreshold))
    return { vadOnThreshold, vadOffThreshold }
  }

  private loadCalibration(deviceId: string, deviceLabel = '') {
    this.migrateCalibrationStorage()
    const normalizedDeviceId = deviceId && deviceId !== 'default'
      ? deviceId
      : `default:${deviceLabel.trim().toLowerCase() || 'unknown'}`
    this.calibrationDeviceId = normalizedDeviceId
    this.calibratedNoiseFloor = 0.003
    this.calibratedAttenuationLimit = DEEPFILTER_SMART_DEFAULT_ATTEN
    this.calibratedPreGainDb = 0
    this.calibratedVadOnThreshold = SAFE_VAD_ON_THRESHOLD
    this.calibratedVadOffThreshold = SAFE_VAD_OFF_THRESHOLD
    this.hasVoiceCalibration = false

    // Apply the most recent stored profile for this device immediately. No
    // background room probe is allowed to revise it while the user speaks.
    const latest = this.readEnvironmentProfiles(normalizedDeviceId)
      .sort((a, b) => b.timestamp - a.timestamp)[0]
    if (latest) {
      this.hasVoiceCalibration = true
      if (Number.isFinite(latest.noiseFloor) && latest.noiseFloor > 0) {
        this.calibratedNoiseFloor = Math.max(0.0001, Math.min(0.03, latest.noiseFloor))
      }
      this.calibratedAttenuationLimit = Math.max(DEEPFILTER_MIN_ATTEN, Math.min(DEEPFILTER_MAX_ATTEN, latest.attenuationLimit))
      this.calibratedPreGainDb = Number.isFinite(latest.preGainDb) ? Math.max(0, Math.min(6, latest.preGainDb!)) : 0
      const vadThresholds = Number.isFinite(latest.speechVadLow) && Number.isFinite(latest.speechVadMedian) &&
        Number.isFinite(latest.noiseVadHigh)
        ? this.calculateVadThresholds(latest.noiseVadHigh!, latest.speechVadLow!, latest.speechVadMedian!)
        : null
      this.calibratedVadOnThreshold = vadThresholds?.vadOnThreshold ?? SAFE_VAD_ON_THRESHOLD
      this.calibratedVadOffThreshold = vadThresholds?.vadOffThreshold ?? SAFE_VAD_OFF_THRESHOLD
      if (this.calibratedPreGainNode) {
        this.calibratedPreGainNode.gain.value = Math.pow(10, this.calibratedPreGainDb / 20)
      }
      this.updateThresholds()
    }
  }

  public resetMicCalibration() {
    this.calibratedNoiseFloor = 0.003
    this.calibratedAttenuationLimit = DEEPFILTER_SMART_DEFAULT_ATTEN
    this.calibratedPreGainDb = 0
    this.calibratedVadOnThreshold = SAFE_VAD_ON_THRESHOLD
    this.calibratedVadOffThreshold = SAFE_VAD_OFF_THRESHOLD
    this.hasVoiceCalibration = false
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i)
        if (key?.startsWith('zabor_mic_calibration_v') || key === 'zabor_calibrated_noise_floor' || key === 'zabor_calibrated_attenuation') {
          localStorage.removeItem(key)
        }
      }
      localStorage.setItem(WebRTCManager.CALIBRATION_SCHEMA_KEY, String(WebRTCManager.CALIBRATION_SCHEMA_VERSION))
    } catch { }
    this.updateThresholds()
  }

  private async loadDeepFilterAsset(rel: string): Promise<ArrayBuffer | null> {
    // Prefer the bundled asset: it works offline and inside the packaged file://
    // app, where fetch() cannot read local resources. Fall back to the CDN only
    // when the build-time download did not run and the machine is online.
    try {
      const bytes = await window.windowControls.loadDeepFilterAsset(rel)
      if (bytes && bytes.byteLength > 0) {
        return (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? bytes.buffer
          : bytes.slice().buffer) as ArrayBuffer
      }
    } catch (e) {
      console.warn(`[WebRTC] Bundled DeepFilter asset "${rel}" unavailable, trying CDN:`, e)
    }
    const res = await fetch(`${DEEPFILTER_CDN_BASE}/${rel}`)
    if (!res.ok) throw new Error(`CDN ${res.status} ${res.statusText}`)
    return res.arrayBuffer()
  }

  private async createProcessedStream(rawStream: MediaStream): Promise<MediaStream> {
    this.cleanupProcessedStream()

    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    this.processedContext = ctx

    if (ctx.sampleRate !== 48000) {
      console.warn(`[WebRTC] Audio processing requires 48000Hz, got ${ctx.sampleRate}Hz`)
      await ctx.close().catch(() => { })
      this.processedContext = null
      return this.noiseSuppression ? createSilentAudioStream() : rawStream
    }

    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => { })
    }

    const destination = ctx.createMediaStreamDestination()

    try {
      await ctx.audioWorklet.addModule(processorUrl)
      this.dfNode = new AudioWorkletNode(ctx, 'deepfilter-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers'
      })
      this.dfNodeReady = false
      this.vadWorkerReady = false
      const me = useAppStore.getState().currentUser
      if (me) {
        this.clearVAD(me.id)
      }
    } catch (e) {
      console.warn('[WebRTC] Failed to load deepfilter-processor.js', e)
    }

    if (this.dfNode) {
      // Install the bridge before either model starts. DeepFilter requests its
      // WASM/model assets immediately and AudioWorklet messages are not replayed.
      this.dfNode.port.onmessage = (event) => {
        if (event.data.type === 'vad') {
          const isSpeaking = event.data.isSpeaking
          if (isSpeaking !== this.localSpeakingState) {
            this.localSpeakingState = isSpeaking
            const me = useAppStore.getState().currentUser
            if (me) {
              useAppStore.getState().setSpeakingStatus(me.id, isSpeaking)
              signalRService.setSpeakingState(isSpeaking)
            }
          }
        } else if (event.data.type === 'audio16k') {
          if (this.vadWorker) {
            const audioFrame = event.data.audio as Float32Array
            this.vadWorker.postMessage({
              type: 'process',
              audioFrame,
              sequence: event.data.sequence,
              endFrameId: event.data.endFrameId,
              windowRms: event.data.windowRms
            }, [audioFrame.buffer])
          }
        } else if (event.data.type === 'micLevelDb') {
          const db = Number(event.data.db)
          if (Number.isFinite(db)) {
            this.micLevelDb = db
            this.micLevelListeners.forEach(listener => listener(db))
          }
        } else if (event.data.type === 'resetVad') {
          this.vadWorker?.postMessage({ type: 'reset' })
        } else if (event.data.type === 'fetchRequest') {
          const url = event.data.url as string
          const deliver = (buffer: ArrayBuffer | null) => {
            if (buffer) {
              this.dfNode?.port.postMessage({ type: 'fetchResponse', url, buffer }, [buffer])
            } else {
              this.dfNode?.port.postMessage({ type: 'fetchResponse', url, buffer: null })
            }
          }
          const localRel = url.startsWith(`${DEEPFILTER_LOCAL_BASE}/`)
            ? url.slice(DEEPFILTER_LOCAL_BASE.length + 1)
            : null
          if (localRel && DEEPFILTER_ASSETS.has(localRel)) {
            this.loadDeepFilterAsset(localRel)
              .then(deliver)
              .catch(err => {
                console.error('[WebRTC] DeepFilter asset load failed:', err)
                deliver(null)
              })
          } else {
            fetch(url)
              .then(res => {
                if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
                return res.arrayBuffer()
              })
              .then(deliver)
              .catch(err => {
                console.error('[WebRTC] fetchRequest failed:', err)
                deliver(null)
              })
          }
        } else if (event.data.type === 'log') {
          console.log('[WebRTC Worklet Log]:', event.data.message)
        } else if (event.data.type === 'ready') {
          this.dfNodeReady = true
          console.log('[WebRTC Worklet Log]: DeepFilterProcessor is ready.')
        }
      }

      // Start model loading only after the fetch bridge above is listening.
      this.dfNode.port.postMessage({ type: 'loadWasm', cdnUrl: DEEPFILTER_LOCAL_BASE })

      try {
        this.vadWorker = new VadWorker()
        const absoluteWasmPath = new URL('./', window.location.href).href
        let resolveVadReady: (() => void) | null = null
        let rejectVadReady: ((error: Error) => void) | null = null
        const vadReadyPromise = new Promise<void>((resolve, reject) => {
          resolveVadReady = resolve
          rejectVadReady = reject
        })
        const vadReadyTimeout = window.setTimeout(() => {
          rejectVadReady?.(new Error('Silero VAD initialization timed out'))
        }, 15000)
        this.vadWorker.onmessage = (workerEvent) => {
          if (workerEvent.data.type === 'probability') {
            this.vadWorkerReady = true
            const prob = workerEvent.data.probability
            if (this.dfNode) {
              this.dfNode.port.postMessage({
                type: 'setSileroVadProbability',
                probability: prob,
                sequence: workerEvent.data.sequence,
                endFrameId: workerEvent.data.endFrameId,
                windowRms: workerEvent.data.windowRms
              })
            }
          } else if (workerEvent.data.type === 'error') {
            console.error('[WebRTC] Silero VAD Worker error:', workerEvent.data.error)
            if (workerEvent.data.phase === 'initialization') {
              window.clearTimeout(vadReadyTimeout)
              this.vadWorkerReady = false
              rejectVadReady?.(new Error(String(workerEvent.data.error)))
            }
          } else if (workerEvent.data.type === 'ready') {
            this.vadWorkerReady = true
            window.clearTimeout(vadReadyTimeout)
            resolveVadReady?.()
            resolveVadReady = null
            rejectVadReady = null
            console.log('[WebRTC] Silero VAD Worker is ready')
            if (this.dfNode) {
              this.dfNode.port.postMessage({
                type: 'setConfig',
                sileroVadEnabled: true
              })
            }
          }
        }
        const model = await window.windowControls.loadSileroModel()
        this.vadWorker.postMessage({
          type: 'init',
          model,
          wasmPath: absoluteWasmPath
        }, [model.buffer])
        await vadReadyPromise
      } catch (e) {
        this.vadWorker?.terminate()
        this.vadWorker = null
        this.vadWorkerReady = false
        this.dfNode.port.postMessage({ type: 'setConfig', sileroVadEnabled: false })
        console.warn(`[WebRTC] Silero VAD is unavailable; using energy-based speech detection: ${e instanceof Error ? e.message : String(e)}`)
      }

      this.localSpeakingState = false
    }

    const source = ctx.createMediaStreamSource(rawStream)
    this.processedSource = source

    const highpass1 = ctx.createBiquadFilter()
    highpass1.type = 'highpass'
    highpass1.frequency.value = 60
    highpass1.Q.value = 0.707

    // Do not use a broadband compressor on the microphone path. It performs
    // automatic gain riding: sustained vowels are pushed down and recover when
    // the sound stops, which makes the voice feel as if it is breathing.
    // A static soft clipper protects the encoder from overload without attack,
    // release, or time-dependent gain changes. Normal voice remains exactly linear.
    const peakGuard = ctx.createWaveShaper()
    const peakCurve = new Float32Array(65536)
    // Static peak limiter: the transfer curve never changes and remains linear
    // until the signal is genuinely close to digital clipping.
    const linearLimit = 0.95
    const outputLimit = 0.995
    const softRange = 1 - linearLimit
    const normalization = 1 - Math.exp(-3)
    for (let i = 0; i < peakCurve.length; i++) {
      const sample = (i / (peakCurve.length - 1)) * 2 - 1
      const magnitude = Math.abs(sample)
      if (magnitude <= linearLimit) {
        peakCurve[i] = sample
      } else {
        const position = (magnitude - linearLimit) / softRange
        const guarded = linearLimit + (outputLimit - linearLimit) * (1 - Math.exp(-3 * position)) / normalization
        peakCurve[i] = Math.sign(sample) * guarded
      }
    }
    peakGuard.curve = peakCurve
    peakGuard.oversample = '4x'

    const inputGain = ctx.createGain()
    const calibratedPreGain = ctx.createGain()
    calibratedPreGain.gain.value = Math.pow(10, this.calibratedPreGainDb / 20)
    this.calibratedPreGainNode = calibratedPreGain
    const gainFactor = this.inputVolumeToGain(this.inputVolume)

    inputGain.gain.value = gainFactor
    this.inputGainNode = inputGain

    try {
      const rawAnalyser = ctx.createAnalyser()
      rawAnalyser.fftSize = 256
      source.connect(rawAnalyser)
      this.rawAnalyserNode = rawAnalyser
    } catch (e) {
      console.warn('[WebRTC] Failed to create raw analyser node for silence monitoring:', e)
    }

    if (this.dfNode) {
      const store = useAppStore.getState()
      const isMuted = store.currentUser?.isMuted || store.currentUser?.isServerMuted || false
      this.dfNode.port.postMessage({
        type: 'setConfig',
        noiseSuppression: this.noiseSuppression,
        sileroVadEnabled: this.vadWorkerReady,
        isMuted: isMuted
      })
      this.dfNode.port.postMessage({
        type: 'setCalibratedParams',
        ...this.getThresholdParams(gainFactor),
      })
      source.connect(this.dfNode)
      this.dfNode.connect(highpass1)
      highpass1.connect(calibratedPreGain)
      calibratedPreGain.connect(inputGain)
    } else {
      // Keep the microphone closed when smart suppression cannot be created.
      // Falling back to the raw track would silently leak unprocessed noise.
      source.connect(inputGain)
      inputGain.gain.value = this.noiseSuppression ? 0 : gainFactor
      inputGain.connect(highpass1)
    }

    if (this.dfNode) inputGain.connect(peakGuard)
    else highpass1.connect(peakGuard)
    peakGuard.connect(destination)

    return destination.stream
  }

  private cleanupProcessedStreamSourceOnly() {
    this.stopSilenceMonitor()
    if (this.inputGainNode) {
      try { this.inputGainNode.disconnect() } catch { }
      this.inputGainNode = null
    }
    if (this.dfNode) {
      try { this.dfNode.disconnect() } catch { }
    }
    if (this.processedSource) {
      try { this.processedSource.disconnect() } catch { }
      this.processedSource = null
    }
    if (this.rawAnalyserNode) {
      try { this.rawAnalyserNode.disconnect() } catch { }
      this.rawAnalyserNode = null
    }
  }

  private cleanupProcessedStream() {
    this.cleanupProcessedStreamSourceOnly()
    if (this.dfNode) {
      try { this.dfNode.port.close() } catch { }
      this.dfNode = null
    }
    this.dfNodeReady = false
    this.vadWorkerReady = false
    if (this.processedContext && this.processedContext.state !== 'closed') {
      this.processedContext.close().catch(() => { })
    }
    this.processedContext = null
    if (this.vadWorker) {
      try { this.vadWorker.terminate() } catch { }
      this.vadWorker = null
    }
    const me = useAppStore.getState().currentUser
    if (me) {
      useAppStore.getState().setSpeakingStatus(me.id, false)
      signalRService.setSpeakingState(false)
    }
    this.localSpeakingState = false
  }

  public setInputVolume(volume: number) {
    this.inputVolume = Math.max(0, Math.min(200, Number.isFinite(volume) ? volume : 100))
    const gainFactor = this.inputVolumeToGain(this.inputVolume)

    if (this.inputGainNode) {
      this.inputGainNode.gain.value = this.noiseSuppression && !this.dfNode ? 0 : gainFactor
    }
    if (this.dfNode) {
      this.dfNode.port.postMessage({
        type: 'setCalibratedParams',
        ...this.getThresholdParams(gainFactor)
      })
    }
  }

  public setMicThresholdParams(mode: 'auto' | 'manual', manualValue: number) {
    const normalizedThreshold = this.normalizeManualThreshold(manualValue)
    localStorage.setItem('zabor_threshold_mode', mode)
    localStorage.setItem('zabor_manual_threshold_value', normalizedThreshold.toString())
    this.thresholdMode = mode
    this.manualThresholdValue = normalizedThreshold
    this.updateThresholds()
  }

  private updateThresholds() {
    const gainFactor = this.inputVolumeToGain(this.inputVolume)

    if (this.dfNode) {
      this.dfNode.port.postMessage({
        type: 'setCalibratedParams',
        ...this.getThresholdParams(gainFactor)
      })
    }
  }

  public setOutputVolume(volume: number) {
    this.outputVolume = volume
    this.userGainNodes.forEach((_, userId) => this.updateRemoteVolume(userId))
  }

  public setDeafened(deafened: boolean) {
    this.isDeafened = deafened
    if (this.mixAudioElement) {
      this.mixAudioElement.muted = deafened
    }
  }

  private updateRemoteVolume(userId: string) {
    const store = useAppStore.getState()
    const isActive = store.activeStreamId === userId
    const streamGainNode = this.streamGainNodes.get(userId)
    if (streamGainNode) {
      const streamVol = isActive ? (store.streamVolumes[userId] ?? 100) : 0
      streamGainNode.gain.value = Math.max(0, Math.min(4.0, (this.outputVolume / 100) * (streamVol / 100)))
    }

    const gainNode = this.userGainNodes.get(userId)
    if (gainNode) {
      const vol = store.userVolumes[userId] ?? 100
      gainNode.gain.value = Math.max(0, Math.min(4.0, (this.outputVolume / 100) * (vol / 100)))
    }
  }

  public setNoiseSuppression(enabled: boolean) {
    this.noiseSuppression = enabled
    if (this.inputGainNode && !this.dfNode) {
      this.inputGainNode.gain.value = enabled ? 0 : this.inputVolumeToGain(this.inputVolume)
    }
    if (this.dfNode) {
      this.dfNode.port.postMessage({
        type: 'setConfig',
        noiseSuppression: enabled
      })
    }
  }




  private setupVAD(stream: MediaStream, userId: string, isLocal: boolean) {
    this.clearVAD(userId)

    try {
      if (isLocal) {
        if (this.dfNode || this.dfNodeReady) {
          return
        }
        if (!this.processedContext || this.processedContext.state === 'closed') {
          this.processedContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
        }
        const contextToUse = this.processedContext
        if (contextToUse.state === 'suspended') contextToUse.resume().catch(() => { })

        const source = contextToUse.createMediaStreamSource(stream)
        const bp1 = contextToUse.createBiquadFilter()
        bp1.type = 'highpass'
        bp1.frequency.value = 85
        bp1.Q.value = 0.5

        const bp2 = contextToUse.createBiquadFilter()
        bp2.type = 'lowpass'
        bp2.frequency.value = 8000
        bp2.Q.value = 0.5

        const analyser = contextToUse.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.6

        source.connect(bp1)
        bp1.connect(bp2)
        bp2.connect(analyser)

        const vadNodes: AudioNode[] = [source, bp1, bp2, analyser]
        const buf = new Uint8Array(analyser.fftSize)
        let lastVoice = 0
        let wasSpeaking = false
        let voiceFrames = 0
        let silenceFrames = 0
        let vadSilenceFrames = 0
        let hasWarnedSilence = false

        const check = () => {
          const store = useAppStore.getState()
          if (store.currentUser?.isMuted || store.currentUser?.isServerMuted) {
            if (wasSpeaking) {
              wasSpeaking = false
              voiceFrames = 0
              store.setSpeakingStatus(userId, false)
              signalRService.setSpeakingState(false)
            }
            silenceFrames = 0
            return
          }

          analyser.getByteTimeDomainData(buf)
          let peak = 0, sum = 0
          for (let i = 0; i < buf.length; i++) {
            const s = Math.abs(buf[i] - 128)
            if (s > peak) peak = s
            sum += s
          }
          const avg = sum / buf.length

          if (peak === 0) {
            silenceFrames++
          } else {
            silenceFrames = 0
            hasWarnedSilence = false
          }

          if (silenceFrames > 150 && !hasWarnedSilence) {
            const toastMsg = i18n.t('toasts.micNotHearing', 'Вас не слышно, проверьте микрофон')
            store.setSystemToast(toastMsg)
            setTimeout(() => {
              const currentStore = useAppStore.getState()
              if (currentStore.systemToast === toastMsg) {
                currentStore.setSystemToast(null)
              }
            }, 4000)
            hasWarnedSilence = true
          }

          const isVoice = avg >= 2.5 || peak >= 7
          if (isVoice) {
            voiceFrames++
            vadSilenceFrames = 0
          } else {
            vadSilenceFrames++
            if (vadSilenceFrames >= 6) voiceFrames = 0
          }
          if (voiceFrames >= 2) lastVoice = Date.now()

          const speaking = (Date.now() - lastVoice) < 400
          if (speaking !== wasSpeaking) {
            wasSpeaking = speaking
            store.setSpeakingStatus(userId, speaking)
            signalRService.setSpeakingState(speaking)
          }
        }

        const timer = setInterval(check, 30)
        this.speakingIntervals.set(userId, { timer, stream, nodes: vadNodes })
      } else {
        let wasSpeaking = false
        let lastSoundAt = 0
        const releaseHoldMs = 200
        const check = () => {
          const pc = this.peerConnections.get(userId)
          if (!pc) return
          const receiver = pc.getReceivers().find(r => r.track && r.track.kind === 'audio')
          if (!receiver) return
          try {
            const syncSources = receiver.getSynchronizationSources()
            if (syncSources && syncSources.length > 0) {
              const latestSource = syncSources[0]
              const currentPlayoutLevel = latestSource.audioLevel
              if (currentPlayoutLevel !== undefined) {
                const now = Date.now()
                if (currentPlayoutLevel > 0.001) lastSoundAt = now
                const isRemoteSpeaking = now - lastSoundAt <= releaseHoldMs
                if (isRemoteSpeaking !== wasSpeaking) {
                  wasSpeaking = isRemoteSpeaking
                  useAppStore.getState().setSpeakingStatus(userId, isRemoteSpeaking)
                }
              }
            }
          } catch { }
        }
        const timer = setInterval(check, 20)
        this.speakingIntervals.set(userId, { timer, stream, nodes: [] })
      }
    } catch (e) {
      console.error('[VAD] setup failed', e)
    }
  }

  private clearVAD(userId: string) {
    const entry = this.speakingIntervals.get(userId)
    if (entry) {
      clearInterval(entry.timer)
      entry.nodes.forEach(n => { try { n.disconnect() } catch { } })
      this.speakingIntervals.delete(userId)
    }
    useAppStore.getState().setSpeakingStatus(userId, false)
  }



  private filterAndDeduplicateDevices(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
    const result: MediaDeviceInfo[] = []
    const seenDeviceIds = new Set<string>()

    const validDevices = devices.filter(d =>
      d.deviceId &&
      d.deviceId !== 'default' &&
      d.deviceId !== 'communications'
    )

    const sortedDevices = [...validDevices].sort((a, b) => {
      const aHasPrefix = /^(Default|Communications|По умолчанию|Связь)[\s:\-]+/i.test(a.label || '')
      const bHasPrefix = /^(Default|Communications|По умолчанию|Связь)[\s:\-]+/i.test(b.label || '')
      if (aHasPrefix && !bHasPrefix) return 1
      if (!aHasPrefix && bHasPrefix) return -1
      return 0
    })

    for (const dev of sortedDevices) {
      const rawLabel = dev.label || ''
      const cleanLabel = rawLabel.replace(/^(Default|Communications|По умолчанию|Связь)[\s:\-]+/i, '').trim()
      if (!seenDeviceIds.has(dev.deviceId)) {
        seenDeviceIds.add(dev.deviceId)
        result.push({
          deviceId: dev.deviceId,
          kind: dev.kind,
          label: cleanLabel,
          groupId: dev.groupId,
          toJSON: () => ({ deviceId: dev.deviceId, kind: dev.kind, label: cleanLabel, groupId: dev.groupId })
        } as MediaDeviceInfo)
      }
    }

    return result
  }

  private getDefaultDeviceFingerprint(devices: MediaDeviceInfo[], kind: MediaDeviceKind): string | null {
    const device = devices.find(item => item.kind === kind && item.deviceId === 'default')
    if (!device) return null
    return `${device.groupId}|${device.label}`
  }

  private toAudioDevices(devices: MediaDeviceInfo[]): AudioDevices {
    return {
      inputs: this.filterAndDeduplicateDevices(devices.filter(device => device.kind === 'audioinput')),
      outputs: this.filterAndDeduplicateDevices(devices.filter(device => device.kind === 'audiooutput'))
    }
  }

  public async getAudioDevices(): Promise<AudioDevices> {
    try {
      if (!this.rawStream?.getAudioTracks().some(track => track.readyState === 'live')) {
        await this.startBackgroundMic()
      }
      const devices = await navigator.mediaDevices.enumerateDevices()
      this.defaultInputFingerprint ??= this.getDefaultDeviceFingerprint(devices, 'audioinput')
      this.defaultOutputFingerprint ??= this.getDefaultDeviceFingerprint(devices, 'audiooutput')
      return this.toAudioDevices(devices)
    } catch { return { inputs: [], outputs: [] } }
  }

  public setInputDevice(deviceId: string) { this.currentDeviceId = deviceId }

  public subscribeMicLevel(listener: (db: number) => void): () => void {
    this.micLevelListeners.add(listener)
    listener(this.micLevelDb)
    return () => this.micLevelListeners.delete(listener)
  }

  private stopBackgroundMeter() {
    if (this.micMeterInterval) {
      clearInterval(this.micMeterInterval)
      this.micMeterInterval = null
    }
    if (this.backgroundSource) {
      try { this.backgroundSource.disconnect() } catch { }
      this.backgroundSource = null
    }
    this.backgroundAnalyser = null
    if (this.backgroundContext && this.backgroundContext.state !== 'closed') {
      this.backgroundContext.close().catch(() => { })
    }
    this.backgroundContext = null
  }

  private startBackgroundMeter() {
    this.stopBackgroundMeter()
    if (!this.rawStream?.getAudioTracks().some(track => track.readyState === 'live')) return

    const context = new AudioContext({ latencyHint: 'playback' })
    const source = context.createMediaStreamSource(this.rawStream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0
    source.connect(analyser)
    // Keep the graph alive without sending microphone audio to the speakers.
    const silentOutput = context.createGain()
    silentOutput.gain.value = 0
    analyser.connect(silentOutput)
    silentOutput.connect(context.destination)
    this.backgroundContext = context
    this.backgroundSource = source
    this.backgroundAnalyser = analyser
    if (context.state === 'suspended') context.resume().catch(() => { })

    const samples = new Float32Array(analyser.fftSize)
    let smoothedDb = -100
    this.micMeterInterval = setInterval(() => {
      if (!this.backgroundAnalyser) return
      this.backgroundAnalyser.getFloatTimeDomainData(samples)
      let sumSquares = 0
      for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i]
      const rms = Math.sqrt(sumSquares / samples.length)
      const measuredDb = Math.max(-100, Math.min(0, 20 * Math.log10(Math.max(rms, 0.000001))))
      const smoothing = measuredDb > smoothedDb ? 0.55 : 0.18
      smoothedDb += (measuredDb - smoothedDb) * smoothing
      this.micLevelDb = smoothedDb
      this.micLevelListeners.forEach(listener => listener(smoothedDb))
    }, 50)
  }

  public async startBackgroundMic(deviceId?: string): Promise<boolean> {
    if (deviceId !== undefined) this.currentDeviceId = deviceId
    if (this.rawStream?.getAudioTracks().some(track => track.readyState === 'live')) {
      if (!this.localStream) this.startBackgroundMeter()
      return true
    }

    try {
      const constraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: { ideal: 48000 },
        // Legacy Chromium flags are still honored by some Windows audio paths.
        // Set every adaptive capture processor explicitly to false.
        // @ts-ignore
        googAutoGainControl: false,
        googAutoGainControl2: false,
        googNoiseSuppression: false,
        googNoiseSuppression2: false,
        googTypingNoiseDetection: false,
        googHighpassFilter: false,
        googEchoCancellation: false,
        googEchoCancellation2: false,
        googAudioMirroring: false
      }
      if (this.currentDeviceId && this.currentDeviceId !== 'default') {
        constraints.deviceId = { exact: this.currentDeviceId }
      }
      this.rawStream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
      const settings = this.rawStream.getAudioTracks()[0]?.getSettings()
      this.loadCalibration(settings?.deviceId || this.currentDeviceId)
      this.startBackgroundMeter()
      return true
    } catch (error) {
      console.warn('[WebRTC] Failed to initialize background microphone:', error)
      return false
    }
  }

  public setOutputDevice(deviceId: string) {
    this.currentOutputDeviceId = deviceId || 'default'
    void this.applyOutputDevice()
  }

  public async handleAudioDeviceChange(): Promise<AudioDeviceChangeResult> {
    if (this.deviceChangePromise) return this.deviceChangePromise

    const reconcile = async (): Promise<AudioDeviceChangeResult> => {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const availableInputs = new Set(
        devices.filter(device => device.kind === 'audioinput').map(device => device.deviceId)
      )
      const availableOutputs = new Set(
        devices.filter(device => device.kind === 'audiooutput').map(device => device.deviceId)
      )

      const previousInputFingerprint = this.defaultInputFingerprint
      const previousOutputFingerprint = this.defaultOutputFingerprint
      const nextInputFingerprint = this.getDefaultDeviceFingerprint(devices, 'audioinput')
      const nextOutputFingerprint = this.getDefaultDeviceFingerprint(devices, 'audiooutput')
      this.defaultInputFingerprint = nextInputFingerprint
      this.defaultOutputFingerprint = nextOutputFingerprint

      const selectedInputMissing = this.currentDeviceId !== 'default' && !availableInputs.has(this.currentDeviceId)
      const selectedOutputMissing = this.currentOutputDeviceId !== 'default' && !availableOutputs.has(this.currentOutputDeviceId)
      if (selectedInputMissing) this.currentDeviceId = 'default'
      if (selectedOutputMissing) this.currentOutputDeviceId = 'default'

      const rawTrack = this.rawStream?.getAudioTracks()[0]
      const defaultInput = devices.find(device => device.kind === 'audioinput' && device.deviceId === 'default')
      const capturedGroupId = rawTrack?.getSettings().groupId
      const capturedWrongDefault = this.currentDeviceId === 'default' && Boolean(
        rawTrack && defaultInput?.groupId && capturedGroupId && defaultInput.groupId !== capturedGroupId
      )
      const defaultInputChanged = this.currentDeviceId === 'default' && previousInputFingerprint !== null &&
        nextInputFingerprint !== previousInputFingerprint
      const captureEnded = Boolean(this.rawStream && (!rawTrack || rawTrack.readyState !== 'live'))

      if (this.rawStream && (selectedInputMissing || defaultInputChanged || capturedWrongDefault || captureEnded)) {
        await this.updateSettings(this.currentDeviceId, this.noiseSuppression)
      }

      const defaultOutputChanged = this.currentOutputDeviceId === 'default' &&
        (previousOutputFingerprint === null || nextOutputFingerprint !== previousOutputFingerprint)
      if (selectedOutputMissing || defaultOutputChanged) await this.applyOutputDevice()

      return {
        ...this.toAudioDevices(devices),
        inputDeviceId: this.currentDeviceId,
        outputDeviceId: this.currentOutputDeviceId
      }
    }

    this.deviceChangePromise = reconcile()
    try {
      return await this.deviceChangePromise
    } finally {
      this.deviceChangePromise = null
    }
  }

  private async applyOutputDevice() {
    const audioElement = this.mixAudioElement
    if (!audioElement) return

    const sinkId = this.currentOutputDeviceId === 'default' ? '' : this.currentOutputDeviceId
    const setSinkId = (audioElement as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>
    }).setSinkId

    if (typeof setSinkId === 'function') {
      try {
        await setSinkId.call(audioElement, sinkId)
      } catch (error) {
        console.warn(`[WebRTC] Failed to select output device "${sinkId}"`, error)
        if (sinkId !== '') {
          this.currentOutputDeviceId = 'default'
          try {
            await setSinkId.call(audioElement, '')
          } catch (fallbackError) {
            console.warn('[WebRTC] Failed to select the default output device', fallbackError)
          }
        }
      }
    }

    if (this.outputMixContext?.state === 'suspended') {
      await this.outputMixContext.resume().catch(() => { })
    }
    await audioElement.play().catch(error => {
      console.warn('[WebRTC] mixAudioElement play failed:', error)
    })
  }

  public async calibrateMic(durationMs = 10000, onStarted?: () => void): Promise<CalibrationResult> {
    const wasInActiveSession = Boolean(useAppStore.getState().currentChannelId || useAppStore.getState().currentCallUser)
    if (!this.dfNode || !this.dfNodeReady) {
      await this.startLocalStream()
    }
    try {
      await this.waitForCalibrationReady()
      onStarted?.()
      return await this.calibrateActiveMic(durationMs)
    } finally {
      if (!wasInActiveSession) await this.enterBackgroundMode()
    }
  }

  private async waitForCalibrationReady(timeoutMs = 15000): Promise<void> {
    const startedAt = Date.now()
    while (!this.dfNodeReady && Date.now() - startedAt < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!this.dfNodeReady) {
      throw new Error('Audio processors are not ready')
    }
  }

  private calibrateActiveMic(durationMs = 10000): Promise<CalibrationResult> {
    return new Promise((resolve, reject) => {
      if (!this.dfNode || !this.dfNodeReady) {
        reject(new Error('Audio processors are not ready'))
        return
      }
      if (this.calibrationInProgress) {
        reject(new Error('Microphone calibration is already running'))
        return
      }
      if (!this.rawStream?.getAudioTracks().some(track => track.readyState === 'live' && track.enabled)) {
        reject(new Error('Microphone is muted or unavailable'))
        return
      }

      const previousProfile = {
        noiseFloor: this.calibratedNoiseFloor,
        attenuationLimit: this.calibratedAttenuationLimit,
        preGainDb: this.calibratedPreGainDb,
        vadOnThreshold: this.calibratedVadOnThreshold,
        vadOffThreshold: this.calibratedVadOffThreshold,
        hasVoiceCalibration: this.hasVoiceCalibration
      }
      const previousInputGain = this.inputGainNode?.gain.value ?? this.inputVolumeToGain(this.inputVolume)
      const restoreInputGain = () => {
        if (this.inputGainNode) this.inputGainNode.gain.value = previousInputGain
      }
      const restorePreviousProfile = () => {
        restoreInputGain()
        this.calibratedNoiseFloor = previousProfile.noiseFloor
        this.calibratedAttenuationLimit = previousProfile.attenuationLimit
        this.calibratedPreGainDb = previousProfile.preGainDb
        this.calibratedVadOnThreshold = previousProfile.vadOnThreshold
        this.calibratedVadOffThreshold = previousProfile.vadOffThreshold
        this.hasVoiceCalibration = previousProfile.hasVoiceCalibration
        if (this.calibratedPreGainNode) {
          this.calibratedPreGainNode.gain.value = Math.pow(10, previousProfile.preGainDb / 20)
        }
        this.updateThresholds()
      }
      this.calibrationInProgress = true
      this.calibratedPreGainDb = 0
      if (this.inputGainNode) this.inputGainNode.gain.value = 1
      if (this.calibratedPreGainNode) this.calibratedPreGainNode.gain.value = 1
      this.updateThresholds()
      this.dfNode.port.postMessage({ type: 'setCalibratedParams', gainFactor: 1 })
      const timeout = window.setTimeout(() => {
        this.calibrationInProgress = false
        this.dfNode?.port.removeEventListener('message', messageHandler)
        restorePreviousProfile()
        reject(new Error('Microphone calibration timed out'))
      }, durationMs + 3000)

      const messageHandler = (e: MessageEvent) => {
        if (e.data.type === 'calibrationResult') {
          window.clearTimeout(timeout)
          this.calibrationInProgress = false
          this.dfNode?.port.removeEventListener('message', messageHandler)
          const noiseFloor = Number(e.data.noiseFloor)
          const lowNoise = Number(e.data.lowNoise)
          const peakNoise = Number(e.data.peakNoise)
          const zeroCrossingRate = Number(e.data.zeroCrossingRate)
          const spectralTilt = Number(e.data.spectralTilt)
          const acceptedFrames = Number(e.data.acceptedFrames) || 0
          const rejectedSpeechFrames = Number(e.data.rejectedSpeechFrames) || 0
          const totalFrames = acceptedFrames + rejectedSpeechFrames

          if (!Number.isFinite(noiseFloor) || noiseFloor <= 0 || !Number.isFinite(lowNoise) || lowNoise <= 0 ||
            !Number.isFinite(peakNoise) || peakNoise <= 0 || !Number.isFinite(zeroCrossingRate) ||
            !Number.isFinite(spectralTilt) || acceptedFrames < 20) {
            console.warn('[WebRTC] Calibration rejected: insufficient noise samples', { acceptedFrames, rejectedSpeechFrames, totalFrames })
            restorePreviousProfile()
            reject(new Error('Too much speech or insufficient noise samples during calibration'))
            return
          }

          const dbNoise = 20 * Math.log10(Math.max(1e-5, noiseFloor))
          const stationarityRatio = peakNoise / Math.max(1e-5, lowNoise)
          const speechRms = Number(e.data.speechRms)
          const quietSpeechRms = Number(e.data.quietSpeechRms)
          const speechPeak = Number(e.data.speechPeak)
          const noiseVadHigh = Number(e.data.noiseVadHigh)
          const speechVadLow = Number(e.data.speechVadLow)
          const speechVadMedian = Number(e.data.speechVadMedian)
          const speechVadFrames = Number(e.data.speechVadFrames) || 0
          const speechFrames = Number(e.data.speechFrames) || 0
          // A transient peak in the room must not invalidate a spoken phrase.
          // Compare speech only with the robust noise floor, not peakNoise.
          const minimumSpeechPeak = Math.max(noiseFloor * 1.01, 0.0002)
          if (!Number.isFinite(speechRms) || !Number.isFinite(quietSpeechRms) || !Number.isFinite(speechPeak) ||
            !Number.isFinite(noiseVadHigh) || !Number.isFinite(speechVadLow) || !Number.isFinite(speechVadMedian) ||
            speechRms <= 0 || speechPeak < minimumSpeechPeak || speechFrames < 1) {
            restorePreviousProfile()
            reject(new Error('No speech detected'))
            return
          }

          const vadThresholds = speechVadFrames >= 6
            ? this.calculateVadThresholds(noiseVadHigh, speechVadLow, speechVadMedian)
            : { vadOnThreshold: SAFE_VAD_ON_THRESHOLD, vadOffThreshold: SAFE_VAD_OFF_THRESHOLD }

          const speechDb = 20 * Math.log10(Math.max(1e-5, speechRms))
          const snrDb = speechDb - dbNoise
          const attenuationLimit = this.calculateSpeechPreservingAttenuation(
            noiseFloor,
            speechRms,
            quietSpeechRms,
            stationarityRatio,
            speechVadFrames
          )
          const quietSpeechDb = 20 * Math.log10(Math.max(1e-5, quietSpeechRms))
          const quietSnrDb = quietSpeechDb - dbNoise
          console.info('[WebRTC] Calibration suppression profile', {
            noiseDbfs: Number(dbNoise.toFixed(1)),
            speechDbfs: Number(speechDb.toFixed(1)),
            quietSpeechDbfs: Number(quietSpeechDb.toFixed(1)),
            snrDb: Number(snrDb.toFixed(1)),
            quietSnrDb: Number(quietSnrDb.toFixed(1)),
            stationarityRatio: Number(stationarityRatio.toFixed(2)),
            speechVadFrames,
            attenuationLimitDb: attenuationLimit,
            availableRangeDb: `${DEEPFILTER_MIN_ATTEN}-${DEEPFILTER_MAX_ATTEN}`
          })
          console.info(
            `[WebRTC] Calibration result: noise=${dbNoise.toFixed(1)}dBFS, ` +
            `speech=${speechDb.toFixed(1)}dBFS, quietSpeech=${quietSpeechDb.toFixed(1)}dBFS, ` +
            `SNR=${snrDb.toFixed(1)}dB, quietSNR=${quietSnrDb.toFixed(1)}dB, ` +
            `stationarity=${stationarityRatio.toFixed(2)}, SileroFrames=${speechVadFrames}, ` +
            `attenuation=${attenuationLimit}dB`
          )
          const peakDb = 20 * Math.log10(Math.max(1e-5, speechPeak))
          const desiredPreGainDb = -24 - speechDb
          const peakLimitedGainDb = -12 - peakDb
          // Calibration may lift a quiet microphone, but must never turn the user
          // down because the prompted phrase happened to be louder than normal.
          const preGainDb = Math.max(0, Math.min(3, Math.min(desiredPreGainDb, peakLimitedGainDb)))

          restoreInputGain()
          this.calibratedNoiseFloor = noiseFloor
          this.calibratedAttenuationLimit = attenuationLimit
          this.calibratedPreGainDb = preGainDb
          this.calibratedVadOnThreshold = vadThresholds.vadOnThreshold
          this.calibratedVadOffThreshold = vadThresholds.vadOffThreshold
          this.hasVoiceCalibration = true
          if (this.calibratedPreGainNode) this.calibratedPreGainNode.gain.value = Math.pow(10, preGainDb / 20)
          this.updateThresholds()
          console.info('[WebRTC] DeepFilter calibrated params requested', {
            attenuationLimitDb: this.getThresholdParams(1).attenuationLimit,
            postFilterBeta: 0,
            thresholdMode: this.thresholdMode,
            vadOnThreshold: Number(this.calibratedVadOnThreshold.toFixed(4)),
            vadOffThreshold: Number(this.calibratedVadOffThreshold.toFixed(4)),
            preGainDb: Number(preGainDb.toFixed(2))
          })

          try {
            const profile: StoredEnvironmentProfile = {
              version: WebRTCManager.CALIBRATION_SCHEMA_VERSION,
              timestamp: Date.now(),
              noiseFloor,
              lowNoise,
              peakNoise,
              attenuationLimit,
              speechRms,
              quietSpeechRms,
              speechPeak,
              speechFrames,
              snrDb,
              noiseVadHigh,
              speechVadLow,
              speechVadMedian,
              preGainDb,
              zeroCrossingRate,
              spectralTilt
            }
            const profiles = this.readEnvironmentProfiles()
              .filter(existing => this.environmentDistance(
                existing,
                noiseFloor,
                lowNoise,
                peakNoise,
                zeroCrossingRate,
                spectralTilt
              ) > 3)
            profiles.push(profile)
            profiles.sort((a, b) => b.timestamp - a.timestamp)
            localStorage.setItem(this.calibrationStorageKey(this.calibrationDeviceId), JSON.stringify({
              version: WebRTCManager.CALIBRATION_SCHEMA_VERSION,
              deviceId: this.calibrationDeviceId,
              profiles: profiles.slice(0, 6)
            }))
          } catch (e) {
            console.error('Failed to save calibration data', e)
          }

          resolve({
            noiseFloor,
            lowNoise,
            peakNoise,
            attenuationLimit,
            speechRms,
            quietSpeechRms,
            speechPeak,
            speechFrames,
            noiseVadHigh,
            speechVadLow,
            speechVadMedian,
            speechVadFrames,
            zeroCrossingRate,
            spectralTilt,
            acceptedFrames,
            rejectedSpeechFrames
          })
        }
      }

      this.dfNode.port.addEventListener('message', messageHandler)
      this.dfNode.port.start()

      this.dfNode.port.postMessage({
        type: 'startCalibration',
        durationMs
      })
    })
  }

  public async prewarmLocalStream(): Promise<boolean> {
    if (this.localStream && this.localStream.getAudioTracks().length > 0 && this.localStream.getAudioTracks().every(t => t.readyState === 'live')) {
      return true
    }
    return this.startLocalStream(undefined, undefined, false)
  }

  public async startLocalStream(deviceId?: string, useNS?: boolean, forceRestart = false): Promise<boolean> {
    if (deviceId !== undefined) this.currentDeviceId = deviceId
    if (useNS !== undefined) this.noiseSuppression = useNS

    if (this.activeStartPromise) {
      return this.activeStartPromise
    }

    const run = async () => {
      if (!forceRestart && this.localStream && this.localStream.getAudioTracks().length > 0 && this.localStream.getAudioTracks().every(t => t.readyState === 'live')) {
        const me = useAppStore.getState().currentUser
        if (me && this.rawStream && !this.speakingIntervals.has(me.id)) {
          this.setupVAD(this.rawStream, me.id, true)
        }
        return true
      }

      try {
        this.initOutputMixer()
        this.stopBackgroundMeter()
        if (forceRestart && this.rawStream) { this.rawStream.getTracks().forEach(t => t.stop()); this.rawStream = null }
        if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null }
        this.cleanupProcessedStream()

        let raw = this.rawStream
        if (!raw?.getAudioTracks().some(track => track.readyState === 'live')) try {
          const constraints: MediaTrackConstraints = {
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: { ideal: 48000 },
            // @ts-ignore
            googAutoGainControl: false,
            googAutoGainControl2: false,
            googNoiseSuppression: false,
            googNoiseSuppression2: false,
            googTypingNoiseDetection: false,
            googHighpassFilter: false,
            googEchoCancellation: false,
            googEchoCancellation2: false,
            googAudioMirroring: false
          }
          if (this.currentDeviceId && this.currentDeviceId !== 'default') {
            constraints.deviceId = { exact: this.currentDeviceId }
          }
          raw = await navigator.mediaDevices.getUserMedia({
            audio: constraints,
            video: false
          })
        } catch {
          this.currentDeviceId = 'default'
          try {
            const devices = await navigator.mediaDevices.enumerateDevices()
            const audioInputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId)
            if (audioInputs.length > 0) {
              const firstDevice = audioInputs.find(d => d.deviceId === 'default') || audioInputs[0]
              raw = await navigator.mediaDevices.getUserMedia({
                audio: {
                  deviceId: { exact: firstDevice.deviceId },
                  channelCount: 1,
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                  sampleRate: { ideal: 48000 },
                  // @ts-ignore
                  googAutoGainControl: false,
                  googAutoGainControl2: false,
                  googNoiseSuppression: false,
                  googNoiseSuppression2: false,
                  googTypingNoiseDetection: false,
                  googHighpassFilter: false,
                  googEchoCancellation: false,
                  googEchoCancellation2: false,
                  googAudioMirroring: false
                },
                video: false
              })
            } else {
              throw new Error('No audio input devices found')
            }
          } catch {
            try {
              raw = await navigator.mediaDevices.getUserMedia({
                audio: {
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                  sampleRate: { ideal: 48000 },
                  // @ts-ignore
                  googAutoGainControl: false,
                  googAutoGainControl2: false,
                  googNoiseSuppression: false,
                  googNoiseSuppression2: false,
                  googTypingNoiseDetection: false,
                  googHighpassFilter: false,
                  googEchoCancellation: false,
                  googEchoCancellation2: false,
                  googAudioMirroring: false
                },
                video: false
              })
            } catch {
              // Never fall back to `audio: true`: Chromium may silently enable
              // AGC, echo cancellation and browser noise suppression, causing the
              // exact real-time level pumping this pipeline is designed to avoid.
              raw = createSilentAudioStream()
            }
          }
        }

        this.rawStream = raw
        const rawTrack = raw.getAudioTracks()[0]
        if (rawTrack) {
          rawTrack.contentHint = 'speech'
          const settings = rawTrack.getSettings()
          this.loadCalibration(settings.deviceId || this.currentDeviceId, rawTrack.label)
          console.info('[WebRTC] Microphone settings', {
            deviceId: settings.deviceId,
            sampleRate: settings.sampleRate,
            channelCount: settings.channelCount,
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: settings.autoGainControl
          })
        }

        this.localStream = await this.createProcessedStream(raw)

        const localTrack = this.localStream.getAudioTracks()[0]
        if (localTrack) {
          // The track has already passed Silero and DeepFilter. Preserve its
          // full-band timbre instead of asking WebRTC to apply speech-oriented
          // encoder heuristics to an already cleaned signal.
          localTrack.contentHint = 'music'
        }

        if (this.processedContext && this.processedContext.state === 'suspended') {
          await this.processedContext.resume().catch(() => { })
        }

        this.startSilenceMonitor()

        const me = useAppStore.getState().currentUser
        if (me && this.rawStream && !this.dfNode) this.setupVAD(this.rawStream, me.id, true)

        const isMuted = me?.isMuted || me?.isServerMuted || false
        this.toggleMute(isMuted)

        return true
      } catch (e) {
        throw new Error(`MIC_ACCESS_FAILED: ${(e as Error).message}`)
      }
    }

    this.activeStartPromise = run()
    try {
      return await this.activeStartPromise
    } finally {
      this.activeStartPromise = null
    }
  }

  public async updateSettings(deviceId: string, useNS: boolean) {
    this.currentDeviceId = deviceId
    this.noiseSuppression = useNS

    if (this.localStream) {
      try {
        await this.startLocalStream(deviceId, useNS, true)
        for (const pc of this.peerConnections.values()) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
          const newTrack = this.localStream?.getAudioTracks()[0]
          if (sender && newTrack) {
            await sender.replaceTrack(newTrack).catch(() => { })
            this.configureAudioSender(sender)
          }
        }
      } catch (e) {
        throw e
      }
    } else if (this.rawStream) {
      this.rawStream.getTracks().forEach(track => track.stop())
      this.rawStream = null
      this.stopBackgroundMeter()
      await this.startBackgroundMic(deviceId)
    }
  }

  public stopLocalStream() {
    const me = useAppStore.getState().currentUser
    if (me) this.clearVAD(me.id)
    this.stopSilenceMonitor()
    if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null }
    if (this.rawStream) { this.rawStream.getTracks().forEach(t => t.stop()); this.rawStream = null }
    this.stopBackgroundMeter()
    this.cleanupProcessedStream()
    this.leaveAll()
  }

  public async enterBackgroundMode(): Promise<void> {
    const me = useAppStore.getState().currentUser
    if (me) this.clearVAD(me.id)
    this.stopSilenceMonitor()
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop())
      this.localStream = null
    }
    this.cleanupProcessedStream()
    this.leaveAll()

    if (this.rawStream?.getAudioTracks().some(track => track.readyState === 'live')) {
      this.startBackgroundMeter()
    } else {
      await this.startBackgroundMic()
    }
  }

  private startSilenceMonitor() {
    this.stopSilenceMonitor();
    this.silenceCounterMs = 0;
    this.isSilenceWarningActive = false;

    if (!this.rawAnalyserNode) return;

    const bufferLength = this.rawAnalyserNode.fftSize;
    const dataArray = new Float32Array(bufferLength);

    this.silenceMonitorInterval = setInterval(() => {
      const store = useAppStore.getState();
      const me = store.currentUser;


      if (!me || me.isMuted || me.isServerMuted) {
        this.silenceCounterMs = 0;
        return;
      }

      if (this.rawAnalyserNode) {
        try {
          this.rawAnalyserNode.getFloatTimeDomainData(dataArray);
          let sumSquares = 0;
          for (let i = 0; i < bufferLength; i++) {
            sumSquares += dataArray[i] * dataArray[i];
          }
          const rms = Math.sqrt(sumSquares / bufferLength);


          if (rms < 0.0002) {
            this.silenceCounterMs += 200;
          } else {
            this.silenceCounterMs = 0;
          }

          if (this.silenceCounterMs >= 15000 && !this.isSilenceWarningActive) {
            this.isSilenceWarningActive = true;
            const toastMsg = i18n.t('toasts.micNotHearing', 'Вас не слышно, проверьте микрофон');
            store.setSystemToast(toastMsg);

            setTimeout(() => {
              const currentStore = useAppStore.getState();
              if (currentStore.systemToast === toastMsg) {
                currentStore.setSystemToast(null);
              }
              this.isSilenceWarningActive = false;
            }, 4000);

            this.silenceCounterMs = 0;
          }
        } catch (e) {
          console.warn('[WebRTC] Silence monitor error:', e);
        }
      }
    }, 200);
  }

  private stopSilenceMonitor() {
    if (this.silenceMonitorInterval) {
      clearInterval(this.silenceMonitorInterval);
      this.silenceMonitorInterval = null;
    }
    this.silenceCounterMs = 0;
    this.isSilenceWarningActive = false;
    this.rawAnalyserNode = null;
  }

  public toggleMute(isMuted: boolean) {
    if (this.dfNode) {
      this.dfNode.port.postMessage({ type: 'setConfig', isMuted: isMuted })
    }
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted })
    }
  }

  public setUserVolume(userId: string, volume: number) {
    useAppStore.getState().setUserVolume(userId, Math.max(0, Math.min(200, volume)))
    this.updateRemoteVolume(userId)
  }

  public setUserVolumeRealtime(userId: string, volume: number) {
    const gainNode = this.userGainNodes.get(userId)
    if (gainNode) {
      gainNode.gain.value = Math.max(0, Math.min(4.0, (this.outputVolume / 100) * (Math.max(0, Math.min(200, volume)) / 100)))
    }
  }



  private initOutputMixer() {
    if (this.outputMixContext) {
      if (this.outputMixContext.state === 'suspended') this.outputMixContext.resume().catch(() => { })
      return
    }
    try {
      this.outputMixContext = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    } catch (e) {
      console.warn('[WebRTC] Failed to create outputMixContext at 48000Hz, falling back to default:', e)
      this.outputMixContext = new AudioContext({ latencyHint: 'interactive' })
    }
    if (this.outputMixContext.state === 'suspended') {
      this.outputMixContext.resume().catch(() => { })
    }
    this.outputCompressor = this.outputMixContext.createDynamicsCompressor()


    this.outputCompressor.threshold.value = -3
    this.outputCompressor.knee.value = 6
    this.outputCompressor.ratio.value = 4
    this.outputCompressor.attack.value = 0.005
    this.outputCompressor.release.value = 0.120

    const dest = this.outputMixContext.createMediaStreamDestination()
    this.outputCompressor.connect(dest)

    this.mixAudioElement = new Audio()
    this.mixAudioElement.autoplay = true
    this.mixAudioElement.srcObject = dest.stream
    this.mixAudioElement.muted = this.isDeafened
    void this.applyOutputDevice()
  }

  private setupPeerHandlers(pc: RTCPeerConnection, userId: string) {
    pc.ontrack = (event) => {
      if (userId === useAppStore.getState().currentUser?.id) {
        event.track.stop()
        this.disconnectFromPeer(userId)
        return
      }
      const stream = event.streams[0] || new MediaStream([event.track])
      this.initOutputMixer()

      if (event.track.kind === 'video') {
        useAppStore.getState().setRemoteVideoStream(userId, stream)
        return
      }

      const remoteVideoStream = useAppStore.getState().remoteVideoStreams[userId]
      const isScreenShareAudio = (remoteVideoStream && event.streams[0] && event.streams[0].id === remoteVideoStream.id) ||
        (event.streams[0] && event.streams[0].getVideoTracks().length > 0)

      if (isScreenShareAudio) {
        let dummyAudio = this.streamAudioElements.get(userId)
        if (!dummyAudio) {
          dummyAudio = new Audio()
          dummyAudio.autoplay = true
          dummyAudio.muted = true
          this.streamAudioElements.set(userId, dummyAudio)
        }
        dummyAudio.srcObject = stream
        dummyAudio.play().catch(() => { })

        if (this.streamSourceNodes.has(userId)) {
          try { this.streamSourceNodes.get(userId)?.disconnect() } catch { }
          try { this.streamGainNodes.get(userId)?.disconnect() } catch { }
        }

        const source = this.outputMixContext!.createMediaStreamSource(new MediaStream([event.track]))
        const gain = this.outputMixContext!.createGain()
        source.connect(gain)
        gain.connect(this.outputCompressor!)

        this.streamSourceNodes.set(userId, source)
        this.streamGainNodes.set(userId, gain)
        this.updateRemoteStreamVolume(userId)
      } else {
        this.setupVAD(stream, userId, false)

        let dummyAudio = this.audioElements.get(userId)
        if (!dummyAudio) {
          dummyAudio = new Audio()
          dummyAudio.autoplay = true
          dummyAudio.muted = true
          this.audioElements.set(userId, dummyAudio)
        }
        dummyAudio.srcObject = stream
        dummyAudio.play().catch(() => { })

        if (this.userSourceNodes.has(userId)) {
          try { this.userSourceNodes.get(userId)?.disconnect() } catch { }
          try { this.userGainNodes.get(userId)?.disconnect() } catch { }
        }

        const source = this.outputMixContext!.createMediaStreamSource(new MediaStream([event.track]))
        const gain = this.outputMixContext!.createGain()
        source.connect(gain)
        gain.connect(this.outputCompressor!)

        this.userSourceNodes.set(userId, source)
        this.userGainNodes.set(userId, gain)
        this.updateRemoteVolume(userId)
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) signalRService.sendIceCandidate(userId, JSON.stringify(e.candidate))
    }

    const checkState = () => {
      const st = pc.connectionState
      const iceSt = pc.iceConnectionState

      if (st === 'connected' || iceSt === 'connected' || iceSt === 'completed') {
        useAppStore.getState().setWebRTCConnectionStatus(userId, true)
        this.clearIceTimeout(userId)
        this.retryCount.delete(userId)
        const dcTimer = this.dcTimers.get(userId)
        if (dcTimer) {
          clearTimeout(dcTimer)
          this.dcTimers.delete(userId)
        }
      } else if (st === 'failed' || iceSt === 'failed') {
        useAppStore.getState().setWebRTCConnectionStatus(userId, false)
        void this.attemptRenegotiation(userId)
      } else if (st === 'disconnected' || iceSt === 'disconnected') {
        useAppStore.getState().setWebRTCConnectionStatus(userId, false)
        const existingTimer = this.dcTimers.get(userId)
        if (!existingTimer) {
          const t = setTimeout(() => {
            if (pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected') {
              void this.attemptRenegotiation(userId)
            }
            this.dcTimers.delete(userId)
          }, WebRTCManager.DISCONNECTED_GRACE_MS)
          this.dcTimers.set(userId, t)
        }
      } else {
        useAppStore.getState().setWebRTCConnectionStatus(userId, false)
      }
    }

    pc.onconnectionstatechange = checkState
    pc.oniceconnectionstatechange = checkState
  }

  private startIceTimeout(userId: string) {
    this.clearIceTimeout(userId)
    const timer = setTimeout(() => {
      this.iceTimeoutTimers.delete(userId)
      const pc = this.peerConnections.get(userId)
      if (pc && pc.connectionState !== 'connected') {
        void this.attemptRenegotiation(userId)
      }
    }, WebRTCManager.ICE_TIMEOUT_MS)
    this.iceTimeoutTimers.set(userId, timer)
  }

  private clearIceTimeout(userId: string) {
    const t = this.iceTimeoutTimers.get(userId)
    if (t) { clearTimeout(t); this.iceTimeoutTimers.delete(userId) }
  }

  private async attemptRenegotiation(userId: string) {
    if (this.iceRestartInFlight.has(userId)) return

    const pc = this.peerConnections.get(userId)
    if (!pc || pc.connectionState === 'closed') return

    const me = useAppStore.getState().currentUser?.id
    if (!me) return

    this.iceRestartInFlight.add(userId)
    try {
      const count = this.retryCount.get(userId) ?? 0

      // Give one side priority to avoid simultaneous offers, but let the other
      // side recover independently if the preferred peer is completely offline.
      if (me > userId && count === 0) {
        this.retryCount.set(userId, 1)
        this.startIceTimeout(userId)
        return
      }

      if (count < WebRTCManager.MAX_ICE_RETRIES) {
        this.retryCount.set(userId, count + 1)
        await this.renegotiatePeer(pc, userId, true)
        this.startIceTimeout(userId)
        return
      }

      // Rebuild only after ICE restarts are exhausted. Preserve the last frame
      // so a transient outage does not close the stream card for the viewer.
      this.disconnectFromPeer(userId, { preserveRemoteVideo: true, preserveRetryState: true })
      this.retryCount.set(userId, 0)
      await this.connectToPeer(userId, true)
    } finally {
      this.iceRestartInFlight.delete(userId)
    }
  }

  public updateRemoteStreamVolume(userId: string) {
    const store = useAppStore.getState()
    const isActive = store.activeStreamId === userId
    const vol = isActive ? (store.streamVolumes[userId] ?? 100) : 0
    const gainNode = this.streamGainNodes.get(userId)
    if (gainNode) {
      gainNode.gain.value = Math.max(0, Math.min(4.0, (this.outputVolume / 100) * (vol / 100)))
    }
  }

  public setStreamVolumeRealtime(userId: string, volume: number) {
    const store = useAppStore.getState()
    const isActive = store.activeStreamId === userId
    const gainNode = this.streamGainNodes.get(userId)
    if (gainNode) {
      const vol = isActive ? volume : 0
      gainNode.gain.value = Math.max(0, Math.min(4.0, (this.outputVolume / 100) * (Math.max(0, Math.min(200, vol)) / 100)))
    }
  }

  private async startIsolatedStreamAudio(sourceId: string): Promise<MediaStreamTrack> {
    this.stopIsolatedStreamAudio()

    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    if (context.sampleRate !== 48000) {
      await context.close().catch(() => { })
      throw new Error(`Stream audio requires 48000Hz, got ${context.sampleRate}Hz`)
    }

    try {
      await context.audioWorklet.addModule(streamAudioProcessorUrl)
      const node = new AudioWorkletNode(context, 'stream-audio-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      })
      const destination = context.createMediaStreamDestination()
      node.connect(destination)

      this.streamCaptureContext = context
      this.streamCaptureNode = node
      this.streamCaptureDestination = destination
      this.removeStreamAudioListener = window.windowControls.onStreamAudioData((data, metadata) => {
        if (metadata.sampleRate !== 48000 || metadata.bitsPerSample !== 32 || !metadata.isFloat) {
          console.warn('[WebRTC] Unsupported native stream audio format:', metadata)
          return
        }

        const copy = new Uint8Array(data.byteLength)
        copy.set(data)
        node.port.postMessage({
          type: 'audio',
          buffer: copy.buffer,
          channels: metadata.channels
        }, [copy.buffer])
      })

      await window.windowControls.startStreamAudioCapture(sourceId)
      if (context.state === 'suspended') await context.resume()

      const track = destination.stream.getAudioTracks()[0]
      if (!track) throw new Error('Native stream audio track was not created')
      track.contentHint = 'music'
      return track
    } catch (error) {
      this.stopIsolatedStreamAudio()
      throw error
    }
  }

  private stopIsolatedStreamAudio() {
    const wasCapturing = this.removeStreamAudioListener !== null
    this.removeStreamAudioListener?.()
    this.removeStreamAudioListener = null

    if (wasCapturing) void window.windowControls.stopStreamAudioCapture().catch(() => { })
    if (this.streamCaptureNode) {
      try { this.streamCaptureNode.disconnect() } catch { }
    }
    this.streamCaptureNode = null
    this.streamCaptureDestination?.stream.getTracks().forEach(track => track.stop())
    this.streamCaptureDestination = null
    if (this.streamCaptureContext && this.streamCaptureContext.state !== 'closed') {
      this.streamCaptureContext.close().catch(() => { })
    }
    this.streamCaptureContext = null
  }

  public async startScreenShare(sourceId: string, quality: 'high' | 'low' | 'camera', includeAudio: boolean) {
    this.currentStreamQuality = quality
    if (this.localVideoStream) {
      this.stopScreenShare()
    }
    const width = quality === 'high' ? 1920 : 1280
    const height = quality === 'high' ? 1080 : 720
    const frameRate = quality === 'high' ? 60 : 30

    try {
      let constraints: MediaStreamConstraints
      const isCamera = sourceId.startsWith('camera:')

      if (isCamera) {
        const deviceId = sourceId.slice(7)
        constraints = {
          video: {
            deviceId: deviceId ? { exact: deviceId } : undefined
          },
          audio: false
        }
      } else {
        constraints = {
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxWidth: width,
              maxHeight: height,
              maxFrameRate: frameRate
            }
          } as any
        }
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints)
      } catch (err) {
        if (constraints.audio) {
          delete constraints.audio
          stream = await navigator.mediaDevices.getUserMedia(constraints)
        } else {
          throw err
        }
      }

      this.localVideoStream = stream
      const videoTrack = stream.getVideoTracks()[0]
      let audioTrack: MediaStreamTrack | undefined
      if (includeAudio && !isCamera) {
        audioTrack = await this.startIsolatedStreamAudio(sourceId)
        stream.addTrack(audioTrack)
      }

      if (videoTrack) {
        videoTrack.contentHint = 'motion'
      }



      for (const [userId, pc] of this.peerConnections.entries()) {
        if (videoTrack) {
          const sender = pc.addTrack(videoTrack, stream)
          try {
            if (!isCamera) {
              (sender as any).degradationPreference = 'maintain-resolution'
              const params = sender.getParameters()
              if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
              params.encodings[0].maxBitrate = quality === 'high' ? 6000000 : 2500000
              params.encodings[0].maxFramerate = quality === 'high' ? 60 : 30
              params.encodings[0].networkPriority = 'high'
              sender.setParameters(params).catch(() => { })
            }
          } catch { }
        }
        if (audioTrack) this.configureAudioSender(pc.addTrack(audioTrack, stream))
        await this.renegotiatePeer(pc, userId)
      }

      this.startStatsMonitoring()
      return true
    } catch (e) {
      this.stopScreenShare()
      throw e
    }
  }

  public stopScreenShare() {
    this.stopIsolatedStreamAudio()
    if (this.statsInterval) {
      clearInterval(this.statsInterval)
      this.statsInterval = null
    }
    if (this.localVideoStream) {
      this.localVideoStream.getTracks().forEach(track => {
        track.enabled = false
        track.stop()
      })
      this.localVideoStream = null
    }
    for (const [userId, pc] of this.peerConnections.entries()) {
      const senders = pc.getSenders()
      senders.forEach(sender => {
        if (sender.track && (sender.track.kind === 'video' || (sender.track.kind === 'audio' && sender.track !== this.localStream?.getAudioTracks()[0]))) {
          pc.removeTrack(sender)
        }
      })
      this.renegotiatePeer(pc, userId).catch(() => { })
    }
    this.lastPacketsLost.clear()
  }

  private async renegotiatePeer(pc: RTCPeerConnection, userId: string, iceRestart = false): Promise<boolean> {
    try {
      if (pc.signalingState !== 'stable') {
        this.pendingRenegotiation.add(userId)
        return false
      }
      this.pendingRenegotiation.delete(userId)
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined)
      const optimizedSDP = optimizeSDP(offer.sdp!)
      await pc.setLocalDescription({ type: 'offer', sdp: optimizedSDP })
      signalRService.sendWebRTCOffer(userId, JSON.stringify(pc.localDescription))
      return true
    } catch (e) {
      console.error('[WebRTC] renegotiation failed', e)
      return false
    }
  }

  private flushPendingRenegotiation(userId: string) {
    if (!this.pendingRenegotiation.has(userId)) return
    const pc = this.peerConnections.get(userId)
    if (!pc || pc.signalingState !== 'stable') return
    this.pendingRenegotiation.delete(userId)
    void this.renegotiatePeer(pc, userId)
  }

  private startStatsMonitoring() {
    if (this.statsInterval) clearInterval(this.statsInterval)
    this.statsInterval = setInterval(async () => {
      if (this.currentStreamQuality === 'camera') return
      for (const [userId, pc] of this.peerConnections.entries()) {
        if (pc.connectionState !== 'connected') continue
        try {
          const stats = await pc.getStats()
          let rawPacketsLost = 0
          let rtt = 0
          let framesDropped = 0

          stats.forEach(report => {
            if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
              rawPacketsLost = report.packetsLost || 0
              rtt = report.roundTripTime || 0
            }
            if (report.type === 'outbound-rtp' && report.kind === 'video') {
              framesDropped = report.framesDropped || 0
            }
          })

          const prevLost = this.lastPacketsLost.get(userId) ?? 0
          this.lastPacketsLost.set(userId, rawPacketsLost)
          const packetsLost = Math.max(0, rawPacketsLost - prevLost)

          const sender = pc.getSenders().find(s => s.track?.kind === 'video')
          if (sender) {
            const params = sender.getParameters()
            if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
            let changed = false

            const isHigh = this.currentStreamQuality === 'high'

            if (params.encodings[0].priority !== 'medium') {
              params.encodings[0].priority = 'medium'
              changed = true
            }

            let targetScale = 1.0
            let targetBitrate = isHigh ? 6000000 : 2500000
            let targetFramerate = isHigh ? 60 : 30

            if (packetsLost > 6 || rtt > 0.28) {
              targetScale = 2.0
              targetBitrate = isHigh ? 800000 : 400000
              targetFramerate = isHigh ? 20 : 15
            } else if (packetsLost > 3 || rtt > 0.18) {
              targetScale = 1.0
              targetBitrate = isHigh ? 1800000 : 700000
              targetFramerate = isHigh ? 30 : 20
            } else if (packetsLost > 1 || rtt > 0.10) {
              targetScale = 1.0
              targetBitrate = isHigh ? 3000000 : 1200000
              targetFramerate = isHigh ? 60 : 30
            }

            if (
              params.encodings[0].scaleResolutionDownBy !== targetScale ||
              params.encodings[0].maxBitrate !== targetBitrate ||
              params.encodings[0].maxFramerate !== targetFramerate
            ) {
              params.encodings[0].scaleResolutionDownBy = targetScale
              params.encodings[0].maxBitrate = targetBitrate
              params.encodings[0].maxFramerate = targetFramerate
              changed = true
            }

            if (changed) {
              await sender.setParameters(params)
            }
          }

          if (framesDropped > 50) {
            const store = useAppStore.getState()
            const toastMsg = i18n.t('toasts.streamPerfIssue', 'Проблемы с производительностью, рекомендуется снизить качество')
            store.setSystemToast(toastMsg)
            setTimeout(() => {
              if (store.systemToast === toastMsg) {
                store.setSystemToast(null)
              }
            }, 4000)
          }
        } catch (e) {
          console.warn(e)
        }
      }
    }, 2500)
  }

  private configureAudioSender(sender: RTCRtpSender) {
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
      params.encodings[0].maxBitrate = OPUS_AUDIO_BITRATE
      params.encodings[0].networkPriority = 'high'
      params.encodings[0].priority = 'high'
      sender.setParameters(params)
        .then(() => {
          console.info('[WebRTC] Audio sender configured', {
            codec: 'opus/48000 mono',
            maxBitrate: sender.getParameters().encodings?.[0]?.maxBitrate,
            contentHint: sender.track?.contentHint
          })
        })
        .catch(error => console.warn('[WebRTC] Failed to configure audio sender', error))
    } catch (error) {
      console.warn('[WebRTC] Failed to read audio sender parameters', error)
    }
  }

  public async connectToPeer(userId: string, preserveRemoteVideoOnFailure = false) {
    if (userId === useAppStore.getState().currentUser?.id) return
    if (this.peerConnections.has(userId)) return

    if (!this.localStream) {
      await this.startLocalStream().catch(() => { })
    }

    const pc = new RTCPeerConnection(this.config)
    this.peerConnections.set(userId, pc)

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, this.localStream!)
        if (track.kind === 'audio') {
          this.configureAudioSender(sender)
        }
      })
    }
    if (this.localVideoStream) {
      this.localVideoStream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, this.localVideoStream!)
        if (track.kind === 'video') {
          try {
            const isCamera = this.currentStreamQuality === 'camera'
            if (!isCamera) {
              (sender as any).degradationPreference = 'maintain-resolution'
              const params = sender.getParameters()
              if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
              params.encodings[0].maxBitrate = this.currentStreamQuality === 'high' ? 6000000 : 2500000
              params.encodings[0].maxFramerate = this.currentStreamQuality === 'high' ? 60 : 30
              params.encodings[0].networkPriority = 'high'
              sender.setParameters(params).catch(() => { })
            }
          } catch { }
        } else if (track.kind === 'audio') {
          this.configureAudioSender(sender)
        }
      })
    }

    this.setupPeerHandlers(pc, userId)
    this.startIceTimeout(userId)

    try {
      const offer = await pc.createOffer()
      const optimizedSDP = optimizeSDP(offer.sdp!)
      await pc.setLocalDescription({ type: 'offer', sdp: optimizedSDP })
      signalRService.sendWebRTCOffer(userId, JSON.stringify(pc.localDescription))
    } catch (e) {
      console.error('[WebRTC] connectToPeer failed', e)
      if (preserveRemoteVideoOnFailure) {
        this.startIceTimeout(userId)
      } else {
        this.disconnectFromPeer(userId)
      }
    }
  }

  public async handleOffer(senderId: string, offerStr: string) {
    const store = useAppStore.getState()
    if (senderId === store.currentUser?.id) return
    const isIncomingFromSender = store.incomingCall && store.incomingCall.callerId === senderId
    const isActiveCallWithSender = store.currentCallUser && store.currentCallUser.id === senderId
    if (!store.currentChannelId && !isIncomingFromSender && !isActiveCallWithSender) {
      const callStatus = store.callStatus
      if (callStatus !== 'connected') return
    }

    let pc = this.peerConnections.get(senderId)
    if (!pc) {
      if (!this.localStream) {
        await this.startLocalStream().catch(() => { })
      }
      pc = new RTCPeerConnection(this.config)
      this.peerConnections.set(senderId, pc)

      if (this.localStream) {
        this.localStream.getTracks().forEach(track => {
          const sender = pc!.addTrack(track, this.localStream!)
          if (track.kind === 'audio') {
            this.configureAudioSender(sender)
          }
        })
      }
      if (this.localVideoStream) {
        this.localVideoStream.getTracks().forEach(track => {
          const sender = pc!.addTrack(track, this.localVideoStream!)
          if (track.kind === 'video') {
            try {
              const isCamera = this.currentStreamQuality === 'camera'
              if (!isCamera) {
                (sender as any).degradationPreference = 'maintain-resolution'
                const params = sender.getParameters()
                if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
                params.encodings[0].maxBitrate = this.currentStreamQuality === 'high' ? 6000000 : 2500000
                params.encodings[0].maxFramerate = this.currentStreamQuality === 'high' ? 60 : 30
                params.encodings[0].networkPriority = 'high'
                sender.setParameters(params).catch(() => { })
              }
            } catch { }
          } else if (track.kind === 'audio') {
            this.configureAudioSender(sender)
          }
        })
      }

      this.setupPeerHandlers(pc, senderId)
      this.startIceTimeout(senderId)
    }

    try {
      const offer = JSON.parse(offerStr)

      const offerCollision = pc.signalingState !== 'stable'
      if (offerCollision) {
        const me = store.currentUser?.id ?? ''
        const isPolitePeer = me > senderId
        if (!isPolitePeer) return
        await pc.setLocalDescription({ type: 'rollback' })
      }

      await pc.setRemoteDescription(new RTCSessionDescription(offer))
      const answer = await pc.createAnswer()
      const optimizedAnswerSDP = optimizeSDP(answer.sdp!)
      await pc.setLocalDescription({ type: 'answer', sdp: optimizedAnswerSDP })
      await this.drainPendingCandidates(senderId)
      signalRService.sendWebRTCAnswer(senderId, JSON.stringify(pc.localDescription))
      this.flushPendingRenegotiation(senderId)
    } catch (e) {
      console.error('[WebRTC] handleOffer failed', e)
      this.disconnectFromPeer(senderId, { preserveRemoteVideo: true })
      void this.connectToPeer(senderId, true)
    }
  }

  public async handleAnswer(senderId: string, answerStr: string) {
    if (senderId === useAppStore.getState().currentUser?.id) return
    const pc = this.peerConnections.get(senderId)
    if (pc) {
      try {
        const answer = JSON.parse(answerStr)
        await pc.setRemoteDescription(new RTCSessionDescription(answer))
        await this.drainPendingCandidates(senderId)
        this.flushPendingRenegotiation(senderId)
      } catch (e) {
        console.error('[WebRTC] handleAnswer failed', e)
      }
    }
  }

  public async handleIceCandidate(senderId: string, candidateStr: string) {
    if (senderId === useAppStore.getState().currentUser?.id) return
    const pc = this.peerConnections.get(senderId)
    let candidate: RTCIceCandidateInit
    try { candidate = JSON.parse(candidateStr) } catch { return }

    if (!pc) {
      const buf = this.pendingCandidates.get(senderId) ?? []
      buf.push(candidate)
      this.pendingCandidates.set(senderId, buf)
      return
    }

    if (!pc.remoteDescription) {
      const buf = this.pendingCandidates.get(senderId) ?? []
      buf.push(candidate)
      this.pendingCandidates.set(senderId, buf)
      return
    }

    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch { }
  }

  private async drainPendingCandidates(userId: string): Promise<void> {
    const pc = this.peerConnections.get(userId)
    const candidates = this.pendingCandidates.get(userId)
    if (!pc || !candidates || candidates.length === 0) return
    this.pendingCandidates.delete(userId)
    for (const c of candidates) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)) } catch { }
    }
  }

  public disconnectFromPeer(
    userId: string,
    options: { preserveRemoteVideo?: boolean; preserveRetryState?: boolean } = {}
  ) {
    useAppStore.getState().setWebRTCConnectionStatus(userId, false)

    this.clearIceTimeout(userId)
    if (!options.preserveRetryState) this.retryCount.delete(userId)
    const dcTimer = this.dcTimers.get(userId)
    if (dcTimer) { clearTimeout(dcTimer); this.dcTimers.delete(userId) }

    const pc = this.peerConnections.get(userId)
    if (pc) { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.oniceconnectionstatechange = null; pc.close(); this.peerConnections.delete(userId) }

    const audio = this.audioElements.get(userId)
    if (audio) { audio.pause(); audio.srcObject = null; this.audioElements.delete(userId) }

    const source = this.userSourceNodes.get(userId)
    if (source) { try { source.disconnect() } catch { }; this.userSourceNodes.delete(userId) }

    const gain = this.userGainNodes.get(userId)
    if (gain) { try { gain.disconnect() } catch { }; this.userGainNodes.delete(userId) }

    const streamAudio = this.streamAudioElements.get(userId)
    if (streamAudio) { streamAudio.pause(); streamAudio.srcObject = null; this.streamAudioElements.delete(userId) }

    const streamSource = this.streamSourceNodes.get(userId)
    if (streamSource) { try { streamSource.disconnect() } catch { }; this.streamSourceNodes.delete(userId) }

    const streamGain = this.streamGainNodes.get(userId)
    if (streamGain) { try { streamGain.disconnect() } catch { }; this.streamGainNodes.delete(userId) }

    if (!options.preserveRemoteVideo) {
      useAppStore.getState().setRemoteVideoStream(userId, null)
    }

    this.pendingCandidates.delete(userId)
    this.pendingRenegotiation.delete(userId)
    this.clearVAD(userId)
    this.lastPacketsLost.delete(userId)
  }

  public cleanupRemoteStream(userId: string) {
    const streamAudio = this.streamAudioElements.get(userId)
    if (streamAudio) { streamAudio.pause(); streamAudio.srcObject = null; this.streamAudioElements.delete(userId) }

    const streamSource = this.streamSourceNodes.get(userId)
    if (streamSource) { try { streamSource.disconnect() } catch { }; this.streamSourceNodes.delete(userId) }

    const streamGain = this.streamGainNodes.get(userId)
    if (streamGain) { try { streamGain.disconnect() } catch { }; this.streamGainNodes.delete(userId) }

    useAppStore.getState().setRemoteVideoStream(userId, null)
  }

  public leaveAll() {
    this.peerConnections.forEach((_, uid) => this.disconnectFromPeer(uid))
  }
}

export const webrtc = new WebRTCManager()
