import { StandaloneDeepFilter } from 'deepfilter-standalone'

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
  constructor()
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor
): void

const pendingFetches = new Map<string, (ab: ArrayBuffer) => void>()

// Polyfill fetch in AudioWorklet to proxy to the main thread
if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = (url: string | URL | Request): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    return new Promise((resolve, reject) => {
      pendingFetches.set(urlStr, (ab: ArrayBuffer) => {
        if (!ab) {
          reject(new Error('Fetch failed in main thread'))
          return
        }
        resolve({
          ok: true,
          statusText: 'OK',
          arrayBuffer: async () => ab
        } as unknown as Response)
      })
      // The port is only available inside the class instance, so we need a global proxy function
      if (globalThis.proxyFetchToMain) {
        globalThis.proxyFetchToMain(urlStr)
      } else {
        reject(new Error('proxyFetchToMain not set'))
      }
    })
  }
}

// Polyfill performance.now() which is used by StandaloneDeepFilter
if (typeof globalThis.performance === 'undefined') {
  (globalThis as any).performance = {
    now: () => Date.now()
  }
}

declare global {
  var proxyFetchToMain: ((url: string) => void) | undefined;
}

class DeepFilterProcessor extends AudioWorkletProcessor {
  private inputBuffer: Float32Array
  private outputBuffer: Float32Array
  private inputReadIndex = 0
  private inputWriteIndex = 0
  private outputReadIndex = 0
  private outputWriteIndex = 0

  private readonly FRAME_SIZE = 480
  private readonly BUFFER_SIZE = 24000

  private denoiser: StandaloneDeepFilter | null = null
  private denoiserReady = false

  private readonly frameToProcess: Float32Array
  private readonly processedFrame: Float32Array
  private monoInput = new Float32Array(0)

  private isMuted = false
  private noiseSuppression = true

  private rmsSmoothed = 0
  private lastVadSent = false
  private overflowCount = 0
  private denoiserErrorCount = 0

  private readonly VAD_FRAME_SIZE = 512
  private readonly VAD_ON_THRESHOLD = 0.10
  private readonly VAD_OFF_THRESHOLD = 0.05
  // Two consecutive 32 ms decisions reject isolated clicks while the existing
  // 200 ms output delay preserves the complete speech onset through preroll.
  private readonly VAD_ATTACK_RESULTS = 2
  // Fixed Silero-only hangover, following the stable "Нормальный шумодав" design.
  // Energy never changes the open state or gain. Seven 32 ms negative decisions
  // preserve quiet word endings while sustained non-speech closes in ~224 ms.
  private readonly VAD_RELEASE_RESULTS = 7
  private readonly MANUAL_HOLD_FRAMES = 30
  // Keep 200 ms of audio so a Silero result can be attached to the actual source
  // frames it classified instead of changing the state of whatever frame happens
  // to be processed when the worker replies.
  private readonly DECISION_DELAY_FRAMES = 20
  private readonly SPEECH_PREROLL_FRAMES = 16
  private vadOnThreshold = this.VAD_ON_THRESHOLD
  private vadOffThreshold = this.VAD_OFF_THRESHOLD
  private speechSegmentOpen = false
  private consecutiveVadSpeechResults = 0
  private consecutiveVadSilenceResults = 0
  private lastVadSequence = -1
  private audioFrameId = 0

  private readonly speechRingSpeech: Uint8Array
  private readonly speechRingFrames: Float32Array[] = []
  private readonly speechRingFrameIds: Int32Array
  private readonly speechRingRms: Float32Array
  private readonly speechRingZcr: Float32Array
  private readonly speechRingTilt: Float32Array
  private speechRingWriteIndex = 0
  private speechRingCount = 0
  private gateWasOpen = false
  private gateGain = 0
  // Automatic mode sends speech only. The short release ramp prevents a click,
  // then non-speech reaches digital silence.
  private readonly GATE_FLOOR = 0

  private readonly MIN_ATTEN_LIMIT = 5
  private readonly MAX_ATTEN_LIMIT = 25
  private attenuationLimit = 5
  private postFilterBeta = 0
  private cdnUrl: string | undefined

  private thresholdMode = 'auto'
  private noiseFloorEstimate = 0.003
  private sileroVadEnabled = false
  private sileroVadHealthy = false
  private lastSileroResultFrameId = -1
  private sileroVadProbability = 0.0
  private readonly vad16kBuffer = new Float32Array(this.VAD_FRAME_SIZE)
  private vad16kWriteIndex = 0
  private vadSequence = 0
  private readonly vadDecimatorTaps = new Float32Array(49)
  private readonly vadDecimatorHistory = new Float32Array(49)
  private vadDecimatorWriteIndex = 0
  private vadDecimatorPhase = 0
  private vadWindowSquareSum = 0
  private vadWindowSampleCount = 0

  private calibrationFramesLeft = 0
  private calibrationMode: 'manual' | 'probe' = 'manual'
  private readonly calibrationRms = new Float32Array(1200)
  private readonly calibrationSpeechRms = new Float32Array(1200)
  private readonly calibrationSpeechPeaks = new Float32Array(1200)
  private readonly calibrationNoiseVad = new Float32Array(1200)
  private readonly calibrationSpeechVad = new Float32Array(1200)
  private readonly calibrationSpeechVadRms = new Float32Array(1200)
  private calibrationTotalFrames = 0
  private calibrationStartFrameId = 0
  private calibrationCount = 0
  private calibrationSpeechCount = 0
  private calibrationNoiseVadCount = 0
  private calibrationSpeechVadCount = 0
  private calibrationRejectedSpeechFrames = 0
  private calibrationZcrSum = 0
  private calibrationSpectralTiltSum = 0
  private calibrationNoiseReference = 0.003
  // Trailing level history of the silence stage, used to tell the user's own voice
  // from speech-shaped room background. It has to be measured inside this run:
  // noiseFloorEstimate is a stored calibration value that is 20 dB off on a first
  // run, and any absolute dBFS threshold is wrong on some microphone.
  private readonly calibrationSilenceHistory = new Float32Array(100)
  private readonly calibrationSilenceScratch = new Float32Array(100)
  private calibrationSilenceHistoryCount = 0
  private calibrationSilenceHistoryIndex = 0
  private calibrationSilenceLevel = 0
  // Sustained-speech evidence for the prompted phrase. A click, a cough or a
  // chair creak produce a few loud frames; a spoken sentence produces hundreds
  // of them in long runs. Counting them here is the only way to tell the two
  // apart, because every percentile of the speech stage looks alike otherwise.
  private calibrationSpeechWindowFrames = 0
  private calibrationSpeechActiveFrames = 0
  private calibrationSpeechRunFrames = 0
  private calibrationSpeechGapFrames = 0
  private calibrationSpeechLongestRun = 0
  // Level a speech-stage frame has to reach to count as voiced. Derived from the
  // spread of the silence stage once that stage is complete, never from a fixed
  // margin: a built-in laptop array can capture a voice only 4 dB above its own
  // room, where a flat +6 dB bar counts nothing, while in a stationary room
  // +2.5 dB already excludes every noise frame.
  private calibrationVoicedFloor = 0.0004

