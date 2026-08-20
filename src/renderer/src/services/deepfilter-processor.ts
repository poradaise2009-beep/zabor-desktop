import { StandaloneDeepFilter } from 'deepfilter-standalone'

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

const pendingFetches = new Map<string, (ab: ArrayBuffer) => void>()

// Polyfill fetch in AudioWorklet to proxy to the main thread
if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = (url: string | URL | Request): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url.toString()
    return new Promise((resolve, reject) => {
      pendingFetches.set(urlStr, (ab: ArrayBuffer) => {
        if (!ab) {
          reject(new Error('Fetch failed in main thread'))
          return
        }
        resolve({
          ok: true,
          statusText: 'OK',
          arrayBuffer: async () => ab
        } as unknown as Response)
      })
      // The port is only available inside the class instance, so we need a global proxy function
      if (globalThis.proxyFetchToMain) {
        globalThis.proxyFetchToMain(urlStr)
      } else {
        reject(new Error('proxyFetchToMain not set'))
      }
    })
  }
}

// Polyfill performance.now() which is used by StandaloneDeepFilter
if (typeof globalThis.performance === 'undefined') {
  (globalThis as any).performance = {
    now: () => Date.now()
  }
}

declare global {
  var proxyFetchToMain: ((url: string) => void) | undefined;
}

class DeepFilterProcessor extends AudioWorkletProcessor {
  private inputBuffer: Float32Array
  private outputBuffer: Float32Array
  private inputReadIndex = 0
  private inputWriteIndex = 0
  private outputReadIndex = 0
  private outputWriteIndex = 0

  private readonly FRAME_SIZE = 480
  private readonly BUFFER_SIZE = 24000

  private denoiser: StandaloneDeepFilter | null = null
  private denoiserReady = false

  private readonly frameToProcess: Float32Array
  private readonly processedFrame: Float32Array
  private monoInput = new Float32Array(0)

  private isMuted = false
  private noiseSuppression = true

  private rmsSmoothed = 0
  private lastVadSent = false
  private overflowCount = 0
  private denoiserErrorCount = 0

  private readonly VAD_FRAME_SIZE = 512
  // Hard bounds of the adaptive opening threshold. The tracker below may move
  // freely between them and nowhere else: under VAD_ON_MIN clean room tone opens
  // the gate, over VAD_ON_MAX a quiet voice no longer opens it. The ceiling used to
  // be 0.35 because threshold height was the only defence against a noisy room -
  // and that is precisely what made a scrape across the table cost the voice: the
  // room drove the threshold up, and a threshold high enough to reject the scrape
  // rejects a quiet syllable with it. Periodicity is that defence now, and it is
  // orthogonal to level, so the threshold no longer has to travel. 0.22 leaves
  // Silero near its own operating point, where quiet speech still scores above it.
  private readonly VAD_ON_MIN = 0.12
  private readonly VAD_ON_MAX = 0.22
  private readonly VAD_ON_MARGIN = 0.05
  private readonly VAD_OFF_RATIO = 0.4
  private readonly VAD_OFF_MIN = 0.06
  // A phrase with no periodicity anywhere in it is either a whisper or a scrape,
  // and nothing cheap separates those two. Rather than lose whispers, they are let
  // in on Silero alone - but only where Silero is genuinely confident, far above
  // where a scrape lands. Voiced phrases never come near this: they open at the
  // adaptive threshold above.
  private readonly VAD_UNVOICED_ON = 0.6
  // The middle tier: no period in this window, but one in the windows around it. See
  // the three-way choice of openThreshold for why this exists rather than being
  // folded into either neighbour.
  private readonly VAD_SEMI_VOICED_ON = 0.35
  // Both room trackers are quantiles over a bounded trailing history rather than
  // exponential followers. A follower that decays at a fixed rate has no way to
  // know an event ended: it carries a shout, or the tail of one, for its whole fall
  // time constant - 16 s for the probability tracker as it was written - and every
  // quiet syllable in those 16 s pays for it. A quantile over a window forgets by
  // construction. The moment the loud samples are older than the window they are
  // simply not in the estimate any more, so the threshold describes what the room
  // is doing now instead of what it did a quarter of a minute ago. The window is
  // the entire memory of the estimator, and adaptation upward is unaffected: it
  // still takes a tenth of the window's samples to move the quantile at all.
  //
  // 0.9 rather than the 0.95 the wizard uses on its own longer capture: the top 5%
  // of a 64-sample window is three samples, which is too few to be a stable
  // statistic and is exactly where a stray speech tail lands.
  private readonly NOISE_PROB_QUANTILE = 0.9
  private readonly noiseProbHistory = new Float32Array(64) // ~2 s of learned windows
  private readonly noiseProbScratch = new Float32Array(64)
  private noiseProbHistoryIndex = 0
  private noiseProbHistoryCount = 0
  private readonly NOISE_TRACKER_SETTLE_WINDOWS = 8
  // Minimum speech duration, the same mechanism Silero's own reference
  // implementation applies outside the model (min_speech_duration_ms = 250 in
  // utils_vad.py): a candidate has to persist before it is called speech at all.
  // Three consecutive 32 ms decisions is 96 ms, which is longer than any impulse -
  // a clap, a key press, a door - and shorter than the shortest real word. Two
  // windows was 64 ms, short enough that the decay tail of a single clap satisfied
  // it, which is why claps reached the stream. Nothing is lost at the start of the
  // phrase: the whole confirmation period is marked speech retroactively out of the
  // delay line below, so the onset is sent in full.
  //
  // Four was tried and made the voice break up, for a reason that is worth keeping
  // written down: a run of "consecutive" windows is not what speech looks like to
  // Silero. Real speech alternates voiced and unvoiced within a syllable, the
  // unvoiced windows are scored against a much higher bar (VAD_UNVOICED_ON), and one
  // of them used to zero the run outright - so four *strictly* consecutive
  // qualifying windows almost never accumulated and phrases opened at random. The
  // fix is the gap tolerance below, not a shorter run; three windows with gaps
  // allowed is both stricter against impulses and far more reliable on speech than
  // four windows without.
  private readonly VAD_ATTACK_RESULTS = 3
  // How many windows in the middle of a forming run may fall short without
  // abandoning it. This is the same hysteresis Silero's reference gets from
  // neg_threshold = threshold - 0.15, which the attack phase here had no equivalent
  // of: a window that is merely unremarkable pauses the run, only a window below
  // vadOffThreshold - genuine silence - cancels it. Bounding it at three windows is
  // what keeps it from becoming "any three loud windows within a minute": the whole
  // confirmation still has to happen inside ~190 ms, so scattered noise cannot
  // assemble a phrase out of unrelated bursts.
  private readonly VAD_ATTACK_GAP_MAX = 3
  // 512 samples at 16 kHz is 32 ms, and a processing frame is 10 ms.
  private readonly VAD_WINDOW_FRAMES = 3.2
  // Hangover proportional to how confident the segment was: 5 windows (160 ms)
  // for a marginal detection, 12 (384 ms) for a clearly voiced phrase, so quiet
  // word endings survive while an edge trigger on a noise burst closes fast.
  private readonly VAD_RELEASE_MIN_RESULTS = 5
  private readonly VAD_RELEASE_MAX_RESULTS = 12
  private readonly MANUAL_HOLD_FRAMES = 30
  // Keep 240 ms of audio so a Silero result can be attached to the actual source
  // frames it classified instead of changing the state of whatever frame happens
  // to be processed when the worker replies. The delay has to cover everything the
  // confirmation above reaches back over: the first confirming window is remembered
  // by frame id (attackFirstWindowEndFrameId), so the reach is 3.2 frames of that
  // window plus 9 frames of preroll - 13 of the 24 available in the no-gap case, and
  // at most 22 when the run used its full gap tolerance.
  private readonly DECISION_DELAY_FRAMES = 24
  // Preroll ahead of the first confirmed window. 16 frames was chosen when the
  // segment opened at the second window and nothing reached back past it; with the
  // confirmation period now marked as well, 160 ms of extra preroll on top of it
  // would pull in whatever happened a fifth of a second before the voice - the
  // mouse click, the chair - so it is cut to the 90 ms that only covers the
  // pre-voiced part of an onset.
  private readonly SPEECH_PREROLL_FRAMES = 9
  private noiseProbHigh = 0.05
  private vadOnThreshold = this.VAD_ON_MIN
  private vadOffThreshold = this.VAD_OFF_MIN
  private speechSegmentOpen = false
  private consecutiveVadSpeechResults = 0
  private attackGapWindows = 0
  // Frame id of the window that started the forming run, so the retroactive marking
  // reaches exactly as far back as the run really went and no further. Deriving it
  // from the run length instead would have to assume the worst case every time,
  // which on a run with no gaps means dragging in 200 ms of whatever preceded the
  // voice - the mouse click, the chair - the preroll was shortened to exclude.
  private attackFirstWindowEndFrameId = -1
  private consecutiveVadSilenceResults = 0
  private closedWindowsSinceSpeech = 0
  private segmentPeakProbability = 0
  // Every estimator in this file is a slow follower, and an impulse - a clap, a
  // door, a key press - is 20 to 40 dB above whatever the follower is tracking and
  // lasts one or two frames. A follower that accepts it whole therefore moves a
  // large fraction of its range on a single event, which is exactly what was
  // reported: clapping walked the room-probability tracker to its ceiling until
  // quiet syllables no longer opened the gate, and made the level control read the
  // clap as the user's own voice and hand back its gain. Each follower below
  // clamps how far above its own current value one frame may pull it. Sustained
  // content still moves it the whole way - the clamp rises with the estimate, so it
  // converges geometrically in a few time constants - while an impulse can do no
  // more than a loud syllable. None of this touches the audio: it decides only what
  // the estimators are allowed to learn from.
  private readonly IMPULSE_CLAMP_RATIO = 4 // 12 dB
  // The adaptive threshold must not be allowed to rise into the user's own voice.
  // The peak probability of each speech segment is followed from below - fast down,
  // slow up, so the estimate settles near the quietest phrase the user actually
  // produces - and the opening threshold is then held a margin under it. A room
  // that scores high enough to threaten that phrase loses the argument: the
  // denoiser cleans whatever passes, and nothing can clean a syllable that was
  // never sent. Seeded high so it constrains nothing until real speech is seen.
  private readonly VOICE_PROB_FALL = 0.08
  private readonly VOICE_PROB_RISE = 0.004
  private readonly VOICE_PROB_MARGIN = 0.06
  // VAD_ATTACK_RESULTS is 4, so a segment that closed at five windows has shown
  // nothing but an edge trigger and says nothing about how the user's voice scores.
  private readonly VOICE_PROB_MIN_WINDOWS = 8
  private voiceProbLow = 0.9
  private segmentWindows = 0
  private loggedVadOnThreshold = -1
  private lastVadSequence = -1
  private audioFrameId = 0

