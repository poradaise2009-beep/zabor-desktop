import { signalRService } from './signalr'
import { useAppStore } from '../store/useAppStore'

type SpeakingEntry = {
  timer: NodeJS.Timeout
  stream: MediaStream
}

export class WebRTCManager {
  private localStream: MediaStream | null = null
  private rawStream: MediaStream | null = null

  private peerConnections: Map<string, RTCPeerConnection> = new Map()
  private audioElements: Map<string, HTMLAudioElement> = new Map()

  private currentDeviceId = 'default'
  private currentOutputDeviceId = 'default'
  private noiseSuppression = true

  private inputVolume = 100
  private outputVolume = 100
  private isDeafened = false

  private processedContext: AudioContext | null = null
  private processedSource: MediaStreamAudioSourceNode | null = null
  private inputGainNode: GainNode | null = null
  private rnnoiseDestroy: (() => void) | null = null

  private vadContext: AudioContext | null = null
  private speakingIntervals: Map<string, SpeakingEntry> = new Map()

  private readonly config: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ],
    bundlePolicy: 'balanced',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 4
  }

  // ── SDP Munging ───────────────────────────────────────────────

  private mungeOpusSDP(sdp: string): string {
    const lines = sdp.split('\r\n')
    let opusPayloadType: string | null = null

    for (const line of lines) {
      const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i)
      if (match) { opusPayloadType = match[1]; break }
    }

    if (!opusPayloadType) return sdp

    const result: string[] = []
    let fmtpUpdated = false
    let ptimeExists = false

    for (const line of lines) {
      let updatedLine = line

      if (line.startsWith('m=audio')) {
        const parts = line.split(' ')
        const header = parts.slice(0, 3)
        const payloads = parts.slice(3).filter(p => p !== opusPayloadType)
        updatedLine = [...header, opusPayloadType, ...payloads].join(' ')
      }

      if (line.startsWith(`a=fmtp:${opusPayloadType}`)) {
        updatedLine =
          `a=fmtp:${opusPayloadType} ` +
          `minptime=10;useinbandfec=1;usedtx=0;maxaveragebitrate=128000;` +
          `sprop-maxcapturerate=48000;stereo=0;cbr=0;maxplaybackrate=48000`
        fmtpUpdated = true
      }

      if (line.startsWith('a=ptime:')) {
        updatedLine = 'a=ptime:10'
        ptimeExists = true
      }

      result.push(updatedLine)
    }

    if (!fmtpUpdated) {
      const rtpmapIndex = result.findIndex(line => line.startsWith(`a=rtpmap:${opusPayloadType}`))
      if (rtpmapIndex >= 0) {
        result.splice(rtpmapIndex + 1, 0,
          `a=fmtp:${opusPayloadType} minptime=10;useinbandfec=1;usedtx=0;maxaveragebitrate=128000;sprop-maxcapturerate=48000;stereo=0;cbr=0;maxplaybackrate=48000`
        )
      }
    }

    if (!ptimeExists) {
      const audioIndex = result.findIndex(line => line.startsWith('m=audio'))
      if (audioIndex >= 0) result.splice(audioIndex + 1, 0, 'a=ptime:10')
    }

    return result.join('\r\n')
  }

  private async optimizeSender(sender: RTCRtpSender): Promise<void> {
    try {
      const parameters = sender.getParameters()
      if (!parameters.encodings || parameters.encodings.length === 0) parameters.encodings = [{}]
      parameters.encodings[0].maxBitrate = 128000
      parameters.encodings[0].priority = 'high'
      parameters.degradationPreference = 'maintain-framerate'
      await sender.setParameters(parameters)
    } catch {}
  }

  // ── Audio Pipeline ────────────────────────────────────────────

  private async createProcessedStream(rawStream: MediaStream): Promise<MediaStream> {
    this.cleanupProcessedStream()

    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    this.processedContext = ctx

    const destination = ctx.createMediaStreamDestination()

    const inputGain = ctx.createGain()
    inputGain.gain.value = Math.max(0, Math.min(2, this.inputVolume / 100))
    this.inputGainNode = inputGain

    // High-pass: убирает гул, вибрации стола, ветер
    const highPass = ctx.createBiquadFilter()
    highPass.type = 'highpass'
    highPass.frequency.value = 85
    highPass.Q.value = 0.71

    // Low-pass: убирает ВЧ-шипение, щелчки мыши, клавиатуру
    const lowPass = ctx.createBiquadFilter()
    lowPass.type = 'lowpass'
    lowPass.frequency.value = 14000
    lowPass.Q.value = 0.71

    // De-ess: смягчает резкие сибилянты (С, Ш, Щ, З)
    const deEss = ctx.createBiquadFilter()
    deEss.type = 'peaking'
    deEss.frequency.value = 6500
    deEss.Q.value = 2.0
    deEss.gain.value = -3.0

    // Presence boost: добавляет ясность голосу
    const presence = ctx.createBiquadFilter()
    presence.type = 'peaking'
    presence.frequency.value = 3000
    presence.Q.value = 1.0
    presence.gain.value = 1.5

    // Warmth: лёгкое усиление низких частот голоса
    const warmth = ctx.createBiquadFilter()
    warmth.type = 'peaking'
    warmth.frequency.value = 200
    warmth.Q.value = 0.8
    warmth.gain.value = 1.0

    // Noise gate: подавляет фоновый шум в паузах
    const gate = ctx.createDynamicsCompressor()
    gate.threshold.value = -50
    gate.knee.value = 5
    gate.ratio.value = 20
    gate.attack.value = 0.001
    gate.release.value = 0.05

    // Compressor: выравнивает громкость
    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -22
    compressor.knee.value = 12
    compressor.ratio.value = 3.0
    compressor.attack.value = 0.003
    compressor.release.value = 0.15

    // Limiter: предотвращает клиппинг
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.001
    limiter.release.value = 0.01

    // Makeup gain: компенсация потерь от gate/compressor
    const makeupGain = ctx.createGain()
    makeupGain.gain.value = 1.15

    if (this.noiseSuppression) {
      try {
        const { createRNNoiseProcessor } = await import('./rnnoise-processor')
        const result = await createRNNoiseProcessor(ctx, rawStream)
        this.rnnoiseDestroy = result.destroy

        const source = ctx.createMediaStreamSource(result.stream)
        this.processedSource = source

        // RNNoise → EQ → Gate → Compressor → Limiter → Gain → Output
        source.connect(highPass)
        highPass.connect(lowPass)
        lowPass.connect(warmth)
        warmth.connect(presence)
        presence.connect(deEss)
        deEss.connect(gate)
        gate.connect(compressor)
        compressor.connect(limiter)
        limiter.connect(makeupGain)
        makeupGain.connect(inputGain)
        inputGain.connect(destination)

        return destination.stream
      } catch (error) {
        console.warn('[WebRTC] RNNoise failed, using browser NS fallback', error)
      }
    }

    // Fallback: без RNNoise
    const source = ctx.createMediaStreamSource(rawStream)
    this.processedSource = source

    source.connect(highPass)
    highPass.connect(lowPass)
    lowPass.connect(warmth)
    warmth.connect(presence)
    presence.connect(deEss)
    deEss.connect(gate)
    gate.connect(compressor)
    compressor.connect(limiter)
    limiter.connect(makeupGain)
    makeupGain.connect(inputGain)
    inputGain.connect(destination)

    return destination.stream
  }

  private cleanupProcessedStream() {
    if (this.rnnoiseDestroy) { this.rnnoiseDestroy(); this.rnnoiseDestroy = null }
    if (this.processedContext && this.processedContext.state !== 'closed') {
      this.processedContext.close().catch(() => {})
    }
    this.processedContext = null
    this.processedSource = null
    this.inputGainNode = null
  }

  public setInputVolume(volume: number) {
    this.inputVolume = volume
    if (this.inputGainNode) {
      this.inputGainNode.gain.value = Math.max(0, Math.min(2, volume / 100))
    }
  }

  public setOutputVolume(volume: number) {
    this.outputVolume = volume
    this.audioElements.forEach((_, userId) => this.updateRemoteVolume(userId))
  }

  public setDeafened(isDeafened: boolean) {
    this.isDeafened = isDeafened
    this.audioElements.forEach(audio => { audio.muted = isDeafened })
  }

  private updateRemoteVolume(userId: string) {
    const audio = this.audioElements.get(userId)
    if (!audio) return
    const userVolume = useAppStore.getState().userVolumes[userId] ?? 100
    const finalVolume = (this.outputVolume / 100) * (userVolume / 100)
    audio.volume = Math.max(0, Math.min(1, finalVolume))
    audio.muted = this.isDeafened
  }

  // ── VAD ───────────────────────────────────────────────────────

  private setupVAD(stream: MediaStream, userId: string, isLocal: boolean) {
    this.clearVAD(userId)

    try {
      if (!this.vadContext || this.vadContext.state === 'closed') {
        this.vadContext = new AudioContext({ latencyHint: 'interactive' })
      }
      if (this.vadContext.state === 'suspended') this.vadContext.resume().catch(() => {})

      const clonedTracks = stream.getAudioTracks().map(t => t.clone())
      const cloned = new MediaStream(clonedTracks)

      const source = this.vadContext.createMediaStreamSource(cloned)

      const highPass = this.vadContext.createBiquadFilter()
      highPass.type = 'highpass'
      highPass.frequency.value = 70
      highPass.Q.value = 0.7

      const lowPass = this.vadContext.createBiquadFilter()
      lowPass.type = 'lowpass'
      lowPass.frequency.value = 5000
      lowPass.Q.value = 0.7

      const analyser = this.vadContext.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.18

      source.connect(highPass)
      highPass.connect(lowPass)
      lowPass.connect(analyser)

      const timeData = new Uint8Array(analyser.fftSize)

      let lastVoiceTime = 0
      let wasSpeaking = false
      let consecutiveVoiceFrames = 0

      const avgThreshold = isLocal ? 7 : 4
      const peakThreshold = isLocal ? 18 : 12

      const check = () => {
        const store = useAppStore.getState()

        if (isLocal && (store.currentUser?.isMuted || store.currentUser?.isServerMuted)) {
          if (wasSpeaking) {
            wasSpeaking = false
            consecutiveVoiceFrames = 0
            store.setSpeakingStatus(userId, false)
            signalRService.setSpeakingState(false)
          }
          return
        }

        analyser.getByteTimeDomainData(timeData)

        let peak = 0
        let sum = 0
        for (let i = 0; i < timeData.length; i++) {
          const sample = Math.abs(timeData[i] - 128)
          if (sample > peak) peak = sample
          sum += sample
        }

        const avg = sum / timeData.length
        const voiceFrame = avg >= avgThreshold || peak >= peakThreshold

        if (voiceFrame) { consecutiveVoiceFrames++ } else { consecutiveVoiceFrames = 0 }
        if (consecutiveVoiceFrames >= 1) lastVoiceTime = Date.now()

        const isSpeakingNow = (Date.now() - lastVoiceTime) < 500

        if (isSpeakingNow !== wasSpeaking) {
          wasSpeaking = isSpeakingNow
          store.setSpeakingStatus(userId, isSpeakingNow)
          if (isLocal) signalRService.setSpeakingState(isSpeakingNow)
        }
      }

      const timer = setInterval(check, 20)
      this.speakingIntervals.set(userId, { timer, stream: cloned })
    } catch (error) {
      console.error('[VAD] setup failed', error)
    }
  }

  private clearVAD(userId: string) {
    const entry = this.speakingIntervals.get(userId)
    if (entry) {
      clearInterval(entry.timer)
      entry.stream.getTracks().forEach(track => { track.stop(); track.enabled = false })
      this.speakingIntervals.delete(userId)
    }
    useAppStore.getState().setSpeakingStatus(userId, false)
  }

  // ── Devices ───────────────────────────────────────────────────

  public async getAudioDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
      const devices = await navigator.mediaDevices.enumerateDevices()
      return {
        inputs: devices.filter(device => device.kind === 'audioinput'),
        outputs: devices.filter(device => device.kind === 'audiooutput')
      }
    } catch { return { inputs: [], outputs: [] } }
  }

  public setInputDevice(deviceId: string) { this.currentDeviceId = deviceId }

  public setOutputDevice(deviceId: string) {
    this.currentOutputDeviceId = deviceId
    this.audioElements.forEach(audio => {
      if (typeof (audio as any).setSinkId === 'function') {
        (audio as any).setSinkId(deviceId).catch(() => {})
      }
    })
  }

  public setNoiseSuppression(enabled: boolean) {
    this.noiseSuppression = enabled
  }

  // ── Local Stream ──────────────────────────────────────────────

  public async startLocalStream(deviceId?: string, useNoiseSuppression?: boolean): Promise<boolean> {
    if (deviceId !== undefined) this.currentDeviceId = deviceId
    if (useNoiseSuppression !== undefined) this.noiseSuppression = useNoiseSuppression

    try {
      if (this.rawStream) { this.rawStream.getTracks().forEach(track => track.stop()); this.rawStream = null }
      if (this.localStream) { this.localStream.getTracks().forEach(track => track.stop()); this.localStream = null }
      this.cleanupProcessedStream()

      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.currentDeviceId !== 'default' ? { exact: this.currentDeviceId } : undefined,
          sampleRate: 48000,
          channelCount: 1,
          sampleSize: 16,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: !this.noiseSuppression // Если RNNoise вкл — браузерный NS выкл
        },
        video: false
      })

      this.rawStream = rawStream

      const rawTrack = rawStream.getAudioTracks()[0]
      if (rawTrack) rawTrack.contentHint = 'speech'

      this.localStream = await this.createProcessedStream(rawStream)

      const localTrack = this.localStream.getAudioTracks()[0]
      if (localTrack) localTrack.contentHint = 'speech'

      const me = useAppStore.getState().currentUser
      if (me && this.rawStream) this.setupVAD(this.rawStream, me.id, true)

      return true
    } catch { return false }
  }

  public async updateSettings(deviceId: string, useNoiseSuppression: boolean) {
    this.currentDeviceId = deviceId
    this.noiseSuppression = useNoiseSuppression

    if (this.localStream) {
      await this.startLocalStream(deviceId, useNoiseSuppression)

      for (const pc of this.peerConnections.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
        const newTrack = this.localStream?.getAudioTracks()[0]
        if (sender && newTrack) {
          await sender.replaceTrack(newTrack).catch(() => {})
          await this.optimizeSender(sender)
        }
      }
    }
  }

  public stopLocalStream() {
    const me = useAppStore.getState().currentUser
    if (me) this.clearVAD(me.id)
    if (this.localStream) { this.localStream.getTracks().forEach(track => track.stop()); this.localStream = null }
    if (this.rawStream) { this.rawStream.getTracks().forEach(track => track.stop()); this.rawStream = null }
    this.cleanupProcessedStream()
    this.leaveAll()
  }

  public toggleMute(isMuted: boolean) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => { track.enabled = !isMuted })
    }
  }

  public setUserVolume(userId: string, volume: number) {
    const normalized = Math.max(0, Math.min(200, volume))
    useAppStore.getState().setUserVolume(userId, normalized)
    this.updateRemoteVolume(userId)
  }

  // ── Peer Connections ──────────────────────────────────────────

  private createAudioElement(userId: string): HTMLAudioElement {
    let audio = this.audioElements.get(userId)
    if (!audio) {
      audio = new Audio()
      audio.autoplay = true
      if (this.currentOutputDeviceId !== 'default' && typeof (audio as any).setSinkId === 'function') {
        (audio as any).setSinkId(this.currentOutputDeviceId).catch(() => {})
      }
      this.audioElements.set(userId, audio)
    }
    this.updateRemoteVolume(userId)
    return audio
  }

  private setupPeerHandlers(pc: RTCPeerConnection, userId: string) {
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0]
      const audio = this.createAudioElement(userId)
      audio.srcObject = remoteStream
      this.setupVAD(remoteStream, userId, false)
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) signalRService.sendIceCandidate(userId, JSON.stringify(event.candidate))
    }

    let disconnectedTimer: NodeJS.Timeout | null = null

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (disconnectedTimer && state !== 'disconnected') { clearTimeout(disconnectedTimer); disconnectedTimer = null }
      if (state === 'failed' || state === 'closed') {
        this.disconnectFromPeer(userId)
      } else if (state === 'disconnected') {
        disconnectedTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') this.disconnectFromPeer(userId)
        }, 5000)
      }
    }
  }

  public async connectToPeer(userId: string) {
    if (this.peerConnections.has(userId)) return

    const pc = new RTCPeerConnection(this.config)
    this.peerConnections.set(userId, pc)

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, this.localStream!)
        this.optimizeSender(sender).catch(() => {})
      })
    }

    this.setupPeerHandlers(pc, userId)

    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true })
      const mungedSdp = this.mungeOpusSDP(offer.sdp ?? '')
      await pc.setLocalDescription(new RTCSessionDescription({ type: 'offer', sdp: mungedSdp }))
      signalRService.sendWebRTCOffer(userId, JSON.stringify(pc.localDescription))
    } catch { this.disconnectFromPeer(userId) }
  }

  public async handleOffer(senderId: string, offerStr: string) {
    const store = useAppStore.getState()
    const inChannel = !!store.currentChannelId
    const inCall = store.currentCallUser?.id === senderId
    if (!inChannel && !inCall) return

    if (this.peerConnections.has(senderId)) this.disconnectFromPeer(senderId)

    const pc = new RTCPeerConnection(this.config)
    this.peerConnections.set(senderId, pc)

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, this.localStream!)
        this.optimizeSender(sender).catch(() => {})
      })
    }

    this.setupPeerHandlers(pc, senderId)

    try {
      const offer = JSON.parse(offerStr)
      await pc.setRemoteDescription(new RTCSessionDescription(offer))
      const answer = await pc.createAnswer()
      const mungedSdp = this.mungeOpusSDP(answer.sdp ?? '')
      await pc.setLocalDescription(new RTCSessionDescription({ type: 'answer', sdp: mungedSdp }))
      signalRService.sendWebRTCAnswer(senderId, JSON.stringify(pc.localDescription))
    } catch { this.disconnectFromPeer(senderId) }
  }

  public async handleAnswer(senderId: string, answerStr: string) {
    const pc = this.peerConnections.get(senderId)
    if (!pc) return
    try { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerStr))) } catch {}
  }

  public async handleIceCandidate(senderId: string, candidateStr: string) {
    const pc = this.peerConnections.get(senderId)
    if (!pc) return
    try { await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(candidateStr))) } catch {}
  }

  public disconnectFromPeer(userId: string) {
    const pc = this.peerConnections.get(userId)
    if (pc) { pc.ontrack = null; pc.onicecandidate = null; pc.onconnectionstatechange = null; pc.close(); this.peerConnections.delete(userId) }
    const audio = this.audioElements.get(userId)
    if (audio) { audio.pause(); audio.srcObject = null; this.audioElements.delete(userId) }
    this.clearVAD(userId)
  }

  public leaveAll() {
    this.peerConnections.forEach((_, userId) => this.disconnectFromPeer(userId))
  }
}

export const webrtc = new WebRTCManager()