import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const repo = 'C:/Users/porad/Documents/zabor/Frontend/zabor-desktop'
const gluePath = `${repo}/node_modules/deepfilter-standalone/dist/df3/df.js`
const wasmPath = process.env.DF_WASM || `${repo}/src/renderer/public/deepfilternet3/pkg/df_bg.wasm`
const modelPath = `${repo}/src/renderer/public/deepfilternet3/models/DeepFilterNet3_onnx.tar.gz`

const df = await import(pathToFileURL(gluePath).href)

const wasmBytes = readFileSync(wasmPath)
console.log(`wasm: ${wasmPath}`)
console.log(`wasm bytes: ${wasmBytes.byteLength}`)

const t0 = performance.now()
await df.initAsync(wasmBytes)
console.log(`initAsync: ${Math.round(performance.now() - t0)} ms`)

const attenLim = Number(process.env.DF_ATTEN || 20)
const modelBytes = new Uint8Array(readFileSync(modelPath))
const t1 = performance.now()
const st = df.df_create(modelBytes, attenLim)
console.log(`df_create(atten_lim=${attenLim}): handle=${st} in ${Math.round(performance.now() - t1)} ms`)

const frameLength = df.df_get_frame_length(st)
console.log(`df_get_frame_length: ${frameLength}`)
if (frameLength !== 480) {
  console.error(`FAIL: expected 480 samples per frame at 48 kHz, got ${frameLength}`)
  process.exit(1)
}

df.df_set_atten_lim(st, attenLim)
df.df_set_post_filter_beta(st, 0.02)

const sampleRate = 48000
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)
const db = (v) => (v > 0 ? 20 * Math.log10(v) : -Infinity)

let seed = 12345
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff * 2 - 1
}

const frames = 80
const measureFrom = 40
const cases = [
  { name: 'white noise only', tone: 0, noise: 0.05 },
  { name: '200 Hz tone at -20 dBFS + noise', tone: 0.1, noise: 0.05 },
  { name: '200 Hz tone at -20 dBFS, clean', tone: 0.1, noise: 0 }
]

let phase = 0
let nonFinite = 0
const outputDigest = createHash('sha256')

for (const c of cases) {
  let inSum = 0
  let outSum = 0
  let counted = 0
  let peakOut = 0
  const started = performance.now()

  for (let f = 0; f < frames; f++) {
    const input = new Float32Array(frameLength)
    for (let i = 0; i < frameLength; i++) {
      phase += (2 * Math.PI * 200) / sampleRate
      input[i] = c.tone * Math.sin(phase) + c.noise * rand()
    }
    const output = df.df_process_frame(st, input)
    if (output.length !== frameLength) {
      console.error(`FAIL: output length ${output.length} != ${frameLength}`)
      process.exit(1)
    }
    for (let i = 0; i < output.length; i++) {
      if (!Number.isFinite(output[i])) nonFinite++
      const a = Math.abs(output[i])
      if (a > peakOut) peakOut = a
    }
    outputDigest.update(Buffer.from(output.buffer, output.byteOffset, output.byteLength))
    if (f >= measureFrom) {
      inSum += rms(input)
      outSum += rms(output)
      counted++
    }
  }

  const elapsed = performance.now() - started
  const inDb = db(inSum / counted)
  const outDb = db(outSum / counted)
  console.log(
    `${c.name}: in ${inDb.toFixed(1)} dBFS -> out ${outDb.toFixed(1)} dBFS ` +
    `(delta ${(outDb - inDb).toFixed(1)} dB), peak ${db(peakOut).toFixed(1)} dBFS, ` +
    `${(elapsed / frames).toFixed(2)} ms/frame`
  )
}

if (nonFinite > 0) {
  console.error(`FAIL: ${nonFinite} non-finite samples in the output`)
  process.exit(1)
}

console.log(`output sha256: ${outputDigest.digest('hex')}`)
console.log('OK: engine initialized, frame length 480, output finite')
