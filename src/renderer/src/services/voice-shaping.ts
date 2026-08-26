declare const sampleRate: number

const FILTER_RATE = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : 48000
const DENORMAL_FLOOR = 1e-25

const EQ_MUD_HZ = 300
const EQ_MUD_Q = 0.9
const EQ_MUD_DB = -1.8
const EQ_PRESENCE_HZ = 3600
const EQ_PRESENCE_Q = 0.85
const EQ_PRESENCE_DB = 2.2
const EQ_AIR_HZ = 9000
const EQ_AIR_Q = 0.707
const EQ_AIR_DB = 1.2

const DEESS_DETECTOR_HZ = 6300
const DEESS_DETECTOR_Q = 1
const DEESS_BELL_HZ = 6800
const DEESS_BELL_Q = 1.1
const DEESS_BELL_DB = -5
const DEESS_THRESHOLD_RATIO = 0.26
const DEESS_FULL_EXCESS = 3
const DEESS_ATTACK = 1 / 48
const DEESS_RELEASE = 1 / 3840

const TONE_FFT_SIZE = 8192
const TONE_FFT_STAGES = Math.round(Math.log2(TONE_FFT_SIZE))
const TONE_FFT_BINS = TONE_FFT_SIZE >> 1
const TONE_FFT_BIN_HZ = FILTER_RATE / TONE_FFT_SIZE
const TONE_FFT_STAGE_INTERVAL = 64
const TONE_SPECTRUM_FLOOR = 1e-24
const TONE_MAINS_HARMONICS = [50, 60, 100, 120, 150, 180, 200, 240, 250, 300]
const TONE_HUM_BANDWIDTH_HZ = 2
const TONE_HUM_REFINE_HZ = 3
const TONE_HUM_ENGAGE_DB = 8
const TONE_HUM_RELEASE_DB = 5
const TONE_HUM_RETUNE_HZ = 8
const TONE_WHINE_MIN_HZ = 400
const TONE_WHINE_MAX_HZ = 7000
const TONE_WHINE_BANDWIDTH_HZ = 60
const TONE_WHINE_ENGAGE_DB = 10
const TONE_WHINE_RELEASE_DB = 6
const TONE_WHINE_RETUNE_HZ = 12
const TONE_WHINE_SLOTS = 3
const TONE_WHINE_EXCLUDE_HZ = 150
const TONE_CONFIRM_WINDOWS = 6
const TONE_MIX_STEP = 1 / (FILTER_RATE * 0.05)
const TONE_REFERENCE_INNER_BINS = Math.max(2, Math.round(20 / TONE_FFT_BIN_HZ))
const TONE_REFERENCE_OUTER_BINS = Math.max(
  TONE_REFERENCE_INNER_BINS + 4,
  Math.round(70 / TONE_FFT_BIN_HZ)
)
const TONE_WHINE_REFERENCE_INNER_BINS = Math.max(3, Math.round(60 / TONE_FFT_BIN_HZ))
const TONE_WHINE_REFERENCE_OUTER_BINS = Math.max(
  TONE_WHINE_REFERENCE_INNER_BINS + 8,
  Math.round(350 / TONE_FFT_BIN_HZ)
)
const TONE_ENVELOPE_BINS = TONE_WHINE_REFERENCE_OUTER_BINS
const TONE_SCRATCH_SIZE = 2 * (TONE_WHINE_REFERENCE_OUTER_BINS - TONE_WHINE_REFERENCE_INNER_BINS + 2)

export class VoiceBiquad {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  static peaking(frequency: number, quality: number, gainDb: number): VoiceBiquad {
    const filter = new VoiceBiquad()
    const amplitude = Math.pow(10, gainDb / 40)
    const omega = (2 * Math.PI * frequency) / FILTER_RATE
    const alpha = Math.sin(omega) / (2 * quality)
    const cosine = Math.cos(omega)
    filter.normalize(
      1 + alpha * amplitude,
      -2 * cosine,
      1 - alpha * amplitude,
      1 + alpha / amplitude,
      -2 * cosine,
      1 - alpha / amplitude
    )
    return filter
  }

  static highShelf(frequency: number, quality: number, gainDb: number): VoiceBiquad {
    const filter = new VoiceBiquad()
    const amplitude = Math.pow(10, gainDb / 40)
    const omega = (2 * Math.PI * frequency) / FILTER_RATE
    const alpha = Math.sin(omega) / (2 * quality)
    const cosine = Math.cos(omega)
    const root = 2 * Math.sqrt(amplitude) * alpha
    filter.normalize(
      amplitude * (amplitude + 1 + (amplitude - 1) * cosine + root),
      -2 * amplitude * (amplitude - 1 + (amplitude + 1) * cosine),
      amplitude * (amplitude + 1 + (amplitude - 1) * cosine - root),
      amplitude + 1 - (amplitude - 1) * cosine + root,
      2 * (amplitude - 1 - (amplitude + 1) * cosine),
      amplitude + 1 - (amplitude - 1) * cosine - root
    )
    return filter
  }

