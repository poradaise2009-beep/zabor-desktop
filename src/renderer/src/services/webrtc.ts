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
  private rnnoiseDestroy: (() => void) | null = null;

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
  // OPUS SDP MUNGING — 48kHz Fullband
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
  // АУДИО ПАЙПЛАЙН
  // ==========================================
  private async createProcessedStream(rawStream: MediaStream): Promise<MediaStream> {
    this.cleanupProcessedStream();

    const ctx = new AudioContext({ sampleRate: 48000 });
    this.processedContext = ctx;

    const inputGain = ctx.createGain();
    inputGain.gain.value = this._inputVolume / 100;
    this.inputGainNode = inputGain;

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

    if (this.noiseSuppression) {
      try {
        const { createRNNoiseProcessor } = await import('./rnnoise-processor');
        const result = await createRNNoiseProcessor(ctx, rawStream);
        this.rnnoiseDestroy = result.destroy;

        const source = ctx.createMediaStreamSource(result.stream);
        source.connect(highPass);
        highPass.connect(compressor);
        compressor.connect(inputGain);
        inputGain.connect(dest);
        return dest.stream;
      } catch {}
    }

    // Fallback
    const source = ctx.createMediaStreamSource(rawStream);
    const lowPass = ctx.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = 12000;
    lowPass.Q.value = 0.7;

    source.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(compressor);
    compressor.connect(inputGain);
    inputGain.connect(dest);

    return dest.stream;
  }

  private cleanupProcessedStream() {
    if (this.rnnoiseDestroy) { this.rnnoiseDestroy(); this.rnnoiseDestroy = null; }
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
    audio.volume = Math.min(1, (this._outputVolume / 100) * (userVol / 100));
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

      // Фильтруем только речевые частоты (300-3000Hz)
      // Это отсекает клики клавиатуры (высокочастотные транзиенты)
      const bandpass = this.vadContext.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 1000;  // Центр полосы
      bandpass.Q.value = 0.5;           // Широкая полоса 300-3000Hz

      const analyzer = this.vadContext.createAnalyser();
      analyzer.fftSize = 512;
      analyzer.smoothingTimeConstant = 0.6; // Сглаживание — игнорирует короткие всплески

      const cloned = new MediaStream(stream.getAudioTracks());
      const source = this.vadContext.createMediaStreamSource(cloned);
      source.connect(bandpass);
      bandpass.connect(analyzer);

      const data = new Uint8Array(analyzer.frequencyBinCount);
      let lastSpoke = 0;
      let wasSpeaking = false;
      let sustainCount = 0; // Счётчик последовательных фреймов с голосом

      const check = () => {
        const store = useAppStore.getState();
        if (isLocal && store.currentUser?.isMuted) {
          if (wasSpeaking) {
            wasSpeaking = false;
            sustainCount = 0;
            store.setSpeakingStatus(userId, false);
            signalRService.setSpeakingState(false);
          }
          return;
        }

        analyzer.getByteFrequencyData(data);

        // Считаем среднюю энергию только в речевом диапазоне
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;

        const threshold = isLocal ? 40 : 20;
if (avg > threshold) {
          sustainCount++;
          // Голос должен держаться минимум 3 фрейма (150мс) чтобы сработать
          if (sustainCount >= 3) {
            lastSpoke = Date.now();
          }
        } else {
          sustainCount = Math.max(0, sustainCount - 1);
        }

        const speaking = (Date.now() - lastSpoke) < 400;

        if (speaking !== wasSpeaking) {
          wasSpeaking = speaking;
          store.setSpeakingStatus(userId, speaking);
          if (isLocal) signalRService.setSpeakingState(speaking);
        }
      };

      const timer = setInterval(check, 50);
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
          noiseSuppression: true,
          sampleSize: 16
        },
        video: false
      });

      this.rawStream = rawStream;
      this.localStream = await this.createProcessedStream(rawStream);

      const me = useAppStore.getState().currentUser;
      if (me) this.setupVAD(this.localStream, me.id, true);

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
      const audio = this.createAudioElement(userId);
      audio.srcObject = event.streams[0];
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) signalRService.sendIceCandidate(userId, JSON.stringify(event.candidate));
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
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
    // Валидация: принимаем только от пользователей в том же канале/звонке
    const store = useAppStore.getState();
    const inChannel = store.currentChannelId && store.voiceUsers.some(u => u.id === senderId);
    const inCall = store.currentCallUser?.id === senderId;
    if (!inChannel && !inCall) return;

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