  // Voicing. Silero answers "is this speech" out of a spectral model, and a scrape
  // across a table is close enough to a fricative in that space to score like
  // speech. What a scrape does not have is a period. Every voiced sound a person
  // makes - vowels, nasals, laughter, a sigh, "мм" - repeats at the rate the vocal
  // folds close, and for humans that rate is 70-400 Hz across men, women, children
  // and falsetto. A normalised autocorrelation restricted to exactly those lags
  // separates the two on a property Silero never looks at. That is the whole reason
  // this exists: raising Silero's threshold cannot do it, because the threshold is
  // one number and every value high enough to reject the scrape also rejects a
  // quiet syllable. Measured on synthetic signals, voiced speech scores 0.70 (at
  // 0 dB SNR) to 1.00 and a rumbly scrape, a fricative and white noise score
  // 0.16-0.34, so the bar sits in the middle of that gap.
  //
  // What this does NOT reject, measured the same way: a ringing resonance - a table
  // struck rather than scraped, a chair creak - scores 0.73-0.96, because a ringing
  // resonance genuinely is periodic. Nothing cheap separates that from a nasal: the
  // fraction of energy above 1 kHz, the obvious candidate, reads 0.11 for a 180 Hz
  // resonance and 0.12 for "мм", and narrowing the autocorrelation peak to demand
  // harmonics would reject the low-harmonic hums this gate exists to pass. So the
  // two failure modes are covered by conjunction rather than by one better feature:
  // a scrape is noise-like and fails periodicity, a creak is tonal and fails Silero,
  // and a sound now has to satisfy both to open the gate. Neither test is weakened
  // to cover the other's blind spot.
  private readonly PITCH_MIN_LAG = 40 // 400 Hz at 16 kHz
  private readonly PITCH_MAX_LAG = 229 // 70 Hz at 16 kHz
  private readonly PITCH_WINDOW = 256 // 16 ms of analysis
  // Voiced speech measured here scores 0.70-1.00 and room noise 0.16-0.34, so the bar
  // sits in the gap. It was 0.5, the middle of the gap, which was right until the 90 Hz
  // high-pass was added ahead of this processor: removing energy below the fundamental
  // costs a low voice part of the periodicity this statistic is built on, and a real
  // syllable was measured at 0.48 - rejected by two hundredths. 0.45 restores the
  // margin on the voice side and is still 0.11 above the loudest noise reading, and the
  // rumble the higher bar was defending against is now removed by the filter rather
  // than argued about here.
  private readonly VOICING_SPEECH_MIN = 0.45
  // A steady tone scores 1.0 here - periodicity alone cannot tell a whine from a
  // vowel - so this never opens the gate by itself. It is a veto on non-voice, not
  // a detector of voice: Silero, the level trackers and the spectral bounds below
  // still have to agree that the sound is the user rather than the room.
  //
  // One voiced core admits the fricatives, breath and word tails around it, which
  // is what lets the complete speech spectrum through rather than only its voiced
  // half. 6 windows is ~200 ms either side, longer than any single consonant.
  private readonly VOICING_HOLD_WINDOWS = 6
  // Periodicity is only evidence of a voice if it is the *same* period from one window
  // to the next. A fundamental moves smoothly - a fifth of an octave inside 32 ms is
  // already an unusually fast glide - so a voice holds its lag across consecutive
  // windows. A broadband impulse does not: the autocorrelation still finds its best
  // match somewhere in 70-400 Hz and still scores high, but the winning lag is
  // wherever the noise happened to line up, and it lands somewhere else on the next
  // window. That is the case this rejects, and it is the common one.
  //
  // It does not reject a genuinely tonal ring - a struck table holding one frequency
  // for 100 ms passes this test as honestly as a vowel does. Nothing here pretends
  // otherwise: that case is carried by the transient envelope test below, by the
  // minimum speech duration, and by the 90 Hz high-pass ahead of this processor,
  // which removes most of what a struck desk actually radiates. Conjunction again,
  // not one better feature.
  private readonly VOICING_LAG_DRIFT_MAX = 0.25
  private readonly pitchBuffer = new Float32Array(512)
  private readonly pitchScratch = new Float32Array(512)
  private pitchWriteIndex = 0
  private pitchFilled = 0
  private voicing = 0
  private voicingLag = 0
  private previousVoicingLag = 0
  private voicingHoldWindows = 0
  private rejectedUnvoicedFrames = 0

  // Silero's answer for a window arrives several frames after the window was measured,
  // so "was this window periodic" cannot be read from the latest measurement - by then
  // it describes a later window. Both answers are keyed by the window's own end frame
  // id and paired on arrival, which is what lets the opening decision require
  // periodicity in the window Silero actually classified rather than anywhere in the
  // last 200 ms. Twelve entries is ~384 ms, far beyond the worker's own backlog limit.
  private readonly voicingRingFrameIds = new Int32Array(12).fill(-1)
  private readonly voicingRingVoiced = new Uint8Array(12)
  private voicingRingWriteIndex = 0

  // Transient rejection. Every branch below this point classifies a sound by what it
  // looks like in one 10 ms frame - level, zero crossings, spectral tilt,
  // periodicity - and an impulse can satisfy all of them at once: a clap is loud,
  // smooth, low-tilt and (through the room's own resonance) periodic. What no impulse
  // shares with speech is its envelope. A glottal onset takes 20-50 ms to reach full
  // level because it is driven by air; a clap, a key press or a knock reaches it in
  // one frame, because it is driven by a collision. Two independent envelope
  // measurements, both required:
  //
  //   attack  - how far the frame rose above the previous one. >15 dB in 10 ms is a
  //             collision; the steepest speech onset measured here is well under it.
  //   crest   - peak over RMS inside the frame. An impulse concentrates its energy in
  //             a few samples and reads above 6 (16 dB); speech, even a plosive,
  //             spreads it across the frame and stays under.
  //
  // Requiring both is what keeps this off the voice: a loud syllable after a pause
  // has the attack but not the crest, and a bright fricative has the crest but not
  // the attack. This does not attenuate anything - it only denies the frame the right
  // to open the gate, and keeps it out of the retroactive preroll.
  private readonly TRANSIENT_ATTACK_DB = 15
  private readonly TRANSIENT_CREST = 6
  // Attack and crest are necessary but not sufficient, and treating them as
  // sufficient rejected speech outright: measured in a -71 dBFS room, the first frame
  // of an ordinary word rises 40 dB above the silence before it, and a plosive reads
  // crest 6.2. Both tests fire on it, and the verdict landed on the very onset the
  // gate most needs.
  //
  // What actually separates the two cases is what happens next, and this processor
  // already runs 240 ms behind the input, so it can simply wait and look. An impulse
  // is over almost immediately - a clap, a key press or a knock falls 12 dB below its
  // own peak inside 60 ms - while a syllable sustains, because it is driven by air
  // that keeps flowing. So attack and crest only nominate a frame, and the frame is
  // convicted on the decay: fall far enough, fast enough, and it is an impulse and the
  // frames from the nomination onward are flagged retroactively out of the delay line;
  // otherwise the nomination is dropped and the sound was a voice all along.
  private readonly TRANSIENT_DECAY_FRAMES = 6
  private readonly TRANSIENT_DECAY_RATIO = 0.25 // -12 dB under the nominated peak
  // The decay of an impulse is as unlike speech as its attack, and it is the part
  // that used to be admitted: the frame after a clap is loud, smooth and no longer
  // rising, so it passed every test. Held from the moment of conviction, by which
  // point the decay itself has already been observed - so this only has to cover what
  // rings on after it, and 50 ms is enough for a hand clap or a key press in a small
  // room without reaching into the syllable that may follow.
  private readonly TRANSIENT_HOLD_FRAMES = 5
  private previousFrameRms = 0
  private transientHoldFrames = 0
  private transientCandidateFrameId = -1
  private transientCandidateRms = 0
  private transientCandidateAge = 0
  private transientCandidateAttackDb = 0
  private transientCandidateCrest = 0
  private rejectedTransientFrames = 0

  // Silero is trained on speech: laughter, a cough, a sigh or "мм" score low, so
  // the requirement that human sounds always pass cannot be met through it alone.
  // A second tracker of the same shape as the one above follows the room level in
  // dBFS, and a frame that rises 10 dB above that room while staying spectrally
  // voice-like opens the gate on its own. Only the upper bounds are checked: "мм"
  // and laughter are low-frequency, hiss and key clicks are not.
  private readonly NOISE_RMS_QUANTILE = 0.9
  private readonly noiseRmsHistory = new Float32Array(200) // 2 s at 10 ms frames
  private readonly noiseRmsScratch = new Float32Array(200)
  private noiseRmsHistoryIndex = 0
  private noiseRmsHistoryCount = 0
  // The quantile is a whole-window statistic; recomputing it 20 times a second is
  // finer than anything downstream of it can resolve and keeps the sort off 80% of
  // the audio callbacks.
  private readonly NOISE_RMS_REFRESH_FRAMES = 5
  private readonly NOISE_TRACKER_SETTLE_FRAMES = 25
  private readonly HUMAN_SOUND_RISE_RATIO = 3.2
  private readonly HUMAN_SOUND_MAX_ZCR = 0.45
  private readonly HUMAN_SOUND_MAX_TILT = 8
  private readonly HUMAN_SOUND_HOLD_FRAMES = 15
  // The same minimum-duration argument as VAD_ATTACK_RESULTS, applied to this branch.
  // A single qualifying frame used to buy 150 ms of open gate, so one frame of clap
  // decay was enough on its own no matter what the Silero path decided. A real human
  // sound - a laugh, a cough, "мм" - lasts hundreds of milliseconds, so 30 ms of
  // continuity costs it nothing.
  private readonly HUMAN_SOUND_MIN_FRAMES = 3
  // Absolute floor for the branch above. On a studio microphone the tracked room
  // level can sit below breathing, where the relative bar alone would trigger on
  // the user's own quiet exhale.
  private readonly HUMAN_SOUND_MIN_RMS = 0.0006
  private noiseRmsHigh = 0.003
  private closedFramesSinceSpeech = 0
  private humanSoundHoldFrames = 0
  private humanSoundFrames = 0

  // Outgoing loudness (automatic level control, ITU-T G.169 in shape: one slow
  // gain, no per-syllable riding). A chain built at unity gain sends whatever the
  // microphone happened to produce, which on a laptop is -35..-45 dBFS of active
  // speech. ITU-T's nominal active speech level for a digital telephony interface
  // is -26 dBov, and that is already the quiet end - streaming practice sits above
  // it (EBU R 128 asks -23 LUFS for broadcast, the AES streaming recommendation
  // -16..-20 LUFS). -20 dBFS RMS of active speech lands inside that band, roughly
  // -18 LUFS for mono speech, ~6 dB above the telephony nominal. That difference is
  // exactly why every user turns everything up and still finds it quiet.
  private readonly ALC_TARGET_RMS = 0.1
  // -1 dBFS, the ceiling EBU R 128 states as -1 dBTP. The WaveShaper further down
  // the graph stays a last resort rather than a working part of the chain.
  private readonly ALC_PEAK_CEILING = 0.891
  private readonly ALC_MAX_GAIN = 15.85 // +24 dB
  private readonly ALC_MIN_SPEECH_RMS = 0.0015
  // Speech peaks sit 12-18 dB above the long-term active-speech level, so a frame
  // peak further above it than this is not the voice's crest. See IMPULSE_CLAMP_RATIO.
  private readonly ALC_MAX_PEAK_OVER_RMS = 8 // 18 dB
  // ITU-T P.56 defines active speech level as a mean taken over the frames that
  // carry speech, and that is what the target above refers to, so this follower is
  // symmetric and slow (2.5 s) rather than a peak-follower like the noise trackers
  // further up. Only frames the gate passed ever reach it - that is what makes it
  // "active", and it is why no separate speech/pause detector is needed here.
  private readonly ALC_RMS_RATE = 0.004
  // The ceiling needs the opposite shape: catch a peak on the frame it happens and
  // forget it on the same 2.5 s the mean above uses. It used to forget over 8 s, on
  // the theory that a slow ceiling is a safe ceiling - but the impulse clamp below
  // is what makes it safe, and 8 s of memory only meant that a single shout held the
  // gain down for three sentences afterwards. This is the one estimator here that is
  // deliberately not instant: the gain is what the listener hears, and a gain that
  // tracks the current phrase is a compressor - it pushes vowels down and pulls
  // consonants up, which is heard as exactly the flat, unnatural voice this whole
  // chain exists to avoid. 2.5 s is well past the longest syllable and well short of
  // a conversation.
  private readonly ALC_PEAK_RISE = 0.3
  private readonly ALC_PEAK_FALL = 0.004
  // 1.25 s on top of the followers. The two together are why this is level control
  // and not compression: the gain cannot move inside a syllable, so vowels are not
  // pushed down and consonants are not pulled up.
  private readonly ALC_GAIN_SMOOTH = 0.008
  // The followers are set outright on the first frame of speech rather than decayed
  // into from a seed, and the gain is given 200 ms instead of 1.25 s until half a
  // second of speech has been seen. Without this a quiet microphone spends half a
  // minute climbing, because the slow rates that keep the gain steady during a call
  // are also the rates it would have to converge at.
  private readonly ALC_SEED_FRAMES = 50
  private readonly ALC_SEED_GAIN_SMOOTH = 0.05
  private alcSpeechRms = 0
  private alcSpeechPeak = 0
  private alcSpeechFrames = 0
  private alcGain = 1
  // Everything between this processor and the track is pure gain: the user's own
  // volume slider reaches 200%. The peak ceiling has to hold where the signal
  // leaves the graph, not where this loop applies it, so the downstream factor is
  // reported in and divided out. Without it a peaky voice at 200% arrives at
  // +5 dBFS and the WaveShaper - a last-resort clipper - becomes a working part
  // of the chain on every phrase.
  private alcDownstreamGain = 1
  private alcLoggedGain = 1
  private alcLogFrames = 0