  static bandPass(frequency: number, quality: number): VoiceBiquad {
    const filter = new VoiceBiquad()
    const omega = (2 * Math.PI * frequency) / FILTER_RATE
    const alpha = Math.sin(omega) / (2 * quality)
    const cosine = Math.cos(omega)
    filter.normalize(alpha, 0, -alpha, 1 + alpha, -2 * cosine, 1 - alpha)
    return filter
  }

  static notch(frequency: number, quality: number): VoiceBiquad {
    const filter = new VoiceBiquad()
    filter.tuneNotch(frequency, quality)
    return filter
  }

  tuneNotch(frequency: number, quality: number): void {
    const omega = (2 * Math.PI * frequency) / FILTER_RATE
    const alpha = Math.sin(omega) / (2 * quality)
    const cosine = Math.cos(omega)
    this.normalize(1, -2 * cosine, 1, 1 + alpha, -2 * cosine, 1 - alpha)
  }

  private normalize(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = a1 / a0
    this.a2 = a2 / a0
  }

  process(sample: number): number {
    let output = this.b0 * sample + this.b1 * this.x1 + this.b2 * this.x2 -
      this.a1 * this.y1 - this.a2 * this.y2
    if (output > -DENORMAL_FLOOR && output < DENORMAL_FLOOR) output = 0
    this.x2 = this.x1
    this.x1 = sample
    this.y2 = this.y1
    this.y1 = output
    return output
  }
}

export class VoiceShaper {
  private readonly mud = VoiceBiquad.peaking(EQ_MUD_HZ, EQ_MUD_Q, EQ_MUD_DB)
  private readonly presence = VoiceBiquad.peaking(EQ_PRESENCE_HZ, EQ_PRESENCE_Q, EQ_PRESENCE_DB)
  private readonly air = VoiceBiquad.highShelf(EQ_AIR_HZ, EQ_AIR_Q, EQ_AIR_DB)
  private readonly detector = VoiceBiquad.bandPass(DEESS_DETECTOR_HZ, DEESS_DETECTOR_Q)
  private readonly sibilanceBell = VoiceBiquad.peaking(DEESS_BELL_HZ, DEESS_BELL_Q, DEESS_BELL_DB)
  private sibilancePower = 0
  private thresholdPower = 0

  setSpeechReference(speechRms: number): void {
    if (!(speechRms > 0)) {
      this.thresholdPower = 0
      return
    }
    const threshold = speechRms * DEESS_THRESHOLD_RATIO
    this.thresholdPower = threshold * threshold
  }

  process(sample: number): number {
    const shaped = this.air.process(this.presence.process(this.mud.process(sample)))
    const sibilant = this.detector.process(shaped)
    const power = sibilant * sibilant
    this.sibilancePower += (power - this.sibilancePower) *
      (power > this.sibilancePower ? DEESS_ATTACK : DEESS_RELEASE)
    const wet = this.sibilanceBell.process(shaped)
    if (this.thresholdPower <= 0 || this.sibilancePower <= this.thresholdPower) return shaped
    const excess = Math.sqrt(this.sibilancePower / this.thresholdPower)
    const mix = Math.min(1, (excess - 1) / (DEESS_FULL_EXCESS - 1))
    return shaped + (wet - shaped) * mix
  }
}

class ToneAnalyzer {
  private readonly samples = new Float32Array(TONE_FFT_SIZE)
  private readonly real = new Float64Array(TONE_FFT_SIZE)
  private readonly imag = new Float64Array(TONE_FFT_SIZE)
  private readonly power = new Float64Array(TONE_FFT_BINS)
  private readonly prefix = new Float64Array(TONE_FFT_BINS + 1)
  private readonly analysisWindow = new Float32Array(TONE_FFT_SIZE)
  private readonly twiddleCos = new Float32Array(TONE_FFT_BINS)
  private readonly twiddleSin = new Float32Array(TONE_FFT_BINS)
  private readonly reversal = new Uint16Array(TONE_FFT_SIZE)
  private readonly scratch = new Float64Array(TONE_SCRATCH_SIZE)
  private fill = 0
  private stage = 0
  private stageCountdown = 0
  private transforming = false

