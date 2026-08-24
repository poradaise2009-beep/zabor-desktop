import {
  df_create,
  df_get_frame_length,
  df_process_frame,
  df_set_atten_lim,
  df_set_post_filter_beta,
  initSync as initWasmSync
} from 'deepfilter-wasm-bindgen'

export const DEEPFILTER_FRAME_LENGTH = 480
export const DEEPFILTER_MIN_POST_FILTER_BETA = 0.02

export const DEEPFILTER_WASM_ASSET = 'pkg/df_bg.wasm'
export const DEEPFILTER_MODEL_ASSET = 'models/DeepFilterNet3_onnx.tar.gz'

export type DeepFilterAssetReader = (asset: string) => Promise<ArrayBuffer | null>

let wasmInstantiated = false

export class DeepFilterEngine {
  readonly label = 'DeepFilterNet3'
  readonly supportsAttenuationLimit = true

  private handle = 0
  private frameLength = 0
  private attenuationLimitDb = 15
  private postFilterBeta = DEEPFILTER_MIN_POST_FILTER_BETA
  private stage = 'not started'
  private modelBytes: Uint8Array | null = null

  get isReady(): boolean {
    return this.handle !== 0
  }

  get stageName(): string {
    return this.stage
  }

  get frame(): number {
    return this.frameLength
  }

  async start(read: DeepFilterAssetReader, attenuationLimitDb: number, postFilterBeta: number): Promise<void> {
    if (this.isReady) return
    this.attenuationLimitDb = attenuationLimitDb
    this.postFilterBeta = postFilterBeta

    if (!wasmInstantiated) {
      this.stage = 'reading wasm'
      const wasmBytes = await read(DEEPFILTER_WASM_ASSET)
      if (!wasmBytes || wasmBytes.byteLength === 0) throw new Error('wasm bytes are unavailable')
      this.stage = 'instantiating wasm'
      initWasmSync(wasmBytes)
      wasmInstantiated = true
    }

    if (!this.modelBytes) {
      this.stage = 'reading the model'
      const modelBytes = await read(DEEPFILTER_MODEL_ASSET)
      if (!modelBytes || modelBytes.byteLength === 0) throw new Error('model bytes are unavailable')
      this.modelBytes = new Uint8Array(modelBytes)
    }

    this.stage = 'creating the model'
    const handle = df_create(this.modelBytes, this.attenuationLimitDb)
    if (!handle) throw new Error('df_create returned no handle')

    const frameLength = df_get_frame_length(handle)
    if (frameLength !== DEEPFILTER_FRAME_LENGTH) {
      throw new Error(`unsupported frame length ${frameLength}, expected ${DEEPFILTER_FRAME_LENGTH}`)
    }

    df_set_atten_lim(handle, this.attenuationLimitDb)
    df_set_post_filter_beta(handle, this.postFilterBeta)

    this.frameLength = frameLength
    this.handle = handle
    this.stage = 'ready'
  }

  process(frame: Float32Array): Float32Array | null {
    if (this.handle === 0) return null
    const processed = df_process_frame(this.handle, frame)
    return processed.length === this.frameLength ? processed : null
  }

  setAttenuationLimit(limitDb: number): void {
    this.attenuationLimitDb = limitDb
    if (this.handle !== 0) df_set_atten_lim(this.handle, limitDb)
  }

  setPostFilterBeta(beta: number): void {
    this.postFilterBeta = beta
    if (this.handle !== 0) df_set_post_filter_beta(this.handle, beta)
  }
}
