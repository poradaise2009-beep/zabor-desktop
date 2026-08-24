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

class MicTestCaptureProcessor extends AudioWorkletProcessor {
  private buffer: Float32Array | null = null
  private writeIndex = 0
  private capturing = false

  constructor() {
    super()

    this.port.onmessage = (event) => {
      const message = event.data
      if (message.type === 'start') {
        const samples = Math.max(1, Math.floor(Number(message.samples) || 0))
        this.buffer = new Float32Array(samples)
        this.writeIndex = 0
        this.capturing = true
      } else if (message.type === 'stop') {
        this.finish()
      }
    }

    this.port.postMessage({ type: 'ready' })
  }

  private finish() {
    if (!this.capturing || !this.buffer) return
    this.capturing = false
    const captured = this.buffer.slice(0, this.writeIndex)
    this.buffer = null
    this.writeIndex = 0
    this.port.postMessage({ type: 'captured', pcm: captured }, [captured.buffer])
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const output = outputs[0]
    const source = input?.[0]

    if (output?.[0]) {
      if (source) output[0].set(source)
      else output[0].fill(0)
      for (let channel = 1; channel < output.length; channel++) output[channel].set(output[0])
    }

    if (!this.capturing || !this.buffer || !source) return true

    const room = this.buffer.length - this.writeIndex
    const frames = source.length < room ? source.length : room
    for (let i = 0; i < frames; i++) this.buffer[this.writeIndex + i] = source[i]
    this.writeIndex += frames
    if (this.writeIndex >= this.buffer.length) this.finish()

    return true
  }
}

registerProcessor('mic-test-capture-processor', MicTestCaptureProcessor)