  measuredProminenceDb = 0
  measuredFrequencyHz = 0

  constructor() {
    for (let index = 0; index < TONE_FFT_SIZE; index++) {
      this.analysisWindow[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / TONE_FFT_SIZE)
      let reversed = 0
      let value = index
      for (let bit = 0; bit < TONE_FFT_STAGES; bit++) {
        reversed = (reversed << 1) | (value & 1)
        value >>= 1
      }
      this.reversal[index] = reversed
    }
    for (let index = 0; index < TONE_FFT_BINS; index++) {
      const angle = (2 * Math.PI * index) / TONE_FFT_SIZE
      this.twiddleCos[index] = Math.cos(angle)
      this.twiddleSin[index] = Math.sin(angle)
    }
  }

  reset(): void {
    this.fill = 0
    this.stage = 0
    this.transforming = false
    this.measuredProminenceDb = 0
    this.measuredFrequencyHz = 0
  }

  push(sample: number, collecting: boolean): boolean {
    if (this.transforming) {
      if (--this.stageCountdown > 0) return false
      this.stageCountdown = TONE_FFT_STAGE_INTERVAL
      this.runStage()
      if (this.stage < TONE_FFT_STAGES) return false
      this.transforming = false
      this.finishTransform()
      return true
    }
    if (!collecting) {
      this.fill = 0
      return false
    }
    this.samples[this.fill++] = sample
    if (this.fill < TONE_FFT_SIZE) return false
    this.fill = 0
    this.beginTransform()
    return false
  }

  measureHarmonic(nominalHz: number): void {
    const centre = Math.round(nominalHz / TONE_FFT_BIN_HZ)
    let peak = centre < 1 ? 1 : centre
    for (let bin = centre - 1; bin <= centre + 1; bin++) {
      if (bin < 1 || bin >= TONE_FFT_BINS - 1) continue
      if (this.power[bin] > this.power[peak]) peak = bin
    }
    const refined = this.interpolatePeakHz(peak)
    this.measuredFrequencyHz = refined
    if (Math.abs(refined - nominalHz) > TONE_HUM_REFINE_HZ) {
      this.measuredProminenceDb = 0
      this.measuredFrequencyHz = nominalHz
      return
    }
    this.measuredProminenceDb = this.prominenceDb(
      peak,
      TONE_REFERENCE_INNER_BINS,
      TONE_REFERENCE_OUTER_BINS
    )
  }

  measureWhine(claimedHz: Float64Array, claimedCount: number): void {
    this.prefix[0] = 0
    for (let bin = 0; bin < TONE_FFT_BINS; bin++) {
      this.prefix[bin + 1] = this.prefix[bin] + this.power[bin]
    }
    const first = Math.max(1, Math.round(TONE_WHINE_MIN_HZ / TONE_FFT_BIN_HZ))
    const last = Math.min(TONE_FFT_BINS - 2, Math.round(TONE_WHINE_MAX_HZ / TONE_FFT_BIN_HZ))
    let peak = -1
    let bestRatio = -1
    for (let bin = first; bin <= last; bin++) {
      const hz = bin * TONE_FFT_BIN_HZ
      let claimed = false
      for (let index = 0; index < claimedCount; index++) {
        const taken = claimedHz[index]
        if (taken > 0 && Math.abs(hz - taken) < TONE_WHINE_EXCLUDE_HZ) {
          claimed = true
          break
        }
      }
      if (claimed) continue
      const low = bin - TONE_ENVELOPE_BINS < 0 ? 0 : bin - TONE_ENVELOPE_BINS
      const high = bin + TONE_ENVELOPE_BINS + 1 > TONE_FFT_BINS
        ? TONE_FFT_BINS
        : bin + TONE_ENVELOPE_BINS + 1
      const average = (this.prefix[high] - this.prefix[low]) / (high - low)
      const ratio = this.power[bin] / (average > TONE_SPECTRUM_FLOOR ? average : TONE_SPECTRUM_FLOOR)
      if (ratio > bestRatio) {
        bestRatio = ratio
        peak = bin
      }
    }
    if (peak < 0) {
      this.measuredProminenceDb = 0
      this.measuredFrequencyHz = 0
      return
    }
    this.measuredProminenceDb = this.prominenceDb(
      peak,
      TONE_WHINE_REFERENCE_INNER_BINS,
      TONE_WHINE_REFERENCE_OUTER_BINS
    )
    this.measuredFrequencyHz = this.interpolatePeakHz(peak)
  }

