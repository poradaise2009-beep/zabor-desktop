import { env, InferenceSession, Tensor } from 'onnxruntime-web'

env.wasm.wasmPaths = './'

const SAMPLE_RATE = 16000
const FRAME_SIZE = 512
const CONTEXT_SIZE = 64
const STATE_SIZE = 2 * 1 * 128

let session: InferenceSession | null = null
const state = new Float32Array(STATE_SIZE)
const context = new Float32Array(CONTEXT_SIZE)
const modelInput = new Float32Array(CONTEXT_SIZE + FRAME_SIZE)
const sampleRateTensor = new Tensor(
  'int64',
  BigInt64Array.from([BigInt(SAMPLE_RATE)]),
  [1]
)
let inferenceRunning = false
const pendingFrames: ProcessMessage[] = []
const MAX_PENDING_FRAMES = 4
let lastProcessedSequence = -1

interface ProcessMessage {
  type: 'process'
  audioFrame: Float32Array
  sequence: number
  endFrameId: number
  windowRms: number
}

function resetModelState(): void {
  state.fill(0)
  context.fill(0)
  modelInput.fill(0)
  lastProcessedSequence = -1
}

async function processFrame(message: ProcessMessage): Promise<void> {
  if (!session || message.audioFrame.length !== FRAME_SIZE) return

  if (lastProcessedSequence >= 0 && message.sequence !== lastProcessedSequence + 1) {
    resetModelState()
  }
  lastProcessedSequence = message.sequence

  try {
    modelInput.set(context, 0)
    modelInput.set(message.audioFrame, CONTEXT_SIZE)

    const results = await session.run({
      input: new Tensor('float32', modelInput, [1, modelInput.length]),
      state: new Tensor('float32', state, [2, 1, 128]),
      sr: sampleRateTensor
    })

    const rawProb = Number(results.output.data[0])
    const probability = Number.isFinite(rawProb) ? Math.max(0, Math.min(1, rawProb)) : 0

    const newStateData = results.stateN.data as Float32Array
    state.set(newStateData)
    context.set(message.audioFrame.subarray(FRAME_SIZE - CONTEXT_SIZE))

    self.postMessage({
      type: 'probability',
      probability,
      sequence: message.sequence,
      endFrameId: message.endFrameId,
      windowRms: message.windowRms
    })
  } catch (error) {
    resetModelState()
    self.postMessage({ type: 'error', phase: 'inference', error: String(error) })
  }
}

interface InitMessage {
  type: 'init'
  model: Uint8Array
  wasmPath: string
}

async function drainFrames(message: ProcessMessage): Promise<void> {
  inferenceRunning = true
  let current: ProcessMessage | null = message
  while (current) {
    await processFrame(current)
    current = pendingFrames.shift() ?? null
  }
  inferenceRunning = false
}

self.onmessage = (event: MessageEvent) => {
  const message = event.data

  if (message.type === 'init') {
    const { model, wasmPath } = message as InitMessage
    if (wasmPath) env.wasm.wasmPaths = wasmPath

    InferenceSession.create(model, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    }).then(createdSession => {
      session = createdSession
      resetModelState()
      self.postMessage({ type: 'ready' })
    }).catch(error => self.postMessage({ type: 'error', phase: 'initialization', error: String(error) }))
  } else if (message.type === 'process') {
    const frame = message as ProcessMessage
    if (inferenceRunning) {
      // Never let delayed VAD decisions control newer audio. If inference falls
      // behind, discard the stale backlog; the sequence gap resets Silero state
      // before the newest contiguous group is evaluated.
      if (pendingFrames.length >= MAX_PENDING_FRAMES) pendingFrames.splice(0, pendingFrames.length - 1)
      pendingFrames.push(frame)
    } else {
      void drainFrames(frame)
    }
  } else if (message.type === 'reset') {
    pendingFrames.length = 0
    lastProcessedSequence = -1
    resetModelState()
  }
}
