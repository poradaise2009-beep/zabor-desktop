import { signalRService } from './signalr';
import { useAppStore } from '../store/useAppStore';

export class WebRTCManager {
  private localStream: MediaStream | null = null;
  private rawStream: MediaStream | null = null;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private audioElements: Map<string, HTMLAudioElement> = new Map();

  private currentDeviceId: string = 'default';
  private currentOutputDeviceId: string = 'default';
  private noiseSuppression: boolean = true;

  private audioContext: AudioContext | null = null;
  private speakingIntervals: Map<string, { timer: NodeJS.Timeout; stream: MediaStream }> = new Map();

  private processedContext: AudioContext | null = null;
  private processedSource: MediaStreamAudioSourceNode | null = null;
  private rnnoiseDestroy: (() => void) | null = null;

  private config: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  };

  // ==========================================
  // АУДИО ПАЙПЛАЙН (шумоподавление)
  // ==========================================
  private async createProcessedStreamAsync(rawStream: MediaStream): Promise<MediaStream> {
    if (this.processedContext && this.processedContext.state !== 'closed') {
      this.processedContext.close().catch(() => {});
    }
    if (this.rnnoiseDestroy) {
      this.rnnoiseDestroy();
      this.rnnoiseDestroy = null;
    }

    const ctx = new AudioContext({ sampleRate: 48000 });
    this.processedContext = ctx;

    // Попытка RNNoise Wasm
    try {
      const { createRNNoiseProcessor } = await import('./rnnoise-processor');
      const result = await createRNNoiseProcessor(ctx, rawStream);
      this.rnnoiseDestroy = result.destroy;

      const source = ctx.createMediaStreamSource(result.stream);

      const highPass = ctx.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.value = 80;
      highPass.Q.value = 0.7;

      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -30;
      compressor.knee.value = 20;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.15;

      const dest = ctx.createMediaStreamDestination();
      source.connect(highPass);
      highPass.connect(compressor);
      compressor.connect(dest);

      return dest.stream;
    } catch {
      return this.createProcessedStreamFallback(ctx, rawStream);
    }
  }

  private createProcessedStreamFallback(ctx: AudioContext, rawStream: MediaStream): MediaStream {
    const source = ctx.createMediaStreamSource(rawStream);
    this.processedSource = source;

    const highPass = ctx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 80;
    highPass.Q.value = 0.7;

    const lowPass = ctx.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 12000;
    lowPass.Q.value = 0.7;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -30;
    compressor.knee.value = 20;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    source.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(compressor);

    const dest = ctx.createMediaStreamDestination();
    compressor.connect(dest);

    return dest.stream;
  }

  private cleanupProcessedStream() {
    if (this.rnnoiseDestroy) {
      this.rnnoiseDestroy();
      this.rnnoiseDestroy = null;
    }
    if (this.processedContext && this.processedContext.state !== 'closed') {
      this.processedContext.close().catch(() => {});
      this.processedContext = null;
      this.processedSource = null;
    }
  }

  // ==========================================
  // VAD (Voice Activity Detection)
  // ==========================================
  private setupAudioAnalyzer(stream: MediaStream, userId: string, isLocal: boolean) {
    this.clearAudioAnalyzer(userId);

    try {
      if (!this.audioContext) this.audioContext = new AudioContext();
      if (this.audioContext.state === 'suspended') this.audioContext.resume();

      const analyzer = this.audioContext.createAnalyser();
      analyzer.fftSize = 256;
      analyzer.smoothingTimeConstant = 0.4;

      const clonedStream = new MediaStream(stream.getAudioTracks());
      const source = this.audioContext.createMediaStreamSource(clonedStream);
      source.connect(analyzer);

      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      let lastSpokeTime = 0;
      let wasSpeaking = false;

      const checkAudio = () => {
        const store = useAppStore.getState();
        if (isLocal && store.currentUser?.isMuted) {
          if (wasSpeaking) {
            wasSpeaking = false;
            store.setSpeakingStatus(userId, false);
            signalRService.setSpeakingState(false);
          }
          return;
        }

        analyzer.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const average = sum / dataArray.length;

        if (average > 40) {
          lastSpokeTime = Date.now();
        }

        const isSpeaking = (Date.now() - lastSpokeTime) < 300;

        if (isSpeaking !== wasSpeaking) {
          wasSpeaking = isSpeaking;
          store.setSpeakingStatus(userId, isSpeaking);
          if (isLocal) signalRService.setSpeakingState(isSpeaking);
        }
      };

      const intervalId = setInterval(checkAudio, 50);
      this.speakingIntervals.set(userId, { timer: intervalId, stream: clonedStream });
    } catch (err) {
      console.error(err);
    }
  }

  private clearAudioAnalyzer(userId: string) {
    const entry = this.speakingIntervals.get(userId);
    if (entry) {
      clearInterval(entry.timer);
      entry.stream.getTracks().forEach(t => {
        t.stop();
        t.enabled = false;
      });
      this.speakingIntervals.delete(userId);
    }
    useAppStore.getState().setSpeakingStatus(userId, false);
  }

  // ==========================================
  // УСТРОЙСТВА
  // ==========================================
  public async getAudioDevices() {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const devices = await navigator.mediaDevices.enumerateDevices();
      return {
        inputs: devices.filter(d => d.kind === 'audioinput'),
        outputs: devices.filter(d => d.kind === 'audiooutput')
      };
    } catch {
      return { inputs: [], outputs: [] };
    }
  }

  public setInputDevice(deviceId: string) {
    this.currentDeviceId = deviceId;
  }

  public setOutputDevice(deviceId: string) {
    this.currentOutputDeviceId = deviceId;
    this.audioElements.forEach(audio => {
      if (typeof (audio as any).setSinkId === 'function')
        (audio as any).setSinkId(deviceId).catch(console.error);
    });
  }

  // ==========================================
  // ЛОКАЛЬНЫЙ СТРИМ
  // ==========================================
  public async startLocalStream(deviceId?: string, useNoiseSuppression?: boolean): Promise<boolean> {
    if (deviceId !== undefined) this.currentDeviceId = deviceId;
    if (useNoiseSuppression !== undefined) this.noiseSuppression = useNoiseSuppression;

    try {
      if (this.rawStream) {
        this.rawStream.getTracks().forEach(t => { t.stop(); t.enabled = false; });
        this.rawStream = null;
      }
      if (this.localStream) {
        this.localStream.getTracks().forEach(t => { t.stop(); t.enabled = false; });
        this.localStream = null;
      }
      this.cleanupProcessedStream();

      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.currentDeviceId !== 'default' ? { exact: this.currentDeviceId } : undefined,
          noiseSuppression: this.noiseSuppression,
          echoCancellation: true,
          autoGainControl: true
        },
        video: false
      });

      this.rawStream = rawStream;

      if (this.noiseSuppression) {
        this.localStream = await this.createProcessedStreamAsync(rawStream);
      } else {
        this.localStream = rawStream;
      }

      const me = useAppStore.getState().currentUser;
      if (me) this.setupAudioAnalyzer(this.localStream, me.id, true);

      return true;
    } catch {
      return false;
    }
  }

  public async updateSettings(deviceId: string, useNoiseSuppression: boolean) {
    this.currentDeviceId = deviceId;
    this.noiseSuppression = useNoiseSuppression;

    if (this.localStream) {
      await this.startLocalStream(deviceId, useNoiseSuppression);
      this.peerConnections.forEach(pc => {
        const senders = pc.getSenders();
        const audioSender = senders.find(s => s.track?.kind === 'audio');
        if (audioSender && this.localStream) audioSender.replaceTrack(this.localStream.getAudioTracks()[0]);
      });
    }
  }

  public stopLocalStream() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => { track.stop(); track.enabled = false; });
      this.localStream = null;
    }
    if (this.rawStream) {
      this.rawStream.getTracks().forEach(track => { track.stop(); track.enabled = false; });
      this.rawStream = null;
    }
    this.cleanupProcessedStream();
    const me = useAppStore.getState().currentUser;
    if (me) this.clearAudioAnalyzer(me.id);
    this.leaveAll();
  }

  public toggleMute(isMuted: boolean) {
    if (this.localStream) this.localStream.getAudioTracks().forEach(track => { track.enabled = !isMuted; });
  }

  public setUserVolume(userId: string, volume: number) {
    const audio = this.audioElements.get(userId);
    if (audio) audio.volume = Math.max(0, Math.min(2, volume));
    useAppStore.getState().setUserVolume(userId, volume * 100);
  }

  // ==========================================
  // PEER CONNECTIONS
  // ==========================================
  public async connectToPeer(userId: string) {
    if (this.peerConnections.has(userId)) this.disconnectFromPeer(userId);
    const pc = new RTCPeerConnection(this.config);
    this.peerConnections.set(userId, pc);
    if (this.localStream) this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));

    pc.ontrack = (event) => {
      let audio = this.audioElements.get(userId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        if (this.currentOutputDeviceId !== 'default' && typeof (audio as any).setSinkId === 'function')
          (audio as any).setSinkId(this.currentOutputDeviceId).catch(console.error);
        const savedVolume = useAppStore.getState().userVolumes[userId];
        if (savedVolume !== undefined) audio.volume = savedVolume / 100;
        this.audioElements.set(userId, audio);
      }
      audio.srcObject = event.streams[0];
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) signalRService.sendIceCandidate(userId, JSON.stringify(event.candidate));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.disconnectFromPeer(userId);
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signalRService.sendWebRTCOffer(userId, JSON.stringify(offer));
    } catch {
      this.disconnectFromPeer(userId);
    }
  }

  public async handleOffer(senderId: string, offerStr: string) {
    if (this.peerConnections.has(senderId)) this.disconnectFromPeer(senderId);
    const offer = JSON.parse(offerStr);
    const pc = new RTCPeerConnection(this.config);
    this.peerConnections.set(senderId, pc);
    if (this.localStream) this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream!));

    pc.ontrack = (event) => {
      let audio = this.audioElements.get(senderId);
      if (!audio) {
        audio = new Audio();
        audio.autoplay = true;
        if (this.currentOutputDeviceId !== 'default' && typeof (audio as any).setSinkId === 'function')
          (audio as any).setSinkId(this.currentOutputDeviceId).catch(console.error);
        const savedVolume = useAppStore.getState().userVolumes[senderId];
        if (savedVolume !== undefined) audio.volume = savedVolume / 100;
        this.audioElements.set(senderId, audio);
      }
      audio.srcObject = event.streams[0];
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) signalRService.sendIceCandidate(senderId, JSON.stringify(event.candidate));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.disconnectFromPeer(senderId);
    };
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      signalRService.sendWebRTCAnswer(senderId, JSON.stringify(answer));
    } catch {
      this.disconnectFromPeer(senderId);
    }
  }

  public async handleAnswer(senderId: string, answerStr: string) {
    const pc = this.peerConnections.get(senderId);
    if (pc) {
      try { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerStr))); } catch {}
    }
  }

  public async handleIceCandidate(senderId: string, candidateStr: string) {
    const pc = this.peerConnections.get(senderId);
    if (pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(candidateStr))); } catch {}
    }
  }

  public disconnectFromPeer(userId: string) {
    const pc = this.peerConnections.get(userId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
      this.peerConnections.delete(userId);
    }
    const audio = this.audioElements.get(userId);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      this.audioElements.delete(userId);
    }
  }

  public leaveAll() {
    this.peerConnections.forEach((_, id) => this.disconnectFromPeer(id));
  }
}

export const webrtc = new WebRTCManager();