  private beginTransform(): void {
    for (let index = 0; index < TONE_FFT_SIZE; index++) {
      const source = this.reversal[index]
      this.real[index] = this.samples[source] * this.analysisWindow[source]
      this.imag[index] = 0
    }
    this.stage = 0
    this.stageCountdown = TONE_FFT_STAGE_INTERVAL
    this.transforming = true
  }

  private runStage(): void {
    const size = 2 << this.stage
    const half = size >> 1
    const step = TONE_FFT_SIZE / size
    for (let base = 0; base < TONE_FFT_SIZE; base += size) {
      for (let offset = 0, twiddle = 0; offset < half; offset++, twiddle += step) {
        const lower = base + offset
        const upper = lower + half
        const cosine = this.twiddleCos[twiddle]
        const sine = this.twiddleSin[twiddle]
        const rotatedReal = this.real[upper] * cosine + this.imag[upper] * sine
        const rotatedImag = this.imag[upper] * cosine - this.real[upper] * sine
        this.real[upper] = this.real[lower] - rotatedReal
        this.imag[upper] = this.imag[lower] - rotatedImag
        this.real[lower] += rotatedReal
        this.imag[lower] += rotatedImag
      }
    }
    this.stage++
  }

  private finishTransform(): void {
    for (let bin = 0; bin < TONE_FFT_BINS; bin++) {
      this.power[bin] = this.real[bin] * this.real[bin] + this.imag[bin] * this.imag[bin]
    }
  }

  private prominenceDb(peak: number, innerBins: number, outerBins: number): number {
    let count = 0
    for (let offset = innerBins; offset <= outerBins; offset++) {
      if (count > this.scratch.length - 3) break
      const low = peak - offset
      const high = peak + offset
      if (low >= 1) this.scratch[count++] = this.power[low]
      if (high < TONE_FFT_BINS) this.scratch[count++] = this.power[high]
    }
    if (count === 0) return 0
    for (let index = 1; index < count; index++) {
      const value = this.scratch[index]
      let scan = index - 1
      while (scan >= 0 && this.scratch[scan] > value) {
        this.scratch[scan + 1] = this.scratch[scan]
        scan--
      }
      this.scratch[scan + 1] = value
    }
    const reference = this.scratch[count >> 1]
    const tone = this.power[peak]
    return 10 * Math.log10(
      (tone > TONE_SPECTRUM_FLOOR ? tone : TONE_SPECTRUM_FLOOR) /
      (reference > TONE_SPECTRUM_FLOOR ? reference : TONE_SPECTRUM_FLOOR)
    )
  }

  private interpolatePeakHz(peak: number): number {
    if (peak < 1 || peak >= TONE_FFT_BINS - 1) return peak * TONE_FFT_BIN_HZ
    const left = Math.log(Math.max(this.power[peak - 1], TONE_SPECTRUM_FLOOR))
    const centre = Math.log(Math.max(this.power[peak], TONE_SPECTRUM_FLOOR))
    const right = Math.log(Math.max(this.power[peak + 1], TONE_SPECTRUM_FLOOR))
    const curvature = left - 2 * centre + right
    if (!(curvature < 0)) return peak * TONE_FFT_BIN_HZ
    const shift = (0.5 * (left - right)) / curvature
    const bounded = shift < -0.5 ? -0.5 : shift > 0.5 ? 0.5 : shift
    return (peak + bounded) * TONE_FFT_BIN_HZ
  }
}

class NotchSlot {
  private readonly filter = new VoiceBiquad()
  private readonly bandwidthHz: number
  private readonly retuneHz: number
  private readonly engageDb: number
  private readonly releaseDb: number
  private frequency = 0
  private pendingHz = 0
  private mix = 0
  private engaged = false
  private confirmStreak = 0
  private releaseStreak = 0

  constructor(
    bandwidthHz: number,
    retuneHz: number,
    engageDb: number,
    releaseDb: number,
    initialHz: number
  ) {
    this.bandwidthHz = bandwidthHz
    this.retuneHz = retuneHz
    this.engageDb = engageDb
    this.releaseDb = releaseDb
    if (initialHz > 0) this.tune(initialHz)
  }

  get toneHz(): number {
    return this.frequency
  }

  get isActive(): boolean {
    return this.mix > 0.5
  }

  reset(): void {
    this.mix = 0
    this.engaged = false
    this.confirmStreak = 0
    this.releaseStreak = 0
    this.pendingHz = 0
  }

