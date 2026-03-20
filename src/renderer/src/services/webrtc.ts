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
  private _inputVolume: number = 100;
  private _outputVolume: number = 100;
  private _isDeafened: boolean = false;

  private processedContext: AudioContext | null = null;
  private inputGainNode: GainNode | null = null;

  private vadContext: AudioContext | null = null;
  private speakingIntervals: Map<string, { timer: NodeJS.Timeout; stream: MediaStream }> = new Map();

  private config: RTCConfiguration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ]
  };

  // ==========================================
  // OPUS SDP MUNGING
  // ==========================================
  private mungeOpusSDP(sdp: string): string {
    const lines = sdp.split('\r\n');
    let opusPT: string | null = null;

    for (const line of lines) {
      const m = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
      if (m) { opusPT = m[1]; break; }
    }
    if (!opusPT) return sdp;

    const result: string[] = [];
    let fmtpReplaced = false;

    for (const line of lines) {
      let out = line;

      if (line.startsWith('m=audio')) {
        const parts = line.split(' ');
        const header = parts.slice(0, 3);
        const payloads = parts.slice(3).filter(p => p !== opusPT);
        out = [...header, opusPT, ...payloads].join(' ');
      }

      if (line.startsWith(`a=fmtp:${opusPT}`)) {
        out = `a=fmtp:${opusPT} minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=128000;sprop-maxcapturerate=48000;stereo=0;cbr=0`;
        fmtpReplaced = true;
      }

      result.push(out);
    }

    if (!fmtpReplaced) {
      const idx = result.findIndex(l => l.startsWith(`a=rtpmap:${opusPT}`));
      if (idx >= 0) {
        result.splice(idx + 1, 0,
          `a=fmtp:${opusPT} minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=128000;sprop-maxcapturerate=48000;stereo=0;cbr=0`
        );
      }
    }

    return result.join('\r\n');
  }

  // ==========================================
  // АУДИО ПАЙПЛАЙН (без RNNoise — браузерный NS)
  // ==========================================
  private async createProcessedStream(rawStream: MediaStream): Promise<MediaStream> {
    this.cleanupProcessedStream();

    const ctx = new AudioContext({ sampleRate: 48000 });
    this.processedContext = ctx;

    const source = ctx.createMediaStreamSource(rawStream);

    const inputGain = ctx.createGain();
    inputGain.gain.value = this._inputVolume / 100;
    this.inputGainNode = inputGain;

    const highPass = ctx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 80;
    highPass.Q.value = 0.7;

    const lowPass = ctx.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 7500;
    lowPass.Q.value = 0.5;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -24;
    compressor.knee.value = 12;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.15;

    const dest = ctx.createMediaStreamDestination();

    source.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(compressor);
    compressor.connect(inputGain);
    inputGain.connect(dest);

    return dest.stream;
  }

  private cleanupProcessedStream() {
    if (this.processedContext && this.processedContext.state !== 'closed') {
      this.processedContext.close().catch(() => {});
    }
    this.processedContext = null;
    this.inputGainNode = null;
  }

  // ==========================================
  // VOLUME / DEAFEN
  // ==========================================
  public setInputVolume(volume: number) {
    this._inputVolume = volume;
    if (this.inputGainNode) this.inputGainNode.gain.value = volume / 100;
  }

  public setOutputVolume(volume: number) {
    this._outputVolume = volume;
    this.audioElements.forEach((_, userId) => this.updateRemoteVolume(userId));
  }

  public setDeafened(isDeafened: boolean) {
    this._isDeafened = isDeafened;
    this.audioElements.forEach(audio => { audio.muted = isDeafened; });
  }

  private updateRemoteVolume(userId: string) {
    const audio = this.audioElements.get(userId);
    if (!audio) return;
    const userVol = useAppStore.getState().userVolumes[userId] ?? 100;
    audio.volume = Math.max(0, Math.min(1, (this._outputVolume / 100) * (userVol / 100)));
  }

  // ==========================================
  // VAD
  // ==========================================
  private setupVAD(stream: MediaStream, userId: string, isLocal: boolean) {
    this.clearVAD(userId);
    try {
      if (!this.vadContext || this.vadContext.state === 'closed') {
        this.vadContext = new AudioContext();
      }
      if (this.vadContext.state === 'suspended') this.vadContext.resume();

      const cloned = new MediaStream(stream.getAudioTracks());
      const source = this.vadContext.createMediaStreamSource(cloned);

      const lowCut = this.vadContext.createBiquadFilter();
      lowCut.type = 'highpass';
      lowCut.frequency.value = 85;
      lowCut.Q.value = 0.5;

      const highCut = this.vadContext.createBiquadFilter();
      highCut.type = 'lowpass';
      highCut.frequency.value = 1100;
      highCut.Q.value = 0.5;

      const analyzer = this.vadContext.createAnalyser();
      analyzer.fftSize = 512;
      analyzer.smoothingTimeConstant = 0.4;

      source.connect(lowCut);
      lowCut.connect(highCut);
      highCut.connect(analyzer);

      const data = new Uint8Array(analyzer.frequencyBinCount);
      const threshold = isLocal ? 40 : 10;
      let lastSpoke = 0;
      let wasSpeaking = false;

      const check = () => {
        const store = useAppStore.getState();
        if (isLocal && store.currentUser?.isMuted) {
          if (wasSpeaking) {
            wasSpeaking = false;
            store.setSpeakingStatus(userId, false);
            signalRService.setSpeakingState(false);
          }
          return;
        }

        analyzer.getByteFrequencyData(data);
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
        const rms = Math.sqrt(sumSq / data.length);

        if (rms > threshold) lastSpoke = Date.now();
        const speaking = (Date.now() - lastSpoke) < 300;

        if (speaking !== wasSpeaking) {
          wasSpeaking = speaking;
          store.setSpeakingStatus(userId, speaking);
          if (isLocal) signalRService.setSpeakingState(speaking);
        }
      };

      const timer = setInterval(check, 20);
      this.speakingIntervals.set(userId, { timer, stream: cloned });
    } catch {}
  }

  private clearVAD(userId: string) {
    const entry = this.speakingIntervals.get(userId);
    if (entry) {
      clearInterval(entry.timer);
      entry.stream.getTracks().forEach(t => { t.stop(); t.enabled = false; });
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
    } catch { return { inputs: [], outputs: [] }; }
  }

  public setInputDevice(deviceId: string) { this.currentDeviceId = deviceId; }

  public setOutputDevice(deviceId: string) {
    this.currentOutputDeviceId = deviceId;
    this.audioElements.forEach(audio => {
      if (typeof (audio as any).setSinkId === 'function')
        (audio as any).setSinkId(deviceId).catch(() => {});
    });
  }

  // ==========================================
  // ЛОКАЛЬНЫЙ СТРИМ
  // ==========================================
  public async startLocalStream(deviceId?: string, useNoiseSuppression?: boolean): Promise<boolean> {
    if (deviceId !== undefined) this.currentDeviceId = deviceId;
    if (useNoiseSuppression !== undefined) this.noiseSuppression = useNoiseSuppression;

    try {
      if (this.rawStream) { this.rawStream.getTracks().forEach(t => t.stop()); this.rawStream = null; }
      if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null; }
      this.cleanupProcessedStream();

      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: this.currentDeviceId !== 'default' ? { exact: this.currentDeviceId } : undefined,
          sampleRate: 48000,
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: this.noiseSuppression,
          sampleSize: 16
        },
        video: false
      });

      this.rawStream = rawStream;
      this.localStream = await this.createProcessedStream(rawStream);

      const me = useAppStore.getState().currentUser;
      if (me) this.setupVAD(this.rawStream!, me.id, true);

      return true;
    } catch { return false; }
  }

  public async updateSettings(deviceId: string, useNoiseSuppression: boolean) {
    this.currentDeviceId = deviceId;
    this.noiseSuppression = useNoiseSuppression;

    if (this.localStream) {
      await this.startLocalStream(deviceId, useNoiseSuppression);
      this.peerConnections.forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
        if (sender && this.localStream) sender.replaceTrack(this.localStream.getAudioTracks()[0]);
      });
    }
  }

  public stopLocalStream() {
    const me = useAppStore.getState().currentUser;
    if (me) this.clearVAD(me.id);

    if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null; }
    if (this.rawStream) { this.rawStream.getTracks().forEach(t => t.stop()); this.rawStream = null; }
    this.cleanupProcessedStream();
    this.leaveAll();
  }

  public toggleMute(isMuted: boolean) {
    if (this.localStream) this.localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  }

  public setUserVolume(userId: string, volume: number) {
    useAppStore.getState().setUserVolume(userId, volume);
    this.updateRemoteVolume(userId);
  }

  // ==========================================
  // PEER CONNECTIONS
  // ==========================================
  private createAudioElement(userId: string): HTMLAudioElement {
    let audio = this.audioElements.get(userId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      if (this.currentOutputDeviceId !== 'default' && typeof (audio as any).setSinkId === 'function')
        (audio as any).setSinkId(this.currentOutputDeviceId).catch(() => {});
      audio.muted = this._isDeafened;
      this.audioElements.set(userId, audio);
    }
    this.updateRemoteVolume(userId);
    return audio;
  }

  private setupPeerHandlers(pc: RTCPeerConnection, userId: string) {
    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      const audio = this.createAudioElement(userId);
      audio.srcObject = remoteStream;

      // VAD для удалённого пользователя — чтобы у нас загоралась его обводка
      this.setupVAD(remoteStream, userId, false);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) signalRService.sendIceCandidate(userId, JSON.stringify(event.candidate));
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        this.disconnectFromPeer(userId);
      }
    };
  }

  public async connectToPeer(userId: string) {
    if (this.peerConnections.has(userId)) this.disconnectFromPeer(userId);

    const pc = new RTCPeerConnection(this.config);
    this.peerConnections.set(userId, pc);

    if (this.localStream) this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream!));

    this.setupPeerHandlers(pc, userId);

    try {
      const offer = await pc.createOffer();
      const munged = new RTCSessionDescription({ type: 'offer', sdp: this.mungeOpusSDP(offer.sdp!) });
      await pc.setLocalDescription(munged);
      signalRService.sendWebRTCOffer(userId, JSON.stringify(pc.localDescription));
    } catch {
      this.disconnectFromPeer(userId);
    }
  }

  public async handleOffer(senderId: string, offerStr: string) {
    if (this.peerConnections.has(senderId)) this.disconnectFromPeer(senderId);

    const pc = new RTCPeerConnection(this.config);
    this.peerConnections.set(senderId, pc);

    if (this.localStream) this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream!));

    this.setupPeerHandlers(pc, senderId);

    try {
      const offer = JSON.parse(offerStr);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      const answer = await pc.createAnswer();
      const munged = new RTCSessionDescription({ type: 'answer', sdp: this.mungeOpusSDP(answer.sdp!) });
      await pc.setLocalDescription(munged);
      signalRService.sendWebRTCAnswer(senderId, JSON.stringify(pc.localDescription));
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
    this.clearVAD(userId);
  }

  public leaveAll() {
    this.peerConnections.forEach((_, id) => this.disconnectFromPeer(id));
  }
}

export const webrtc = new WebRTCManager();