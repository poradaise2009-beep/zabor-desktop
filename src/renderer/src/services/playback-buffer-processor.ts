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
const MAX_FRAMES = Math.round(SAMPLE_RATE * 0.4)
const DRIFT_GAIN = 0.05
const MAX_RATE_DEVIATION = 0.005
const MIN_READABLE_FRAMES = 2

class PlaybackBufferProcessor extends AudioWorkletProcessor {
  private readonly left = new Float32Array(RING_FRAMES)
  private readonly right = new Float32Array(RING_FRAMES)
  private readPosition = 0
  private writeIndex = 0
  private availableFrames = 0
  private primed = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<AudioChunkMessage>) => {
      const message = event.data
      if (message.type !== 'audio' || !(message.buffer instanceof ArrayBuffer)) return
      if (message.channels !== 1 && message.channels !== 2) return

      const samples = new Float32Array(message.buffer)
      const frames = Math.floor(samples.length / message.channels)
      if (frames === 0) return

      if (!this.primed || this.availableFrames < MIN_READABLE_FRAMES) this.rebaseTimeline()

      for (let frame = 0; frame < frames; frame++) {
        const sampleIndex = frame * message.channels
        this.left[this.writeIndex] = samples[sampleIndex]
        this.right[this.writeIndex] = message.channels === 2 ? samples[sampleIndex + 1] : samples[sampleIndex]
        this.writeIndex = (this.writeIndex + 1) % RING_FRAMES
        this.availableFrames++
      }

      if (this.availableFrames > MAX_FRAMES) this.dropOldest(this.availableFrames - TARGET_FRAMES)
    }
  }

  private rebaseTimeline() {
    const readIndex = Math.floor(this.readPosition)
    for (let offset = 0; offset < TARGET_FRAMES; offset++) {
      const index = (readIndex + offset) % RING_FRAMES
      this.left[index] = 0
      this.right[index] = 0
    }
    this.readPosition = readIndex
    this.writeIndex = (readIndex + TARGET_FRAMES) % RING_FRAMES
    this.availableFrames = TARGET_FRAMES
    this.primed = true
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
    if (!this.primed) {
      output.forEach(channel => channel.fill(0))
      return true
    }

    const error = (this.availableFrames - TARGET_FRAMES) / TARGET_FRAMES
    const rate = Math.max(
      1 - MAX_RATE_DEVIATION,
      Math.min(1 + MAX_RATE_DEVIATION, 1 + DRIFT_GAIN * error)
    )

    const stereo = output[1]
    for (let frame = 0; frame < frames; frame++) {
      if (this.availableFrames < 2) {
        output[0][frame] = 0
        if (stereo) stereo[frame] = 0
        continue
      }

      output[0][frame] = this.readFrame(this.left, this.readPosition)
      if (stereo) stereo[frame] = this.readFrame(this.right, this.readPosition)

      const advanced = this.readPosition + rate
      const consumed = Math.floor(advanced) - Math.floor(this.readPosition)
      this.readPosition = advanced % RING_FRAMES
      this.availableFrames -= consumed
    }

    return true
  }
}

registerProcessor('playback-buffer-processor', PlaybackBufferProcessor)
