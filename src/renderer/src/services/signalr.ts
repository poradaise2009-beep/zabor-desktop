import * as signalR from '@microsoft/signalr';
import { useAppStore, User, VoiceChannel, ChannelUpdate, UserStateUpdate, IncomingCall } from '../store/useAppStore';
import { webrtc } from './webrtc';

const SERVER_URL = "http://150.241.64.108:8080/zabor_v3";

class SignalRService {
  private connection: signalR.HubConnection | null = null;
  private listenersAttached = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectGraceTimer: NodeJS.Timeout | null = null;
  private isReconnecting = false;
  private intentionalDisconnect = false;
  private pingInterval: NodeJS.Timeout | null = null;
  private currentPing: number = 0;
  private lastSpeakingState: boolean | null = null;
  private wasInChannel: string | null = null;

  private sfxContext: AudioContext | null = null;

  private pingCallbacks: Set<(ping: number) => void> = new Set();
  private connectionCallbacks: Set<(isConnected: boolean) => void> = new Set();

  public isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }

  public getPing(): number { return this.currentPing; }

  public onPingUpdate(callback: (ping: number) => void): () => void {
    this.pingCallbacks.add(callback);
    return () => this.pingCallbacks.delete(callback);
  }

  public onConnectionUpdate(callback: (isConnected: boolean) => void): () => void {
    this.connectionCallbacks.add(callback);
    callback(this.isConnected());
    return () => this.connectionCallbacks.delete(callback);
  }

  private notifyPingUpdate(ping: number) {
    this.currentPing = ping;
    this.pingCallbacks.forEach(cb => cb(ping));
  }

  private notifyConnectionUpdate(isConnected: boolean) {
    this.connectionCallbacks.forEach(cb => cb(isConnected));
  }

  private getSfxContext(masterGain: number): { ctx: AudioContext; master: GainNode } | null {
    try {
      if (!this.sfxContext) {
        this.sfxContext = new AudioContext();
      }
      if (this.sfxContext.state === 'suspended') {
        this.sfxContext.resume().catch(() => {});
      }
      const ctx = this.sfxContext;
      const master = ctx.createGain();
      master.gain.value = masterGain;
      master.connect(ctx.destination);
      return { ctx, master };
    } catch {
      return null;
    }
  }

  private startPingMeasurement() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    const measurePing = async () => {
      if (!this.isConnected()) { this.notifyPingUpdate(-1); return; }
      try {
        const start = performance.now();
        await this.connection!.invoke("Ping");
        this.notifyPingUpdate(Math.round(performance.now() - start));
      } catch {
        this.notifyPingUpdate(-1);
      }
    };
    measurePing();
    this.pingInterval = setInterval(measurePing, 5000);
  }

  private stopPingMeasurement() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  public async connect(): Promise<boolean> {
    if (this.isConnected()) return true;
    if (this.isReconnecting) {
      await new Promise(r => setTimeout(r, 500));
      return this.isConnected();
    }

    this.intentionalDisconnect = false;
    this.isReconnecting = true;

    try {
      if (this.connection) {
        try { await this.connection.stop(); } catch {}
      }

      this.connection = new signalR.HubConnectionBuilder()
        .withUrl(SERVER_URL, {
          skipNegotiation: false,
          transport: signalR.HttpTransportType.WebSockets | signalR.HttpTransportType.LongPolling
        })
        .withAutomaticReconnect([0, 1000, 2000, 5000, 5000, 10000, 10000, 30000, 30000])
        .build();

      this.setupListeners();
      this.setupReconnectionHandlers();
      await this.connection.start();

      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.startPingMeasurement();
      this.notifyConnectionUpdate(true);
      return true;
    } catch {
      this.isReconnecting = false;
      this.notifyPingUpdate(-1);
      this.notifyConnectionUpdate(false);
      this.scheduleReconnect();
      return false;
    }
  }

  private setupReconnectionHandlers() {
    if (!this.connection) return;

    this.connection.onreconnecting(() => {
      if (this.intentionalDisconnect) return;

      this.isReconnecting = true;
      this.notifyPingUpdate(-1);

      const store = useAppStore.getState();
      if (store.currentChannelId) {
        this.wasInChannel = store.currentChannelId;
      }

      if (!this.reconnectGraceTimer) {
        this.reconnectGraceTimer = setTimeout(() => {
          this.reconnectGraceTimer = null;
          if (this.isReconnecting) {
            this.notifyConnectionUpdate(false);
          }
        }, 5000);
      }
    });

    this.connection.onreconnected(async () => {
      this.reconnectAttempts = 0;
      this.isReconnecting = false;

      if (this.reconnectGraceTimer) {
        clearTimeout(this.reconnectGraceTimer);
        this.reconnectGraceTimer = null;
      }

      this.startPingMeasurement();
      this.notifyConnectionUpdate(true);

      const store = useAppStore.getState();
      const user = store.currentUser;

      if (user) {
        try {
          const raw = await window.windowControls.loadSession();
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed.login && parsed.password) {
              await this.connection!.invoke("Login", parsed.login, parsed.password);
              await this.loadData();
            }
          }
        } catch {}
      }

      const channelToRejoin = this.wasInChannel || store.currentChannelId;
      this.wasInChannel = null;

      if (channelToRejoin) {
        this.rejoinChannel(channelToRejoin);
      }
    });

    this.connection.onclose(() => {
      this.isReconnecting = false;
      this.notifyPingUpdate(-1);
      this.stopPingMeasurement();

      if (!this.intentionalDisconnect) {
        const store = useAppStore.getState();
        if (store.currentChannelId) {
          this.wasInChannel = store.currentChannelId;
        }

        if (!this.reconnectGraceTimer) {
          this.reconnectGraceTimer = setTimeout(() => {
            this.reconnectGraceTimer = null;
            this.notifyConnectionUpdate(false);
          }, 5000);
        }

        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.intentionalDisconnect) return;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, 5000);
  }

  private async rejoinChannel(channelId: string) {
    try {
      await this.safeInvoke("LeaveChannel");
      await this.joinChannel(channelId);
    } catch {}
  }

  public disconnect() {
    this.intentionalDisconnect = true;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
    this.lastSpeakingState = null;
    this.wasInChannel = null;
    this.stopPingMeasurement();

    if (this.reconnectGraceTimer) { clearTimeout(this.reconnectGraceTimer); this.reconnectGraceTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }

    if (this.connection) {
      this.connection.stop();
      this.connection = null;
      this.listenersAttached = false;
    }

    if (this.sfxContext) {
      this.sfxContext.close().catch(() => {});
      this.sfxContext = null;
    }
  }

  private setupListeners() {
    if (!this.connection || this.listenersAttached) return;
    this.listenersAttached = true;
    const store = useAppStore.getState;

    this.connection.on("SyncFullChannelState", (stateMap: Record<string, User[]>) => {
      store().setFullChannelState(stateMap);
    });

    this.connection.on("UserJoined", (user: User) =>
      store().updateUserStatus(user.id, { isOnline: true })
    );

    this.connection.on("UserLeft", (userId: string) => {
      store().updateUserStatus(userId, { isOnline: false });
      store().setVoiceUsers(store().voiceUsers.filter(u => u.id !== userId));
      store().removeUserFromChannelMap('', userId);
      webrtc.disconnectFromPeer(userId);
    });

    this.connection.on("UserUpdated", (user: User) => {
      if (store().currentUser?.id === user.id)
        store().setCurrentUser({ ...store().currentUser!, ...user });
      store().updateUserStatus(user.id, user);
    });

    this.connection.on("UserJoinedChannel", (user: User, channelId?: string) => {
      if (channelId) store().addUserToChannelMap(channelId, user);

      if (channelId && store().currentChannelId === channelId && user.id !== store().currentUser?.id) {
        const currentUsers = store().voiceUsers;
        if (!currentUsers.find(u => u.id === user.id)) {
          store().setVoiceUsers([...currentUsers, user]);
        }
        webrtc.connectToPeer(user.id);
      }
    });

    this.connection.on("UserLeftChannel", (userId: string, channelId?: string) => {
      store().setVoiceUsers(store().voiceUsers.filter(u => u.id !== userId));
      store().removeUserFromChannelMap(channelId || '', userId);
      webrtc.disconnectFromPeer(userId);
    });

    this.connection.on("ChannelCreated", (channel: VoiceChannel) => {
      const channels = store().channels;
      if (!channels.find(c => c.id === channel.id)) store().setChannels([...channels, channel]);
    });

    this.connection.on("ChannelUpdated", (channel: VoiceChannel) => {
      store().setChannels(store().channels.map(c => c.id === channel.id ? channel : c));
    });

    this.connection.on("ChannelDeleted", (channelId: string) => {
      store().setChannels(store().channels.filter(c => c.id !== channelId));
      if (store().currentChannelId === channelId) this.leaveChannel();
      if (store().selectedChannelForMembers?.id === channelId) store().setModal('channelMembers', false);
    });

    this.connection.on("ForceLeaveVoice", () => { this.leaveChannel(); });

    this.connection.on("UserStateChanged", (update: UserStateUpdate) => {
      store().updateUserStatus(update.userId, {
        isMuted: update.isMuted ?? false,
        isDeafened: update.isDeafened ?? false,
        isSpeaking: update.isSpeaking ?? false
      });
    });

    this.connection.on("UserSpeaking", (userId: string, isSpeaking: boolean) => {
      store().setSpeakingStatus(userId, isSpeaking);
    });

    this.connection.on("FriendRequestReceived", (user: User) => {
      if (!store().friendRequests.find(r => r.id === user.id)) {
        store().setFriendRequests([...store().friendRequests, user]);
        this.playNotificationSound();
      }
    });

    this.connection.on("FriendRequestAccepted", (user: User) => {
      if (!store().friends.find(f => f.id === user.id))
        store().setFriends([...store().friends, user]);
    });

    this.connection.on("FriendAdded", (user: User) => {
      if (!store().friends.find(f => f.id === user.id))
        store().setFriends([...store().friends, user]);
      store().setFriendRequests(store().friendRequests.filter(r => r.id !== user.id));
    });

    this.connection.on("FriendRemoved", (userId: string) =>
      store().setFriends(store().friends.filter(f => f.id !== userId))
    );

    this.connection.on("ReceiveChannelInvite", (senderId: string, senderName: string, channelId: string, channelName: string) => {
      if (!store().channelInvites.find(i => i.channelId === channelId)) {
        store().setChannelInvites([...store().channelInvites, { senderId, senderName, channelId, channelName }]);
        this.playNotificationSound();
      }
    });

    this.connection.on("IncomingCall", (call: IncomingCall) => {
      store().setIncomingCall(call);
      store().setModal('incomingCall', true);
      this.playRingtone();
    });

    this.connection.on("CallAccepted", (user: User) => {
      store().setCurrentCallUser(user);
      store().setCallStatus('connected');
      store().setIncomingCall(null);
      store().setModal('incomingCall', false);
      this.stopRingtone();
      webrtc.connectToPeer(user.id);
    });

    this.connection.on("CallDeclined", () => {
      store().setCallStatus('idle');
      store().setIncomingCall(null);
      store().setModal('incomingCall', false);
      store().setCurrentCallUser(null);
      this.stopRingtone();
    });

    this.connection.on("CallEnded", () => {
      const callUser = store().currentCallUser;
      if (callUser) webrtc.disconnectFromPeer(callUser.id);
      store().setCurrentCallUser(null);
      store().setCallStatus('idle');
      this.stopRingtone();
    });

    this.connection.on("CallStarted", (user: User) => {
      store().setCurrentCallUser(user);
      store().setCallStatus('connected');
      store().setIncomingCall(null);
      store().setModal('incomingCall', false);
      this.stopRingtone();
      webrtc.connectToPeer(user.id);
    });

    this.connection.on("AchievementUnlocked", (achievementId: string) => {
      store().setAchievementToast(achievementId);

      setTimeout(() => {
        store().setAchievementToast('__hiding__' + achievementId);
      }, 4500);
      setTimeout(() => store().setAchievementToast(null), 5000);

      try {
        const sfx = this.getSfxContext(0.25);
        if (!sfx) throw new Error('no sfx context');
        const { ctx, master } = sfx;

        const notes1 = [
          { freq: 523.25, time: 0 },
          { freq: 659.25, time: 0.07 },
          { freq: 783.99, time: 0.14 },
          { freq: 1046.50, time: 0.21 },
        ];

        const notes2 = [
          { freq: 659.25, time: 0.45 },
          { freq: 783.99, time: 0.52 },
          { freq: 1046.50, time: 0.59 },
          { freq: 1318.51, time: 0.66 },
        ];

        [...notes1, ...notes2].forEach(({ freq, time }) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(master);
          osc.type = 'square';
          osc.frequency.value = freq;
          const t = ctx.currentTime + time;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(0.6, t + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
          osc.start(t);
          osc.stop(t + 0.5);

          const osc2 = ctx.createOscillator();
          const gain2 = ctx.createGain();
          osc2.connect(gain2);
          gain2.connect(master);
          osc2.type = 'sine';
          osc2.frequency.value = freq * 2;
          gain2.gain.setValueAtTime(0, t);
          gain2.gain.linearRampToValueAtTime(0.15, t + 0.01);
          gain2.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
          osc2.start(t);
          osc2.stop(t + 0.3);
        });
      } catch {}

      const currentData = store().achievementsData;
      if (currentData && !store().achievementsViewUserId) {
        const updated = {
          ...currentData,
          unlockedIds: [...(currentData.unlockedIds || []), achievementId]
        };
        store().setAchievementsData(updated);
      }
    });

    this.connection.on("ReceiveWebRTCOffer", async (sId: string, o: string) => await webrtc.handleOffer(sId, o));
    this.connection.on("ReceiveWebRTCAnswer", async (sId: string, a: string) => await webrtc.handleAnswer(sId, a));
    this.connection.on("ReceiveIceCandidate", async (sId: string, c: string) => await webrtc.handleIceCandidate(sId, c));

    this.connection.on("ForceLogout", async () => {
      try {
        await window.windowControls.clearSession();
        await window.windowControls.wipeAppData();
      } catch {}

      const appStore = useAppStore.getState();
      appStore.setCurrentUser(null);
      appStore.setChannels([]);
      appStore.setFriends([]);
      appStore.setFriendRequests([]);
      appStore.setChannelInvites([]);
      appStore.setVoiceUsers([]);
      appStore.setCurrentChannelId(null);
      appStore.setCallStatus('idle');
      appStore.setCurrentCallUser(null);
      appStore.setFullChannelState({});

      window.location.reload();
    });

    window.windowControls?.onBeforeQuit?.(() => {
      this.disconnect();
    });
  }

  private notificationAudio: HTMLAudioElement | null = null;
  private ringtoneInterval: NodeJS.Timeout | null = null;

  private playNotificationSound() {
    try {
      if (!this.notificationAudio) {
        this.notificationAudio = new Audio('data:audio/wav;base64,UklGRl9vT19XQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU' + 'A'.repeat(100));
        this.notificationAudio.volume = 0.5;
      }
      const sfx = this.getSfxContext(1);
      if (!sfx) return;
      const { ctx, master } = sfx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(master);
      osc.frequency.value = 800;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch {}
  }

  private playRingtone() {
    this.stopRingtone();
    const playMelody = () => {
      try {
        const sfx = this.getSfxContext(0.15);
        if (!sfx) return;
        const { ctx, master } = sfx;
        const up = [
          { freq: 587.33, time: 0 },
          { freq: 739.99, time: 0.12 },
          { freq: 880.00, time: 0.24 },
          { freq: 1174.66, time: 0.36 },
        ];
        const down = [
          { freq: 1174.66, time: 0.6 },
          { freq: 880.00, time: 0.72 },
          { freq: 739.99, time: 0.84 },
          { freq: 587.33, time: 0.96 },
        ];
        [...up, ...down].forEach(({ freq, time }) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(master);
          osc.type = 'sine';
          osc.frequency.value = freq;
          const t = ctx.currentTime + time;
          gain.gain.setValueAtTime(0, t);
          gain.gain.linearRampToValueAtTime(1, t + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.01, t + 0.3);
          osc.start(t);
          osc.stop(t + 0.3);
        });
      } catch {}
    };
    playMelody();
    this.ringtoneInterval = setInterval(playMelody, 3000);
  }

  private stopRingtone() {
    if (this.ringtoneInterval) { clearInterval(this.ringtoneInterval); this.ringtoneInterval = null; }
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.isConnected()) return true;
    for (let i = 0; i < 3; i++) {
      const connected = await this.connect();
      if (connected) return true;
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  private async safeInvoke<T>(method: string, ...args: any[]): Promise<T | null> {
    if (!await this.ensureConnected()) return null;
    try { return await this.connection!.invoke<T>(method, ...args); }
    catch { return null; }
  }

  public async checkUserExists(username: string): Promise<boolean> {
    return await this.safeInvoke<boolean>("CheckUserExists", username) ?? false;
  }

  public async login(username: string, password: string): Promise<boolean> {
    const user = await this.safeInvoke<User>("Login", username, password);
    if (user) {
      useAppStore.getState().setCurrentUser(user);
      await this.loadData();
      return true;
    }
    return false;
  }

  public async register(username: string, password: string, displayName: string, avatarBase64: string | null, avatarColor: string): Promise<boolean> {
    const user = await this.safeInvoke<User>("Register", username, password, displayName, avatarBase64, avatarColor);
    if (user) {
      useAppStore.getState().setCurrentUser(user);
      await this.loadData();
      return true;
    }
    return false;
  }

  public async updateProfile(displayName: string, avatarBase64: string | null, avatarColor: string): Promise<void> {
    await this.safeInvoke("UpdateProfile", displayName, avatarBase64, avatarColor);
  }

  public async changePassword(newPassword: string): Promise<boolean> {
    return await this.safeInvoke<boolean>("UpdateUserPassword", newPassword) ?? false;
  }

  public async saveAudioSettings(settings: {
    inputVolume: number;
    outputVolume: number;
    selectedInput: string;
    selectedOutput: string;
    noiseSuppression: boolean;
  }): Promise<void> {
    await this.safeInvoke("SaveAudioSettings", JSON.stringify(settings));
  }

  public async loadAudioSettings(): Promise<{
    inputVolume: number;
    outputVolume: number;
    selectedInput: string;
    selectedOutput: string;
    noiseSuppression: boolean;
  } | null> {
    const json = await this.safeInvoke<string>("GetAudioSettings");
    if (json) {
      try { return JSON.parse(json); } catch { return null; }
    }
    return null;
  }

  public async getMyAchievements(): Promise<any> {
    const json = await this.safeInvoke<string>("GetMyAchievements");
    if (json) {
      try {
        const raw = JSON.parse(json);
        return {
          stats: raw.Stats || raw.stats || {},
          unlockedIds: raw.UnlockedIds || raw.unlockedIds || [],
          visitedChannelIds: raw.VisitedChannelIds || raw.visitedChannelIds || [],
        };
      } catch {}
    }
    return { stats: {}, unlockedIds: [], visitedChannelIds: [] };
  }

  public async getUserAchievements(userId: string): Promise<any> {
    const json = await this.safeInvoke<string>("GetUserAchievements", userId);
    if (json) {
      try {
        const raw = JSON.parse(json);
        return {
          stats: raw.Stats || raw.stats || {},
          unlockedIds: raw.UnlockedIds || raw.unlockedIds || [],
          visitedChannelIds: raw.VisitedChannelIds || raw.visitedChannelIds || [],
        };
      } catch {}
    }
    return { stats: {}, unlockedIds: [], visitedChannelIds: [] };
  }

  public async viewProfile(userId: string): Promise<void> {
    await this.safeInvoke("ViewProfile", userId);
  }

  public async getJokeOfTheDay(): Promise<string> {
    return await this.safeInvoke<string>("GetJokeOfTheDay") ?? '';
  }

  public async loadData(): Promise<void> {
    const [channels, friends, requests] = await Promise.all([
      this.safeInvoke<VoiceChannel[]>("GetChannels"),
      this.safeInvoke<User[]>("GetFriends"),
      this.safeInvoke<User[]>("GetFriendRequests")
    ]);
    useAppStore.getState().setChannels(channels || []);
    useAppStore.getState().setFriends(friends || []);
    useAppStore.getState().setFriendRequests(requests || []);
  }

  public async createChannel(name: string): Promise<void> { await this.safeInvoke("CreateChannel", name); }
  public async updateChannel(id: string, name: string): Promise<void> { await this.safeInvoke("UpdateChannel", { channelId: id, name }); }
  public async quitAccessChannel(channelId: string): Promise<void> { await this.safeInvoke("QuitAccessChannel", channelId); }
  public async kickFromChannel(channelId: string, userId: string): Promise<void> { await this.safeInvoke("KickFromChannel", channelId, userId); }
  public async getChannelMembersList(channelId: string): Promise<User[]> { return await this.safeInvoke<User[]>("GetChannelMembersList", channelId) || []; }
  public async sendChannelInvite(targetUserId: string, channelId: string, channelName: string): Promise<void> { await this.safeInvoke("SendChannelInvite", targetUserId, channelId, channelName); }

  public async joinChannel(channelId: string): Promise<boolean> {
    if (!await this.ensureConnected()) return false;

    const store = useAppStore.getState();
    const currentUser = store.currentUser;
    if (!currentUser) return false;

    const optimisticUser: User = {
      ...currentUser,
      currentChannelId: channelId,
      isSpeaking: false,
    };

    const prevChannelId = store.currentChannelId;
    const prevVoiceUsers = store.voiceUsers;
    const prevChannelUsersMap = { ...store.channelUsersMap };

    const existingUsers = store.channelUsersMap[channelId] || [];
    const allUsers = existingUsers.find(u => u.id === currentUser.id)
      ? existingUsers
      : [...existingUsers, optimisticUser];

    store.setCurrentChannelId(channelId);
    store.setVoiceUsers(allUsers);
    store.setChannelUsers(channelId, allUsers);

    webrtc.leaveAll();
    store.setCallStatus('idle');
    store.setCurrentCallUser(null);

    try {
      const micStarted = await webrtc.startLocalStream();
      if (!micStarted) {
        this.rollbackChannelJoin(prevChannelId, prevVoiceUsers, prevChannelUsersMap);
        alert("Не удалось получить доступ к микрофону. Проверьте настройки Windows.");
        return false;
      }

      const update = await this.safeInvoke<ChannelUpdate>("JoinChannel", { channelId });

      if (update && update.users) {
        store.setVoiceUsers(update.users);
        store.setChannelUsers(channelId, update.users);
        const currentUserId = currentUser.id;
        update.users.forEach((u: User) => { if (u.id !== currentUserId) webrtc.connectToPeer(u.id); });
        return true;
      } else {
        this.rollbackChannelJoin(prevChannelId, prevVoiceUsers, prevChannelUsersMap);
        webrtc.stopLocalStream();
        return false;
      }
    } catch {
      this.rollbackChannelJoin(prevChannelId, prevVoiceUsers, prevChannelUsersMap);
      webrtc.stopLocalStream();
      return false;
    }
  }

  private rollbackChannelJoin(
    prevChannelId: string | null,
    prevVoiceUsers: User[],
    prevChannelUsersMap: Record<string, User[]>
  ) {
    const store = useAppStore.getState();
    store.setCurrentChannelId(prevChannelId);
    store.setVoiceUsers(prevVoiceUsers);
    store.setFullChannelState(prevChannelUsersMap);
  }

  public async leaveChannel(): Promise<void> {
    webrtc.stopLocalStream();
    await this.safeInvoke("LeaveChannel");
    useAppStore.getState().setCurrentChannelId(null);
    useAppStore.getState().setVoiceUsers([]);
  }

  public async sendFriendRequest(username: string): Promise<boolean> { return await this.safeInvoke<boolean>("SendFriendRequest", username) ?? false; }

  public async acceptFriendRequest(userId: string): Promise<void> {
    await this.safeInvoke("AcceptFriendRequest", userId);
    const store = useAppStore.getState();
    store.setFriendRequests(store.friendRequests.filter(r => r.id !== userId));
  }

  public async declineFriendRequest(userId: string): Promise<void> {
    await this.safeInvoke("DeclineFriendRequest", userId);
    const store = useAppStore.getState();
    store.setFriendRequests(store.friendRequests.filter(r => r.id !== userId));
  }

  public async removeFriend(userId: string): Promise<void> {
    await this.safeInvoke("RemoveFriend", userId);
    const store = useAppStore.getState();
    store.setFriends(store.friends.filter(f => f.id !== userId));
  }

  public async startCall(targetUserId: string): Promise<boolean> {
    useAppStore.getState().setCallStatus('calling');
    const targetUser = useAppStore.getState().friends.find(f => f.id === targetUserId);
    if (targetUser) useAppStore.getState().setCurrentCallUser(targetUser);
    if (useAppStore.getState().currentChannelId) await this.leaveChannel();

    const micStarted = await webrtc.startLocalStream();
    if (!micStarted) {
      useAppStore.getState().setCallStatus('idle');
      useAppStore.getState().setCurrentCallUser(null);
      return false;
    }

    const res = await this.safeInvoke<boolean>("StartCall", targetUserId);
    if (!res) {
      useAppStore.getState().setCallStatus('idle');
      useAppStore.getState().setCurrentCallUser(null);
      webrtc.stopLocalStream();
    }
    return res ?? false;
  }

  public async acceptCall(callerId: string): Promise<void> {
    if (useAppStore.getState().currentChannelId) await this.leaveChannel();
    const micStarted = await webrtc.startLocalStream();
    if (!micStarted) return;
    await this.safeInvoke("AcceptCall", callerId);
    useAppStore.getState().setModal('incomingCall', false);
    this.stopRingtone();
  }

  public async declineCall(callerId: string): Promise<void> {
    await this.safeInvoke("DeclineCall", callerId);
    useAppStore.getState().setIncomingCall(null);
    useAppStore.getState().setModal('incomingCall', false);
    this.stopRingtone();
  }

  public async endCall(): Promise<void> {
    const callUser = useAppStore.getState().currentCallUser;
    if (callUser) webrtc.disconnectFromPeer(callUser.id);
    webrtc.stopLocalStream();
    await this.safeInvoke("EndCall");
    useAppStore.getState().setCurrentCallUser(null);
    useAppStore.getState().setCallStatus('idle');
  }

  public toggleState(isMuted: boolean, isDeafened: boolean): void {
    webrtc.toggleMute(isMuted);
    if (this.isConnected()) this.connection?.send("UpdateUserState", { isMuted, isDeafened });
  }

  public setSpeakingState(isSpeaking: boolean): void {
    if (isSpeaking === this.lastSpeakingState) return;
    this.lastSpeakingState = isSpeaking;
    if (this.isConnected()) this.connection?.send("SetSpeakingState", isSpeaking);
  }

  public sendWebRTCOffer(targetId: string, offer: string): void {
    if (this.isConnected()) this.connection?.send("SendWebRTCOffer", targetId, offer);
  }

  public sendWebRTCAnswer(targetId: string, answer: string): void {
    if (this.isConnected()) this.connection?.send("SendWebRTCAnswer", targetId, answer);
  }

  public sendIceCandidate(targetId: string, candidate: string): void {
    if (this.isConnected()) this.connection?.send("SendIceCandidate", targetId, candidate);
  }

  // ==========================================
  // ADMIN
  // ==========================================
  public async isCurrentUserAdmin(): Promise<boolean> {
    return await this.safeInvoke<boolean>("IsCurrentUserAdmin") ?? false;
  }

  public async adminGetAllUsers(): Promise<any[]> {
    return await this.safeInvoke<any[]>("AdminGetAllUsers") ?? [];
  }

  public async adminUpdateUser(payload: {
    userId: string;
    displayName?: string;
    password?: string;
  }): Promise<boolean> {
    return await this.safeInvoke<boolean>("AdminUpdateUser", payload) ?? false;
  }

  public async adminDeleteUser(userId: string): Promise<boolean> {
    return await this.safeInvoke<boolean>("AdminDeleteUser", { userId }) ?? false;
  }

    public async adminGetUserDetails(userId: string): Promise<any | null> {
    return await this.safeInvoke<any>("AdminGetUserDetails", userId);
  }

    public async adminUpdateAchievements(payload: {
    userId: string;
    unlockedIds: string[];
    stats: Record<string, number>;
  }): Promise<boolean> {
    return await this.safeInvoke<boolean>("AdminUpdateAchievements", payload) ?? false;
  }

  public async adminKickFromCurrentChannel(userId: string): Promise<boolean> {
  return await this.safeInvoke<boolean>("AdminKickFromCurrentChannel", { userId }) ?? false;
}

public async adminSetGlobalVoiceState(payload: {
  userId: string;
  isMuted?: boolean;
  isDeafened?: boolean;
}): Promise<boolean> {
  return await this.safeInvoke<boolean>("AdminSetGlobalVoiceState", payload) ?? false;
}

public async adminRenameChannel(channelId: string, name: string): Promise<boolean> {
  return await this.safeInvoke<boolean>("AdminRenameChannel", { channelId, name }) ?? false;
}

}

export const signalRService = new SignalRService();