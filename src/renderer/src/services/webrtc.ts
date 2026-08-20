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

// DeepFilterNet attenuation limit (dB). In DeepFilterNet this value is a floor
// under the per-band mask, which makes it two things at once: how much noise is
// removed, and how deep the mask is allowed to cut into a band it misjudges. The
// second reading is why it must not simply be maximised - at 35-45 dB the
// network's per-frame uncertainty becomes audible amplitude modulation of the
// voice itself, and speech detail that lives near the noise floor (fricatives,
// breath, word tails) is carried out with the noise. That is heard exactly as
// reported: a voice that dips in and out and sounds flat.
//
// The floor is not a compromise between those two readings, though, because the gate
// in front of this network already delivers absolute silence between phrases. Whatever
// the limit is, it is only ever paid for inside a phrase, where the voice masks the
// texture it costs.
//
// It is deliberately low. A floor's only job is to keep a *measured* room from being
// given absurdly little; it is not a way to add depth, and every dB of it is spent
// blind. 16 dB was an attempt to fix an under-measuring formula by clamping its output,
// which is the wrong place: on a genuinely silent room it forced 16 dB nobody asked
// for, and it hid the fact that the demand below was reading 3.7 dB where it should
// have read 14. The demand is now computed against the voice instead of against an
// absolute level (see ASSUMED_SPEECH_LEVEL_DBFS), so it delivers the deeper value on
// its own and the floor is back to being a floor: 8 dB, which is what a super quiet
// room actually needs, and which no room ever hits unless it really is that quiet.
const DEEPFILTER_MIN_ATTEN = 8
const DEEPFILTER_MAX_ATTEN = 45
// Past this point every extra dB removes less audible noise than it does speech
// detail, so the room level is followed one-for-one below the knee and at half
// rate above it. It doubles as the pre-calibration default: a room nobody has
// measured yet is assumed to sit exactly on the knee.
const SUPPRESSION_SOFT_KNEE_DB = 24
const SUPPRESSION_ABOVE_KNEE_SLOPE = 0.5
const DEEPFILTER_SMART_DEFAULT_ATTEN = SUPPRESSION_SOFT_KNEE_DB
// Manual mode has no adaptive gate behind it: the user's own threshold decides when
// audio passes, and the suppressor's only remaining job is to take the hum and the
// room out of the phrases that do pass. So it is deliberately light and, unlike
// smart mode, fixed rather than calibrated - manual mode exists precisely because
// the user wants the chain to stop deciding things for them. 7 dB is under the
// library's own floor for the adaptive path (DEEPFILTER_MIN_ATTEN) on purpose: at
// this depth the network removes steady broadband noise and leaves speech detail
// untouched, which is exactly the "at least something" the mode was missing.
const DEEPFILTER_MANUAL_ATTEN = 7
// How far under the voice the remains of the room have to sit to be inaudible in a
// call. This is the single knob of the whole chain, and it is a *ratio* rather than an
// absolute level: what a listener hears is the residual relative to the speech it hides
// behind, and the worklet's ALC normalises every speaker to the same output level
// (ALC_TARGET_RMS = 0.1 = -20 dBFS) regardless of how loud they arrived. Writing it as
// an absolute -75 dBFS said the same thing arithmetically but hid the fact that the ALC
// applies up to +24 dB of make-up after the denoiser - which lifts the residual along
// with the voice, so an absolute target is only met at unity gain and is missed by the
// make-up amount on every quiet microphone. 55 dB is inaudible; move toward 50 for a
// more natural voice, toward 60 if noise returns.
const TARGET_SPEECH_TO_NOISE_DB = 55
// The level the ALC normalises speech to, in dBFS. Mirrors ALC_TARGET_RMS in
// deepfilter-processor.ts (0.1 linear); kept here so the demand below can be stated in
// the dBFS the room trackers measure in.
const ALC_TARGET_DBFS = -20
const TARGET_RESIDUAL_NOISE_DBFS = ALC_TARGET_DBFS - TARGET_SPEECH_TO_NOISE_DB
// The one quantity calibration cannot measure and cannot do without. The target above
// is a ratio between the voice and what is left of the room, so answering it needs both
// numbers - and 2.5 s of deliberate silence contains only the room. Treating the room
// level as if it were already at the ALC's output scale was the error behind "sets 8-10
// when the room needs 14": it made a quiet room look like it had met the target
// already, when what it actually had was a quiet room *and* a quiet voice in the same
// proportion.
//
// So the speech level is assumed instead of ignored. -30 dBFS is where a consumer
// microphone at its default capture gain puts an ordinary speaking voice, and the
// worklet's own ALC bounds bracket it: it normalises to -20 dBFS with up to +24 dB of
// make-up, so anything it is built to handle sits between -44 and -20 dBFS. -30 dBFS is
// the middle of that range, and on the measured -71 dBFS room here it yields 14 dB -
// the value the room was independently judged to need.
//
// Being an assumption, it is only ever a seed: the worklet measures the real ratio
// during the first second of speech and takes the limit from here to wherever it
// belongs (refreshAttenuationLimit in deepfilter-processor.ts). What this constant buys
// is starting at roughly the right depth instead of climbing to it at 1 dB/s.
const ASSUMED_SPEECH_LEVEL_DBFS = -30
// Playback make-up for the channel mix. The outgoing side is normalised to the
// standard speech level in the worklet, so this exists for the other direction:
// senders that predate that normalisation, and the gap between a voice at the
// telephony nominal and the streaming loudness a listener is used to from every
// other application. See initOutputMixer for how it pairs with the compressor.
const PLAYBACK_MAKEUP_GAIN_DB = 6
// Opus bitrate for the outgoing mono voice stream. Xiph's own guidance puts fullband
// (48 kHz) mono speech at 28-40 kbps, with 24 kbps already producing full bandwidth -
// Opus is a speech codec first, and voice stops improving long before music does. The
// previous 128 kbps was therefore roughly a 4x overspend that bought nothing audible,
// while costing every participant real upstream on connections that have little of it;
// 64 kbps keeps a 2x margin over the top of Xiph's range, so there is no measurable
// quality question, and halves it again. Note that this is a ceiling, not a rate: with
// cbr=0 the encoder spends what the frame needs and no more.
const OPUS_AUDIO_BITRATE = 64_000
/** Предел одной попытки захвата микрофона. */
const MIC_CAPTURE_TIMEOUT_MS = 10_000
/** Предел загрузки модели Silero по IPC — вписан в общий бюджет инициализации VAD. */
const SILERO_MODEL_LOAD_TIMEOUT_MS = 10_000
/** Предел загрузки ассетов DeepFilter из сети (bundled-путь идёт через IPC). */
const DEEPFILTER_FETCH_TIMEOUT_MS = 15_000
// The gate threshold itself is no longer computed here. It is an adaptive tracker
// inside the worklet, bounded there, and calibration only supplies its starting
// point. This is the seed used before any profile exists.
const DEFAULT_VAD_TRACKER_SEED = 0.05
// A calibration run is 10 ms per frame. Fewer than 20 usable frames means almost
// everything measured was rejected as the user's own voice, so there is no room
// profile to store.
const MIN_CALIBRATION_FRAMES = 20

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
  noiseVadMedian: number
  noiseVadHigh: number
}