  observe(prominenceDb: number, frequencyHz: number): void {
    if (prominenceDb >= this.engageDb) {
      if (this.frequency > 0 && Math.abs(frequencyHz - this.frequency) > this.retuneHz) {
        this.pendingHz = frequencyHz
        this.engaged = false
        this.confirmStreak = 0
        this.releaseStreak = 0
        return
      }
      this.releaseStreak = 0
      if (++this.confirmStreak < TONE_CONFIRM_WINDOWS) return
      this.confirmStreak = TONE_CONFIRM_WINDOWS
      this.engaged = true
      if (this.mix <= 0 || Math.abs(frequencyHz - this.frequency) <= 1) this.tune(frequencyHz)
      return
    }
    this.confirmStreak = 0
    if (prominenceDb > this.releaseDb) return
    if (++this.releaseStreak >= TONE_CONFIRM_WINDOWS) {
      this.releaseStreak = TONE_CONFIRM_WINDOWS
      this.engaged = false
    }
  }

  process(sample: number): number {
    const target = this.engaged ? 1 : 0
    if (this.mix < target) {
      this.mix = Math.min(target, this.mix + TONE_MIX_STEP)
    } else if (this.mix > target) {
      this.mix = Math.max(target, this.mix - TONE_MIX_STEP)
      if (this.mix <= 0 && this.pendingHz > 0) {
        this.tune(this.pendingHz)
        this.pendingHz = 0
      }
    }
    const filtered = this.filter.process(sample)
    if (this.mix <= 0) return sample
    return sample + (filtered - sample) * this.mix
  }

  private tune(hz: number): void {
    this.frequency = hz
    this.filter.tuneNotch(hz, Math.max(0.5, hz / this.bandwidthHz))
  }
}

export class TonalNoiseSuppressor {
  private readonly analyzer = new ToneAnalyzer()
  private readonly humSlots = TONE_MAINS_HARMONICS.map(
    hz => new NotchSlot(TONE_HUM_BANDWIDTH_HZ, TONE_HUM_RETUNE_HZ, TONE_HUM_ENGAGE_DB, TONE_HUM_RELEASE_DB, hz)
  )
  private readonly whineSlots = Array.from({ length: TONE_WHINE_SLOTS }, () => new NotchSlot(
    TONE_WHINE_BANDWIDTH_HZ,
    TONE_WHINE_RETUNE_HZ,
    TONE_WHINE_ENGAGE_DB,
    TONE_WHINE_RELEASE_DB,
    0
  ))
  private readonly claimedWhineHz = new Float64Array(TONE_WHINE_SLOTS)

  process(sample: number, adapting: boolean): number {
    if (this.analyzer.push(sample, adapting)) this.evaluate()
    let value = sample
    for (let index = 0; index < this.humSlots.length; index++) {
      value = this.humSlots[index].process(value)
    }
    for (let index = 0; index < this.whineSlots.length; index++) {
      value = this.whineSlots[index].process(value)
    }
    return value
  }

  reset(): void {
    this.analyzer.reset()
    for (let index = 0; index < this.humSlots.length; index++) this.humSlots[index].reset()
    for (let index = 0; index < this.whineSlots.length; index++) this.whineSlots[index].reset()
    this.claimedWhineHz.fill(0)
  }

  get activeHumCount(): number {
    let count = 0
    for (let index = 0; index < this.humSlots.length; index++) {
      if (this.humSlots[index].isActive) count++
    }
    return count
  }

  get lowestHumHz(): number {
    for (let index = 0; index < this.humSlots.length; index++) {
      if (this.humSlots[index].isActive) return this.humSlots[index].toneHz
    }
    return 0
  }

  get activeWhineCount(): number {
    let count = 0
    for (let index = 0; index < this.whineSlots.length; index++) {
      if (this.whineSlots[index].isActive) count++
    }
    return count
  }

  get strongestWhineHz(): number {
    for (let index = 0; index < this.whineSlots.length; index++) {
      if (this.whineSlots[index].isActive) return this.whineSlots[index].toneHz
    }
    return 0
  }

  private evaluate(): void {
    for (let index = 0; index < this.humSlots.length; index++) {
      this.analyzer.measureHarmonic(TONE_MAINS_HARMONICS[index])
      this.humSlots[index].observe(
        this.analyzer.measuredProminenceDb,
        this.analyzer.measuredFrequencyHz
      )
    }
    this.claimedWhineHz.fill(0)
    for (let index = 0; index < this.whineSlots.length; index++) {
      this.analyzer.measureWhine(this.claimedWhineHz, index)
      this.whineSlots[index].observe(
        this.analyzer.measuredProminenceDb,
        this.analyzer.measuredFrequencyHz
      )
      this.claimedWhineHz[index] = this.analyzer.measuredFrequencyHz
    }
  }
}
