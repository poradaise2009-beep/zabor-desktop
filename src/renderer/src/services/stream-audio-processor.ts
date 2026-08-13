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

const BUFFER_FRAMES = 48000 * 2
const START_THRESHOLD_FRAMES = 48000 * 0.04

class StreamAudioProcessor extends AudioWorkletProcessor {
  private readonly left = new Float32Array(BUFFER_FRAMES)
  private readonly right = new Float32Array(BUFFER_FRAMES)
  private readIndex = 0
  private writeIndex = 0
  private bufferedFrames = 0
  private playing = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent<AudioChunkMessage>) => {
      const message = event.data
      if (message.type !== 'audio' || !(message.buffer instanceof ArrayBuffer)) return
      if (message.channels !== 1 && message.channels !== 2) return

      const samples = new Float32Array(message.buffer)
      const frames = Math.floor(samples.length / message.channels)
      for (let frame = 0; frame < frames; frame++) {
        if (this.bufferedFrames === BUFFER_FRAMES) {
          this.readIndex = (this.readIndex + 1) % BUFFER_FRAMES
          this.bufferedFrames--
        }

        const sampleIndex = frame * message.channels
        this.left[this.writeIndex] = samples[sampleIndex]
        this.right[this.writeIndex] = message.channels === 2 ? samples[sampleIndex + 1] : samples[sampleIndex]
        this.writeIndex = (this.writeIndex + 1) % BUFFER_FRAMES
        this.bufferedFrames++
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]
    if (!output?.length) return true

    const frames = output[0].length
    if (!this.playing && this.bufferedFrames >= START_THRESHOLD_FRAMES) this.playing = true
    if (!this.playing || this.bufferedFrames < frames) {
      output.forEach(channel => channel.fill(0))
      this.playing = false
      return true
    }

    for (let frame = 0; frame < frames; frame++) {
      output[0][frame] = this.left[this.readIndex]
      if (output[1]) output[1][frame] = this.right[this.readIndex]
      this.readIndex = (this.readIndex + 1) % BUFFER_FRAMES
    }
    this.bufferedFrames -= frames
    return true
  }
}

registerProcessor('stream-audio-processor', StreamAudioProcessor)
