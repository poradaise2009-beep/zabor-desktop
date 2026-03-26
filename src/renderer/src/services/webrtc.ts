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

  // ==========================================
  // OPUS / SDP
  // ==========================================
  private mungeOpusSDP(sdp: string): string {
    const lines = sdp.split('\r\n')
    let opusPayloadType: string | null = null

    for (const line of lines) {
      const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000\/?(\d+)?/i)
      if (match) {
        opusPayloadType = match[1]
        break
      }
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
          `minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=96000;` +
          `sprop-maxcapturerate=48000;stereo=0;cbr=0`
        fmtpUpdated = true
      }

      if (line.startsWith('a=ptime:')) {
        updatedLine = 'a=ptime:20'
        ptimeExists = true
      }

      result.push(updatedLine)
    }

    if (!fmtpUpdated) {
      const rtpmapIndex = result.findIndex(line => line.startsWith(`a=rtpmap:${opusPayloadType}`))
      if (rtpmapIndex >= 0) {
        result.splice(
          rtpmapIndex + 1,
          0,
          `a=fmtp:${opusPayloadType} minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=96000;sprop-maxcapturerate=48000;stereo=0;cbr=0`
        )
      }
    }

    if (!ptimeExists) {
      const audioIndex = result.findIndex(line => line.startsWith('m=audio'))
      if (audioIndex >= 0) {
        result.splice(audioIndex + 1, 0, 'a=ptime:20')
      }
    }

    return result.join('\r\n')
  }

  private async optimizeSender(sender: RTCRtpSender): Promise<void> {
    try {
      const parameters = sender.getParameters()
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}]
      }
      parameters.encodings[0].maxBitrate = 96000
      parameters.encodings[0].priority = 'high'
      parameters.degradationPreference = 'maintain-framerate'
      await sender.setParameters(parameters)
    } catch {}
  }

  // ==========================================
  // AUDIO PROCESSING
  // ==========================================
  private async createProcessedStream(rawStream: MediaStream): Promise<MediaStream> {
    this.cleanupProcessedStream()

    const ctx = new AudioContext({
      sampleRate: 48000,
      latencyHint: 'interactive'
    })
    this.processedContext = ctx

    const destination = ctx.createMediaStreamDestination()
    const inputGain = ctx.createGain()
    inputGain.gain.value = Math.max(0, Math.min(2, this.inputVolume / 100))
    this.inputGainNode = inputGain

    const highPass = ctx.createBiquadFilter()
    highPass.type = 'highpass'
    highPass.frequency.value = 80
    highPass.Q.value = 0.707

    const lowPass = ctx.createBiquadFilter()
    lowPass.type = 'lowpass'
    lowPass.frequency.value = 14000
    lowPass.Q.value = 0.707

    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -24
    compressor.knee.value = 15
    compressor.ratio.value = 2
    compressor.attack.value = 0.005
    compressor.release.value = 0.15

    // RNNoise pipeline
    if (this.noiseSuppression) {
      try {
        const { createRNNoiseProcessor } = await import('./rnnoise-processor')
        const result = await createRNNoiseProcessor(ctx, rawStream)
        this.rnnoiseDestroy = result.destroy

        const source = ctx.createMediaStreamSource(result.stream)
        this.processedSource = source

        source.connect(highPass)
        highPass.connect(lowPass)
        lowPass.connect(compressor)
        compressor.connect(inputGain)
        inputGain.connect(destination)

        return destination.stream
      } catch (e) {
        console.warn('[WebRTC] RNNoise failed, falling back to browser noise suppression', e)
        // Fallback: пересоздаём стрим с браузерным шумоподавлением
        try {
          const fallbackStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: this.currentDeviceId !== 'default' ? { exact: this.currentDeviceId } : undefined,
              sampleRate: 48000,
              channelCount: 1,
              echoCancellation: true,
              autoGainControl: true,
              noiseSuppression: true
            }
          })
          rawStream.getTracks().forEach(t => t.stop())
          if (this.rawStream) {
            this.rawStream.getTracks().forEach(t => t.stop())
          }
          this.rawStream = fallbackStream
          rawStream = fallbackStream
        } catch {
          // Продолжаем без шумоподавления
        }
      }
    }

    // Fallback path (без RNNoise)
    const source = ctx.createMediaStreamSource(rawStream)
    this.processedSource = source

    source.connect(highPass)
    highPass.connect(lowPass)
    lowPass.connect(compressor)
    compressor.connect(inputGain)
    inputGain.connect(destination)

    return destination.stream
  }

  private cleanupProcessedStream() {
    if (this.rnnoiseDestroy) {
      this.rnnoiseDestroy()
      this.rnnoiseDestroy = null
    }

    if (this.processedContext && this.processedContext.state !== 'closed') {
      this.processedContext.close().catch(() => {})
    }

    this.processedContext = null
    this.processedSource = null
    this.inputGainNode = null
  }

  // ==========================================
  // VOLUME / DEAFEN
  // ==========================================
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
    this.audioElements.forEach(audio => {
      audio.muted = isDeafened
    })
  }

  private updateRemoteVolume(userId: string) {
    const audio = this.audioElements.get(userId)
    if (!audio) return

    const userVolume = useAppStore.getState().userVolumes[userId] ?? 100
    const finalVolume = (this.outputVolume / 100) * (userVolume / 100)

    audio.volume = Math.max(0, Math.min(1, finalVolume))
    audio.muted = this.isDeafened
  }

  // ==========================================
  // VAD
  // ==========================================
  private setupVAD(stream: MediaStream, userId: string, isLocal: boolean) {
  this.clearVAD(userId)

  try {
    if (!this.vadContext || this.vadContext.state === 'closed') {
      this.vadContext = new AudioContext({ latencyHint: 'interactive' })
    }

    if (this.vadContext.state === 'suspended') {
      this.vadContext.resume().catch(() => {})
    }

    const clonedTracks = stream.getAudioTracks().map(t => t.clone())
    const cloned = new MediaStream(clonedTracks)

    const source = this.vadContext.createMediaStreamSource(cloned)

    const highPass = this.vadContext.createBiquadFilter()
    highPass.type = 'highpass'
    highPass.frequency.value = 80
    highPass.Q.value = 0.7

    const lowPass = this.vadContext.createBiquadFilter()
    lowPass.type = 'lowpass'
    lowPass.frequency.value = 5000
    lowPass.Q.value = 0.7

    const analyser = this.vadContext.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.20

    source.connect(highPass)
    highPass.connect(lowPass)
    lowPass.connect(analyser)

    const timeData = new Uint8Array(analyser.fftSize)

    let lastVoiceTime = 0
    let wasSpeaking = false
    let consecutiveVoiceFrames = 0

    
    const avgThreshold = isLocal ? 12 : 8
    const peakThreshold = isLocal ? 18 : 12

    const check = () => {
      const store = useAppStore.getState()

      if (isLocal && store.currentUser?.isMuted) {
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

      if (voiceFrame) {
        consecutiveVoiceFrames++
      } else {
        consecutiveVoiceFrames = 0
      }

      
      if (consecutiveVoiceFrames >= 1) {
        lastVoiceTime = Date.now()
      }

      
      const isSpeakingNow = (Date.now() - lastVoiceTime) < 350

      if (isSpeakingNow !== wasSpeaking) {
        wasSpeaking = isSpeakingNow
        store.setSpeakingStatus(userId, isSpeakingNow)

        if (isLocal) {
          signalRService.setSpeakingState(isSpeakingNow)
        }
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
      entry.stream.getTracks().forEach(track => {
        track.stop()
        track.enabled = false
      })
      this.speakingIntervals.delete(userId)
    }

    useAppStore.getState().setSpeakingStatus(userId, false)
  }

  // ==========================================
  // DEVICES
  // ==========================================
  public async getAudioDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
      const devices = await navigator.mediaDevices.enumerateDevices()
      return {
        inputs: devices.filter(device => device.kind === 'audioinput'),
        outputs: devices.filter(device => device.kind === 'audiooutput')
      }
    } catch {
      return { inputs: [], outputs: [] }
    }
  }

  public setInputDevice(deviceId: string) {
    this.currentDeviceId = deviceId
  }

  public setOutputDevice(deviceId: string) {
    this.currentOutputDeviceId = deviceId
    this.audioElements.forEach(audio => {
      if (typeof (audio as any).setSinkId === 'function') {
        (audio as any).setSinkId(deviceId).catch(() => {})
      }
    })
  }

  // ==========================================
  // LOCAL STREAM
  // ==========================================
  public async startLocalStream(deviceId?: string, useNoiseSuppression?: boolean): Promise<boolean> {
    if (deviceId !== undefined) this.currentDeviceId = deviceId
    if (useNoiseSuppression !== undefined) this.noiseSuppression = useNoiseSuppression

    try {
      if (this.rawStream) {
        this.rawStream.getTracks().forEach(track => track.stop())
        this.rawStream = null
      }

      if (this.localStream) {
        this.localStream.getTracks().forEach(track => track.stop())
        this.localStream = null
      }

      this.cleanupProcessedStream()

      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.currentDeviceId !== 'default' ? { exact: this.currentDeviceId } : undefined,
          sampleRate: 48000,
          channelCount: 1,
          sampleSize: 16,
          echoCancellation: true,
          autoGainControl: true,
          // Если RNNoise включён — отключаем браузерный шумодав (двойная обработка = артефакты).
          // Если RNNoise выключен — включаем браузерный как единственный шумодав.
          noiseSuppression: !this.noiseSuppression
        },
        video: false
      })

      this.rawStream = rawStream

      const rawTrack = rawStream.getAudioTracks()[0]
      if (rawTrack) {
        rawTrack.contentHint = 'speech'
      }

      this.localStream = await this.createProcessedStream(rawStream)

      const localTrack = this.localStream.getAudioTracks()[0]
      if (localTrack) {
        localTrack.contentHint = 'speech'
      }

      const me = useAppStore.getState().currentUser
      if (me && this.rawStream) {
        this.setupVAD(this.rawStream, me.id, true)
      }

      return true
    } catch {
      return false
    }
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
    if (me) {
      this.clearVAD(me.id)
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop())
      this.localStream = null
    }

    if (this.rawStream) {
      this.rawStream.getTracks().forEach(track => track.stop())
      this.rawStream = null
    }

    this.cleanupProcessedStream()
    this.leaveAll()
  }

  public toggleMute(isMuted: boolean) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !isMuted
      })
    }
  }

  public setUserVolume(userId: string, volume: number) {
    const normalized = Math.max(0, Math.min(200, volume))
    useAppStore.getState().setUserVolume(userId, normalized)
    this.updateRemoteVolume(userId)
  }

  // ==========================================
  // PEER CONNECTIONS
  // ==========================================
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
      if (event.candidate) {
        signalRService.sendIceCandidate(userId, JSON.stringify(event.candidate))
      }
    }

    let disconnectedTimer: NodeJS.Timeout | null = null

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState

      // Очищаем таймер если состояние изменилось
      if (disconnectedTimer && state !== 'disconnected') {
        clearTimeout(disconnectedTimer)
        disconnectedTimer = null
      }

      if (state === 'failed' || state === 'closed') {
        this.disconnectFromPeer(userId)
      } else if (state === 'disconnected') {
        // Даём 5 секунд на восстановление перед разрывом
        disconnectedTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') {
            this.disconnectFromPeer(userId)
          }
        }, 5000)
      }
    }
  }

  public async connectToPeer(userId: string) {
    if (this.peerConnections.has(userId)) {
      this.disconnectFromPeer(userId)
    }

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
      const offer = await pc.createOffer({
        offerToReceiveAudio: true
      })

      const mungedSdp = this.mungeOpusSDP(offer.sdp ?? '')
      const localDescription = new RTCSessionDescription({
        type: 'offer',
        sdp: mungedSdp
      })

      await pc.setLocalDescription(localDescription)
      signalRService.sendWebRTCOffer(userId, JSON.stringify(pc.localDescription))
    } catch {
      this.disconnectFromPeer(userId)
    }
  }

  public async handleOffer(senderId: string, offerStr: string) {
    const store = useAppStore.getState()

    // Принимаем offer если мы в любом канале или в звонке с этим пользователем.
    // Сервер уже авторизовал signaling — доверяем ему.
    const inChannel = !!store.currentChannelId
    const inCall = store.currentCallUser?.id === senderId

    if (!inChannel && !inCall) return

    if (this.peerConnections.has(senderId)) {
      this.disconnectFromPeer(senderId)
    }

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
      const localDescription = new RTCSessionDescription({
        type: 'answer',
        sdp: mungedSdp
      })

      await pc.setLocalDescription(localDescription)
      signalRService.sendWebRTCAnswer(senderId, JSON.stringify(pc.localDescription))
    } catch {
      this.disconnectFromPeer(senderId)
    }
  }

  public async handleAnswer(senderId: string, answerStr: string) {
    const pc = this.peerConnections.get(senderId)
    if (!pc) return

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerStr)))
    } catch {}
  }

  public async handleIceCandidate(senderId: string, candidateStr: string) {
    const pc = this.peerConnections.get(senderId)
    if (!pc) return

    try {
      await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(candidateStr)))
    } catch {}
  }

  public disconnectFromPeer(userId: string) {
    const pc = this.peerConnections.get(userId)
    if (pc) {
      pc.ontrack = null
      pc.onicecandidate = null
      pc.onconnectionstatechange = null
      pc.close()
      this.peerConnections.delete(userId)
    }

    const audio = this.audioElements.get(userId)
    if (audio) {
      audio.pause()
      audio.srcObject = null
      this.audioElements.delete(userId)
    }

    this.clearVAD(userId)
  }

  public leaveAll() {
    this.peerConnections.forEach((_, userId) => this.disconnectFromPeer(userId))
  }
}

export const webrtc = new WebRTCManager()