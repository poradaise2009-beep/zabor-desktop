import 'rnnoise-wasm-polyfills'
import RnnoiseProcessor from 'rnnoise-wasm-processor'
import createRNNWasmModuleSync from 'rnnoise-wasm-sync'

export const RNNOISE_FRAME_LENGTH = 480

type RnnoiseModule = ConstructorParameters<typeof RnnoiseProcessor>[0]

export class RnnoiseEngine {
  readonly label = 'RNNoise'
  readonly supportsAttenuationLimit = false

  private processor: RnnoiseProcessor | null = null
  private readonly scratch = new Float32Array(RNNOISE_FRAME_LENGTH)
  private stage = 'not started'
  private voiceScore = 0

  get isReady(): boolean {
    return this.processor !== null
  }

  get stageName(): string {
    return this.stage
  }

  get frame(): number {
    return this.processor ? RNNOISE_FRAME_LENGTH : 0
  }

  get lastVoiceScore(): number {
    return this.voiceScore
  }

  async start(): Promise<void> {
    if (this.processor) return

    this.stage = 'instantiating wasm'
    const wasmModule = createRNNWasmModuleSync() as RnnoiseModule

    this.stage = 'creating the model'
    const processor = new RnnoiseProcessor(wasmModule)
    const frameLength = processor.getSampleLength()
    if (frameLength !== RNNOISE_FRAME_LENGTH) {
      processor.destroy()
      throw new Error(`unsupported frame length ${frameLength}, expected ${RNNOISE_FRAME_LENGTH}`)
    }

    this.processor = processor
    this.stage = 'ready'
  }

  process(frame: Float32Array): Float32Array | null {
    const processor = this.processor
    if (!processor) return null
    this.scratch.set(frame)
    this.voiceScore = processor.processAudioFrame(this.scratch, true)
    return this.scratch
  }

  setAttenuationLimit(): void {
  }

  setPostFilterBeta(): void {
  }
}
