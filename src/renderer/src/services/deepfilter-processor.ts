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
  private readonly vadDecimatorTaps = new Float32Array(21)
  private readonly vadDecimatorHistory = new Float32Array(21)
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
  private calibrationTotalFrames = 0
  private calibrationCount = 0
  private calibrationSpeechCount = 0
  private calibrationNoiseVadCount = 0
  private calibrationRejectedSpeechFrames = 0
  private calibrationZcrSum = 0
  private calibrationSpectralTiltSum = 0
  private calibrationNoiseReference = 0.003

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
    // Windowed-sinc low-pass for clean 48 -> 16 kHz decimation. The previous
    // two-state approximation changed the spectral shape of quiet consonants and
    // made Silero less stable on some microphones.
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
          if (nextMuted && !this.isMuted) {
            this.inputBuffer.fill(0)
            this.outputBuffer.fill(0)
            this.inputReadIndex = 0
            this.inputWriteIndex = 0
            this.outputReadIndex = 0
            this.outputWriteIndex = this.FRAME_SIZE * 2
            this.rmsSmoothed = 0
            this.speechSegmentOpen = false
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
            ? Math.max(0.025, Math.min(0.20, vadOnThreshold))
            : this.VAD_ON_THRESHOLD
          this.vadOffThreshold = Number.isFinite(vadOffThreshold)
            ? Math.max(0.012, Math.min(this.vadOnThreshold - 0.008, vadOffThreshold))
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
        this.calibrationCount = 0
        this.calibrationSpeechCount = 0
        this.calibrationNoiseVadCount = 0
        this.calibrationRejectedSpeechFrames = 0
        this.calibrationZcrSum = 0
        this.calibrationSpectralTiltSum = 0
        this.calibrationNoiseReference = this.noiseFloorEstimate
        // Do not let a VAD decision from the preceding conversation contaminate
        // the first silence stage of a new one-shot calibration.
        this.sileroVadProbability = 0
        this.speechSegmentOpen = false
        this.consecutiveVadSilenceResults = 0
        this.port.postMessage({ type: 'log', message: 'Calibration started' })
      } else if (event.data.type === 'setSileroVadProbability') {
        if (this.isMuted || !this.sileroVadEnabled) return
        const sequence = Number(event.data.sequence)
        const endFrameId = Number(event.data.endFrameId)
        const windowRms = Number(event.data.windowRms)
        if (!Number.isFinite(sequence) || sequence <= this.lastVadSequence) return

        this.lastVadSequence = sequence
        this.sileroVadHealthy = true
        this.lastSileroResultFrameId = Number.isFinite(endFrameId) ? endFrameId : this.audioFrameId
        this.sileroVadProbability = Math.max(0, Math.min(1, Number(event.data.probability) || 0))

        if (this.sileroVadProbability >= this.vadOnThreshold) {
          this.speechSegmentOpen = true
          this.consecutiveVadSilenceResults = 0
          if (Number.isFinite(endFrameId)) {
            this.markBufferedSpeechFrom(endFrameId - this.SPEECH_PREROLL_FRAMES)
          }
        } else if (this.speechSegmentOpen) {
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
      this.port.postMessage({ type: 'log', message: 'DeepFilterNet3 initialization failed: ' + (e instanceof Error ? e.message : String(e)) })
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

    if (this.isMuted) {
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

      if (this.lastVadSent !== isSpeaking) {
        this.port.postMessage({ type: 'vad', isSpeaking })
        this.lastVadSent = isSpeaking
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
        const calibrationVadFloor = this.calibrationMode === 'manual' ? this.VAD_OFF_THRESHOLD : this.vadOffThreshold
        const isManualSilenceStage = this.calibrationMode === 'manual' &&
          elapsedFrames >= phaseGuardFrames && elapsedFrames < silenceStageFrames - phaseGuardFrames
        const isManualSpeechStage = this.calibrationMode === 'manual' &&
          elapsedFrames >= silenceStageFrames + phaseGuardFrames && elapsedFrames < speechStageEnd - phaseGuardFrames
        const collectNoise = this.calibrationMode === 'probe' || isManualSilenceStage

        const normalizedRms = currentRms / this.gainFactor
        const normalizedPeak = currentPeak / this.gainFactor
        // During the silence stage, a false-positive VAD result must not reject
        // genuinely quiet room noise. A fixed acoustic floor still rejects normal
        // speech (which is several dB above 0.0015 RMS) from the noise profile.
        const noiseEnergyFloor = 0.0015
        const containsSpeech = this.sileroVadProbability >= calibrationVadFloor &&
          normalizedRms >= noiseEnergyFloor

        if (collectNoise && this.calibrationNoiseVadCount < this.calibrationNoiseVad.length) {
          this.calibrationNoiseVad[this.calibrationNoiseVadCount++] = this.sileroVadProbability
        }

        // The manual calibration prompt defines the silence phase. Collect every
        // frame in that phase and use robust percentiles later; Silero is only a
        // diagnostic signal here and must not make a valid calibration fail.
        if (collectNoise && this.calibrationCount < this.calibrationRms.length) {
          this.calibrationRms[this.calibrationCount] = normalizedRms
          this.calibrationCount++
          this.calibrationZcrSum += zeroCrossings / (this.FRAME_SIZE - 1)
          this.calibrationSpectralTiltSum += Math.sqrt(highBandSquares / Math.max(1e-12, lowBandSquares))
          if (containsSpeech) {
            this.calibrationRejectedSpeechFrames++
          }
        } else if (collectNoise && containsSpeech) {
          this.calibrationRejectedSpeechFrames++
        }

        if (elapsedFrames === silenceStageFrames && this.calibrationCount > 0) {
          const noiseSamples = Array.from(this.calibrationRms.subarray(0, this.calibrationCount)).sort((a, b) => a - b)
          this.calibrationNoiseReference = noiseSamples[Math.floor((noiseSamples.length - 1) * 0.8)]
        }

        // The speech phase is also explicit in the UI. Keep all audible frames so
        // a missed Silero decision cannot produce an empty speech profile. The
        // percentile estimator rejects brief pauses without requiring VAD success.
        if (isManualSpeechStage && normalizedRms >= 0.0001 && this.calibrationSpeechCount < this.calibrationSpeechRms.length) {
          this.calibrationSpeechRms[this.calibrationSpeechCount] = normalizedRms
          this.calibrationSpeechPeaks[this.calibrationSpeechCount] = normalizedPeak
          this.calibrationSpeechVad[this.calibrationSpeechCount] = this.sileroVadProbability
          this.calibrationSpeechCount++
        }

        if (this.calibrationFramesLeft === 0) {
          const samples = Array.from(this.calibrationRms.subarray(0, this.calibrationCount)).sort((a, b) => a - b)
          const allSpeechSamples = Array.from(this.calibrationSpeechRms.subarray(0, this.calibrationSpeechCount)).sort((a, b) => a - b)
          const allSpeechPeaks = Array.from(this.calibrationSpeechPeaks.subarray(0, this.calibrationSpeechCount)).sort((a, b) => a - b)
          const noiseVadSamples = Array.from(this.calibrationNoiseVad.subarray(0, this.calibrationNoiseVadCount)).sort((a, b) => a - b)
          const speechVadSamples = Array.from(this.calibrationSpeechVad.subarray(0, this.calibrationSpeechCount)).sort((a, b) => a - b)
          const percentile = (values: number[], p: number) => values.length
            ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))]
            : 0
          const measuredNoise = percentile(samples, 0.5)
          // Select the active-energy portion of the prompted phrase. This removes
          // pauses robustly without making successful calibration depend on Silero.
          const activeSpeechFloor = Math.max(measuredNoise * 1.08, percentile(allSpeechSamples, 0.3))
          const speechSamples = allSpeechSamples.filter(value => value >= activeSpeechFloor)
          const speechPeaks = allSpeechPeaks.filter(value => value >= activeSpeechFloor)
          const noiseVadHigh = percentile(noiseVadSamples, 0.95)
          const speechVadAboveNoise = speechVadSamples.filter(probability => probability >= noiseVadHigh + 0.002)
          this.port.postMessage({
            type: this.calibrationMode === 'probe' ? 'environmentProbeResult' : 'calibrationResult',
            noiseFloor: measuredNoise,
            lowNoise: percentile(samples, 0.2),
            peakNoise: percentile(samples, 0.95),
            speechRms: percentile(speechSamples, 0.5),
            quietSpeechRms: percentile(speechSamples, 0.2),
            speechPeak: percentile(speechPeaks, 0.95),
            noiseVadHigh,
            speechVadLow: percentile(speechVadAboveNoise, 0.15),
            speechVadMedian: percentile(speechVadAboveNoise, 0.5),
            speechVadFrames: speechVadAboveNoise.length,
            speechFrames: this.calibrationSpeechCount,
            zeroCrossingRate: this.calibrationZcrSum / Math.max(1, this.calibrationCount),
            spectralTilt: this.calibrationSpectralTiltSum / Math.max(1, this.calibrationCount),
            acceptedFrames: this.calibrationCount,
            rejectedSpeechFrames: this.calibrationRejectedSpeechFrames
          })
        }
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