  private manualThresholdDb = -42
  private manualVadHoldFrames = 0
  private meterFrameCounter = 0
  private gainFactor = 1

  constructor() {
    super()
    this.inputBuffer = new Float32Array(this.BUFFER_SIZE)
    this.outputBuffer = new Float32Array(this.BUFFER_SIZE)
    this.frameToProcess = new Float32Array(this.FRAME_SIZE)
    this.processedFrame = new Float32Array(this.FRAME_SIZE)
    this.speechRingSpeech = new Uint8Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingFrameIds = new Int32Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingFrameIds.fill(-1)
    this.speechRingRms = new Float32Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingZcr = new Float32Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingTilt = new Float32Array(this.DECISION_DELAY_FRAMES + 1)
    for (let i = 0; i < this.speechRingSpeech.length; i++) {
      this.speechRingFrames.push(new Float32Array(this.FRAME_SIZE))
    }
    // Windowed-sinc low-pass for clean 48 -> 16 kHz decimation. Forty-nine taps
    // preserve the speech band while rejecting aliases above the 8 kHz Nyquist
    // limit much more strongly than the former short filter. The coefficients are
    // normalized to unity DC gain, so Silero still receives the raw voice level.
    const center = (this.vadDecimatorTaps.length - 1) / 2
    const cutoff = 0.15
    let tapSum = 0
    for (let i = 0; i < this.vadDecimatorTaps.length; i++) {
      const offset = i - center
      const sinc = offset === 0
        ? 2 * cutoff
        : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset)
      const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (this.vadDecimatorTaps.length - 1))
      const tap = sinc * window
      this.vadDecimatorTaps[i] = tap
      tapSum += tap
    }
    for (let i = 0; i < this.vadDecimatorTaps.length; i++) this.vadDecimatorTaps[i] /= tapSum
    // Buffer enough zeros to prevent underflow while accumulating the first 480 input samples
    this.outputWriteIndex = this.FRAME_SIZE * 2

    globalThis.proxyFetchToMain = (url: string) => {
      this.port.postMessage({ type: 'fetchRequest', url })
    }

    this.port.onmessage = (event) => {
      if (event.data.type === 'loadWasm') {
        if (typeof event.data.cdnUrl === 'string' && event.data.cdnUrl) {
          this.cdnUrl = event.data.cdnUrl
        }
        this.initDeepFilter()
      } else if (event.data.type === 'setConfig') {
        if (event.data.noiseSuppression !== undefined) {
          this.noiseSuppression = event.data.noiseSuppression
        }
        if (event.data.sileroVadEnabled !== undefined) {
          this.sileroVadEnabled = event.data.sileroVadEnabled
          if (!this.sileroVadEnabled) this.sileroVadHealthy = false
        }
        if (event.data.isMuted !== undefined) {
          const nextMuted = event.data.isMuted
          if (nextMuted && !this.isMuted && this.calibrationFramesLeft > 0) {
            // Muting in the middle of a calibration run: the full reset below
            // would zero audioFrameId and invalidate calibrationStartFrameId, so
            // the run could never produce a result. Only silence what is already
            // buffered — process() keeps writing zeros while muted.
            this.outputBuffer.fill(0)
            if (this.lastVadSent) {
              this.port.postMessage({ type: 'vad', isSpeaking: false })
              this.lastVadSent = false
            }
          } else if (nextMuted && !this.isMuted) {
            this.inputBuffer.fill(0)
            this.outputBuffer.fill(0)
            this.inputReadIndex = 0
            this.inputWriteIndex = 0
            this.outputReadIndex = 0
            this.outputWriteIndex = this.FRAME_SIZE * 2
            this.rmsSmoothed = 0
            this.speechSegmentOpen = false
            this.consecutiveVadSpeechResults = 0
            this.consecutiveVadSilenceResults = 0
            this.sileroVadHealthy = false
            this.lastSileroResultFrameId = -1
            this.lastVadSequence = -1
            this.audioFrameId = 0
            this.speechRingWriteIndex = 0
            this.speechRingCount = 0
            this.gateWasOpen = false
            this.gateGain = 0
            this.speechRingSpeech.fill(0)
            this.speechRingFrameIds.fill(-1)
            this.speechRingRms.fill(0)
            this.speechRingZcr.fill(0)
            this.speechRingTilt.fill(0)
            for (const frame of this.speechRingFrames) frame.fill(0)
            this.vad16kWriteIndex = 0
            this.vad16kBuffer.fill(0)
            this.vadDecimatorHistory.fill(0)
            this.vadDecimatorWriteIndex = 0
            this.vadDecimatorPhase = 0
            this.vadWindowSquareSum = 0
            this.vadWindowSampleCount = 0
            this.sileroVadProbability = 0.0
            this.port.postMessage({ type: 'resetVad' })
            if (this.lastVadSent) {
              this.port.postMessage({ type: 'vad', isSpeaking: false })
              this.lastVadSent = false
            }
          }
          this.isMuted = nextMuted
        }
      } else if (event.data.type === 'fetchResponse') {
        const resolve = pendingFetches.get(event.data.url)
        if (resolve) {
          resolve(event.data.buffer)
          pendingFetches.delete(event.data.url)
        }
      } else if (event.data.type === 'setCalibratedParams') {
        if (event.data.thresholdMode !== undefined) {
          this.thresholdMode = event.data.thresholdMode
        }
        if (event.data.manualThresholdValue !== undefined && this.thresholdMode === 'manual') {
          const threshold = Number(event.data.manualThresholdValue)
          this.manualThresholdDb = Math.max(-60, Math.min(-12, Number.isFinite(threshold) ? threshold : -42))
        } else if (this.thresholdMode === 'auto' &&
          (event.data.vadOnThreshold !== undefined || event.data.vadOffThreshold !== undefined)) {
          const vadOnThreshold = Number(event.data.vadOnThreshold)
          const vadOffThreshold = Number(event.data.vadOffThreshold)
          this.vadOnThreshold = Number.isFinite(vadOnThreshold)
            ? Math.max(0.018, Math.min(0.20, vadOnThreshold))
            : this.VAD_ON_THRESHOLD
          this.vadOffThreshold = Number.isFinite(vadOffThreshold)
            ? Math.max(0.008, Math.min(this.vadOnThreshold - 0.006, vadOffThreshold))
            : this.VAD_OFF_THRESHOLD
        }
        if (event.data.attenuationLimit !== undefined) {
          this.attenuationLimit = Math.max(this.MIN_ATTEN_LIMIT, Math.min(this.MAX_ATTEN_LIMIT, event.data.attenuationLimit))
          if (this.denoiserReady && this.denoiser) {
            try {
              this.denoiser.setAttenuationLimit(this.attenuationLimit)
            } catch {
            }
          }
        }
        if (event.data.postFilterBeta !== undefined) {
          // The DeepFilter post-filter is intentionally disabled. Even small
          // values can smear quiet consonants after the neural mask.
          this.postFilterBeta = 0
          if (this.denoiserReady && this.denoiser) {
            try {
              (this.denoiser as any).setPostFilterBeta?.(this.postFilterBeta)
            } catch {
            }
          }
        }
        if (event.data.gainFactor !== undefined) {
          const gainFactor = Number(event.data.gainFactor)
          this.gainFactor = Number.isFinite(gainFactor) && gainFactor > 0 ? gainFactor : 1
        }
        if (event.data.noiseFloor !== undefined) {
          const noiseFloor = Number(event.data.noiseFloor)
          if (Number.isFinite(noiseFloor) && noiseFloor > 0) {
            this.noiseFloorEstimate = Math.max(0.0001, Math.min(0.03, noiseFloor))
          }
        }
      } else if (event.data.type === 'startCalibration' || event.data.type === 'startEnvironmentProbe') {
        this.calibrationMode = event.data.type === 'startEnvironmentProbe' ? 'probe' : 'manual'
        this.calibrationTotalFrames = Math.floor((event.data.durationMs || 5000) / 10)
        this.calibrationFramesLeft = this.calibrationTotalFrames
        this.calibrationStartFrameId = this.audioFrameId
        this.calibrationCount = 0
        this.calibrationSpeechCount = 0
        this.calibrationNoiseVadCount = 0
        this.calibrationSpeechVadCount = 0
        this.calibrationRejectedSpeechFrames = 0
        this.calibrationZcrSum = 0
        this.calibrationSpectralTiltSum = 0
        this.calibrationNoiseReference = this.noiseFloorEstimate
        this.calibrationSilenceHistoryCount = 0
        this.calibrationSilenceHistoryIndex = 0
        this.calibrationSilenceLevel = 0
        this.calibrationSpeechWindowFrames = 0
        this.calibrationSpeechActiveFrames = 0
        this.calibrationSpeechRunFrames = 0
        this.calibrationSpeechGapFrames = 0
        this.calibrationSpeechLongestRun = 0
        this.calibrationVoicedFloor = Math.max(this.calibrationNoiseReference * 2, 0.0004)
        // Do not let a VAD decision from the preceding conversation contaminate
        // the first silence stage of a new one-shot calibration.
        this.sileroVadProbability = 0
        this.speechSegmentOpen = false
        this.consecutiveVadSpeechResults = 0
        this.consecutiveVadSilenceResults = 0
        this.port.postMessage({ type: 'log', message: 'Calibration started' })
      } else if (event.data.type === 'setSileroVadProbability') {
        // Calibration keeps consuming VAD results while muted: without them the
        // run has no labelled speech distribution and can only fail.
        if ((this.isMuted && this.calibrationFramesLeft <= 0) || !this.sileroVadEnabled) return
        const sequence = Number(event.data.sequence)
        const endFrameId = Number(event.data.endFrameId)
        const windowRms = Number(event.data.windowRms)
        if (!Number.isFinite(sequence) || sequence <= this.lastVadSequence) return

        this.lastVadSequence = sequence
        this.sileroVadHealthy = true
        this.lastSileroResultFrameId = Number.isFinite(endFrameId) ? endFrameId : this.audioFrameId
        this.sileroVadProbability = Math.max(0, Math.min(1, Number(event.data.probability) || 0))

        // Calibration must pair a Silero probability with the exact raw 32 ms
        // window classified by the model. The worker returns both its source frame
        // id and RMS; using the current 10 ms processing frame here would introduce
        // inference-latency skew and bias quiet-speech thresholds unpredictably.
        if (this.calibrationFramesLeft > 0 && Number.isFinite(endFrameId) && Number.isFinite(windowRms)) {
          const elapsedFrames = endFrameId - this.calibrationStartFrameId
          const silenceStageFrames = Math.floor(this.calibrationTotalFrames * 0.3)
          const speechStageEnd = Math.floor(this.calibrationTotalFrames * 0.8)
          const phaseGuardFrames = Math.min(20, Math.floor(this.calibrationTotalFrames * 0.02))
          const isSilenceStage = elapsedFrames >= phaseGuardFrames &&
            elapsedFrames < silenceStageFrames - phaseGuardFrames
          const isSpeechStage = this.calibrationMode === 'manual' &&
            elapsedFrames >= silenceStageFrames + phaseGuardFrames &&
            elapsedFrames < speechStageEnd - phaseGuardFrames
          const isProbeFrame = this.calibrationMode === 'probe' &&
            elapsedFrames >= 0 && elapsedFrames < this.calibrationTotalFrames
          const normalizedWindowRms = windowRms / this.gainFactor
          // Exclude only the user's own voice from the labelled noise distribution.
          // Speech-shaped background - a television in another room, a conversation
          // down the hallway - has to stay inside it: noiseVadHigh is the anchor the
          // runtime gate threshold is built on, so a distribution that pretends the
          // room never produces speech probabilities would place the gate below what
          // the room actually produces and hold it open on that background.
          const calibrationSpeechVadFloor = Math.max(0.03, Math.min(0.08, this.vadOnThreshold + 0.01))
          const likelySpeechWindow = this.calibrationMode === 'manual' &&
            this.sileroVadProbability >= calibrationSpeechVadFloor &&
            normalizedWindowRms >= Math.max(this.calibrationSilenceLevel * 8, 0.0008)
          if ((isProbeFrame || (isSilenceStage && !likelySpeechWindow)) &&
            this.calibrationNoiseVadCount < this.calibrationNoiseVad.length) {
            this.calibrationNoiseVad[this.calibrationNoiseVadCount++] = this.sileroVadProbability
          }
          if (isSpeechStage && normalizedWindowRms >= 0.0001 &&
            this.calibrationSpeechVadCount < this.calibrationSpeechVad.length) {
            this.calibrationSpeechVad[this.calibrationSpeechVadCount] = this.sileroVadProbability
            this.calibrationSpeechVadRms[this.calibrationSpeechVadCount] = normalizedWindowRms
            this.calibrationSpeechVadCount++
          }
        }

        if (this.sileroVadProbability >= this.vadOnThreshold) {
          this.consecutiveVadSpeechResults++
          this.consecutiveVadSilenceResults = 0
          if (!this.speechSegmentOpen && this.consecutiveVadSpeechResults >= this.VAD_ATTACK_RESULTS) {
            this.speechSegmentOpen = true
            if (Number.isFinite(endFrameId)) {
              this.markBufferedSpeechFrom(endFrameId - this.SPEECH_PREROLL_FRAMES)
            }
          }
        } else {
          this.consecutiveVadSpeechResults = 0
          if (this.speechSegmentOpen) {
            if (this.sileroVadProbability >= this.vadOffThreshold) {
              this.consecutiveVadSilenceResults = 0
            } else {
              this.consecutiveVadSilenceResults++
              if (this.consecutiveVadSilenceResults >= this.VAD_RELEASE_RESULTS) {
                this.speechSegmentOpen = false
                this.consecutiveVadSilenceResults = 0
              }
            }
          }
        }
      }
    }
  }

  private markBufferedSpeechFrom(firstFrameId: number) {
    for (let i = 0; i < this.speechRingSpeech.length; i++) {
      const frameId = this.speechRingFrameIds[i]
      if (frameId >= firstFrameId) this.speechRingSpeech[i] = 1
    }
  }

  private decimateVadSample(sample: number): number | null {
    this.vadDecimatorHistory[this.vadDecimatorWriteIndex] = sample
    this.vadDecimatorWriteIndex = (this.vadDecimatorWriteIndex + 1) % this.vadDecimatorHistory.length
    this.vadDecimatorPhase++
    if (this.vadDecimatorPhase < 3) return null
    this.vadDecimatorPhase = 0

    let filtered = 0
    let historyIndex = (this.vadDecimatorWriteIndex - 1 + this.vadDecimatorHistory.length) % this.vadDecimatorHistory.length
    for (let i = 0; i < this.vadDecimatorTaps.length; i++) {
      filtered += this.vadDecimatorTaps[i] * this.vadDecimatorHistory[historyIndex]
      historyIndex = (historyIndex - 1 + this.vadDecimatorHistory.length) % this.vadDecimatorHistory.length
    }
    return Math.max(-1, Math.min(1, filtered))
  }

  private async initDeepFilter() {
    if (this.denoiserReady) return
    try {
      this.port.postMessage({ type: 'log', message: 'DeepFilterNet3 initialization started' })
      this.denoiser = new StandaloneDeepFilter({
        ...(this.cdnUrl ? { cdnUrl: this.cdnUrl } : {}),
        attenuationLimit: this.attenuationLimit,
        postFilterBeta: 0.0
      })
      await this.denoiser.initialize()
      const modelFrameLength = this.denoiser.getFrameLength()
      if (modelFrameLength !== this.FRAME_SIZE) {
        throw new Error(`Unsupported DeepFilter frame length ${modelFrameLength}; expected ${this.FRAME_SIZE}`)
      }
      this.denoiser.startStreaming()
      this.denoiser.setAttenuationLimit(this.attenuationLimit)
      ;(this.denoiser as any).setPostFilterBeta?.(this.postFilterBeta)
      this.denoiserReady = true
      this.port.postMessage({
        type: 'log',
        message: `DeepFilterNet3 initialized: frame=${this.denoiser.getFrameLength()}, attenuation=${this.attenuationLimit}dB, postFilter=${this.postFilterBeta}`
      })
      this.port.postMessage({ type: 'ready' })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.port.postMessage({ type: 'log', message: 'DeepFilterNet3 initialization failed: ' + message })
      // A separate message, not a log line: the main thread has to know that this
      // machine has no working engine, otherwise calibration only reports a
      // timeout and the real reason stays in the console.
      this.port.postMessage({ type: 'engineError', message: `DeepFilterNet3 initialization failed: ${message}` })
    }
  }

  private pushToBuffer(buffer: Float32Array, data: Float32Array, writeIndex: number, readIndex: number): number {
    const availableSpace = (readIndex - writeIndex - 1 + this.BUFFER_SIZE) % this.BUFFER_SIZE
    if (availableSpace < data.length) {
      this.overflowCount++
      return writeIndex
    }
    const part1 = this.BUFFER_SIZE - writeIndex
    if (part1 >= data.length) {
      buffer.set(data, writeIndex)
      writeIndex = (writeIndex + data.length) % this.BUFFER_SIZE
    } else {
      buffer.set(data.subarray(0, part1), writeIndex)
      buffer.set(data.subarray(part1), 0)
      writeIndex = data.length - part1
    }
    return writeIndex
  }

  private pullFromBuffer(buffer: Float32Array, data: Float32Array, writeIndex: number, readIndex: number): number {
    const availableData = (writeIndex - readIndex + this.BUFFER_SIZE) % this.BUFFER_SIZE
    if (availableData < data.length) {
      data.fill(0)
      return readIndex
    }
    const part1 = this.BUFFER_SIZE - readIndex
    if (part1 >= data.length) {
      data.set(buffer.subarray(readIndex, readIndex + data.length))
      readIndex = (readIndex + data.length) % this.BUFFER_SIZE
    } else {
      data.set(buffer.subarray(readIndex, this.BUFFER_SIZE), 0)
      data.set(buffer.subarray(0, data.length - part1), part1)
      readIndex = data.length - part1
    }
    return readIndex
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const output = outputs[0]

    if (!input?.length || !output?.length) return true

    const inputChannel = input[0]
    const outputChannel = output[0]

    // A muted user must still be able to calibrate the microphone: the frames are
    // measured exactly as usual while the output stays silent, so nothing reaches
    // the channel. Outside calibration a muted processor still costs nothing.
    const measureWhileMuted = this.isMuted && this.calibrationFramesLeft > 0
    if (this.isMuted && !measureWhileMuted) {
      outputChannel.fill(0)
      return true
    }

    // A capture track can negotiate stereo even for a mono microphone. Downmix
    // both channels before VAD, calibration and DeepFilter instead of discarding
    // the right channel and losing part of the voice.
    let monoInput = inputChannel
    if (input.length > 1) {
      if (this.monoInput.length !== inputChannel.length) this.monoInput = new Float32Array(inputChannel.length)
      this.monoInput.fill(0)
      for (const channel of input) {
        for (let i = 0; i < inputChannel.length; i++) this.monoInput[i] += channel[i] || 0
      }
      const scale = 1 / input.length
      for (let i = 0; i < this.monoInput.length; i++) this.monoInput[i] *= scale
      monoInput = this.monoInput
    }
    this.inputWriteIndex = this.pushToBuffer(this.inputBuffer, monoInput, this.inputWriteIndex, this.inputReadIndex)

    while ((this.inputWriteIndex - this.inputReadIndex + this.BUFFER_SIZE) % this.BUFFER_SIZE >= this.FRAME_SIZE) {
      this.inputReadIndex = this.pullFromBuffer(this.inputBuffer, this.frameToProcess, this.inputWriteIndex, this.inputReadIndex)

      for (let i = 0; i < this.FRAME_SIZE; i++) {
        const inputSample = this.frameToProcess[i]
        this.vadWindowSquareSum += inputSample * inputSample
        this.vadWindowSampleCount++
        const filteredSample = this.decimateVadSample(inputSample)
        if (filteredSample === null) continue
        this.vad16kBuffer[this.vad16kWriteIndex++] = filteredSample

        if (this.vad16kWriteIndex === this.VAD_FRAME_SIZE) {
          const audioFrame = this.vad16kBuffer.slice()
          const windowRms = Math.sqrt(this.vadWindowSquareSum / Math.max(1, this.vadWindowSampleCount))
          this.port.postMessage(
            { type: 'audio16k', audio: audioFrame, sequence: this.vadSequence++, endFrameId: this.audioFrameId, windowRms },
            [audioFrame.buffer]
          )
          this.vad16kWriteIndex = 0
          this.vadWindowSquareSum = 0
          this.vadWindowSampleCount = 0
        }
      }

      let sumSquares = 0
      let currentPeak = 0
      let lowBandState = 0
      let lowBandSquares = 0
      let highBandSquares = 0
      let zeroCrossings = 0
      for (let i = 0; i < this.FRAME_SIZE; i++) {
        const sample = this.frameToProcess[i]
        currentPeak = Math.max(currentPeak, Math.abs(sample))
        sumSquares += sample * sample
        lowBandState += 0.12 * (sample - lowBandState)
        const highBand = sample - lowBandState
        lowBandSquares += lowBandState * lowBandState
        highBandSquares += highBand * highBand
        if (i > 0 && (sample >= 0) !== (this.frameToProcess[i - 1] >= 0)) zeroCrossings++
      }
      const currentRms = Math.sqrt(sumSquares / this.FRAME_SIZE)
      this.rmsSmoothed = 0.2 * currentRms + 0.8 * this.rmsSmoothed
      const currentDb = 20 * Math.log10(Math.max(this.rmsSmoothed, 0.000001))
      if (++this.meterFrameCounter >= 5) {
        this.meterFrameCounter = 0
        this.port.postMessage({ type: 'micLevelDb', db: Math.max(-100, Math.min(0, currentDb)) })
      }
      const currentZcr = zeroCrossings / (this.FRAME_SIZE - 1)
      const currentTilt = Math.sqrt(highBandSquares / Math.max(1e-12, lowBandSquares))

      // A worker that initialized successfully can still stop returning results.
      // After 1.2 seconds without a decision, leave the permanently-closed Silero
      // state and use the strict fallback below until inference recovers.
      if (this.sileroVadEnabled && this.sileroVadHealthy && this.lastSileroResultFrameId >= 0 &&
        this.audioFrameId - this.lastSileroResultFrameId > 120) {
        this.sileroVadHealthy = false
        this.speechSegmentOpen = false
        this.consecutiveVadSpeechResults = 0
        this.consecutiveVadSilenceResults = 0
      }

      if (this.thresholdMode === 'manual') {
        if (currentDb >= this.manualThresholdDb) {
          this.manualVadHoldFrames = this.MANUAL_HOLD_FRAMES
        } else if (this.manualVadHoldFrames > 0) {
          // Hysteresis: once open, keep the gate open through the quiet tail of a
          // word (down to 6 dB below the threshold) instead of chopping consonants.
          if (currentDb >= this.manualThresholdDb - 6) {
            this.manualVadHoldFrames = this.MANUAL_HOLD_FRAMES
          } else {
            this.manualVadHoldFrames--
          }
        }
      }

      // Silero remains authoritative whenever it is producing decisions. If the
      // worker failed before its first result, do not lock the microphone at zero
      // forever: use a deliberately strict speech-shaped energy fallback.
      const fallbackSpeech = !this.sileroVadHealthy &&
        currentRms >= Math.max(0.0015, this.noiseFloorEstimate * 3.5) &&
        currentZcr >= 0.025 && currentZcr <= 0.35 &&
        currentTilt >= 0.16 && currentTilt <= 5
      if (fallbackSpeech) {
        this.manualVadHoldFrames = this.MANUAL_HOLD_FRAMES
      } else if (!this.sileroVadHealthy && this.manualVadHoldFrames > 0) {
        this.manualVadHoldFrames--
      }

      const isSpeaking = this.thresholdMode === 'manual'
        ? this.manualVadHoldFrames > 0
        : this.sileroVadEnabled && this.sileroVadHealthy
          ? this.speechSegmentOpen
          : this.manualVadHoldFrames > 0

      const writeIndex = this.speechRingWriteIndex
      this.speechRingSpeech[writeIndex] = isSpeaking ? 1 : 0
      this.speechRingFrameIds[writeIndex] = this.audioFrameId
      this.speechRingRms[writeIndex] = currentRms
      this.speechRingZcr[writeIndex] = currentZcr
      this.speechRingTilt[writeIndex] = currentTilt
      this.speechRingFrames[writeIndex].set(this.frameToProcess)
      this.speechRingWriteIndex = (writeIndex + 1) % this.speechRingSpeech.length
      this.speechRingCount++
      this.audioFrameId++

      const readIndex = this.speechRingWriteIndex
      const hasDelayedFrame = this.speechRingCount > this.DECISION_DELAY_FRAMES
      const delayedIsSpeech = hasDelayedFrame && this.speechRingSpeech[readIndex] === 1

      const reportedSpeaking = measureWhileMuted ? false : isSpeaking
      if (this.lastVadSent !== reportedSpeaking) {
        this.port.postMessage({ type: 'vad', isSpeaking: reportedSpeaking })
        this.lastVadSent = reportedSpeaking
      }

      const delayedFrame = this.speechRingFrames[readIndex]
      let outputFrame: Float32Array | null = delayedFrame
      if (hasDelayedFrame && this.noiseSuppression && this.denoiserReady && this.denoiser) {
        try {
          const denoised = this.denoiser.processStreaming(delayedFrame)
          outputFrame = denoised.length === this.FRAME_SIZE ? denoised : null
        } catch (error) {
          outputFrame = null
          this.denoiserErrorCount++
          if (this.denoiserErrorCount <= 3 || this.denoiserErrorCount % 100 === 0) {
            this.port.postMessage({
              type: 'log',
              message: `DeepFilter frame failed (${this.denoiserErrorCount}): ${error instanceof Error ? error.message : String(error)}`
            })
          }
        }
      }
      if (!hasDelayedFrame || (this.noiseSuppression && !this.denoiserReady)) {
        // Warm-up, or the denoiser has not initialized yet: stay silent rather
        // than leak raw, unprocessed microphone noise into the stream.
        this.processedFrame.fill(0)
        this.gateGain = 0
      } else if (!this.noiseSuppression) {
        this.processedFrame.set(delayedFrame)
        this.gateGain = 1
      } else if (!outputFrame) {
        // A denoiser frame failure must never expose the raw microphone to the stream.
        this.processedFrame.fill(0)
        this.gateGain = 0
      } else {
        // DeepFilter keeps its recurrent state on every frame, then Silero alone
        // decides what may enter the automatic-mode stream.
        const targetGain = delayedIsSpeech ? 1 : this.GATE_FLOOR
        const attackCoefficient = 1 / 48 // ~1 ms at 48 kHz
        const releaseCoefficient = 1 / 480 // ~10 ms at 48 kHz
        for (let i = 0; i < this.FRAME_SIZE; i++) {
          const coefficient = targetGain > this.gateGain ? attackCoefficient : releaseCoefficient
          this.gateGain += (targetGain - this.gateGain) * coefficient
          this.processedFrame[i] = outputFrame[i] * this.gateGain
        }
      }
      this.gateWasOpen = delayedIsSpeech

      if (this.calibrationFramesLeft > 0) {
        const elapsedFrames = this.calibrationTotalFrames - this.calibrationFramesLeft
        this.calibrationFramesLeft--
        const silenceStageFrames = Math.floor(this.calibrationTotalFrames * 0.3)
        const speechStageEnd = Math.floor(this.calibrationTotalFrames * 0.8)
        const phaseGuardFrames = Math.min(20, Math.floor(this.calibrationTotalFrames * 0.02))
        const calibrationVadFloor = this.calibrationMode === 'manual'
          ? Math.max(0.03, Math.min(0.08, this.vadOnThreshold + 0.01))
          : this.vadOffThreshold
        const isManualSilenceStage = this.calibrationMode === 'manual' &&
          elapsedFrames >= phaseGuardFrames && elapsedFrames < silenceStageFrames - phaseGuardFrames
        const isManualSpeechStage = this.calibrationMode === 'manual' &&
          elapsedFrames >= silenceStageFrames + phaseGuardFrames && elapsedFrames < speechStageEnd - phaseGuardFrames
        const collectNoise = this.calibrationMode === 'probe' || isManualSilenceStage

        const normalizedRms = currentRms / this.gainFactor
        const normalizedPeak = currentPeak / this.gainFactor
        if (collectNoise) {
          // Keep the trailing level history regardless of the decision below, so
          // the reference can never depend on its own outcome. A low percentile
          // survives speech-shaped content that fills most of the stage.
          this.calibrationSilenceHistory[this.calibrationSilenceHistoryIndex] = normalizedRms
          this.calibrationSilenceHistoryIndex =
            (this.calibrationSilenceHistoryIndex + 1) % this.calibrationSilenceHistory.length
          this.calibrationSilenceHistoryCount++
          if (this.calibrationSilenceHistoryCount % 10 === 0) {
            const filled = Math.min(this.calibrationSilenceHistoryCount, this.calibrationSilenceHistory.length)
            const recent = this.calibrationSilenceScratch.subarray(0, filled)
            recent.set(this.calibrationSilenceHistory.subarray(0, filled))
            recent.sort()
            this.calibrationSilenceLevel = recent[Math.floor((filled - 1) * 0.4)]
          }
        }
        // Distant speech - a television in another room, a conversation at the far
        // end of the apartment - is background noise for this microphone, and the
        // denoiser is expected to remove exactly that, so it belongs in the noise
        // profile instead of aborting calibration. Only the user's own voice has to
        // stay out of it, and near-field speech is ~18 dB above the room level
        // measured in this very stage. The former test rejected any Silero
        // detection above -74 dBFS, which on a quiet microphone is the room tone
        // itself, so one distant conversation could reject the whole stage and
        // report that silence was required. Heavier contamination than this filter
        // can catch is still caught twice: the noise floor is a median, and a
        // speech-dominated silence stage collapses the final SNR.
        const nearFieldSpeechFloor = Math.max(this.calibrationSilenceLevel * 8, 0.0008)
        const containsSpeech = this.sileroVadProbability >= calibrationVadFloor &&
          normalizedRms >= nearFieldSpeechFloor

        // The manual calibration prompt defines the silence phase. Keep its room
        // sound, but exclude frames independently identified as speech so starting
        // the phrase slightly early cannot inflate the measured noise floor.
        if (collectNoise && !containsSpeech && this.calibrationCount < this.calibrationRms.length) {
          this.calibrationRms[this.calibrationCount] = normalizedRms
          this.calibrationCount++
          this.calibrationZcrSum += zeroCrossings / (this.FRAME_SIZE - 1)
          this.calibrationSpectralTiltSum += Math.sqrt(highBandSquares / Math.max(1e-12, lowBandSquares))
        } else if (collectNoise && containsSpeech) {
          this.calibrationRejectedSpeechFrames++
        }

        if (elapsedFrames === silenceStageFrames && this.calibrationCount > 0) {
          // Median, not a high percentile: the noise profile may now legitimately
          // contain distant speech, and its louder moments must not raise the
          // sustained-speech floor of the next stage above the user's own voice.
          const noiseSamples = Array.from(this.calibrationRms.subarray(0, this.calibrationCount)).sort((a, b) => a - b)
          this.calibrationNoiseReference = noiseSamples[Math.floor((noiseSamples.length - 1) * 0.5)]
          // The voiced bar follows the room's own spread instead of a fixed margin.
          // Just above the loud edge of the silence stage is exactly the level no
          // noise frame reaches, and the bounds keep it usable at both extremes:
          // never under +2.5 dB, so a stationary room cannot pass its own tone as
          // voice, and never over +6 dB, so a built-in microphone whose voice rises
          // only 4 dB above the room still registers the phrase it just captured.
          const loudNoiseEdge = noiseSamples[Math.floor((noiseSamples.length - 1) * 0.8)] * 1.122
          this.calibrationVoicedFloor = Math.max(0.0004, Math.min(
            this.calibrationNoiseReference * 1.995,
            Math.max(this.calibrationNoiseReference * 1.334, loudNoiseEdge)
          ))
        }

        // The speech phase is also explicit in the UI. Keep all audible frames so
        // a missed Silero decision cannot produce an empty speech profile. The
        // percentile estimator rejects brief pauses without requiring VAD success.
        if (isManualSpeechStage) {
          this.calibrationSpeechWindowFrames++
          // Sustained-speech evidence, measured against the bar derived from this
          // run's own silence stage so it stays independent of the device's raw
          // sensitivity and of how live the room is. Stop closures inside words
          // must not break a run, so up to 60 ms of silence is bridged before the
          // current run is considered finished.
          if (normalizedRms >= this.calibrationVoicedFloor) {
            this.calibrationSpeechActiveFrames++
            this.calibrationSpeechRunFrames++
            this.calibrationSpeechGapFrames = 0
            if (this.calibrationSpeechRunFrames > this.calibrationSpeechLongestRun) {
              this.calibrationSpeechLongestRun = this.calibrationSpeechRunFrames
            }
          } else if (++this.calibrationSpeechGapFrames > 6) {
            this.calibrationSpeechRunFrames = 0
          }
          if (normalizedRms >= 0.0001 && this.calibrationSpeechCount < this.calibrationSpeechRms.length) {
            this.calibrationSpeechRms[this.calibrationSpeechCount] = normalizedRms
            this.calibrationSpeechPeaks[this.calibrationSpeechCount] = normalizedPeak
            this.calibrationSpeechCount++
          }
        }

        if (this.calibrationFramesLeft === 0) {
          const samples = Array.from(this.calibrationRms.subarray(0, this.calibrationCount)).sort((a, b) => a - b)
          const speechRmsFrames = Array.from(this.calibrationSpeechRms.subarray(0, this.calibrationSpeechCount))
          const speechPeakFrames = Array.from(this.calibrationSpeechPeaks.subarray(0, this.calibrationSpeechCount))
          const speechVadFrames = Array.from(this.calibrationSpeechVad.subarray(0, this.calibrationSpeechVadCount))
          const speechVadRmsFrames = Array.from(this.calibrationSpeechVadRms.subarray(0, this.calibrationSpeechVadCount))
          const allSpeechSamples = [...speechRmsFrames].sort((a, b) => a - b)
          const noiseVadSamples = Array.from(this.calibrationNoiseVad.subarray(0, this.calibrationNoiseVadCount)).sort((a, b) => a - b)
          const percentile = (values: number[], p: number) => values.length
            ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))]
            : 0
          const measuredNoise = percentile(samples, 0.5)
          // Select the active-energy portion of the prompted phrase. This removes
          // pauses robustly without making successful calibration depend on Silero.
          const activeSpeechFloor = Math.max(measuredNoise * 1.08, percentile(allSpeechSamples, 0.3))
          const speechSamples = speechRmsFrames.filter(value => value >= activeSpeechFloor).sort((a, b) => a - b)
          const speechPeaks = speechPeakFrames
            .filter((_, index) => speechRmsFrames[index] >= activeSpeechFloor)
            .sort((a, b) => a - b)
          // Keep each Silero probability paired with the raw acoustic frame that
          // produced it. Filtering probabilities against noise first biased the
          // low speech quantile upward and could make calibrated gates miss quiet
          // consonants. Acoustic activity selects speech candidates; Silero then
          // supplies their complete probability distribution without truncation.
          const vadActiveSpeechFloor = Math.max(measuredNoise * 1.08, percentile([...speechVadRmsFrames].sort((a, b) => a - b), 0.3))
          const activeSpeechVad = speechVadFrames
            .filter((_, index) => speechVadRmsFrames[index] >= vadActiveSpeechFloor)
            .sort((a, b) => a - b)
          const noiseVadMedian = percentile(noiseVadSamples, 0.5)
          const noiseVadHigh = percentile(noiseVadSamples, 0.95)
          const speechVadLow = percentile(activeSpeechVad, 0.05)
          const speechVadMedian = percentile(activeSpeechVad, 0.5)
          // Speech evidence must clear a real probability, not merely rise above a
          // silent room. Anchor the floor at 0.04 and always above the measured
          // noise distribution: quiet microphones still qualify, while a Silero
          // output of a few percent - what room tone, clicks and breath produce -
          // no longer counts as a spoken phrase. The 0.5 cap keeps the test
          // reachable in a room whose own background is speech-shaped: there the
          // noise distribution reaches 0.9, and telling that background from the
          // user is the job of the sustained-energy measurement, not of a threshold
          // no near-field phrase could clear.
          const speechEvidenceThreshold = Math.min(0.5, Math.max(0.04, noiseVadHigh + 0.01))
          const confirmedSpeechVad = activeSpeechVad.filter(probability => probability >= speechEvidenceThreshold)
          const confirmedSpeechVadFrames = confirmedSpeechVad.length
          const confirmedSpeechVadRatio = confirmedSpeechVadFrames / Math.max(1, activeSpeechVad.length)
          // The lowest confirmed probability is the speech anchor for the gate.
          // The 5th percentile of every active window (speechVadLow) also contains
          // inter-word gaps, so it collapses to zero for any real phrase and drove
          // the derived opening threshold onto its clamp on every run.
          const confirmedSpeechVadLow = percentile(confirmedSpeechVad, 0.1)
          // Longest sustained confirmed run, in 32 ms windows, tolerating a single
          // dropped window. A phrase produces seconds of it; a cough produces one
          // isolated burst that must not be accepted as calibrated speech.
          //
          // Deliberately measured WITHOUT the active-energy mask that the frame
          // count above applies, so the two numbers describe different populations
          // and a run larger than the frame count is expected, not a bug. The mask
          // punches holes at every inter-word gap - energy drops instantly there
          // while Silero holds its probability across the gap - and this run is the
          // evidence that rescues a low-sensitivity capture whose voice rises only
          // 4 dB above the room, where no energy bar can be cleared at all. The
          // acoustic requirement is not lost: the masked frame count is required
          // alongside this run, so at least part of the stretch has to sit above
          // the measured room level.
          let confirmedRun = 0
          let confirmedGap = 0
          let confirmedSpeechVadRun = 0
          let maskedRun = 0
          let maskedGap = 0
          let confirmedSpeechVadRunActive = 0
          for (let index = 0; index < speechVadFrames.length; index++) {
            if (speechVadRmsFrames[index] >= vadActiveSpeechFloor &&
              speechVadFrames[index] >= speechEvidenceThreshold) {
              maskedRun++
              maskedGap = 0
              if (maskedRun > confirmedSpeechVadRunActive) confirmedSpeechVadRunActive = maskedRun
            } else if (++maskedGap > 1) {
              maskedRun = 0
            }
            if (speechVadFrames[index] >= speechEvidenceThreshold) {
              confirmedRun++
              confirmedGap = 0
              if (confirmedRun > confirmedSpeechVadRun) confirmedSpeechVadRun = confirmedRun
            } else if (++confirmedGap > 1) {
              confirmedRun = 0
            }
          }
          this.port.postMessage({
            type: this.calibrationMode === 'probe' ? 'environmentProbeResult' : 'calibrationResult',
            noiseFloor: measuredNoise,
            lowNoise: percentile(samples, 0.2),
            peakNoise: percentile(samples, 0.95),
            speechRms: percentile(speechSamples, 0.5),
            quietSpeechRms: percentile(speechSamples, 0.2),
            speechPeak: percentile(speechPeaks, 0.95),
            noiseVadMedian,
            noiseVadHigh,
            speechVadLow,
            speechVadMedian,
            speechVadFrames: activeSpeechVad.length,
            confirmedSpeechVadFrames,
            confirmedSpeechVadRatio,
            confirmedSpeechVadLow,
            confirmedSpeechVadRun,
            confirmedSpeechVadRunActive,
            speechEvidenceThreshold,
            speechFrames: this.calibrationSpeechCount,
            speechWindowFrames: this.calibrationSpeechWindowFrames,
            speechActiveFrames: this.calibrationSpeechActiveFrames,
            speechLongestRunFrames: this.calibrationSpeechLongestRun,
            zeroCrossingRate: this.calibrationZcrSum / Math.max(1, this.calibrationCount),
            spectralTilt: this.calibrationSpectralTiltSum / Math.max(1, this.calibrationCount),
            acceptedFrames: this.calibrationCount,
            rejectedSpeechFrames: this.calibrationRejectedSpeechFrames,
            silenceReference: this.calibrationSilenceLevel,
            voicedFloor: this.calibrationVoicedFloor
          })
        }
      }

      if (measureWhileMuted) {
        // The calibration above already measured the real frame; the stream must
        // still receive nothing but silence while the user is muted.
        this.processedFrame.fill(0)
        this.gateGain = 0
      }
      this.outputWriteIndex = this.pushToBuffer(this.outputBuffer, this.processedFrame, this.outputWriteIndex, this.outputReadIndex)
    }

    const availableOutput = (this.outputWriteIndex - this.outputReadIndex + this.BUFFER_SIZE) % this.BUFFER_SIZE
    if (availableOutput >= outputChannel.length) {
      this.outputReadIndex = this.pullFromBuffer(this.outputBuffer, outputChannel, this.outputWriteIndex, this.outputReadIndex)
    } else {
      outputChannel.fill(0)
    }

    return true
  }
}

registerProcessor('deepfilter-processor', DeepFilterProcessor)
