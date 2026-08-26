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

type AudioChunkMessage = {
  type: 'audio'
  buffer: ArrayBuffer
  channels: number
}

const SAMPLE_RATE = 48000
const RING_FRAMES = SAMPLE_RATE * 2
const TARGET_FRAMES = Math.round(SAMPLE_RATE * 0.08)
const PRIME_FRAMES = Math.round(SAMPLE_RATE * 0.06)
const MAX_FRAMES = Math.round(SAMPLE_RATE * 0.4)
const RESTART_STARVED_FRAMES = Math.round(SAMPLE_RATE * 0.2)
const FADE_STEP = 1 / Math.round(SAMPLE_RATE * 0.002)
const DRIFT_GAIN = 0.05
const MAX_RATE_DEVIATION = 0.01
const MIN_READABLE_FRAMES = 2

class PlaybackBufferProcessor extends AudioWorkletProcessor {
  private readonly left = new Float32Array(RING_FRAMES)
  private readonly right = new Float32Array(RING_FRAMES)
  private readPosition = 0
  private writeIndex = 0
  private availableFrames = 0
  private playing = false
  private starvedFrames = 0
  private fadeGain = 0
  private lastLeft = 0
  private lastRight = 0

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<AudioChunkMessage>) => {
      const message = event.data
      if (message.type !== 'audio' || !(message.buffer instanceof ArrayBuffer)) return
      if (message.channels !== 1 && message.channels !== 2) return

      const samples = new Float32Array(message.buffer)
      const frames = Math.floor(samples.length / message.channels)
      if (frames === 0) return

      if (this.availableFrames < MIN_READABLE_FRAMES) this.spliceAtReadHead()

      for (let frame = 0; frame < frames; frame++) {
        const sampleIndex = frame * message.channels
        this.left[this.writeIndex] = samples[sampleIndex]
        this.right[this.writeIndex] = message.channels === 2 ? samples[sampleIndex + 1] : samples[sampleIndex]
        this.writeIndex = (this.writeIndex + 1) % RING_FRAMES
        this.availableFrames++
      }

      if (!this.playing && this.availableFrames >= PRIME_FRAMES) {
        this.playing = true
        this.starvedFrames = 0
      }

      if (this.availableFrames > MAX_FRAMES) this.dropOldest(this.availableFrames - TARGET_FRAMES)
    }
  }

  private spliceAtReadHead() {
    const readIndex = Math.floor(this.readPosition)
    this.readPosition = readIndex
    this.writeIndex = readIndex
    this.availableFrames = 0
  }

  private dropOldest(frames: number) {
    const dropped = Math.min(frames, this.availableFrames)
    this.readPosition = (Math.floor(this.readPosition) + dropped) % RING_FRAMES
    this.availableFrames -= dropped
  }

  private readFrame(channel: Float32Array, position: number): number {
    const base = Math.floor(position)
    const fraction = position - base
    const current = channel[base % RING_FRAMES]
    if (fraction === 0) return current
    const next = channel[(base + 1) % RING_FRAMES]
    return current + (next - current) * fraction
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    if (!output?.length) return true

    const frames = output[0].length
    const stereo = output[1]

    if (!this.playing) {
      this.fadeGain = 0
      this.lastLeft = 0
      this.lastRight = 0
      output.forEach(channel => channel.fill(0))
      return true
    }

    const error = (this.availableFrames - TARGET_FRAMES) / TARGET_FRAMES
    const rate = Math.max(
      1 - MAX_RATE_DEVIATION,
      Math.min(1 + MAX_RATE_DEVIATION, 1 + DRIFT_GAIN * error)
    )

    for (let frame = 0; frame < frames; frame++) {
      if (this.availableFrames < MIN_READABLE_FRAMES) {
        this.starvedFrames++
        if (this.starvedFrames >= RESTART_STARVED_FRAMES) this.playing = false
        if (this.fadeGain > 0) this.fadeGain = Math.max(0, this.fadeGain - FADE_STEP)
        output[0][frame] = this.lastLeft * this.fadeGain
        if (stereo) stereo[frame] = this.lastRight * this.fadeGain
        continue
      }

      this.starvedFrames = 0
      if (this.fadeGain < 1) this.fadeGain = Math.min(1, this.fadeGain + FADE_STEP)
      this.lastLeft = this.readFrame(this.left, this.readPosition)
      this.lastRight = stereo ? this.readFrame(this.right, this.readPosition) : this.lastLeft
      output[0][frame] = this.lastLeft * this.fadeGain
      if (stereo) stereo[frame] = this.lastRight * this.fadeGain

      const advanced = this.readPosition + rate
      const consumed = Math.floor(advanced) - Math.floor(this.readPosition)
      this.readPosition = advanced % RING_FRAMES
      this.availableFrames -= consumed
    }

    return true
  }
}

registerProcessor('playback-buffer-processor', PlaybackBufferProcessor)
