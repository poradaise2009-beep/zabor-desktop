

let rnnoiseModule: any = null

const FRAME_SIZE = 480

async function loadRNNoiseModule(): Promise<any | null> {
  if (rnnoiseModule) return rnnoiseModule

  try {
    const mod = await import('@jitsi/rnnoise-wasm')
    rnnoiseModule = mod
    return rnnoiseModule
  } catch (error) {
    console.warn('[RNNoise] wasm module load failed', error)
    return null
  }
}

function buildRNNoiseWorkletSource(): string {
  return `
    class RNNoiseProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super()

        this.frameSize = 480
        this.pending = new Float32Array(0)
        this.outputQueue = new Float32Array(0)

        this.port.onmessage = (event) => {
          const data = event.data
          if (!data) return

          if (data.type === 'processed-frame' && data.samples) {
            const incoming = data.samples
            const merged = new Float32Array(this.outputQueue.length + incoming.length)
            merged.set(this.outputQueue, 0)
            merged.set(incoming, this.outputQueue.length)
            this.outputQueue = merged
          }
        }
      }

      process(inputs, outputs) {
        const input = inputs[0]
        const output = outputs[0]

        if (!output || output.length === 0) {
          return true
        }

        const outChannel = output[0]
        outChannel.fill(0)

        if (!input || input.length === 0 || !input[0]) {
          return true
        }

        const inChannel = input[0]

        const merged = new Float32Array(this.pending.length + inChannel.length)
        merged.set(this.pending, 0)
        merged.set(inChannel, this.pending.length)
        this.pending = merged

        while (this.pending.length >= this.frameSize) {
          const frame = this.pending.slice(0, this.frameSize)
          this.port.postMessage({
            type: 'process-frame',
            samples: frame
          })
          this.pending = this.pending.slice(this.frameSize)
        }

        const copyCount = Math.min(outChannel.length, this.outputQueue.length)

        if (copyCount > 0) {
          outChannel.set(this.outputQueue.slice(0, copyCount), 0)
          this.outputQueue = this.outputQueue.slice(copyCount)
        } else {
          // если RNNoise не успел отдать кадр — мягкий passthrough, чтобы не было дыр
          const fallbackCount = Math.min(outChannel.length, inChannel.length)
          for (let i = 0; i < fallbackCount; i++) {
            outChannel[i] = inChannel[i]
          }
        }

        return true
      }
    }

    registerProcessor('rnnoise-worklet-processor', RNNoiseProcessor)
  `
}


export async function createRNNoiseProcessor(
  audioContext: AudioContext,
  sourceStream: MediaStream
): Promise<{ stream: MediaStream; destroy: () => void }> {
  const mod = await loadRNNoiseModule()
  if (!mod) {
    return { stream: sourceStream, destroy: () => {} }
  }

  if (!audioContext.audioWorklet) {
    console.warn('[RNNoise] AudioWorklet is not supported, fallback to original stream')
    return { stream: sourceStream, destroy: () => {} }
  }

  let source: MediaStreamAudioSourceNode | null = null
  let workletNode: AudioWorkletNode | null = null
  let destination: MediaStreamAudioDestinationNode | null = null
  let rnnoiseState: any = null
  let objectUrl: string | null = null
  let destroyed = false

  try {
    const workletSource = buildRNNoiseWorkletSource()
    const blob = new Blob([workletSource], { type: 'application/javascript' })
    objectUrl = URL.createObjectURL(blob)

    await audioContext.audioWorklet.addModule(objectUrl)

    source = audioContext.createMediaStreamSource(sourceStream)
    destination = audioContext.createMediaStreamDestination()
    workletNode = new AudioWorkletNode(audioContext, 'rnnoise-worklet-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1]
    })

    rnnoiseState = mod.newState()

    workletNode.port.onmessage = (event) => {
      if (destroyed) return

      const data = event.data
      if (!data || data.type !== 'process-frame' || !data.samples) return

      try {
        const inputSamples = data.samples as Float32Array
        const pcm16 = new Int16Array(FRAME_SIZE)

        for (let i = 0; i < FRAME_SIZE; i++) {
          const s = Math.max(-1, Math.min(1, inputSamples[i] ?? 0))
          pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)))
        }

        mod.processFrame(rnnoiseState, pcm16)

        const processed = new Float32Array(FRAME_SIZE)
        for (let i = 0; i < FRAME_SIZE; i++) {
          processed[i] = pcm16[i] / 32768
        }

        workletNode?.port.postMessage({
          type: 'processed-frame',
          samples: processed
        })
      } catch (error) {
        console.warn('[RNNoise] processFrame failed, passthrough frame', error)

        // fallback: отдаём оригинальный кадр назад
        workletNode?.port.postMessage({
          type: 'processed-frame',
          samples: data.samples
        })
      }
    }

    source.connect(workletNode)
    workletNode.connect(destination)

    return {
      stream: destination.stream,
      destroy: () => {
        destroyed = true

        try {
          workletNode?.disconnect()
        } catch {}

        try {
          source?.disconnect()
        } catch {}

        try {
          if (rnnoiseState) {
            mod.deleteState(rnnoiseState)
          }
        } catch {}

        if (objectUrl) {
          URL.revokeObjectURL(objectUrl)
        }

        source = null
        workletNode = null
        destination = null
        rnnoiseState = null
        objectUrl = null
      }
    }
  } catch (error) {
    console.warn('[RNNoise] AudioWorklet init failed, fallback to original stream', error)

    try {
      workletNode?.disconnect()
    } catch {}

    try {
      source?.disconnect()
    } catch {}

    try {
      if (rnnoiseState) {
        mod.deleteState(rnnoiseState)
      }
    } catch {}

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
    }

    return {
      stream: sourceStream,
      destroy: () => {}
    }
  }
}