  private readonly speechRingSpeech: Uint8Array
  private readonly speechRingFrames: Float32Array[] = []
  private readonly speechRingFrameIds: Int32Array
  private readonly speechRingRms: Float32Array
  private readonly speechRingZcr: Float32Array
  private readonly speechRingTilt: Float32Array
  private readonly speechRingTransient: Uint8Array
  private speechRingWriteIndex = 0
  private speechRingCount = 0
  private gateGain = 0
  // Automatic mode sends speech only. The short release ramp prevents a click,
  // then non-speech reaches digital silence.
  private readonly GATE_FLOOR = 0

  // Suppression strength in dB, driven by the measured room level. The wide range
  // is what makes a deliberately permissive gate safe: whatever the gate lets
  // through still arrives 65+ dB below the voice. The floor is 7 rather than 10
  // because manual mode asks for a deliberately light pass (DEEPFILTER_MANUAL_ATTEN
  // in webrtc.ts) - clamping it up to 10 here would silently overrule that.
  private readonly MIN_ATTEN_LIMIT = 7
  private readonly MAX_ATTEN_LIMIT = 45
  private attenuationLimit = 24
  private postFilterBeta = 0
  private cdnUrl: string | undefined

  // The calibrated attenuation limit is a measurement of one room over 2.5 s of
  // silence, and it has to predict how much suppression a whole call will need. It
  // systematically under-predicts, for a reason that is structural rather than a
  // tuning error: the wizard measures the room but cannot measure the voice, so it
  // has to assume how far the voice sits above it, and the automatic level control
  // then multiplies both by up to +24 dB. The two numbers that actually decide the
  // answer are measured continuously right here - the room level tracker and the
  // ITU-T P.56 active speech level - and their ratio is the true SNR. So the
  // calibrated value becomes the seed and the floor, and this loop takes it from
  // there using real speech against the real room.
  //
  // Deliberately one-directional and slow. Suppression depth is audible as texture
  // inside a phrase, and a limit that moves while a person is talking is heard as
  // the room breathing behind them; 1 dB/s is below the rate at which that is
  // perceptible, and the limit only ever climbs within a session because giving depth
  // back on a quiet moment would mean re-learning it on the next loud one.
  private readonly TARGET_SPEECH_TO_NOISE_DB = 55
  private readonly ATTEN_KNEE_DB = 24
  private readonly ATTEN_ABOVE_KNEE_SLOPE = 0.5
  private readonly ATTEN_SLEW_DB_PER_SEC = 1
  // A second of measured speech before the P.56 follower means anything, and the
  // room tracker's full 2 s window before its quantile does.
  private readonly ATTEN_MIN_SPEECH_FRAMES = 100
  private attenuationFloor = 24
  private attenuationTarget = 24
  private adaptiveAttenuationEnabled = false
  private attenuationLoggedLimit = 24

  // DeepFilter's own verdict, used as a per-frame veto. Every other test in this file
  // is a hand-written feature - a threshold, a ratio, an autocorrelation - and each
  // has a blind spot that had to be covered by conjunction with another. The denoiser
  // is a trained model that has already made a full spectral decision about this exact
  // frame, and the decision is legible in its output: comparing the frame's energy
  // before and after the mask gives how much the network chose to remove. When that
  // reaches the limit the network was given, the network has classified the frame as
  // nothing but noise. There is no reason to send a frame the denoiser has already
  // emptied, whatever the VAD thought of it - and being a different model entirely,
  // its mistakes are not correlated with Silero's. This is the last line: it catches
  // what got through everything above.
  //
  // Two consecutive frames was not nearly enough, and the reason is worth stating: the
  // veto is a claim about a *sound*, and two frames is 20 ms, which is shorter than the
  // quiet parts of ordinary speech. A word tail, an /f/, a breath between clauses - the
  // network takes 13 dB out of any of those without meaning "this is not speech", and
  // the gate then shut in the middle of a word. What the veto is genuinely for is
  // sustained non-speech that fooled the VAD: a fan, a hum, a distant television, all of
  // which last far longer than a syllable. 80 ms is above every gap inside a word and
  // far below the duration of anything the veto is meant to catch, so it keeps its
  // purpose and stops interrupting the voice. (It still cannot catch a click - a click
  // is 10-40 ms - but clicks are the transient detector's job, upstream of here.)
  //
  // Three dB of slack under the limit because the measured ratio is a whole-frame
  // average while the limit applies per band.
  private readonly DF_VETO_MARGIN_DB = 3
  private readonly DF_VETO_MIN_FRAMES = 8
  // A floor under the evidence, not under the limit. "Removed everything it was allowed
  // to" is only a verdict when the allowance was deep: at the manual mode's 7 dB the
  // limit-derived threshold would be 4 dB, and 4 dB off a frame is something the network
  // does to a quiet word tail without meaning anything by it. Requiring 9 dB regardless
  // switches the veto off in the shallow modes - where the engine cannot produce that
  // much reduction at all - and leaves it fully active wherever the limit is deep enough
  // for the verdict to mean what it says.
  private readonly DF_VETO_MIN_REDUCTION_DB = 9
  private dfVetoFrames = 0

  private thresholdMode = 'auto'
  private noiseFloorEstimate = 0.003
  private sileroVadEnabled = false
  private sileroVadHealthy = false
  private lastSileroResultFrameId = -1
  private sileroVadProbability = 0.0
  private readonly vad16kBuffer = new Float32Array(this.VAD_FRAME_SIZE)
  private vad16kWriteIndex = 0
  private vadSequence = 0
  private readonly vadDecimatorTaps = new Float32Array(49)
  private readonly vadDecimatorHistory = new Float32Array(49)
  private vadDecimatorWriteIndex = 0
  private vadDecimatorPhase = 0
  private vadWindowSquareSum = 0
  private vadWindowSampleCount = 0

  // One measuring stage: the room with nobody speaking. 2.5 s is 250 frames, of
  // which the lead-in is discarded so the click that started the run cannot enter
  // the noise profile.
  private calibrationFramesLeft = 0
  private readonly CALIBRATION_LEAD_IN_FRAMES = 20
  // Silero level a frame has to reach before it may be called the user's own voice
  // and kept out of the noise profile. A fixed value on purpose: the runtime gate
  // threshold is now a tracked quantity bounded well above this, so deriving the
  // calibration filter from it would exclude nothing.
  private readonly CALIBRATION_SPEECH_VAD_FLOOR = 0.08
  private readonly calibrationRms = new Float32Array(600)
  private readonly calibrationNoiseVad = new Float32Array(200)
  private calibrationTotalFrames = 0
  private calibrationStartFrameId = 0
  private calibrationCount = 0
  private calibrationNoiseVadCount = 0
  private calibrationRejectedSpeechFrames = 0
  private calibrationZcrSum = 0
  private calibrationSpectralTiltSum = 0
  // Trailing level history of the run, used to tell the user's own voice from
  // speech-shaped room background. It has to be measured inside this run:
  // noiseFloorEstimate is a stored calibration value that is 20 dB off on a first
  // run, and any absolute dBFS threshold is wrong on some microphone.
  private readonly calibrationSilenceHistory = new Float32Array(100)
  private readonly calibrationSilenceScratch = new Float32Array(100)
  private calibrationSilenceHistoryCount = 0
  private calibrationSilenceHistoryIndex = 0
  private calibrationSilenceLevel = 0

  private manualThresholdDb = -42
  private manualVadHoldFrames = 0
  private meterFrameCounter = 0
  private gainFactor = 1