type StoredEnvironmentProfile = {
  version: 40
  timestamp: number
  noiseFloor: number
  lowNoise: number
  peakNoise: number
  attenuationLimit: number
  zeroCrossingRate: number
  spectralTilt: number
  noiseVadMedian?: number
  noiseVadHigh?: number
}

type AudioDevices = {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}

type AudioDeviceChangeResult = AudioDevices & {
  inputDeviceId: string
  outputDeviceId: string
}

// Calibration fails for reasons the user can act on: a denied or busy device, an
// audio engine that never started on this machine, speaking during the measuring
// stage. Report them as codes so the UI can name the actual cause instead of
// collapsing every failure into one "try again" message.
export type CalibrationFailureCode =
  | 'CALIBRATION_ENGINE_UNAVAILABLE'
  | 'CALIBRATION_NO_MIC'
  | 'CALIBRATION_BUSY'
  | 'CALIBRATION_TIMEOUT'
  | 'CALIBRATION_NEEDS_SILENCE'

export class CalibrationError extends Error {
  constructor(public readonly code: CalibrationFailureCode, public readonly detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'CalibrationError'
  }
}

// getUserMedia rejects with a DOMException whose `name` carries the diagnosis;
// `message` alone loses it. Keep both so the cause survives every wrapper.
export function describeMediaError(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    const named = error as { name?: string, message?: string }
    return `${named.name || 'Error'}: ${named.message || ''}`.trim()
  }
  return error instanceof Error ? error.message : String(error)
}

export type MicrophoneErrorKind = 'micNoAccess' | 'micBusy' | 'micNotFound' | 'unknown'

// Order matters: check the specific device states before the generic
// MIC_ACCESS_FAILED wrapper, otherwise a busy or missing microphone is always
// reported as a permission problem.
export function classifyMicrophoneError(detail: string): MicrophoneErrorKind {
  if (/NotReadableError|TrackStartError|AbortError/i.test(detail)) return 'micBusy'
  if (/NotFoundError|DevicesNotFoundError|OverconstrainedError/i.test(detail)) return 'micNotFound'
  if (/NotAllowedError|PermissionDeniedError|SecurityError|MIC_ACCESS_FAILED/i.test(detail)) return 'micNoAccess'
  return 'unknown'
}

/**
 * Ограничивает ожидание промиса, у которого нет своего предела. Нужно прежде
 * всего для getUserMedia: при занятом или зависшем аудиодрайвере он не
 * отклоняется вовсе, а вызов ждёт его внутри общего startLocalStream — то есть
 * один зависший захват микрофона запирает вход в канал до перезапуска
 * приложения. Опоздавший результат отдаётся в `onLate`, чтобы пришедший после
 * отказа поток не остался держать устройство.
 */
