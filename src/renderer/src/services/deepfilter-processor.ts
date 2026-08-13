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

  private isMuted = false
  private noiseSuppression = true

  private rmsSmoothed = 0
  private lastVadSent = false
  private overflowCount = 0
  private denoiserErrorCount = 0

  private readonly VAD_FRAME_SIZE = 512
  private readonly VAD_ON_THRESHOLD = 0.13
  private readonly VAD_OFF_THRESHOLD = 0.07
  // Fixed hangover prevents short Silero confidence gaps from closing the gate
  // inside a word or a sustained vowel. It never depends on live signal level.
  private readonly VAD_HOLD_FRAMES = 45
  // Preserve up to 120 ms before Silero confirms voice, so word-initial unvoiced
  // consonants survive. The buffered audio is released only after speech proof.
  private readonly DECISION_DELAY_FRAMES = 12
  private vadOnThreshold = this.VAD_ON_THRESHOLD
  private vadOffThreshold = this.VAD_OFF_THRESHOLD
  private vadHoldFrames = 0
  private lastVadSequence = -1

  private readonly speechRingSpeech: Uint8Array
  private readonly speechRingFrames: Float32Array[] = []
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

  private readonly MIN_ATTEN_LIMIT = 6
  private readonly MAX_ATTEN_LIMIT = 36
  private attenuationLimit = 30
  private postFilterBeta = 0.002
  private cdnUrl: string | undefined

  private thresholdMode = 'auto'
  private noiseFloorEstimate = 0.003
  private sileroVadEnabled = false
  private sileroVadProbability = 0.0
  private readonly vad16kBuffer = new Float32Array(this.VAD_FRAME_SIZE)
  private vad16kWriteIndex = 0
  private vadSequence = 0

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

  private dsMem0 = 0
  private dsMem1 = 0
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
    this.speechRingRms = new Float32Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingZcr = new Float32Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingTilt = new Float32Array(this.DECISION_DELAY_FRAMES + 1)
    for (let i = 0; i < this.speechRingSpeech.length; i++) {
      this.speechRingFrames.push(new Float32Array(this.FRAME_SIZE))
    }
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
            this.vadHoldFrames = 0
            this.lastVadSequence = -1
            this.speechRingWriteIndex = 0
            this.speechRingCount = 0
            this.gateWasOpen = false
            this.gateGain = 0
            this.speechRingSpeech.fill(0)
            this.speechRingRms.fill(0)
            this.speechRingZcr.fill(0)
            this.speechRingTilt.fill(0)
            for (const frame of this.speechRingFrames) frame.fill(0)
            this.vad16kWriteIndex = 0
            this.vad16kBuffer.fill(0)
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
          this.postFilterBeta = Math.max(0.0, Math.min(0.003, event.data.postFilterBeta))
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
        this.port.postMessage({ type: 'log', message: 'Calibration started' })
      } else if (event.data.type === 'setSileroVadProbability') {
        if (this.isMuted || !this.sileroVadEnabled) return
        const sequence = Number(event.data.sequence)
        if (!Number.isFinite(sequence) || sequence <= this.lastVadSequence) return

        this.lastVadSequence = sequence
        this.sileroVadProbability = Math.max(0, Math.min(1, Number(event.data.probability) || 0))

        const isVoiceOnset = this.sileroVadProbability >= this.vadOnThreshold

        if (isVoiceOnset) {
          this.vadHoldFrames = this.VAD_HOLD_FRAMES
          // The VAD result arrives after its audio. Open every frame still in the
          // look-ahead queue so whispered and plosive onsets are not truncated.
          this.speechRingSpeech.fill(1)
        } else if (this.vadHoldFrames > 0 && this.sileroVadProbability >= this.vadOffThreshold) {
          // Sustain speech across short intra-word dips without leaving the gate
          // open long enough for clicks after a phrase to leak through.
          this.vadHoldFrames = this.VAD_HOLD_FRAMES
        }
      }
    }
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

    this.inputWriteIndex = this.pushToBuffer(this.inputBuffer, inputChannel, this.inputWriteIndex, this.inputReadIndex)

    while ((this.inputWriteIndex - this.inputReadIndex + this.BUFFER_SIZE) % this.BUFFER_SIZE >= this.FRAME_SIZE) {
      this.inputReadIndex = this.pullFromBuffer(this.inputBuffer, this.frameToProcess, this.inputWriteIndex, this.inputReadIndex)

      for (let i = 0; i < this.FRAME_SIZE; i += 3) {
        const s0 = this.frameToProcess[i]
        const s1 = this.frameToProcess[i + 1]
        const s2 = this.frameToProcess[i + 2]

        this.dsMem0 = 0.5 * this.dsMem0 + 0.25 * s0 + 0.25 * s1
        this.dsMem1 = 0.5 * this.dsMem1 + 0.25 * s1 + 0.25 * s2
        const filteredSample = 0.5 * (this.dsMem0 + this.dsMem1)

        // Silero is trained for linear PCM. Boosting and clipping impulses makes
        // finger clicks and keyboard transients look more speech-like.
        this.vad16kBuffer[this.vad16kWriteIndex++] = Math.max(-1.0, Math.min(1.0, filteredSample))

        if (this.vad16kWriteIndex === this.VAD_FRAME_SIZE) {
          const audioFrame = this.vad16kBuffer.slice()
          this.port.postMessage(
            { type: 'audio16k', audio: audioFrame, sequence: this.vadSequence++ },
            [audioFrame.buffer]
          )
          this.vad16kWriteIndex = 0
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

      if (this.thresholdMode === 'manual') {
        if (currentDb >= this.manualThresholdDb) {
          this.manualVadHoldFrames = this.VAD_HOLD_FRAMES
        } else if (this.manualVadHoldFrames > 0) {
          // Hysteresis: once open, keep the gate open through the quiet tail of a
          // word (down to 6 dB below the threshold) instead of chopping consonants.
          if (currentDb >= this.manualThresholdDb - 6) {
            this.manualVadHoldFrames = this.VAD_HOLD_FRAMES
          } else {
            this.manualVadHoldFrames--
          }
        }
      } else if (this.vadHoldFrames > 0) {
        this.vadHoldFrames--
      }

      const isSpeaking = this.thresholdMode === 'manual'
        ? this.manualVadHoldFrames > 0
        : this.sileroVadEnabled && this.vadHoldFrames > 0

      const writeIndex = this.speechRingWriteIndex
      this.speechRingSpeech[writeIndex] = isSpeaking ? 1 : 0
      this.speechRingRms[writeIndex] = currentRms
      this.speechRingZcr[writeIndex] = currentZcr
      this.speechRingTilt[writeIndex] = currentTilt
      this.speechRingFrames[writeIndex].set(this.frameToProcess)
      this.speechRingWriteIndex = (writeIndex + 1) % this.speechRingSpeech.length
      this.speechRingCount++

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
        const containsSpeech = this.sileroVadProbability >= calibrationVadFloor
        const isManualSilenceStage = this.calibrationMode === 'manual' &&
          elapsedFrames >= phaseGuardFrames && elapsedFrames < silenceStageFrames - phaseGuardFrames
        const isManualSpeechStage = this.calibrationMode === 'manual' &&
          elapsedFrames >= silenceStageFrames + phaseGuardFrames && elapsedFrames < speechStageEnd - phaseGuardFrames
        const collectNoise = this.calibrationMode === 'probe' || isManualSilenceStage

        const normalizedRms = currentRms / this.gainFactor
        const normalizedPeak = currentPeak / this.gainFactor

        if (collectNoise && this.calibrationNoiseVadCount < this.calibrationNoiseVad.length) {
          this.calibrationNoiseVad[this.calibrationNoiseVadCount++] = this.sileroVadProbability
        }

        if (collectNoise && !containsSpeech && this.calibrationCount < this.calibrationRms.length) {
          this.calibrationRms[this.calibrationCount] = normalizedRms
          this.calibrationCount++
          this.calibrationZcrSum += zeroCrossings / (this.FRAME_SIZE - 1)
          this.calibrationSpectralTiltSum += Math.sqrt(highBandSquares / Math.max(1e-12, lowBandSquares))
        } else if (collectNoise && containsSpeech) {
          this.calibrationRejectedSpeechFrames++
        }

        if (elapsedFrames === silenceStageFrames && this.calibrationCount > 0) {
          const noiseSamples = Array.from(this.calibrationRms.subarray(0, this.calibrationCount)).sort((a, b) => a - b)
          this.calibrationNoiseReference = noiseSamples[Math.floor((noiseSamples.length - 1) * 0.8)]
        }

        // Bias below the noise reference so quiet speech is still collected as
        // speech during calibration and does not skew the profile toward silence.
        const energyIndicatesSpeech = normalizedRms >= Math.max(0.0007, this.calibrationNoiseReference * 1.3) &&
          (currentZcr >= 0.02 || currentTilt >= 0.18)
        if (isManualSpeechStage && (containsSpeech || energyIndicatesSpeech) && this.calibrationSpeechCount < this.calibrationSpeechRms.length) {
          this.calibrationSpeechRms[this.calibrationSpeechCount] = normalizedRms
          this.calibrationSpeechPeaks[this.calibrationSpeechCount] = normalizedPeak
          this.calibrationSpeechVad[this.calibrationSpeechCount] = this.sileroVadProbability
          this.calibrationSpeechCount++
        }

        if (this.calibrationFramesLeft === 0) {
          const samples = Array.from(this.calibrationRms.subarray(0, this.calibrationCount)).sort((a, b) => a - b)
          const speechSamples = Array.from(this.calibrationSpeechRms.subarray(0, this.calibrationSpeechCount)).sort((a, b) => a - b)
          const speechPeaks = Array.from(this.calibrationSpeechPeaks.subarray(0, this.calibrationSpeechCount)).sort((a, b) => a - b)
          const noiseVadSamples = Array.from(this.calibrationNoiseVad.subarray(0, this.calibrationNoiseVadCount)).sort((a, b) => a - b)
          const speechVadSamples = Array.from(this.calibrationSpeechVad.subarray(0, this.calibrationSpeechCount)).sort((a, b) => a - b)
          const percentile = (values: number[], p: number) => values.length
            ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))]
            : 0
          const noiseVadHigh = percentile(noiseVadSamples, 0.95)
          const speechVadAboveNoise = speechVadSamples.filter(probability => probability >= noiseVadHigh + 0.002)
          this.port.postMessage({
            type: this.calibrationMode === 'probe' ? 'environmentProbeResult' : 'calibrationResult',
            noiseFloor: percentile(samples, 0.5),
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