  constructor() {
    super()
    this.inputBuffer = new Float32Array(this.BUFFER_SIZE)
    this.outputBuffer = new Float32Array(this.BUFFER_SIZE)
    this.frameToProcess = new Float32Array(this.FRAME_SIZE)
    this.processedFrame = new Float32Array(this.FRAME_SIZE)
    this.speechRingSpeech = new Uint8Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingFrameIds = new Int32Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingFrameIds.fill(-1)
    this.speechRingRms = new Float32Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingZcr = new Float32Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingTilt = new Float32Array(this.DECISION_DELAY_FRAMES + 1)
    this.speechRingTransient = new Uint8Array(this.DECISION_DELAY_FRAMES + 1)
    for (let i = 0; i < this.speechRingSpeech.length; i++) {
      this.speechRingFrames.push(new Float32Array(this.FRAME_SIZE))
    }
    // Windowed-sinc low-pass for clean 48 -> 16 kHz decimation. Forty-nine taps
    // preserve the speech band while rejecting aliases above the 8 kHz Nyquist
    // limit much more strongly than the former short filter. The coefficients are
    // normalized to unity DC gain, so Silero still receives the raw voice level.
    const center = (this.vadDecimatorTaps.length - 1) / 2
    const cutoff = 0.15
    let tapSum = 0
    for (let i = 0; i < this.vadDecimatorTaps.length; i++) {
      const offset = i - center
      const sinc = offset === 0
        ? 2 * cutoff
        : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset)
      const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (this.vadDecimatorTaps.length - 1))
      const tap = sinc * window
      this.vadDecimatorTaps[i] = tap
      tapSum += tap
    }
    for (let i = 0; i < this.vadDecimatorTaps.length; i++) this.vadDecimatorTaps[i] /= tapSum
    // Buffer enough zeros to prevent underflow while accumulating the first 480 input samples
    this.outputWriteIndex = this.FRAME_SIZE * 2

    globalThis.proxyFetchToMain = (url: string) => {
      this.port.postMessage({ type: 'fetchRequest', url })
    }

    this.port.onmessage = (event) => {
      if (event.data.type === 'loadWasm') {
        if (typeof event.data.cdnUrl === 'string' && event.data.cdnUrl) {
          this.cdnUrl = event.data.cdnUrl
        }
        this.initDeepFilter()
      } else if (event.data.type === 'setConfig') {
        if (event.data.noiseSuppression !== undefined) {
          this.noiseSuppression = event.data.noiseSuppression
        }
        if (event.data.sileroVadEnabled !== undefined) {
          this.sileroVadEnabled = event.data.sileroVadEnabled
          if (!this.sileroVadEnabled) this.sileroVadHealthy = false
        }
        if (event.data.isMuted !== undefined) {
          const nextMuted = event.data.isMuted
          if (nextMuted && !this.isMuted && this.calibrationFramesLeft > 0) {
            // Muting in the middle of a calibration run: the full reset below
            // would zero audioFrameId and invalidate calibrationStartFrameId, so
            // the run could never produce a result. Only silence what is already
            // buffered — process() keeps writing zeros while muted.
            this.outputBuffer.fill(0)
            if (this.lastVadSent) {
              this.port.postMessage({ type: 'vad', isSpeaking: false })
              this.lastVadSent = false
            }
          } else if (nextMuted && !this.isMuted) {
            this.inputBuffer.fill(0)
            this.outputBuffer.fill(0)
            this.inputReadIndex = 0
            this.inputWriteIndex = 0
            this.outputReadIndex = 0
            this.outputWriteIndex = this.FRAME_SIZE * 2
            this.rmsSmoothed = 0
            this.speechSegmentOpen = false
            this.consecutiveVadSpeechResults = 0
            this.attackGapWindows = 0
            this.attackFirstWindowEndFrameId = -1
            this.consecutiveVadSilenceResults = 0
            // The room does not change because the user muted, so both trackers
            // keep what they learned. Only the per-segment state is dropped.
            this.closedWindowsSinceSpeech = 0
            this.closedFramesSinceSpeech = 0
            this.segmentPeakProbability = 0
            this.segmentWindows = 0
            this.humanSoundHoldFrames = 0
            this.humanSoundFrames = 0
            this.previousFrameRms = 0
            this.transientHoldFrames = 0
            this.transientCandidateFrameId = -1
            this.transientCandidateRms = 0
            this.transientCandidateAge = 0
            this.dfVetoFrames = 0
            this.sileroVadHealthy = false
            this.lastSileroResultFrameId = -1
            this.lastVadSequence = -1
            this.audioFrameId = 0
            this.speechRingWriteIndex = 0
            this.speechRingCount = 0
            this.gateGain = 0
            this.speechRingSpeech.fill(0)
            this.speechRingFrameIds.fill(-1)
            this.speechRingRms.fill(0)
            this.speechRingZcr.fill(0)
            this.speechRingTilt.fill(0)
            this.speechRingTransient.fill(0)
            for (const frame of this.speechRingFrames) frame.fill(0)
            this.vad16kWriteIndex = 0
            this.vad16kBuffer.fill(0)
            this.vadDecimatorHistory.fill(0)
            this.vadDecimatorWriteIndex = 0
            this.vadDecimatorPhase = 0
            this.vadWindowSquareSum = 0
            this.vadWindowSampleCount = 0
            // The pitch ring holds pre-mute audio. Left in place, the first window
            // after unmute would correlate the new signal against the old one across
            // the silence, which is a comparison of two unrelated sounds.
            this.pitchBuffer.fill(0)
            this.pitchWriteIndex = 0
            this.pitchFilled = 0
            this.voicing = 0
            this.voicingLag = 0
            this.previousVoicingLag = 0
            this.voicingHoldWindows = 0
            this.voicingRingFrameIds.fill(-1)
            this.voicingRingVoiced.fill(0)
            this.voicingRingWriteIndex = 0
            this.sileroVadProbability = 0.0
            this.port.postMessage({ type: 'resetVad' })
            if (this.lastVadSent) {
              this.port.postMessage({ type: 'vad', isSpeaking: false })
              this.lastVadSent = false
            }
          }
          this.isMuted = nextMuted
        }
      } else if (event.data.type === 'fetchResponse') {
        const resolve = pendingFetches.get(event.data.url)
        if (resolve) {
          resolve(event.data.buffer)
          pendingFetches.delete(event.data.url)
        }
      } else if (event.data.type === 'setCalibratedParams') {
        if (event.data.thresholdMode !== undefined) {
          this.thresholdMode = event.data.thresholdMode
        }
        if (event.data.manualThresholdValue !== undefined && this.thresholdMode === 'manual') {
          const threshold = Number(event.data.manualThresholdValue)
          this.manualThresholdDb = Math.max(-60, Math.min(-12, Number.isFinite(threshold) ? threshold : -42))
        }
        if (event.data.vadTrackerSeed !== undefined) {
          // The stored profile no longer carries a threshold, only the room's own
          // 95th Silero percentile. Seeding the tracker with it means the first
          // second after joining is already calibrated instead of starting at the
          // floor; from there the tracker owns the value.
          const seed = Number(event.data.vadTrackerSeed)
          if (Number.isFinite(seed) && seed >= 0) {
            // The estimator is now a quantile over its history, so the seed has to
            // be written as history: a bare assignment would be overwritten by the
            // very first learned window. Filling the whole window makes the seed the
            // estimate until real samples have displaced it, which takes the same
            // ~2 s the window is worth.
            const seeded = Math.min(this.VAD_ON_MAX, seed)
            this.noiseProbHistory.fill(seeded)
            this.noiseProbHistoryIndex = 0
            this.noiseProbHistoryCount = this.noiseProbHistory.length
            this.noiseProbHigh = seeded
            this.refreshVadThresholds()
          }
        }
        if (event.data.attenuationLimit !== undefined) {
          this.attenuationLimit = Math.max(this.MIN_ATTEN_LIMIT, Math.min(this.MAX_ATTEN_LIMIT, event.data.attenuationLimit))
          // The wizard's answer is where the adaptive loop starts and the lowest it
          // may ever go, not the value for the whole call. In manual mode the user
          // asked for a specific light pass, so nothing adapts.
          this.attenuationFloor = this.attenuationLimit
          this.attenuationTarget = this.attenuationLimit
          this.attenuationLoggedLimit = this.attenuationLimit
          this.adaptiveAttenuationEnabled = this.thresholdMode !== 'manual'
          if (this.denoiserReady && this.denoiser) {
            try {
              this.denoiser.setAttenuationLimit(this.attenuationLimit)
            } catch {
            }
          }
        }
        if (event.data.postFilterBeta !== undefined) {
          // The DeepFilter post-filter is intentionally disabled. Even small
          // values can smear quiet consonants after the neural mask.
          this.postFilterBeta = 0
          if (this.denoiserReady && this.denoiser) {
            try {
              (this.denoiser as any).setPostFilterBeta?.(this.postFilterBeta)
            } catch {
            }
          }
        }
        if (event.data.gainFactor !== undefined) {
          const gainFactor = Number(event.data.gainFactor)
          this.gainFactor = Number.isFinite(gainFactor) && gainFactor > 0 ? gainFactor : 1
        }
        if (event.data.downstreamGain !== undefined) {
          const downstreamGain = Number(event.data.downstreamGain)
          // Never below 1: a user who turns the slider down is asking to be
          // quieter, which is not something this loop should compensate for.
          this.alcDownstreamGain = Number.isFinite(downstreamGain) ? Math.max(1, downstreamGain) : 1
        }
        if (event.data.noiseFloor !== undefined) {
          const noiseFloor = Number(event.data.noiseFloor)
          if (Number.isFinite(noiseFloor) && noiseFloor > 0) {
            this.noiseFloorEstimate = Math.max(0.0001, Math.min(0.03, noiseFloor))
            // The stored floor is a median; the runtime tracker reads a high
            // quantile of the same distribution. Seed it a factor of two higher so
            // the human-sound bar does not sit inside the room on the first second.
            // Written across the whole window for the same reason as the seed above.
            this.noiseRmsHigh = this.noiseFloorEstimate * 2
            this.noiseRmsHistory.fill(this.noiseRmsHigh)
            this.noiseRmsHistoryIndex = 0
            this.noiseRmsHistoryCount = this.noiseRmsHistory.length
          }
        }
      } else if (event.data.type === 'startCalibration') {
        this.calibrationTotalFrames = Math.floor((event.data.durationMs || 2500) / 10)
        this.calibrationFramesLeft = this.calibrationTotalFrames
        this.calibrationStartFrameId = this.audioFrameId
        this.calibrationCount = 0
        this.calibrationNoiseVadCount = 0
        this.calibrationRejectedSpeechFrames = 0
        this.calibrationZcrSum = 0
        this.calibrationSpectralTiltSum = 0
        this.calibrationSilenceHistoryCount = 0
        this.calibrationSilenceHistoryIndex = 0
        this.calibrationSilenceLevel = 0
        // Do not let a VAD decision from the preceding conversation contaminate
        // the measuring window of a new one-shot calibration.
        this.sileroVadProbability = 0
        this.speechSegmentOpen = false
        this.consecutiveVadSpeechResults = 0
        this.attackGapWindows = 0
        this.attackFirstWindowEndFrameId = -1
        this.consecutiveVadSilenceResults = 0
        this.segmentPeakProbability = 0
        this.segmentWindows = 0
        this.port.postMessage({ type: 'log', message: 'Calibration started' })
      } else if (event.data.type === 'setSileroVadProbability') {
        // Calibration keeps consuming VAD results while muted: without them the
        // run has no probability distribution of the room and cannot seed the
        // runtime tracker.
        if ((this.isMuted && this.calibrationFramesLeft <= 0) || !this.sileroVadEnabled) return
        const sequence = Number(event.data.sequence)
        const endFrameId = Number(event.data.endFrameId)
        const windowRms = Number(event.data.windowRms)
        if (!Number.isFinite(sequence) || sequence <= this.lastVadSequence) return

        this.lastVadSequence = sequence
        this.sileroVadHealthy = true
        this.lastSileroResultFrameId = Number.isFinite(endFrameId) ? endFrameId : this.audioFrameId
        this.sileroVadProbability = Math.max(0, Math.min(1, Number(event.data.probability) || 0))
        const probability = this.sileroVadProbability

        // Calibration must pair a Silero probability with the exact raw 32 ms
        // window classified by the model. The worker returns both its source frame
        // id and RMS; using the current 10 ms processing frame here would introduce
        // inference-latency skew and bias the measured room distribution.
        if (this.calibrationFramesLeft > 0 && Number.isFinite(endFrameId) && Number.isFinite(windowRms)) {
          const elapsedFrames = endFrameId - this.calibrationStartFrameId
          const insideWindow = elapsedFrames >= this.CALIBRATION_LEAD_IN_FRAMES &&
            elapsedFrames < this.calibrationTotalFrames
          const normalizedWindowRms = windowRms / this.gainFactor
          // Exclude only the user's own voice from the labelled noise distribution.
          // Speech-shaped background - a television in another room, a conversation
          // down the hallway - has to stay inside it: noiseVadHigh seeds the runtime
          // tracker, so a distribution that pretends the room never produces speech
          // probabilities would start the gate below what the room actually
          // produces and hold it open on that background.
          const likelySpeechWindow = probability >= this.CALIBRATION_SPEECH_VAD_FLOOR &&
            normalizedWindowRms >= Math.max(this.calibrationSilenceLevel * 8, 0.0008)
          if (insideWindow && !likelySpeechWindow &&
            this.calibrationNoiseVadCount < this.calibrationNoiseVad.length) {
            this.calibrationNoiseVad[this.calibrationNoiseVadCount++] = probability
          }
        }

        // The room's own probability distribution, followed continuously instead of
        // measured once by the wizard. Learn it only well outside a speech segment:
        // a speech tail keeps scoring high for several windows after the gate
        // closes, and feeding that back would let the threshold raise itself until
        // it mutes the very voice it was tracking.
        if (this.speechSegmentOpen) {
          this.closedWindowsSinceSpeech = 0
        } else {
          this.closedWindowsSinceSpeech++
          // A window carrying an impulse is not the room and says nothing about the
          // room's probability distribution, so it is dropped rather than clamped -
          // a probability has no dB to clamp. The level reference is the room
          // tracker, which is impulse-proof by the same rule and measured on the
          // same raw signal, so the two are directly comparable.
          //
          // A window with a period in it is also not the room, even with no segment
          // open. Speech that failed to open the gate - one quiet word, a tail past
          // the release, the two attack windows of a phrase that came to nothing -
          // used to be learned as room, which is a feedback loop that raises the bar
          // using the very voice the bar is meant to let through.
          const roomWindow = this.voicingHoldWindows === 0 &&
            (!Number.isFinite(windowRms) || windowRms <= this.noiseRmsHigh * this.IMPULSE_CLAMP_RATIO)
          if (roomWindow && this.closedWindowsSinceSpeech > this.NOISE_TRACKER_SETTLE_WINDOWS) {
            this.noiseProbHistory[this.noiseProbHistoryIndex] = probability
            this.noiseProbHistoryIndex = (this.noiseProbHistoryIndex + 1) % this.noiseProbHistory.length
            this.noiseProbHistoryCount++
            const filled = Math.min(this.noiseProbHistoryCount, this.noiseProbHistory.length)
            const recent = this.noiseProbScratch.subarray(0, filled)
            recent.set(this.noiseProbHistory.subarray(0, filled))
            recent.sort()
            this.noiseProbHigh = recent[Math.floor((filled - 1) * this.NOISE_PROB_QUANTILE)]
            this.refreshVadThresholds()
          }
        }

        if (this.speechSegmentOpen) this.segmentWindows++

        // Two tiers, and only for opening a segment. A window with a period in it is
        // a voice, so it opens at the adaptive threshold - low, where quiet syllables
        // live. A window without one has to clear VAD_UNVOICED_ON instead, far above
        // where a scrape or a fricative-shaped noise lands. This is the answer to
        // "scraping opens the gate, and after it adapts the voice stops opening it
        // too": the two are separated on periodicity, not on threshold height, so
        // rejecting the scrape no longer costs anything on the voice side.
        //
        // The cheap tier now requires the period to be in *this* window, paired by
        // frame id. It used to be granted by voicingHoldWindows, which meant one
        // periodic window discounted the next six - enough for the ring of a struck
        // object to hand the discount to the windows after it. The hold is still the
        // right rule for sustaining a segment that is already open (one voiced core
        // admits the fricatives around it); it is the wrong rule for starting one.
        // If the pairing is ever lost - a worker so far behind that the window has
        // left the ring - fall back to the hold rather than to the strict tier, so
        // heavy CPU load degrades to the previous behaviour instead of to a new one.
        //
        // Between those two there is a third case, and collapsing it into the strict
        // tier is what made speech break up. A window with no period of its own but
        // sitting inside a periodic neighbourhood is a fricative, a stop or a word
        // tail between vowels - the unvoiced half of ordinary speech - and asking it
        // for VAD_UNVOICED_ON (0.6, a bar set for whispers in an otherwise silent
        // room) fails it every time. It is not the same evidence as a period in the
        // window itself, so it does not get the cheap tier; 0.35 is comfortably above
        // where a scrape or a key click scores and comfortably below a real
        // consonant. An impulse cannot reach this tier by its own ring either: the
        // hold it would create is denied by the lag-continuity test that has to pass
        // before voicingHoldWindows is set at all.
        const voicingIndex = Number.isFinite(endFrameId) ? this.findVoicingWindow(endFrameId) : -1
        const windowVoiced = voicingIndex >= 0
          ? this.voicingRingVoiced[voicingIndex] === 1
          : this.voicingHoldWindows > 0
        const openThreshold = windowVoiced
          ? this.vadOnThreshold
          : this.voicingHoldWindows > 0
            ? this.VAD_SEMI_VOICED_ON
            : this.VAD_UNVOICED_ON

        // Tracked whenever the segment is open, not only when the window is above the
        // opening tier: a phrase's quietest windows sustain on vadOffThreshold, and
        // they are exactly the ones voiceProbLow exists to protect.
        if (
          probability > this.segmentPeakProbability &&
          (this.speechSegmentOpen || probability >= this.vadOnThreshold)
        ) {
          this.segmentPeakProbability = probability
        }

        if (probability >= openThreshold) {
          // A window whose audio carried an impulse may sustain a segment that is
          // already open, but it may never contribute to opening one. Without this the
          // confirmation period below can be satisfied entirely by the attack and ring
          // of a single clap, which is what VAD_ATTACK_RESULTS alone cannot fix:
          // lengthening it only asks for more windows of the same clap.
          if (!this.speechSegmentOpen && this.windowCarriedTransient(endFrameId)) {
            this.consecutiveVadSpeechResults = 0
            this.attackGapWindows = 0
            this.attackFirstWindowEndFrameId = -1
            this.consecutiveVadSilenceResults = 0
          } else {
            if (this.consecutiveVadSpeechResults === 0) {
              this.attackFirstWindowEndFrameId = Number.isFinite(endFrameId) ? endFrameId : -1
            }
            this.consecutiveVadSpeechResults++
            this.attackGapWindows = 0
            this.consecutiveVadSilenceResults = 0
            if (!this.speechSegmentOpen && this.consecutiveVadSpeechResults >= this.VAD_ATTACK_RESULTS) {
              this.speechSegmentOpen = true
              // Reach back over the whole confirmation period, not just the preroll:
              // the segment is only declared at the third window, and the ones before
              // it are speech that has now been proven. Without this the
              // minimum-duration rule would cut ~100 ms off the start of every phrase.
              const firstWindowEnd = this.attackFirstWindowEndFrameId >= 0
                ? this.attackFirstWindowEndFrameId
                : (Number.isFinite(endFrameId) ? endFrameId : -1)
              if (firstWindowEnd >= 0) {
                this.markBufferedSpeechFrom(
                  firstWindowEnd -
                  Math.ceil(this.VAD_WINDOW_FRAMES) -
                  this.SPEECH_PREROLL_FRAMES
                )
              }
              this.attackGapWindows = 0
              this.attackFirstWindowEndFrameId = -1
            }
          }
        } else if (this.speechSegmentOpen) {
          this.consecutiveVadSpeechResults = 0
          this.attackGapWindows = 0
          this.attackFirstWindowEndFrameId = -1
          if (probability >= this.vadOffThreshold) {
            this.consecutiveVadSilenceResults = 0
          } else {
            this.consecutiveVadSilenceResults++
            if (this.consecutiveVadSilenceResults >= this.currentReleaseResults()) {
              this.speechSegmentOpen = false
              this.consecutiveVadSilenceResults = 0
              // Only segments long enough to be a phrase describe the voice.
              if (this.segmentWindows >= this.VOICE_PROB_MIN_WINDOWS) {
                const rate = this.segmentPeakProbability < this.voiceProbLow
                  ? this.VOICE_PROB_FALL
                  : this.VOICE_PROB_RISE
                this.voiceProbLow += rate * (this.segmentPeakProbability - this.voiceProbLow)
                this.refreshVadThresholds()
              }
              this.segmentWindows = 0
              this.segmentPeakProbability = 0
            }
          }
        } else if (this.consecutiveVadSpeechResults > 0) {
          // Attack-phase hysteresis. See VAD_ATTACK_GAP_MAX: a run that has started
          // survives a window that merely failed to confirm it, and is cancelled only
          // by real silence or by taking too long. This one branch is what the
          // choppiness came down to - it used to be an unconditional reset, so every
          // unvoiced window inside a syllable threw away the evidence collected so far.
          this.attackGapWindows++
          if (probability < this.vadOffThreshold || this.attackGapWindows > this.VAD_ATTACK_GAP_MAX) {
            this.consecutiveVadSpeechResults = 0
            this.attackGapWindows = 0
            this.attackFirstWindowEndFrameId = -1
          }
        }
      }
    }
  }

  // The tracked room level plus a fixed margin, held inside the hard bounds and
  // then under the user's own quietest phrase. Both thresholds are derived here and
  // nowhere else, so the invariant VAD_OFF_MIN <= off < on <= VAD_ON_MAX holds by
  // construction.
  private refreshVadThresholds() {
    const room = Math.max(this.VAD_ON_MIN, Math.min(this.VAD_ON_MAX, this.noiseProbHigh + this.VAD_ON_MARGIN))
    const on = Math.max(this.VAD_ON_MIN, Math.min(room, this.voiceProbLow - this.VOICE_PROB_MARGIN))
    this.vadOnThreshold = on
    this.vadOffThreshold = Math.max(this.VAD_OFF_MIN, Math.min(on - 0.02, on * this.VAD_OFF_RATIO))
    if (Math.abs(on - this.loggedVadOnThreshold) >= 0.02) {
      this.loggedVadOnThreshold = on
      this.port.postMessage({
        type: 'log',
        message: `VAD gate ${on.toFixed(2)}/${this.vadOffThreshold.toFixed(2)} ` +
          `for voiced, ${this.VAD_UNVOICED_ON.toFixed(2)} for unvoiced ` +
          `(room ${this.noiseProbHigh.toFixed(2)}, quietest phrase ${this.voiceProbLow.toFixed(2)})`
      })
    }
  }

  // Hangover length for the segment that is closing, scaled by how far its peak
  // probability rose above the opening threshold.
  private currentReleaseResults(): number {
    const span = Math.max(0.05, 0.9 - this.vadOnThreshold)
    const confidence = Math.max(0, Math.min(1, (this.segmentPeakProbability - this.vadOnThreshold) / span))
    return this.VAD_RELEASE_MIN_RESULTS +
      Math.round((this.VAD_RELEASE_MAX_RESULTS - this.VAD_RELEASE_MIN_RESULTS) * confidence)
  }

  // Suppression depth from the SNR this call is actually running at. See the comment
  // on TARGET_SPEECH_TO_NOISE_DB for why the calibrated value cannot be the final
  // answer. Both inputs are measured on the same signal by estimators that already
  // exist here and are already impulse-clamped, so this adds no measurement of its
  // own - only the arithmetic that turns them into a dB figure.
  //
  // Runs once per 10 ms frame, so every rate below is expressed per frame.
  private refreshAttenuationLimit() {
    if (!this.adaptiveAttenuationEnabled || !this.denoiserReady || !this.denoiser) return
    // Neither follower means anything before it has seen its window: the P.56 level
    // needs a second of real speech, and the room quantile needs its history filled.
    if (this.alcSpeechRms <= 0 || this.alcSpeechFrames < this.ATTEN_MIN_SPEECH_FRAMES) return
    if (this.noiseRmsHistoryCount < this.noiseRmsHistory.length) return
    if (this.noiseRmsHigh <= 0) return

    const measuredSnrDb = 20 * Math.log10(this.alcSpeechRms / this.noiseRmsHigh)
    const demandDb = this.TARGET_SPEECH_TO_NOISE_DB - measuredSnrDb
    // The same soft knee the calibration wizard applies (SUPPRESSION_SOFT_KNEE_DB in
    // webrtc.ts): full credit up to 24 dB, half above it. A room that demands 40 dB is
    // a room where the last 16 dB would cost more in artefacts than it buys in quiet.
    const shapedDb = demandDb <= this.ATTEN_KNEE_DB
      ? demandDb
      : this.ATTEN_KNEE_DB + (demandDb - this.ATTEN_KNEE_DB) * this.ATTEN_ABOVE_KNEE_SLOPE
    this.attenuationTarget = Math.max(this.attenuationFloor, Math.min(this.MAX_ATTEN_LIMIT, shapedDb))

    // Only upward, and never faster than the ear stops noticing. Giving depth back on
    // a quiet passage would mean re-learning it on the next loud one, which is the
    // room breathing behind the voice.
    if (this.attenuationTarget <= this.attenuationLimit) return
    const step = this.ATTEN_SLEW_DB_PER_SEC * (this.FRAME_SIZE / 48000)
    this.attenuationLimit = Math.min(this.attenuationTarget, this.attenuationLimit + step)

    // The engine call is not free and its resolution is a dB, so it is made when the
    // ramp has actually crossed one.
    if (this.attenuationLimit - this.attenuationLoggedLimit < 1) return
    this.attenuationLoggedLimit = this.attenuationLimit
    try {
      this.denoiser.setAttenuationLimit(this.attenuationLimit)
    } catch {
      return
    }
    this.port.postMessage({
      type: 'log',
      message: `Suppression ${this.attenuationLimit.toFixed(0)}dB ` +
        `(target ${this.attenuationTarget.toFixed(0)}, calibrated floor ${this.attenuationFloor.toFixed(0)}): ` +
        `measured SNR ${measuredSnrDb.toFixed(0)}dB, room ` +
        `${(20 * Math.log10(Math.max(1e-6, this.noiseRmsHigh))).toFixed(0)}dBFS`
    })
  }

  // Pairs a Silero result back to the periodicity measured on the very window it
  // classified. Returns -1 if that window has already left the ring.
  private findVoicingWindow(endFrameId: number): number {
    for (let i = 0; i < this.voicingRingFrameIds.length; i++) {
      if (this.voicingRingFrameIds[i] === endFrameId) return i
    }
    return -1
  }

  // Did any of the frames making up this 32 ms window carry an impulse? A clap is one
  // or two frames inside a window Silero scores as a whole, so asking about the
  // window's last frame alone would miss it.
  private windowCarriedTransient(endFrameId: number): boolean {
    if (!Number.isFinite(endFrameId)) return this.transientHoldFrames > 0
    const firstFrameId = endFrameId - Math.ceil(this.VAD_WINDOW_FRAMES)
    for (let i = 0; i < this.speechRingTransient.length; i++) {
      const frameId = this.speechRingFrameIds[i]
      if (frameId >= firstFrameId && frameId <= endFrameId && this.speechRingTransient[i] === 1) return true
    }
    return false
  }

  // Retroactive speech marking over the delay line. Frames flagged as impulses are
  // skipped: a mouse click or a key press a tenth of a second before the first word
  // is inside the reach of the preroll, and marking it would send the very sound the
  // gate exists to reject - with the gate wide open, because it belongs to a segment
  // that really is speech.
  private markBufferedSpeechFrom(firstFrameId: number) {
    for (let i = 0; i < this.speechRingSpeech.length; i++) {
      const frameId = this.speechRingFrameIds[i]
      if (frameId >= firstFrameId && this.speechRingTransient[i] === 0) this.speechRingSpeech[i] = 1
    }
  }

  // Retroactive impulse marking, the counterpart of markBufferedSpeechFrom. An impulse
  // is only proven once its decay has been observed, several frames after the frames
  // that make it up were already written to the ring. This flags them where they sit.
  // It deliberately does not clear speechRingSpeech: the flag governs the right to
  // *open* the gate, and punching a hole in a segment that is already open would take
  // a bite out of a real voice for the sake of a click that landed inside it.
  private markBufferedTransientFrom(firstFrameId: number) {
    if (firstFrameId < 0) return
    for (let i = 0; i < this.speechRingTransient.length; i++) {
      if (this.speechRingFrameIds[i] >= firstFrameId) this.speechRingTransient[i] = 1
    }
  }

  private decimateVadSample(sample: number): number | null {
    this.vadDecimatorHistory[this.vadDecimatorWriteIndex] = sample
    this.vadDecimatorWriteIndex = (this.vadDecimatorWriteIndex + 1) % this.vadDecimatorHistory.length
    this.vadDecimatorPhase++
    if (this.vadDecimatorPhase < 3) return null
    this.vadDecimatorPhase = 0

    let filtered = 0
    let historyIndex = (this.vadDecimatorWriteIndex - 1 + this.vadDecimatorHistory.length) % this.vadDecimatorHistory.length
    for (let i = 0; i < this.vadDecimatorTaps.length; i++) {
      filtered += this.vadDecimatorTaps[i] * this.vadDecimatorHistory[historyIndex]
      historyIndex = (historyIndex - 1 + this.vadDecimatorHistory.length) % this.vadDecimatorHistory.length
    }
    return Math.max(-1, Math.min(1, filtered))
  }

  // Normalised autocorrelation peak over the human fundamental range, computed on
  // the 16 kHz stream that already feeds Silero. The lag range is the whole design:
  // outside 70-400 Hz nothing a person's vocal folds do can appear, so a match found
  // there is periodicity at a rate only a voice produces.
  //
  // The newest PITCH_WINDOW samples are the analysis frame and each candidate lag
  // compares it against the frame that many samples older, so the ring is unwrapped
  // once into a linear scratch (newest first) and every access below is sequential.
  // The lagged frame's energy is carried between lags instead of resummed, which
  // leaves one multiply per sample per lag: ~49k per evaluation, ~31 evaluations a
  // second. That is affordable on the audio thread; a per-frame evaluation would not
  // be, and would tell us nothing more - a period needs several cycles to exist.
  //
  // The winning lag is recorded in voicingLag as well as the score, because the score
  // alone cannot tell a period from a coincidence: see VOICING_LAG_DRIFT_MAX.
  private measureVoicing(): number {
    const size = this.pitchBuffer.length
    const window = this.PITCH_WINDOW
    const maxLag = this.PITCH_MAX_LAG
    const span = window + maxLag + 1
    this.voicingLag = 0
    if (this.pitchFilled < span) return 0

    const scratch = this.pitchScratch
    let index = (this.pitchWriteIndex - 1 + size) % size
    for (let i = 0; i < span; i++) {
      scratch[i] = this.pitchBuffer[index]
      index = (index - 1 + size) % size
    }

    let frameEnergy = 0
    for (let i = 0; i < window; i++) frameEnergy += scratch[i] * scratch[i]
    if (frameEnergy < 1e-9) return 0

    let lagEnergy = 0
    for (let j = this.PITCH_MIN_LAG; j < this.PITCH_MIN_LAG + window; j++) lagEnergy += scratch[j] * scratch[j]

    let best = 0
    let bestLag = 0
    for (let lag = this.PITCH_MIN_LAG; lag <= maxLag; lag++) {
      if (lagEnergy > 1e-9) {
        let correlation = 0
        for (let i = 0; i < window; i++) correlation += scratch[i] * scratch[i + lag]
        const score = correlation / Math.sqrt(frameEnergy * lagEnergy)
        if (score > best) {
          best = score
          bestLag = lag
        }
      }
      lagEnergy += scratch[lag + window] * scratch[lag + window] - scratch[lag] * scratch[lag]
    }
    this.voicingLag = bestLag
    return Math.max(0, Math.min(1, best))
  }

  private async initDeepFilter() {
    if (this.denoiserReady) return
    try {
      this.port.postMessage({ type: 'log', message: 'DeepFilterNet3 initialization started' })
      this.denoiser = new StandaloneDeepFilter({
        ...(this.cdnUrl ? { cdnUrl: this.cdnUrl } : {}),
        attenuationLimit: this.attenuationLimit,
        postFilterBeta: 0.0
      })
      await this.denoiser.initialize()
      const modelFrameLength = this.denoiser.getFrameLength()
      if (modelFrameLength !== this.FRAME_SIZE) {
        throw new Error(`Unsupported DeepFilter frame length ${modelFrameLength}; expected ${this.FRAME_SIZE}`)
      }
      this.denoiser.startStreaming()
      this.denoiser.setAttenuationLimit(this.attenuationLimit)
      ;(this.denoiser as any).setPostFilterBeta?.(this.postFilterBeta)
      this.denoiserReady = true
      this.port.postMessage({
        type: 'log',
        message: `DeepFilterNet3 initialized: frame=${this.denoiser.getFrameLength()}, attenuation=${this.attenuationLimit}dB, postFilter=${this.postFilterBeta}`
      })
      this.port.postMessage({ type: 'ready' })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.port.postMessage({ type: 'log', message: 'DeepFilterNet3 initialization failed: ' + message })
      // A separate message, not a log line: the main thread has to know that this
      // machine has no working engine, otherwise calibration only reports a
      // timeout and the real reason stays in the console.
      this.port.postMessage({ type: 'engineError', message: `DeepFilterNet3 initialization failed: ${message}` })
    }
  }

  private pushToBuffer(buffer: Float32Array, data: Float32Array, writeIndex: number, readIndex: number): number {
    const availableSpace = (readIndex - writeIndex - 1 + this.BUFFER_SIZE) % this.BUFFER_SIZE
    if (availableSpace < data.length) {
      this.overflowCount++
      return writeIndex
    }
    const part1 = this.BUFFER_SIZE - writeIndex
    if (part1 >= data.length) {
      buffer.set(data, writeIndex)
      writeIndex = (writeIndex + data.length) % this.BUFFER_SIZE
    } else {
      buffer.set(data.subarray(0, part1), writeIndex)
      buffer.set(data.subarray(part1), 0)
      writeIndex = data.length - part1
    }
    return writeIndex
  }

  private pullFromBuffer(buffer: Float32Array, data: Float32Array, writeIndex: number, readIndex: number): number {
    const availableData = (writeIndex - readIndex + this.BUFFER_SIZE) % this.BUFFER_SIZE
    if (availableData < data.length) {
      data.fill(0)
      return readIndex
    }
    const part1 = this.BUFFER_SIZE - readIndex
    if (part1 >= data.length) {
      data.set(buffer.subarray(readIndex, readIndex + data.length))
      readIndex = (readIndex + data.length) % this.BUFFER_SIZE
    } else {
      data.set(buffer.subarray(readIndex, this.BUFFER_SIZE), 0)
      data.set(buffer.subarray(0, data.length - part1), part1)
      readIndex = data.length - part1
    }
    return readIndex
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]
    const output = outputs[0]

    if (!input?.length || !output?.length) return true

    const inputChannel = input[0]
    const outputChannel = output[0]

    // A muted user must still be able to calibrate the microphone: the frames are
    // measured exactly as usual while the output stays silent, so nothing reaches
    // the channel. Outside calibration a muted processor still costs nothing.
    const measureWhileMuted = this.isMuted && this.calibrationFramesLeft > 0
    if (this.isMuted && !measureWhileMuted) {
      outputChannel.fill(0)
      return true
    }

    // A capture track can negotiate stereo even for a mono microphone. Downmix
    // both channels before VAD, calibration and DeepFilter instead of discarding
    // the right channel and losing part of the voice.
    let monoInput = inputChannel
    if (input.length > 1) {
      if (this.monoInput.length !== inputChannel.length) this.monoInput = new Float32Array(inputChannel.length)
      this.monoInput.fill(0)
      for (const channel of input) {
        for (let i = 0; i < inputChannel.length; i++) this.monoInput[i] += channel[i] || 0
      }
      const scale = 1 / input.length
      for (let i = 0; i < this.monoInput.length; i++) this.monoInput[i] *= scale
      monoInput = this.monoInput
    }
    this.inputWriteIndex = this.pushToBuffer(this.inputBuffer, monoInput, this.inputWriteIndex, this.inputReadIndex)

    while ((this.inputWriteIndex - this.inputReadIndex + this.BUFFER_SIZE) % this.BUFFER_SIZE >= this.FRAME_SIZE) {
      this.inputReadIndex = this.pullFromBuffer(this.inputBuffer, this.frameToProcess, this.inputWriteIndex, this.inputReadIndex)

      for (let i = 0; i < this.FRAME_SIZE; i++) {
        const inputSample = this.frameToProcess[i]
        this.vadWindowSquareSum += inputSample * inputSample
        this.vadWindowSampleCount++
        const filteredSample = this.decimateVadSample(inputSample)
        if (filteredSample === null) continue
        this.vad16kBuffer[this.vad16kWriteIndex++] = filteredSample
        this.pitchBuffer[this.pitchWriteIndex] = filteredSample
        this.pitchWriteIndex = (this.pitchWriteIndex + 1) % this.pitchBuffer.length
        if (this.pitchFilled < this.pitchBuffer.length) this.pitchFilled++

        if (this.vad16kWriteIndex === this.VAD_FRAME_SIZE) {
          const audioFrame = this.vad16kBuffer.slice()
          const windowRms = Math.sqrt(this.vadWindowSquareSum / Math.max(1, this.vadWindowSampleCount))
          // Measured on the same window Silero is about to classify, so the two
          // answers describe the same 32 ms of audio.
          this.voicing = this.measureVoicing()
          // Continuity is folded in here, at the single place the voiced decision is
          // made, so every consumer of it downstream - the opening threshold, the
          // room-tracker exclusion, the human-sound branch - inherits the constraint
          // without having to repeat it. The first voiced window of a phrase has no
          // predecessor and is therefore not counted; it costs 32 ms at the start of a
          // segment, which the retroactive marking covers many times over.
          const lag = this.voicingLag
          const previousLag = this.previousVoicingLag
          const lagContinuous = lag > 0 && previousLag > 0 &&
            Math.abs(lag - previousLag) / previousLag <= this.VOICING_LAG_DRIFT_MAX
          this.previousVoicingLag = lag
          const windowVoiced = this.voicing >= this.VOICING_SPEECH_MIN && lagContinuous
          if (windowVoiced) this.voicingHoldWindows = this.VOICING_HOLD_WINDOWS
          else if (this.voicingHoldWindows > 0) this.voicingHoldWindows--

          this.voicingRingFrameIds[this.voicingRingWriteIndex] = this.audioFrameId
          this.voicingRingVoiced[this.voicingRingWriteIndex] = windowVoiced ? 1 : 0
          this.voicingRingWriteIndex = (this.voicingRingWriteIndex + 1) % this.voicingRingFrameIds.length

          this.port.postMessage(
            { type: 'audio16k', audio: audioFrame, sequence: this.vadSequence++, endFrameId: this.audioFrameId, windowRms },
            [audioFrame.buffer]
          )
          this.vad16kWriteIndex = 0
          this.vadWindowSquareSum = 0
          this.vadWindowSampleCount = 0
        }
      }

      let sumSquares = 0
      let currentPeak = 0
      let lowBandState = 0
      let lowBandSquares = 0
      let highBandSquares = 0
      let zeroCrossings = 0
      for (let i = 0; i < this.FRAME_SIZE; i++) {
        const sample = this.frameToProcess[i]
        currentPeak = Math.max(currentPeak, Math.abs(sample))
        sumSquares += sample * sample
        lowBandState += 0.12 * (sample - lowBandState)
        const highBand = sample - lowBandState
        lowBandSquares += lowBandState * lowBandState
        highBandSquares += highBand * highBand
        if (i > 0 && (sample >= 0) !== (this.frameToProcess[i - 1] >= 0)) zeroCrossings++
      }
      const currentRms = Math.sqrt(sumSquares / this.FRAME_SIZE)
      this.rmsSmoothed = 0.2 * currentRms + 0.8 * this.rmsSmoothed
      const currentDb = 20 * Math.log10(Math.max(this.rmsSmoothed, 0.000001))
      if (++this.meterFrameCounter >= 5) {
        this.meterFrameCounter = 0
        this.port.postMessage({ type: 'micLevelDb', db: Math.max(-100, Math.min(0, currentDb)) })
      }
      const currentZcr = zeroCrossings / (this.FRAME_SIZE - 1)
      const currentTilt = Math.sqrt(highBandSquares / Math.max(1e-12, lowBandSquares))

      // Transient detection. See TRANSIENT_ATTACK_DB: attack and crest nominate,
      // the decay convicts, measured on the raw frame before anything downstream has
      // an opinion.
      if (this.transientHoldFrames > 0) this.transientHoldFrames--
      const attackDb = 20 * Math.log10(currentRms / Math.max(1e-6, this.previousFrameRms))
      const crest = currentPeak / Math.max(1e-6, currentRms)
      const frameNominatesTransient = attackDb >= this.TRANSIENT_ATTACK_DB &&
        crest >= this.TRANSIENT_CREST &&
        currentRms >= Math.max(this.noiseRmsHigh * 2, this.HUMAN_SOUND_MIN_RMS)
      this.previousFrameRms = currentRms

      let convictedTransient = false
      if (this.transientCandidateFrameId >= 0) {
        // Track the peak rather than the nominating frame's level: a collision puts
        // its energy in the first frame, but if the sound keeps growing the bar it has
        // to fall under grows with it, which is one more way a voice escapes.
        this.transientCandidateRms = Math.max(this.transientCandidateRms, currentRms)
        this.transientCandidateAge++
        if (currentRms <= this.transientCandidateRms * this.TRANSIENT_DECAY_RATIO) {
          convictedTransient = true
        } else if (this.transientCandidateAge >= this.TRANSIENT_DECAY_FRAMES) {
          this.transientCandidateFrameId = -1
        }
      } else if (frameNominatesTransient) {
        this.transientCandidateFrameId = this.audioFrameId
        this.transientCandidateRms = currentRms
        this.transientCandidateAge = 0
        this.transientCandidateAttackDb = attackDb
        this.transientCandidateCrest = crest
      }

      if (convictedTransient) {
        // Everything from the nomination to here is the impulse. Those frames are
        // already in the ring, written before the verdict existed, so they are flagged
        // now - which is exactly what the delay line is for.
        this.markBufferedTransientFrom(this.transientCandidateFrameId)
        this.transientCandidateFrameId = -1
        this.transientHoldFrames = this.TRANSIENT_HOLD_FRAMES
        this.rejectedTransientFrames++
        if (this.rejectedTransientFrames % 20 === 1) {
          // The envelope figures describe the nominating frame, not this one: by the
          // frame the verdict lands on, the attack is long past and negative.
          this.port.postMessage({
            type: 'log',
            message: `VAD rejected transient at ${currentDb.toFixed(0)} dB ` +
              `(attack ${this.transientCandidateAttackDb.toFixed(0)} dB, ` +
              `crest ${this.transientCandidateCrest.toFixed(1)}, ` +
              `decayed ${(20 * Math.log10(Math.max(1e-6, currentRms) / Math.max(1e-6, this.transientCandidateRms))).toFixed(0)} dB ` +
              `in ${this.transientCandidateAge} frames)`
          })
        }
      }
      // Two readings of the same state, and the difference matters. The ring records
      // only convictions, because the Silero path reads it and must not be denied an
      // onset on the strength of a nomination that is about to be dropped. The live
      // flag includes the pending nomination, because the branches that read it
      // (humanSound, the energy fallback) decide inside the frame and have no delay
      // line to revisit - for them the conservative reading is the right one, and the
      // cost of being wrong is at most 60 ms against hold times of 150-300 ms.
      const ringTransient = convictedTransient || this.transientHoldFrames > 0
      const inTransient = ringTransient || this.transientCandidateFrameId >= 0

      // A worker that initialized successfully can still stop returning results.
      // After 1.2 seconds without a decision, leave the permanently-closed Silero
      // state and use the strict fallback below until inference recovers.
      if (this.sileroVadEnabled && this.sileroVadHealthy && this.lastSileroResultFrameId >= 0 &&
        this.audioFrameId - this.lastSileroResultFrameId > 120) {
        this.sileroVadHealthy = false
        this.speechSegmentOpen = false
        this.consecutiveVadSpeechResults = 0
        this.attackGapWindows = 0
        this.attackFirstWindowEndFrameId = -1
        this.consecutiveVadSilenceResults = 0
        this.segmentPeakProbability = 0
        this.segmentWindows = 0
      }

      // Room level tracker: same windowed quantile as the probability tracker and
      // learned under the same condition - only well outside anything the gate
      // considers voice, so the user's own sounds cannot raise their own bar.
      if (this.speechSegmentOpen || this.humanSoundHoldFrames > 0) {
        this.closedFramesSinceSpeech = 0
      } else {
        this.closedFramesSinceSpeech++
        if (this.closedFramesSinceSpeech > this.NOISE_TRACKER_SETTLE_FRAMES) {
          this.noiseRmsHistory[this.noiseRmsHistoryIndex] =
            Math.min(currentRms, this.noiseRmsHigh * this.IMPULSE_CLAMP_RATIO)
          this.noiseRmsHistoryIndex = (this.noiseRmsHistoryIndex + 1) % this.noiseRmsHistory.length
          this.noiseRmsHistoryCount++
          if (this.noiseRmsHistoryCount % this.NOISE_RMS_REFRESH_FRAMES === 0) {
            const filled = Math.min(this.noiseRmsHistoryCount, this.noiseRmsHistory.length)
            const recent = this.noiseRmsScratch.subarray(0, filled)
            recent.set(this.noiseRmsHistory.subarray(0, filled))
            recent.sort()
            this.noiseRmsHigh = recent[Math.floor((filled - 1) * this.NOISE_RMS_QUANTILE)]
          }
        }
      }
      // Laughter, a cough, a sigh, "мм": loud enough to be the user, spectrally too
      // low and too smooth to be hiss or a key click. This is a deliberate reversal
      // of the earlier rule that energy may never open the gate. That rule was
      // right at 12 dB of attenuation, where a false open passed audible noise; at
      // 29-45 dB the same false open is nearly silent, while the cost of dropping a
      // human sound has not changed. It therefore depends on the strong denoiser.
      //
      // Level, smoothness and tilt describe how a sound is shaped; none of them can
      // tell that it came from a throat, which is why a scrape across the table used
      // to read as a sigh. Periodicity can, so it is required here too - and the ZCR
      // and tilt bounds still have to hold, because a steady tone is perfectly
      // periodic and is not a person. Three axes, no one of them sufficient alone.
      //
      // A fourth now: the envelope. A clap satisfies all three of the above at once -
      // it is loud, it is smooth, and the room's own ring gives it a period - and one
      // qualifying frame used to buy 150 ms of open gate. So an impulse is excluded
      // outright, and the remaining evidence has to persist for three frames, which no
      // impulse does and every real human sound does.
      const soundIsLoudAndSmooth = this.sileroVadHealthy &&
        currentRms >= Math.max(this.noiseRmsHigh * this.HUMAN_SOUND_RISE_RATIO, this.HUMAN_SOUND_MIN_RMS) &&
        currentZcr <= this.HUMAN_SOUND_MAX_ZCR &&
        currentTilt <= this.HUMAN_SOUND_MAX_TILT &&
        !inTransient
      if (soundIsLoudAndSmooth && this.voicingHoldWindows > 0) this.humanSoundFrames++
      else this.humanSoundFrames = 0
      const humanSound = this.humanSoundFrames >= this.HUMAN_SOUND_MIN_FRAMES
      if (soundIsLoudAndSmooth && this.voicingHoldWindows === 0) {
        // Evidence for the user that a loud non-voice was turned away on periodicity
        // rather than lost to a threshold that also swallows quiet speech. Once a
        // second at most, since a sustained scrape is hundreds of frames. The lag is
        // reported too: a sound can score above the bar and still be rejected here for
        // failing to hold one period across windows, and the two look identical in a
        // log that only prints the score.
        this.rejectedUnvoicedFrames++
        if (this.rejectedUnvoicedFrames % 100 === 1) {
          this.port.postMessage({
            type: 'log',
            message: `VAD rejected non-periodic sound at ${currentDb.toFixed(0)} dB ` +
              `(voicing ${this.voicing.toFixed(2)}, bar ${this.VOICING_SPEECH_MIN}, ` +
              `lag ${this.voicingLag} after ${this.previousVoicingLag})`
          })
        }
      }
      if (humanSound) {
        this.humanSoundHoldFrames = this.HUMAN_SOUND_HOLD_FRAMES
      } else if (this.humanSoundHoldFrames > 0) {
        this.humanSoundHoldFrames--
      }

      if (this.thresholdMode === 'manual') {
        if (currentDb >= this.manualThresholdDb) {
          this.manualVadHoldFrames = this.MANUAL_HOLD_FRAMES
        } else if (this.manualVadHoldFrames > 0) {
          // Hysteresis: once open, keep the gate open through the quiet tail of a
          // word (down to 6 dB below the threshold) instead of chopping consonants.
          if (currentDb >= this.manualThresholdDb - 6) {
            this.manualVadHoldFrames = this.MANUAL_HOLD_FRAMES
          } else {
            this.manualVadHoldFrames--
          }
        }
      }

      // Silero remains authoritative whenever it is producing decisions. If the
      // worker failed before its first result, do not lock the microphone at zero
      // forever: use a deliberately strict speech-shaped energy fallback.
      const fallbackSpeech = !this.sileroVadHealthy &&
        !inTransient &&
        currentRms >= Math.max(0.0015, this.noiseFloorEstimate * 3.5) &&
        currentZcr >= 0.025 && currentZcr <= 0.35 &&
        currentTilt >= 0.16 && currentTilt <= 5
      if (fallbackSpeech) {
        this.manualVadHoldFrames = this.MANUAL_HOLD_FRAMES
      } else if (!this.sileroVadHealthy && this.manualVadHoldFrames > 0) {
        this.manualVadHoldFrames--
      }

      const isSpeaking = this.thresholdMode === 'manual'
        ? this.manualVadHoldFrames > 0
        : this.sileroVadEnabled && this.sileroVadHealthy
          ? this.speechSegmentOpen || this.humanSoundHoldFrames > 0
          : this.manualVadHoldFrames > 0

      const writeIndex = this.speechRingWriteIndex
      this.speechRingSpeech[writeIndex] = isSpeaking ? 1 : 0
      this.speechRingFrameIds[writeIndex] = this.audioFrameId
      this.speechRingRms[writeIndex] = currentRms
      this.speechRingZcr[writeIndex] = currentZcr
      this.speechRingTilt[writeIndex] = currentTilt
      this.speechRingTransient[writeIndex] = ringTransient ? 1 : 0
      this.speechRingFrames[writeIndex].set(this.frameToProcess)
      this.speechRingWriteIndex = (writeIndex + 1) % this.speechRingSpeech.length
      this.speechRingCount++
      this.audioFrameId++

      const readIndex = this.speechRingWriteIndex
      const hasDelayedFrame = this.speechRingCount > this.DECISION_DELAY_FRAMES
      const delayedIsSpeech = hasDelayedFrame && this.speechRingSpeech[readIndex] === 1

      const reportedSpeaking = measureWhileMuted ? false : isSpeaking
      if (this.lastVadSent !== reportedSpeaking) {
        this.port.postMessage({ type: 'vad', isSpeaking: reportedSpeaking })
        this.lastVadSent = reportedSpeaking
      }

      const delayedFrame = this.speechRingFrames[readIndex]
      let outputFrame: Float32Array | null = delayedFrame
      if (hasDelayedFrame && this.noiseSuppression && this.denoiserReady && this.denoiser) {
        try {
          const denoised = this.denoiser.processStreaming(delayedFrame)
          outputFrame = denoised.length === this.FRAME_SIZE ? denoised : null
        } catch (error) {
          outputFrame = null
          this.denoiserErrorCount++
          if (this.denoiserErrorCount <= 3 || this.denoiserErrorCount % 100 === 0) {
            this.port.postMessage({
              type: 'log',
              message: `DeepFilter frame failed (${this.denoiserErrorCount}): ${error instanceof Error ? error.message : String(error)}`
            })
          }
        }
      }
      if (!hasDelayedFrame || (this.noiseSuppression && !this.denoiserReady)) {
        // Warm-up, or the denoiser has not initialized yet: stay silent rather
        // than leak raw, unprocessed microphone noise into the stream.
        this.processedFrame.fill(0)
        this.gateGain = 0
      } else if (!this.noiseSuppression) {
        this.processedFrame.set(delayedFrame)
        this.gateGain = 1
      } else if (!outputFrame) {
        // A denoiser frame failure must never expose the raw microphone to the stream.
        this.processedFrame.fill(0)
        this.gateGain = 0
      } else {
        // DeepFilter keeps its recurrent state on every frame, then Silero and the
        // denoiser's own verdict together decide what may enter the automatic-mode
        // stream. See DF_VETO_MARGIN_DB: how much energy the mask removed is a full
        // spectral classification of this exact frame, made by a different model from
        // the one the gate is built on.
        let inputSquares = 0
        let outputSquares = 0
        for (let i = 0; i < this.FRAME_SIZE; i++) {
          inputSquares += delayedFrame[i] * delayedFrame[i]
          outputSquares += outputFrame[i] * outputFrame[i]
        }
        const vetoReductionDb = Math.max(
          this.DF_VETO_MIN_REDUCTION_DB,
          this.attenuationLimit - this.DF_VETO_MARGIN_DB
        )
        const emptiedByDenoiser = inputSquares > 1e-12 &&
          10 * Math.log10(Math.max(1e-12, outputSquares) / inputSquares) <= -vetoReductionDb
        if (emptiedByDenoiser) this.dfVetoFrames++
        else this.dfVetoFrames = 0

        const targetGain = delayedIsSpeech && this.dfVetoFrames < this.DF_VETO_MIN_FRAMES
          ? 1
          : this.GATE_FLOOR
        const attackCoefficient = 1 / 48 // ~1 ms at 48 kHz
        const releaseCoefficient = 1 / 480 // ~10 ms at 48 kHz
        for (let i = 0; i < this.FRAME_SIZE; i++) {
          const coefficient = targetGain > this.gateGain ? attackCoefficient : releaseCoefficient
          this.gateGain += (targetGain - this.gateGain) * coefficient
          this.processedFrame[i] = outputFrame[i] * this.gateGain
        }
      }

      // Automatic level control. One pass: measure what the gate produced, apply
      // the gain decided by the previous frame, then adapt. Measuring before the
      // gain is applied is what keeps this from being a feedback loop - the
      // followers see the microphone's own level, not the level of their own work.
      let framePeak = 0
      let frameSquares = 0
      for (let i = 0; i < this.FRAME_SIZE; i++) {
        const sample = this.processedFrame[i]
        const magnitude = sample < 0 ? -sample : sample
        if (magnitude > framePeak) framePeak = magnitude
        frameSquares += sample * sample
        this.processedFrame[i] = sample * this.alcGain
      }

      // Learn only from frames the gate actually passed and only above the floor:
      // a closed gate is digital silence, and near-silence carries no level to aim
      // at. Everything else - phrases, laughter, a cough - is the user's own voice
      // and is exactly what has to reach the target.
      const frameRms = Math.sqrt(frameSquares / this.FRAME_SIZE)
      if (this.gateGain > 0.5 && framePeak >= this.ALC_MIN_SPEECH_RMS) {
        if (this.alcSpeechFrames === 0) {
          this.alcSpeechRms = frameRms
          this.alcSpeechPeak = framePeak
        } else {
          // Both followers see a clap as the user's own voice - the mean reads it as
          // the level, the follower as the crest - and between them they hand back
          // every dB of gain, then need seconds of real speech to forget it. Clamped
          // to what speech can plausibly do relative to the level already measured,
          // an impulse costs no more than a loud syllable. See IMPULSE_CLAMP_RATIO.
          const learnRms = Math.min(frameRms, this.alcSpeechRms * this.IMPULSE_CLAMP_RATIO)
          const learnPeak = Math.min(framePeak, this.alcSpeechRms * this.ALC_MAX_PEAK_OVER_RMS)
          this.alcSpeechRms += this.ALC_RMS_RATE * (learnRms - this.alcSpeechRms)
          this.alcSpeechPeak += (learnPeak > this.alcSpeechPeak ? this.ALC_PEAK_RISE : this.ALC_PEAK_FALL) *
            (learnPeak - this.alcSpeechPeak)
        }
        const seeding = ++this.alcSpeechFrames <= this.ALC_SEED_FRAMES

        // Whichever limit binds first wins: the target loudness, or the peak
        // ceiling. A voice with an unusually high crest factor is therefore held
        // slightly below target instead of being pushed into the clipper to reach
        // it. The gain is never allowed below 1 - bringing a loud microphone down
        // is the user's volume control, not this loop's business.
        const rmsGain = this.ALC_TARGET_RMS / Math.max(this.ALC_MIN_SPEECH_RMS, this.alcSpeechRms)
        const peakGain = this.ALC_PEAK_CEILING /
          (Math.max(this.ALC_MIN_SPEECH_RMS, this.alcSpeechPeak) * this.alcDownstreamGain)
        const targetGain = Math.max(1, Math.min(this.ALC_MAX_GAIN, Math.min(rmsGain, peakGain)))
        this.alcGain += (targetGain - this.alcGain) *
          (seeding ? this.ALC_SEED_GAIN_SMOOTH : this.ALC_GAIN_SMOOTH)

        if (++this.alcLogFrames >= 100) {
          this.alcLogFrames = 0
          const dbfs = (value: number) => (20 * Math.log10(Math.max(1e-6, value))).toFixed(1)
          if (Math.abs(20 * Math.log10(this.alcGain / this.alcLoggedGain)) >= 1) {
            this.alcLoggedGain = this.alcGain
            this.port.postMessage({
              type: 'log',
              message: `ALC ${dbfs(this.alcGain)}dB: active speech ${dbfs(this.alcSpeechRms)}dBFS -> ` +
                `${dbfs(this.alcSpeechRms * this.alcGain)}dBFS, peak ${dbfs(this.alcSpeechPeak * this.alcGain)}dBFS`
            })
          }
        }
      }

      // Suppression depth from the SNR measured above. Not while a calibration run is
      // in flight: that run exists to produce the floor this loop starts from.
      if (this.calibrationFramesLeft <= 0) this.refreshAttenuationLimit()

      if (this.calibrationFramesLeft > 0) {
        const elapsedFrames = this.calibrationTotalFrames - this.calibrationFramesLeft
        this.calibrationFramesLeft--
        const insideWindow = elapsedFrames >= this.CALIBRATION_LEAD_IN_FRAMES

        const normalizedRms = currentRms / this.gainFactor
        if (insideWindow) {
          // Keep the trailing level history regardless of the decision below, so
          // the reference can never depend on its own outcome. A low percentile
          // survives speech-shaped content that fills most of the window.
          this.calibrationSilenceHistory[this.calibrationSilenceHistoryIndex] = normalizedRms
          this.calibrationSilenceHistoryIndex =
            (this.calibrationSilenceHistoryIndex + 1) % this.calibrationSilenceHistory.length
          this.calibrationSilenceHistoryCount++
          if (this.calibrationSilenceHistoryCount % 10 === 0) {
            const filled = Math.min(this.calibrationSilenceHistoryCount, this.calibrationSilenceHistory.length)
            const recent = this.calibrationSilenceScratch.subarray(0, filled)
            recent.set(this.calibrationSilenceHistory.subarray(0, filled))
            recent.sort()
            this.calibrationSilenceLevel = recent[Math.floor((filled - 1) * 0.4)]
          }
        }
        // Distant speech - a television in another room, a conversation at the far
        // end of the apartment - is background noise for this microphone, and the
        // denoiser is expected to remove exactly that, so it belongs in the noise
        // profile instead of aborting calibration. Only the user's own voice has to
        // stay out of it, and near-field speech is ~18 dB above the room level
        // measured in this very run. Heavier contamination than this filter can
        // catch is still caught twice: the noise floor is a median, and a
        // speech-dominated window collapses the accepted-frame count.
        const nearFieldSpeechFloor = Math.max(this.calibrationSilenceLevel * 8, 0.0008)
        const containsSpeech = this.sileroVadProbability >= this.CALIBRATION_SPEECH_VAD_FLOOR &&
          normalizedRms >= nearFieldSpeechFloor

        if (insideWindow && !containsSpeech && this.calibrationCount < this.calibrationRms.length) {
          this.calibrationRms[this.calibrationCount] = normalizedRms
          this.calibrationCount++
          this.calibrationZcrSum += currentZcr
          this.calibrationSpectralTiltSum += currentTilt
        } else if (insideWindow && containsSpeech) {
          this.calibrationRejectedSpeechFrames++
        }

        if (this.calibrationFramesLeft === 0) {
          const samples = Array.from(this.calibrationRms.subarray(0, this.calibrationCount)).sort((a, b) => a - b)
          const noiseVadSamples = Array.from(this.calibrationNoiseVad.subarray(0, this.calibrationNoiseVadCount)).sort((a, b) => a - b)
          const percentile = (values: number[], p: number) => values.length
            ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))]
            : 0
          this.port.postMessage({
            type: 'calibrationResult',
            noiseFloor: percentile(samples, 0.5),
            lowNoise: percentile(samples, 0.2),
            peakNoise: percentile(samples, 0.95),
            noiseVadMedian: percentile(noiseVadSamples, 0.5),
            noiseVadHigh: percentile(noiseVadSamples, 0.95),
            zeroCrossingRate: this.calibrationZcrSum / Math.max(1, this.calibrationCount),
            spectralTilt: this.calibrationSpectralTiltSum / Math.max(1, this.calibrationCount),
            acceptedFrames: this.calibrationCount,
            rejectedSpeechFrames: this.calibrationRejectedSpeechFrames,
            silenceReference: this.calibrationSilenceLevel
          })
        }
      }

      if (measureWhileMuted) {
        // The calibration above already measured the real frame; the stream must
        // still receive nothing but silence while the user is muted.
        this.processedFrame.fill(0)
        this.gateGain = 0
      }
      this.outputWriteIndex = this.pushToBuffer(this.outputBuffer, this.processedFrame, this.outputWriteIndex, this.outputReadIndex)
    }

    const availableOutput = (this.outputWriteIndex - this.outputReadIndex + this.BUFFER_SIZE) % this.BUFFER_SIZE
    if (availableOutput >= outputChannel.length) {
      this.outputReadIndex = this.pullFromBuffer(this.outputBuffer, outputChannel, this.outputWriteIndex, this.outputReadIndex)
    } else {
      outputChannel.fill(0)
    }

    return true
  }
}

registerProcessor('deepfilter-processor', DeepFilterProcessor)
