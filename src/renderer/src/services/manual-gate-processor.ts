export {}

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

class ManualGateProcessor extends AudioWorkletProcessor {
  private readonly LOOKAHEAD_SAMPLES = 1_440
  private readonly HOLD_SAMPLES = 12_000
  private readonly HYSTERESIS_DB = 6
  private readonly MIN_THRESHOLD_DB = -60
  private readonly MAX_THRESHOLD_DB = -12
  private readonly DEFAULT_THRESHOLD_DB = -42
  private readonly MAKEUP_GAIN = 3.1622776601683795
  private readonly GATE_ATTACK = 1 / 144
  private readonly GATE_RELEASE = 1 / 5_760
  private readonly METER_INTERVAL_SAMPLES = 2_400

  private readonly delayLine = new Float32Array(this.LOOKAHEAD_SAMPLES)
  private delayIndex = 0
  private monoInput = new Float32Array(0)

  private thresholdDb = this.DEFAULT_THRESHOLD_DB
  private isMuted = false
  private monitorWhileMuted = false
  private gateOpen = false
  private holdRemaining = 0
  private gateGain = 0
  private lastVadSent = false

  private meterSquareSum = 0
  private meterSampleCount = 0
  private meterDb = -100

  constructor() {
    super()

    this.port.onmessage = (event) => {
      const message = event.data
      if (message.type === 'setConfig') {
        if (message.monitorWhileMuted !== undefined) this.monitorWhileMuted = Boolean(message.monitorWhileMuted)
        if (message.isMuted !== undefined) this.setMuted(Boolean(message.isMuted))
        if (message.manualThresholdValue !== undefined) this.applyThreshold(Number(message.manualThresholdValue))
      } else if (message.type === 'setCalibratedParams') {
        if (message.manualThresholdValue !== undefined) this.applyThreshold(Number(message.manualThresholdValue))
      }
    }

    this.port.postMessage({ type: 'ready' })
  }

  private applyThreshold(value: number) {
    const threshold = Number.isFinite(value) ? value : this.DEFAULT_THRESHOLD_DB
    this.thresholdDb = Math.max(this.MIN_THRESHOLD_DB, Math.min(this.MAX_THRESHOLD_DB, threshold))
  }

  private setMuted(muted: boolean) {
    if (muted && !this.isMuted && !this.monitorWhileMuted) {
      this.delayLine.fill(0)
      this.gateGain = 0
      this.gateOpen = false
      this.holdRemaining = 0
      this.reportSpeaking(false)
    }
    this.isMuted = muted
  }

  private reportSpeaking(isSpeaking: boolean) {
    if (isSpeaking === this.lastVadSent) return
    this.lastVadSent = isSpeaking
    this.port.postMessage({ type: 'vad', isSpeaking })
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const output = outputs[0]
    if (!output?.length) return true

    const outputChannel = output[0]
    const frames = outputChannel.length

    if (!input?.length || !input[0]?.length) {
      outputChannel.fill(0)
      for (let channel = 1; channel < output.length; channel++) output[channel].set(outputChannel)
      return true
    }

    let mono = input[0]
    if (input.length > 1) {
      if (this.monoInput.length !== frames) this.monoInput = new Float32Array(frames)
      this.monoInput.fill(0)
      for (const channel of input) {
        for (let i = 0; i < frames; i++) this.monoInput[i] += channel[i] || 0
      }
      const scale = 1 / input.length
      for (let i = 0; i < frames; i++) this.monoInput[i] *= scale
      mono = this.monoInput
    }

    let squares = 0
    for (let i = 0; i < frames; i++) squares += mono[i] * mono[i]

    this.meterSquareSum += squares
    this.meterSampleCount += frames
    if (this.meterSampleCount >= this.METER_INTERVAL_SAMPLES) {
      const rms = Math.sqrt(this.meterSquareSum / this.meterSampleCount)
      const measuredDb = Math.max(-100, Math.min(0, 20 * Math.log10(Math.max(rms, 0.000001))))
      const smoothing = measuredDb > this.meterDb ? 0.55 : 0.18
      this.meterDb += (measuredDb - this.meterDb) * smoothing
      this.meterSquareSum = 0
      this.meterSampleCount = 0
      this.port.postMessage({ type: 'micLevelDb', db: this.meterDb })
    }

    const blockDb = 20 * Math.log10(Math.max(Math.sqrt(squares / frames), 0.000001))
    const gateMuted = this.isMuted && !this.monitorWhileMuted
    if (gateMuted) {
      this.gateOpen = false
      this.holdRemaining = 0
    } else if (blockDb >= this.thresholdDb) {
      this.gateOpen = true
      this.holdRemaining = this.HOLD_SAMPLES
    } else if (this.gateOpen) {
      if (blockDb >= this.thresholdDb - this.HYSTERESIS_DB) {
        this.holdRemaining = this.HOLD_SAMPLES
      } else {
        this.holdRemaining -= frames
        if (this.holdRemaining <= 0) {
          this.gateOpen = false
          this.holdRemaining = 0
        }
      }
    }

    const targetGate = this.gateOpen ? 1 : 0
    for (let i = 0; i < frames; i++) {
      const delayed = this.delayLine[this.delayIndex]
      this.delayLine[this.delayIndex] = mono[i]
      this.delayIndex = this.delayIndex + 1 >= this.LOOKAHEAD_SAMPLES ? 0 : this.delayIndex + 1
      const coefficient = targetGate > this.gateGain ? this.GATE_ATTACK : this.GATE_RELEASE
      this.gateGain += (targetGate - this.gateGain) * coefficient
      outputChannel[i] = gateMuted ? 0 : delayed * this.gateGain * this.MAKEUP_GAIN
    }

    this.reportSpeaking(this.gateOpen && !this.isMuted)

    for (let channel = 1; channel < output.length; channel++) output[channel].set(outputChannel)
    return true
  }
}

registerProcessor('manual-gate-processor', ManualGateProcessor)