function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onLate?: (value: T) => void
): Promise<T> {
  let timer: number | undefined
  let timedOut = false
  const guard = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      timedOut = true
      reject(new Error(message))
    }, timeoutMs)
  })
  if (onLate) {
    operation.then(value => { if (timedOut) onLate(value) }).catch(() => { })
  }
  return Promise.race([operation, guard]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer)
  })
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
      // the older SDP bandwidth field, and is derived from the same constant so the
      // two lines cannot drift apart when the bitrate changes (it was hardcoded).
      lines.splice(
        bandwidthInsertIndex,
        0,
        `b=AS:${Math.ceil(OPUS_AUDIO_BITRATE / 1000)}`,
        `b=TIAS:${OPUS_AUDIO_BITRATE}`,
        'a=ptime:20'
      )
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
  // Bumped to 39: profiles stored by 38 measured the room's demand against its median
  // level (p50) and then gave up to 3 dB back as transient relief, so their stored
  // attenuation limit is several dB under what the same room asks for now. Discarding
  // them means an existing user gets the deeper suppression on the next call without
  // having to know that recalibration is what delivers it.
  private static readonly CALIBRATION_SCHEMA_VERSION = 40
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
  /** Каскад HPF перед воркл-ом; хранится, чтобы отцепляться вместе с source. */
  private micRumbleFilters: BiquadFilterNode[] = []
  private calibratedPreGainNode: GainNode | null = null
  private inputGainNode: GainNode | null = null
  private dfNode: AudioWorkletNode | null = null
  private dfNodeReady = false
  // Why the DeepFilter graph is unusable on this machine (worklet module, WASM /
  // ONNX runtime or a non-48 kHz context). Surfaced with the calibration error.
  private dfEngineError: string | null = null
  private lastMicCaptureError: string | null = null
  private lastReportedMicError: string | null = null
  private vadWorker: Worker | null = null


  private calibratedAttenuationLimit = DEEPFILTER_SMART_DEFAULT_ATTEN
  private calibratedNoiseFloor = 0.003
  private calibratedPreGainDb = 0
  // Starting point of the worklet's adaptive threshold tracker, not a threshold.
  private calibratedVadTrackerSeed = DEFAULT_VAD_TRACKER_SEED
  private hasVoiceCalibration = false
  private calibrationDeviceId = 'default'
  private vadWorkerReady = false
  private calibrationInProgress = false
  // Set while calibration runs with the worklet mute lifted, so a muted user is
  // never broadcast as speaking during the run.
  private calibrationSuppressesSpeaking = false
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
  private outputBusGain: GainNode | null = null
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
      { urls: 'stun:stun.twilio.com:3478' }
    ],
    bundlePolicy: 'max-bundle',
    iceCandidatePoolSize: 4
  }

  /**
   * TURN-серверов здесь нет намеренно. Раньше рядом со STUN лежала строка
   * turn:<адрес> с логином и постоянным паролем: она уезжала в каждую сборку, то
   * есть доставалась из установленного клиента за минуту и позволяла кому угодно
   * бессрочно гонять трафик через сервер. Теперь адрес и креды выдаёт хаб на
   * несколько часов и с userId внутри логина, поэтому список склеивается в
   * рантайме — статический STUN плюс то, что пришло с сервера.
   *
   * STUN оставлен в сборке сознательно: он не требует авторизации, и если хаб
   * недоступен, прямые соединения продолжают устанавливаться как раньше.
   */
  private turnServers: RTCIceServer[] = []
  private turnExpiresAt = 0
  private turnUserId: string | null = null
  private turnFetch: Promise<void> | null = null
  private turnRetryAfter = 0

  /** За сколько до истечения кредов идти за новыми. */
  private static readonly TURN_REFRESH_MARGIN_MS = 60 * 60 * 1000
  /** Пауза после неудачи: на старом сервере метода GetIceServers ещё нет, и без
   *  этой паузы клиент дёргал бы хаб на каждом новом peer-соединении. */
  private static readonly TURN_RETRY_COOLDOWN_MS = 30_000

  private async ensureIceServers(): Promise<void> {
    const userId = useAppStore.getState().currentUser?.id ?? null
    const fresh = this.turnServers.length > 0
      && this.turnUserId === userId
      && Date.now() < this.turnExpiresAt - WebRTCManager.TURN_REFRESH_MARGIN_MS
    if (fresh) return
    if (this.turnFetch) return this.turnFetch
    if (Date.now() < this.turnRetryAfter) return

    this.turnFetch = (async () => {
      try {
        const config = await signalRService.fetchIceServers()
        const servers = config?.iceServers?.filter(server => server?.urls?.length) ?? []
        if (servers.length > 0) {
          this.turnServers = servers
          this.turnExpiresAt = config!.expiresAtUnixMs
          this.turnUserId = userId
          this.turnRetryAfter = 0
        } else {
          this.turnRetryAfter = Date.now() + WebRTCManager.TURN_RETRY_COOLDOWN_MS
        }
      } catch {
        this.turnRetryAfter = Date.now() + WebRTCManager.TURN_RETRY_COOLDOWN_MS
      } finally {
        this.turnFetch = null
      }
    })()
    return this.turnFetch
  }

  /** Конфигурация для нового RTCPeerConnection: статический STUN плюс выданный сервером TURN. */
  private rtcConfig(): RTCConfiguration {
    if (this.turnServers.length === 0) return this.config
    return { ...this.config, iceServers: [...(this.config.iceServers ?? []), ...this.turnServers] }
  }



  private getThresholdParams(gainFactor: number) {
    // Manual mode used to be pinned to the library minimum on the theory that the
    // user's own threshold gate does the work, but the gate only decides when audio
    // passes - it cannot clean the audio that does pass, so manual mode was left
    // with audible noise during every phrase. It then followed the calibrated
    // strength with a floor of its own, which was the opposite mistake: the same
    // over-suppression that flattens a voice in smart mode flattened it here, in the
    // one mode whose whole point is that the user is in charge. Now it gets a fixed
    // light pass instead, and only smart mode follows the measured room.
    const activeAttenuationLimit = this.thresholdMode === 'manual'
      ? DEEPFILTER_MANUAL_ATTEN
      : this.calibratedAttenuationLimit
    return {
      attenuationLimit: activeAttenuationLimit,
      noiseFloor: this.calibratedNoiseFloor,
      thresholdMode: this.thresholdMode,
      manualThresholdValue: this.manualThresholdValue,
      vadTrackerSeed: this.calibratedVadTrackerSeed,
      // The neural suppressor is already the spectral processor. Its optional
      // post-filter is disabled to keep quiet consonants and breath texture intact.
      postFilterBeta: 0,
      // VAD and calibration run before all gain nodes, so their thresholds must
      // stay independent of the user's microphone volume and calibrated pre-gain.
      gainFactor: 1,
      // The level control at the end of the worklet needs the opposite: it is
      // followed by nothing but gain, so it has to know how much, or its -1 dBFS
      // ceiling is enforced in the wrong place.
      downstreamGain: gainFactor * Math.pow(10, this.calibratedPreGainDb / 20)
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

  // How much suppression this room needs, in the only terms that mean anything:
  // how far the measured room level has to fall to become inaudible. Everything
  // else is a bounded correction on that one subtraction, and the total then passes
  // through a soft knee - a loud room is deliberately not given everything it asks
  // for, because the attenuation limit is a floor under the mask and the last few
  // dB of cleanliness are taken out of the voice. The version before this one
  // interpolated an abstract "strength" and applied a voice-safety ceiling derived
  // from the calibration phrase, which was inverted with respect to the need and
  // settled near 12 dB out of 100 on this class of laptop; the version after it
  // tracked a -85 dBFS residual one-for-one and overshot into the voice instead.
  //
  // What this produces is a starting point, not the answer. It has to predict a whole
  // call from 2.5 s of silence, and it cannot measure the one quantity that decides
  // the outcome - how far the user's voice sits above their room - so it necessarily
  // guesses. The worklet measures that ratio continuously and takes the limit up from
  // here (see refreshAttenuationLimit in deepfilter-processor.ts). Everything below is
  // therefore aimed at not starting too low, which was the reported symptom.
  private calculateAttenuationFromRoom(
    noiseFloor: number,
    lowNoise: number,
    peakNoise: number,
    noiseVadHigh = 0
  ): {
    attenuationLimit: number, requiredDb: number, speechLikeBonusDb: number,
    transientReliefDb: number, demandDb: number, shapedDb: number, roomDbfs: number
  } {
    const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
    // The reference is a high percentile of the room, not its median. noiseFloor is
    // the p50 of the calibration window, and a p50 describes the room's quiet half:
    // what a listener calls "the noise in this room" is the level it keeps returning
    // to at its top, which for a fan, a fridge or street traffic is 3-8 dB higher.
    // Demanding suppression against the median therefore under-delivers by exactly
    // that margin - the reported "sets 10 when the noise is at 13". peakNoise (p95) is
    // already measured for the stationarity ratio below; 6 dB under it is a robust
    // stand-in for p90 that does not chase a single burst, and the max() keeps a
    // perfectly steady room on its own median.
    const roomDbfs = Math.max(
      20 * Math.log10(Math.max(1e-5, noiseFloor)),
      20 * Math.log10(Math.max(1e-5, peakNoise)) - 6
    )
    // Stated as an SNR shortfall, which is what the target actually is: how far the
    // room sits under an ordinary voice today, and how much of the difference between
    // that and TARGET_SPEECH_TO_NOISE_DB the denoiser has to make up. The subtraction
    // it replaces (room minus an absolute residual level) is the same arithmetic with
    // the voice term dropped, and dropping it is what made a quiet room ask for
    // nothing: at -71 dBFS it demanded 3.7 dB, where the honest answer against a
    // -30 dBFS voice is 14 dB. A noisy -55 dBFS room now asks for 30 dB and receives
    // 27 after the knee, instead of the 20 the old form produced.
    const measuredSnrDb = ASSUMED_SPEECH_LEVEL_DBFS - roomDbfs
    const requiredDb = TARGET_SPEECH_TO_NOISE_DB - measuredSnrDb

    // Speech-shaped background - a television, a conversation down the corridor -
    // opens the gate on its own, so it has to be pushed further down than steady
    // noise the gate already keeps out: 0 dB at noiseVadHigh <= 0.25, +5 dB at 0.70.
    const speechLikeBonusDb = 5 * clamp01((noiseVadHigh - 0.25) / 0.45)
    // Impulsive noise (typing, clicks) at maximum attenuation produces pumping
    // rather than cleanliness, because the network re-estimates on every burst. This
    // used to be worth up to 3 dB, and on a room with a keyboard in it that was the
    // difference between a demand of 13 and a delivered 10: a whole session of
    // shallower suppression to avoid an artefact on the impulses themselves. The
    // impulses are now rejected upstream, at the gate, by the transient detector in
    // deepfilter-processor.ts - they never reach the stream at all, so there is
    // nothing left to pump. 1 dB remains for the burst that arrives inside a phrase,
    // where the gate is already open and only the network is deciding.
    const stationarity = peakNoise / Math.max(1e-5, lowNoise)
    const transientReliefDb = clamp01((stationarity - 6) / 6)

    // The knee shapes the demand, because the demand is paid for by the voice. The
    // transient relief is a safety subtraction rather than a demand, so it applies
    // in full afterwards.
    const demandDb = requiredDb + speechLikeBonusDb
    const shapedDb = demandDb <= SUPPRESSION_SOFT_KNEE_DB
      ? demandDb
      : SUPPRESSION_SOFT_KNEE_DB + (demandDb - SUPPRESSION_SOFT_KNEE_DB) * SUPPRESSION_ABOVE_KNEE_SLOPE

    // The seed is bounded on both sides, and the upper bound is the knee rather than
    // DEEPFILTER_MAX_ATTEN on purpose. Being a guess about the voice, this number can be
    // wrong in either direction, and the two errors do not cost the same: the worklet
    // raises the limit when it measures a worse ratio than assumed, but it never lowers
    // it, so an over-generous seed is paid for by the voice for the rest of the session
    // while a modest one is corrected within seconds. Capping it at the knee - which is
    // also the value used for a room nobody has measured at all
    // (DEEPFILTER_SMART_DEFAULT_ATTEN) - means measuring a room can lower the starting
    // point or confirm it, and only a *measured* ratio ever takes it above the knee.
    const attenuationLimit = Math.max(DEEPFILTER_MIN_ATTEN, Math.min(
      SUPPRESSION_SOFT_KNEE_DB,
      Math.round(shapedDb - transientReliefDb)
    ))
    return { attenuationLimit, requiredDb, speechLikeBonusDb, transientReliefDb, demandDb, shapedDb, roomDbfs }
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
    this.calibratedVadTrackerSeed = DEFAULT_VAD_TRACKER_SEED
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
      // The room's own 95th Silero percentile is where the worklet's tracker would
      // have converged anyway. Handing it over means the first second after joining
      // is already calibrated instead of climbing from the floor.
      this.calibratedVadTrackerSeed = Number.isFinite(latest.noiseVadHigh)
        ? Math.max(0, Math.min(1, latest.noiseVadHigh!))
        : DEFAULT_VAD_TRACKER_SEED
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
    this.calibratedVadTrackerSeed = DEFAULT_VAD_TRACKER_SEED
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
    // Без предела ожидания повисший запрос к CDN не отклоняется, worklet ждёт
    // `fetchResponse` вечно, и шумодав молча не запускается вовсе.
    const res = await fetch(`${DEEPFILTER_CDN_BASE}/${rel}`, { signal: AbortSignal.timeout(DEEPFILTER_FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`CDN ${res.status} ${res.statusText}`)
    return res.arrayBuffer()
  }

  private async createProcessedStream(rawStream: MediaStream): Promise<MediaStream> {
    this.cleanupProcessedStream()
    this.dfEngineError = null

    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    this.processedContext = ctx

    if (ctx.sampleRate !== 48000) {
      const detail = `AudioContext runs at ${ctx.sampleRate}Hz, 48000Hz required`
      console.error(`[WebRTC] Audio processing requires 48000Hz, got ${ctx.sampleRate}Hz`)
      this.dfEngineError = detail
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
      this.dfEngineError = `AudioWorklet module failed: ${e instanceof Error ? e.message : String(e)}`
      console.error('[WebRTC] Failed to load deepfilter-processor.js', e)
    }

    if (this.dfNode) {
      // Install the bridge before either model starts. DeepFilter requests its
      // WASM/model assets immediately and AudioWorklet messages are not replayed.
      this.dfNode.port.onmessage = (event) => {
        if (event.data.type === 'vad') {
          const isSpeaking = event.data.isSpeaking
          // Calibration lifts the worklet mute to measure the real microphone.
          // A muted user must not light up as speaking for everyone else while
          // that runs — nothing is being transmitted anyway.
          if (isSpeaking && this.calibrationSuppressesSpeaking) return
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
            fetch(url, { signal: AbortSignal.timeout(DEEPFILTER_FETCH_TIMEOUT_MS) })
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
        } else if (event.data.type === 'engineError') {
          // The neural denoiser can fail to start on a specific machine while raw
          // audio keeps flowing. Remember why, so calibration can say so instead
          // of waiting for a "ready" message that will never arrive.
          this.dfEngineError = String(event.data.message || 'DeepFilterNet3 initialization failed')
          console.error('[WebRTC] DeepFilterNet3 engine unavailable:', this.dfEngineError)
        } else if (event.data.type === 'ready') {
          this.dfNodeReady = true
          this.dfEngineError = null
          console.log('[WebRTC Worklet Log]: DeepFilterProcessor is ready.')
        }
      }

      // Start model loading only after the fetch bridge above is listening.
      this.dfNode.port.postMessage({ type: 'loadWasm', cdnUrl: DEEPFILTER_LOCAL_BASE })

      let vadReadyTimeout: number | undefined
      try {
        this.vadWorker = new VadWorker()
        const absoluteWasmPath = new URL('./', window.location.href).href
        let resolveVadReady: (() => void) | null = null
        let rejectVadReady: ((error: Error) => void) | null = null
        const vadReadyPromise = new Promise<void>((resolve, reject) => {
          resolveVadReady = resolve
          rejectVadReady = reject
        })
        // Обработчик навешивается сразу: таймаут ниже может отклонить промис
        // раньше, чем до `await vadReadyPromise` дойдёт очередь, и это был бы
        // необработанный reject. На сам `await` это не влияет.
        vadReadyPromise.catch(() => { })
        vadReadyTimeout = window.setTimeout(() => {
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
            console.log('[WebRTC] Silero VAD Worker is ready', workerEvent.data.io ?? '')
            if (this.dfNode) {
              this.dfNode.port.postMessage({
                type: 'setConfig',
                sileroVadEnabled: true
              })
            }
          }
        }
        const model = await withTimeout(
          window.windowControls.loadSileroModel(),
          SILERO_MODEL_LOAD_TIMEOUT_MS,
          'Silero VAD model load timed out'
        )
        this.vadWorker.postMessage({
          type: 'init',
          model,
          wasmPath: absoluteWasmPath
        }, [model.buffer])
        await vadReadyPromise
      } catch (e) {
        window.clearTimeout(vadReadyTimeout)
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

    // Rumble has to be removed *before* the worklet, not after it, because the worklet
    // is where every decision about this audio is made. The 60 Hz filter above sits
    // after dfNode, so the pitch detector, Silero, the room trackers and calibration
    // all see low-frequency energy in full - and the pitch detector searches lags
    // 40-229 at 16 kHz, i.e. 70-400 Hz, which is precisely where a desk thump, a
    // footstep or a table knock lives. Such a thump is *genuinely periodic* in that
    // band, so it scores as voiced and opens the gate: the reported "claps and clicks
    // go into the stream". Two cascaded 90 Hz sections (24 dB/oct) put a knock 20+ dB
    // down before anything looks at it, while the lowest male F0 (~85 Hz, with its
    // harmonics carrying the periodicity) survives - telephony has band-limited voice
    // at 300 Hz for a century without hurting intelligibility, so 90 Hz is
    // conservative. highpass1 stays as belt-and-braces on the output.
    const rumbleGuards = [ctx.createBiquadFilter(), ctx.createBiquadFilter()]
    for (const guard of rumbleGuards) {
      guard.type = 'highpass'
      guard.frequency.value = 90
      guard.Q.value = 0.707
    }
    this.micRumbleFilters = rumbleGuards

    // Do not use a broadband compressor on the microphone path. It performs
    // automatic gain riding: sustained vowels are pushed down and recover when
    // the sound stops, which makes the voice feel as if it is breathing.
    // A static soft clipper protects the encoder from overload without attack,
    // release, or time-dependent gain changes. Normal voice remains exactly linear.
    const peakGuard = ctx.createWaveShaper()
    const peakCurve = new Float32Array(65536)
    // Static peak limiter: the transfer curve never changes and remains linear
    // until the signal is genuinely close to digital clipping.
    const linearLimit = 0.98
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
      source.connect(rumbleGuards[0])
      rumbleGuards[0].connect(rumbleGuards[1])
      rumbleGuards[1].connect(this.dfNode)
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
    for (const guard of this.micRumbleFilters) {
      try { guard.disconnect() } catch { }
    }
    this.micRumbleFilters = []
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



  private toCleanAudioDevice(device: MediaDeviceInfo): MediaDeviceInfo {
    const cleanLabel = (device.label || '').replace(/^(Default|Communications|По умолчанию|Связь)[\s:\-]+/i, '').trim()
    return {
      deviceId: device.deviceId,
      kind: device.kind,
      label: cleanLabel,
      groupId: device.groupId,
      toJSON: () => ({ deviceId: device.deviceId, kind: device.kind, label: cleanLabel, groupId: device.groupId })
    } as MediaDeviceInfo
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
      if (!seenDeviceIds.has(dev.deviceId)) {
        seenDeviceIds.add(dev.deviceId)
        result.push(this.toCleanAudioDevice(dev))
      }
    }

    // Some systems expose only the "default"/"communications" pseudo-devices.
    // Dropping them would leave an empty selector with nothing to choose, so keep
    // them rather than hiding a microphone the user actually has.
    if (result.length === 0) {
      return devices.filter(device => device.deviceId).map(device => this.toCleanAudioDevice(device))
    }

    return result
  }

  private getDefaultDeviceFingerprint(devices: MediaDeviceInfo[], kind: MediaDeviceKind): string | null {
    const devicesOfKind = devices.filter(device => device.kind === kind)
    // Windows exposes a "default" pseudo-device mirroring the system choice. Where
    // it is missing, a constraint without deviceId lands on the first enumerated
    // device, so use that as the fingerprint instead of returning null and never
    // noticing that the system default changed.
    const device = devicesOfKind.find(item => item.deviceId === 'default')
      ?? devicesOfKind.find(item => item.deviceId === 'communications')
      ?? devicesOfKind[0]
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
    } catch (error) {
      console.error('[WebRTC] Failed to enumerate audio devices:', error)
      return { inputs: [], outputs: [] }
    }
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

  private buildMicConstraints(deviceId?: string, echoCancellation = true): MediaTrackConstraints {
    const constraints: MediaTrackConstraints = {
      channelCount: 1,
      // Echo cancellation is the one Chromium capture processor this pipeline wants,
      // and it is a different kind of thing from the other two. AEC subtracts a model
      // of what the speakers are playing from what the microphone hears; it does not
      // ride the gain and does not decide what is noise, so it takes nothing away from
      // the voice. Without it a user on laptop speakers sends every other participant
      // their own voice back, which no amount of denoising downstream can undo -
      // DeepFilterNet correctly classifies far-end speech as speech.
      //
      // AGC and Chromium's own noise suppression stay off, as they were: AGC fights
      // the worklet's ALC and produces exactly the breathing this pipeline exists to
      // avoid, and a second suppressor ahead of DeepFilterNet damages what the network
      // is trained to receive. Some Windows audio paths implement all three as one
      // unit and switch the others on alongside AEC - captureRawMicStream checks the
      // settings actually delivered and recaptures without AEC when that happens, so
      // the trade is only ever taken when it costs nothing.
      echoCancellation,
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
      googEchoCancellation: echoCancellation,
      googEchoCancellation2: echoCancellation,
      googAudioMirroring: false
    }
    // Omitting deviceId is deliberate for "default": Chromium then follows the
    // system default device on its own, including later changes.
    if (deviceId && deviceId !== 'default') constraints.deviceId = { exact: deviceId }
    return constraints
  }

  /**
   * Один заход захвата с самопроверкой AEC. Если драйвер включил вместе с ним AGC
   * или собственный шумодав, трек останавливается и та же попытка повторяется с
   * `echoCancellation: false` — эхоподавление берётся только тогда, когда оно не
   * тянет за собой обработку, портящую голос.
   */
  private async captureMicAttempt(
    label: string,
    run: (echoCancellation: boolean) => Promise<MediaStream>
  ): Promise<MediaStream> {
    const capture = (echoCancellation: boolean) => withTimeout(
      run(echoCancellation),
      MIC_CAPTURE_TIMEOUT_MS,
      `MIC_CAPTURE_TIMEOUT: ${label}`,
      late => late.getTracks().forEach(track => track.stop())
    )

    const stream = await capture(true)
    const settings = stream.getAudioTracks()[0]?.getSettings() ?? {}
    const hitchhikers: string[] = []
    if (settings.autoGainControl === true) hitchhikers.push('AGC')
    if (settings.noiseSuppression === true) hitchhikers.push('noise suppression')

    if (hitchhikers.length === 0) {
      if (settings.echoCancellation !== true) {
        console.log(`[WebRTC] Echo cancellation unavailable on ${label}; capturing without it`)
      }
      return stream
    }

    console.warn(
      `[WebRTC] ${label} switched on ${hitchhikers.join(' + ')} together with echo ` +
      `cancellation; recapturing with AEC off so the voice stays unprocessed`
    )
    stream.getTracks().forEach(track => track.stop())
    return capture(false)
  }

  /**
   * The single microphone capture path for both the foreground and the background
   * graph. Never falls back to `audio: true`: Chromium would silently enable AGC
   * and its own noise suppression, producing the exact level pumping this pipeline
   * exists to avoid. Echo cancellation is requested deliberately and verified per
   * attempt (see captureMicAttempt). The first DOMException is preserved (name
   * included) so the UI can tell "no permission" from "busy" and "missing".
   */
  private async captureRawMicStream(): Promise<MediaStream> {
    const requestedDeviceId = this.currentDeviceId
    const attempts: Array<{
      label: string,
      keepsSelection: boolean,
      run: (echoCancellation: boolean) => Promise<MediaStream>
    }> = []

    if (requestedDeviceId && requestedDeviceId !== 'default') {
      attempts.push({
        label: `selected device ${requestedDeviceId}`,
        keepsSelection: true,
        run: echoCancellation => navigator.mediaDevices.getUserMedia({
          audio: this.buildMicConstraints(requestedDeviceId, echoCancellation),
          video: false
        })
      })
    }
    attempts.push({
      label: 'system default',
      keepsSelection: requestedDeviceId === 'default',
      run: echoCancellation => navigator.mediaDevices.getUserMedia({
        audio: this.buildMicConstraints(undefined, echoCancellation),
        video: false
      })
    })
    attempts.push({
      label: 'first available input',
      keepsSelection: false,
      run: async echoCancellation => {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const inputs = devices.filter(device => device.kind === 'audioinput' && device.deviceId)
        const input = inputs.find(device => device.deviceId !== 'default' && device.deviceId !== 'communications')
          ?? inputs[0]
        if (!input) throw new DOMException('No audio input devices found', 'NotFoundError')
        return navigator.mediaDevices.getUserMedia({
          audio: this.buildMicConstraints(input.deviceId, echoCancellation),
          video: false
        })
      }
    })

    let firstError: unknown = null
    for (const attempt of attempts) {
      try {
        const stream = await this.captureMicAttempt(attempt.label, attempt.run)
        if (!attempt.keepsSelection) {
          // The stored selection is gone. Follow the system default from now on
          // instead of failing the same constraint on every restart.
          this.currentDeviceId = 'default'
          console.warn(`[WebRTC] Microphone "${requestedDeviceId}" unavailable, captured via ${attempt.label}`)
        }
        this.lastMicCaptureError = null
        this.lastReportedMicError = null
        return stream
      } catch (error) {
        firstError ??= error
        console.warn(`[WebRTC] Microphone capture failed (${attempt.label}):`, error)
      }
    }

    this.lastMicCaptureError = describeMediaError(firstError)
    throw firstError instanceof Error
      ? firstError
      : new Error(`MIC_ACCESS_FAILED: ${this.lastMicCaptureError}`)
  }

  private reportMicCaptureError(error: unknown): void {
    const detail = describeMediaError(error)
    this.lastMicCaptureError = detail
    // enumerateDevices/devicechange can retry capture many times. Report each
    // distinct failure once instead of stacking identical toasts.
    if (this.lastReportedMicError === detail) return
    this.lastReportedMicError = detail

    const store = useAppStore.getState()
    const kind = classifyMicrophoneError(detail)
    const toastMsg = kind === 'micBusy'
      ? i18n.t('toasts.micBusy', 'Микрофон занят другим приложением.')
      : kind === 'micNotFound'
        ? i18n.t('toasts.micNotFound', 'Микрофон не найден. Подключите устройство и попробуйте снова.')
        : kind === 'micNoAccess'
          ? i18n.t('toasts.micNoAccess', 'Нет доступа к микрофону. Проверьте разрешения в ОС.')
          : i18n.t('toasts.audioError', { message: detail, defaultValue: `Ошибка аудио: ${detail}` })
    store.setSystemToast(toastMsg)
    setTimeout(() => {
      const currentStore = useAppStore.getState()
      if (currentStore.systemToast === toastMsg) currentStore.setSystemToast(null)
    }, 4000)
  }

  public async startBackgroundMic(deviceId?: string): Promise<boolean> {
    if (deviceId !== undefined) this.currentDeviceId = deviceId
    if (this.rawStream?.getAudioTracks().some(track => track.readyState === 'live')) {
      if (!this.localStream) this.startBackgroundMeter()
      return true
    }

    try {
      this.rawStream = await this.captureRawMicStream()
      const rawTrack = this.rawStream.getAudioTracks()[0]
      const settings = rawTrack?.getSettings()
      // Pass the label: without it this path stores the profile under
      // "default:unknown" while startLocalStream uses "default:<label>", and a
      // successful calibration is never found again.
      this.loadCalibration(settings?.deviceId || this.currentDeviceId, rawTrack?.label || '')
      this.startBackgroundMeter()
      return true
    } catch (error) {
      console.error('[WebRTC] Failed to initialize background microphone:', error)
      this.reportMicCaptureError(error)
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
        previousOutputFingerprint !== null && nextOutputFingerprint !== previousOutputFingerprint
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

  public getCalibrationDiagnostics() {
    const rawTrack = this.rawStream?.getAudioTracks()[0]
    const rawSettings = rawTrack?.getSettings()
    return {
      inputDeviceId: this.currentDeviceId,
      outputDeviceId: this.currentOutputDeviceId,
      calibrationProfileKey: this.calibrationDeviceId,
      noiseSuppression: this.noiseSuppression,
      thresholdMode: this.thresholdMode,
      hasDfNode: Boolean(this.dfNode),
      dfNodeReady: this.dfNodeReady,
      dfEngineError: this.dfEngineError,
      vadWorkerReady: this.vadWorkerReady,
      micCaptureError: this.lastMicCaptureError,
      processedContextState: this.processedContext?.state ?? null,
      processedContextSampleRate: this.processedContext?.sampleRate ?? null,
      capturedDeviceId: rawSettings?.deviceId ?? null,
      capturedSampleRate: rawSettings?.sampleRate ?? null,
      capturedChannelCount: rawSettings?.channelCount ?? null,
      // What the driver actually delivered, not what was asked for. AEC is requested;
      // the other two must read false, and if AGC or noise suppression is true here
      // the recapture in captureMicAttempt failed to take effect - that is the case
      // where Chromium is processing the voice before this pipeline sees it.
      capturedEchoCancellation: rawSettings?.echoCancellation ?? null,
      capturedAutoGainControl: rawSettings?.autoGainControl ?? null,
      capturedNoiseSuppression: rawSettings?.noiseSuppression ?? null,
      rawTrackLabel: rawTrack?.label ?? null,
      rawTrackState: rawTrack?.readyState ?? null,
      rawTrackEnabled: rawTrack?.enabled ?? null,
      rawTrackMuted: rawTrack?.muted ?? null,
      localTrackEnabled: this.localStream?.getAudioTracks()[0]?.enabled ?? null
    }
  }

  public async calibrateMic(durationMs = 2500, onStarted?: () => void): Promise<CalibrationResult> {
    const wasInActiveSession = Boolean(useAppStore.getState().currentChannelId || useAppStore.getState().currentCallUser)

    // A live localStream is not proof of a working graph: the worklet or the
    // DeepFilter engine can fail on a specific machine while the raw delayed frame
    // keeps reaching the channel, so the user is heard but nothing can be
    // calibrated. Plain startLocalStream() returns early on a live stream and
    // would never repair that, so force the graph to be rebuilt.
    if (!this.dfNode || !this.dfNodeReady) {
      try {
        if (this.localStream) {
          // Also replaces the outgoing track on every peer connection.
          await this.updateSettings(this.currentDeviceId, this.noiseSuppression)
        } else {
          await this.startLocalStream(this.currentDeviceId, this.noiseSuppression, true)
        }
      } catch (error) {
        const detail = describeMediaError(error)
        console.error('[WebRTC] Calibration could not start the microphone:', detail)
        if (!wasInActiveSession) await this.enterBackgroundMode()
        throw new CalibrationError('CALIBRATION_NO_MIC', detail)
      }
    }

    // Calibration must measure the real microphone even while the user is muted:
    // the worklet keeps counting frames and writes silence, and the localStream
    // tracks stay disabled, so nothing reaches the channel.
    const me = useAppStore.getState().currentUser
    const wasMuted = Boolean(me?.isMuted || me?.isServerMuted)
    if (wasMuted) {
      this.calibrationSuppressesSpeaking = true
      this.dfNode?.port.postMessage({ type: 'setConfig', isMuted: false })
    }

    try {
      if (this.lastMicCaptureError) {
        // Capture fell back to a silent track: calibration would only measure
        // digital silence and report "no speech" for a device problem.
        throw new CalibrationError('CALIBRATION_NO_MIC', this.lastMicCaptureError)
      }
      await this.waitForCalibrationReady()
      onStarted?.()
      return await this.calibrateActiveMic(durationMs)
    } finally {
      if (wasMuted) {
        // Re-read the state instead of blindly restoring: the user may have
        // unmuted during the run, and forcing the worklet mute back on would
        // silence them while the UI shows them as live.
        const currentUser = useAppStore.getState().currentUser
        const stillMuted = Boolean(currentUser?.isMuted || currentUser?.isServerMuted)
        this.dfNode?.port.postMessage({ type: 'setConfig', isMuted: stillMuted })
        this.calibrationSuppressesSpeaking = false
        if (stillMuted && this.localSpeakingState) {
          this.localSpeakingState = false
          if (currentUser) {
            useAppStore.getState().setSpeakingStatus(currentUser.id, false)
            signalRService.setSpeakingState(false)
          }
        }
      }
      if (!wasInActiveSession) await this.enterBackgroundMode()
    }
  }

  private async waitForCalibrationReady(timeoutMs = 8000): Promise<void> {
    const startedAt = Date.now()
    while (!this.dfNodeReady && Date.now() - startedAt < timeoutMs) {
      // A failed engine never becomes ready. Stop waiting as soon as the worklet
      // or the DeepFilter runtime has reported why it is unavailable.
      if (!this.dfNode || this.dfEngineError) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!this.dfNodeReady) {
      throw new CalibrationError('CALIBRATION_ENGINE_UNAVAILABLE', this.dfEngineError || (this.dfNode
        ? 'DeepFilterNet3 did not become ready'
        : 'Audio worklet node is unavailable'))
    }
  }

  // durationMs is the worklet's measuring window, not the UI countdown: it has to
  // match the time the user is actually asked to stay silent, or the run keeps
  // recording after the prompt has already gone away.
  private calibrateActiveMic(durationMs = 2500): Promise<CalibrationResult> {
    return new Promise((resolve, reject) => {
      if (!this.dfNode || !this.dfNodeReady) {
        reject(new CalibrationError('CALIBRATION_ENGINE_UNAVAILABLE', this.dfEngineError || 'Audio processors are not ready'))
        return
      }
      if (this.calibrationInProgress) {
        reject(new CalibrationError('CALIBRATION_BUSY', 'Microphone calibration is already running'))
        return
      }
      if (!this.rawStream?.getAudioTracks().some(track => track.readyState === 'live' && track.enabled)) {
        reject(new CalibrationError('CALIBRATION_NO_MIC', this.lastMicCaptureError || 'The microphone track is not live'))
        return
      }

      const previousProfile = {
        noiseFloor: this.calibratedNoiseFloor,
        attenuationLimit: this.calibratedAttenuationLimit,
        preGainDb: this.calibratedPreGainDb,
        vadTrackerSeed: this.calibratedVadTrackerSeed,
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
        this.calibratedVadTrackerSeed = previousProfile.vadTrackerSeed
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
        // The worklet stopped producing frames mid-run: the track died, the
        // context got suspended or the engine crashed after it reported ready.
        const rawTrack = this.rawStream?.getAudioTracks()[0]
        reject(new CalibrationError('CALIBRATION_TIMEOUT', this.dfEngineError
          || `no result within ${durationMs + 3000}ms (context ${this.processedContext?.state ?? 'none'}, track ${rawTrack?.readyState ?? 'none'}${rawTrack?.muted ? ', muted by the system' : ''})`))
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
            !Number.isFinite(spectralTilt) || acceptedFrames < MIN_CALIBRATION_FRAMES) {
            const silenceReference = Number(e.data.silenceReference) || 0
            console.warn('[WebRTC] Calibration rejected: insufficient noise samples', {
              acceptedFrames,
              rejectedSpeechFrames,
              totalFrames,
              requiredFrames: MIN_CALIBRATION_FRAMES,
              // Only near-field speech is rejected now, so a high count here means
              // the user was talking during the run - not that a distant television
              // or a conversation in another room was audible.
              silenceReferenceDbfs: Number((20 * Math.log10(Math.max(1e-5, silenceReference))).toFixed(1)),
              nearFieldFloorDbfs: Number((20 * Math.log10(Math.max(1e-5, Math.max(silenceReference * 8, 0.0008)))).toFixed(1))
            })
            restorePreviousProfile()
            reject(new CalibrationError('CALIBRATION_NEEDS_SILENCE',
              `accepted ${acceptedFrames} of ${totalFrames} noise frames`))
            return
          }

          const dbNoise = 20 * Math.log10(Math.max(1e-5, noiseFloor))
          const stationarityRatio = peakNoise / Math.max(1e-5, lowNoise)
          const noiseVadMedian = Number(e.data.noiseVadMedian) || 0
          const noiseVadHigh = Number(e.data.noiseVadHigh) || 0

          // The room is now the only measurement, and it fully determines the
          // suppression strength. There is nothing left to accept or reject beyond
          // "did we get enough frames": the wizard no longer asks for a phrase, so
          // it can no longer fail on one.
          const suppressionCalibration = this.calculateAttenuationFromRoom(
            noiseFloor,
            lowNoise,
            peakNoise,
            noiseVadHigh
          )
          const attenuationLimit = suppressionCalibration.attenuationLimit

          restoreInputGain()
          this.calibratedNoiseFloor = noiseFloor
          this.calibratedAttenuationLimit = attenuationLimit
          // Pre-gain came from the calibration phrase and left with it. The user's
          // own input volume (0-200 %) is the remaining loudness control.
          this.calibratedPreGainDb = 0
          this.calibratedVadTrackerSeed = Math.max(0, Math.min(1, noiseVadHigh))
          this.hasVoiceCalibration = true
          if (this.calibratedPreGainNode) this.calibratedPreGainNode.gain.value = 1
          this.updateThresholds()
          console.info('[WebRTC] Calibration suppression profile', {
            noiseDbfs: Number(dbNoise.toFixed(1)),
            // Median vs. the high percentile the demand is actually measured against;
            // roomDbfs above noiseDbfs means the p95-6dB branch won.
            roomDbfs: Number(suppressionCalibration.roomDbfs.toFixed(1)),
            stationarityRatio: Number(stationarityRatio.toFixed(2)),
            noiseVadMedian: Number(noiseVadMedian.toFixed(4)),
            noiseVadHigh: Number(noiseVadHigh.toFixed(4)),
            requiredDb: Number(suppressionCalibration.requiredDb.toFixed(1)),
            speechLikeBonusDb: Number(suppressionCalibration.speechLikeBonusDb.toFixed(2)),
            demandDb: Number(suppressionCalibration.demandDb.toFixed(1)),
            shapedDb: Number(suppressionCalibration.shapedDb.toFixed(1)),
            transientReliefDb: Number(suppressionCalibration.transientReliefDb.toFixed(2)),
            attenuationLimitDb: attenuationLimit,
            assumedSpeechDbfs: ASSUMED_SPEECH_LEVEL_DBFS,
            assumedSnrDb: Number((ASSUMED_SPEECH_LEVEL_DBFS - suppressionCalibration.roomDbfs).toFixed(1)),
            targetSpeechToNoiseDb: TARGET_SPEECH_TO_NOISE_DB,
            targetResidualDbfs: TARGET_RESIDUAL_NOISE_DBFS,
            softKneeDb: SUPPRESSION_SOFT_KNEE_DB,
            vadTrackerSeed: Number(this.calibratedVadTrackerSeed.toFixed(4)),
            appliedAttenuationDb: this.getThresholdParams(1).attenuationLimit,
            thresholdMode: this.thresholdMode,
            availableRangeDb: `${DEEPFILTER_MIN_ATTEN}-${DEEPFILTER_MAX_ATTEN}`
          })
          console.info(
            `[WebRTC] Calibration result: noise=${dbNoise.toFixed(1)}dBFS ` +
            `(room reference ${suppressionCalibration.roomDbfs.toFixed(1)}dBFS), ` +
            `stationarity=${stationarityRatio.toFixed(2)}, ` +
            `noiseVadHigh=${noiseVadHigh.toFixed(4)}, ` +
            `frames=${acceptedFrames} (rejected ${rejectedSpeechFrames}), ` +
            `attenuation=${attenuationLimit}dB of ${DEEPFILTER_MAX_ATTEN}dB ` +
            `(demand ${suppressionCalibration.demandDb.toFixed(1)}dB to lift a ` +
            `${(ASSUMED_SPEECH_LEVEL_DBFS - suppressionCalibration.roomDbfs).toFixed(1)}dB room SNR to ` +
            `${TARGET_SPEECH_TO_NOISE_DB}dB speech-to-noise, ` +
            `softened to ${suppressionCalibration.shapedDb.toFixed(1)}dB above the ` +
            `${SUPPRESSION_SOFT_KNEE_DB}dB knee)`
          )

          try {
            const profile: StoredEnvironmentProfile = {
              version: WebRTCManager.CALIBRATION_SCHEMA_VERSION,
              timestamp: Date.now(),
              noiseFloor,
              lowNoise,
              peakNoise,
              attenuationLimit,
              noiseVadMedian,
              noiseVadHigh,
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
            noiseVadMedian,
            noiseVadHigh,
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
        if (!raw?.getAudioTracks().some(track => track.readyState === 'live')) {
          try {
            raw = await this.captureRawMicStream()
          } catch (error) {
            // Keep the session alive with a silent track instead of tearing the
            // call down, but tell the user which device problem to fix.
            this.reportMicCaptureError(error)
            raw = createSilentAudioStream()
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
        // Keep the DOMException name inside the message: the toast classifier
        // needs it to tell a busy or missing microphone from a denied one.
        throw new Error(`MIC_ACCESS_FAILED: ${describeMediaError(e)}`)
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

    // Make-up gain for everything arriving from the channel - voices and shared
    // stream audio alike. In-app sound effects are deliberately not here: they run
    // on their own AudioContext in signalr.ts and keep the level they were mixed at.
    //
    // The bus used to sit at unity with the compressor as a distant safety net at
    // -3 dB, so nothing in the chain ever applied gain: a quiet sender stayed quiet
    // no matter how far the sliders were pushed, which is the reported problem. With
    // the make-up ahead of the compressor the pair behaves as a mix leveller: a
    // sender that is already at the standard level is peak-limited back to roughly
    // +4.5 dB, while a quiet or legacy sender receives the full +6 dB.
    this.outputBusGain = this.outputMixContext.createGain()
    this.outputBusGain.gain.value = Math.pow(10, PLAYBACK_MAKEUP_GAIN_DB / 20)
    this.outputBusGain.connect(this.outputCompressor)

    // Threshold lowered from -3 dB so the compressor actually catches what the
    // make-up adds; the slower release keeps it from pumping between syllables.
    this.outputCompressor.threshold.value = -8
    this.outputCompressor.knee.value = 6
    this.outputCompressor.ratio.value = 4
    this.outputCompressor.attack.value = 0.004
    this.outputCompressor.release.value = 0.180

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
        gain.connect(this.outputBusGain!)

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
        gain.connect(this.outputBusGain!)

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

  private isPeerRelevant(userId: string): boolean {
    const store = useAppStore.getState()
    if (store.currentCallUser?.id === userId || store.incomingCall?.callerId === userId) return true
    return Boolean(store.currentChannelId && store.voiceUsers.some(user => user.id === userId))
  }

  public async connectToPeer(userId: string, preserveRemoteVideoOnFailure = false) {
    if (userId === useAppStore.getState().currentUser?.id) return
    if (!this.isPeerRelevant(userId)) return
    if (this.peerConnections.has(userId)) return

    if (!this.localStream) {
      await this.startLocalStream().catch(() => { })
    }
    await this.ensureIceServers()
    if (!this.isPeerRelevant(userId)) return

    const pc = new RTCPeerConnection(this.rtcConfig())
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
      if (this.peerConnections.get(userId) !== pc || !this.isPeerRelevant(userId)) {
        this.disconnectFromPeer(userId)
        return
      }
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
    if (!this.isPeerRelevant(senderId)) return

    let pc = this.peerConnections.get(senderId)
    if (!pc) {
      if (!this.localStream) {
        await this.startLocalStream().catch(() => { })
      }
      await this.ensureIceServers()
      if (!this.isPeerRelevant(senderId)) return
      pc = new RTCPeerConnection(this.rtcConfig())
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
      if (this.peerConnections.get(senderId) !== pc || !this.isPeerRelevant(senderId)) {
        this.disconnectFromPeer(senderId)
        return
      }
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
    if (!this.isPeerRelevant(senderId)) return
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
    if (!this.isPeerRelevant(senderId)) {
      this.pendingCandidates.delete(senderId)
      return
    }
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
    this.pendingCandidates.clear()
    this.pendingRenegotiation.clear()
  }
}

export const webrtc = new WebRTCManager()
