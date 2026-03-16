import { create } from 'zustand';

export interface User {
  id: string; username: string; displayName: string; avatarBase64: string | null; avatarColor: string;
  isOnline: boolean; isMuted: boolean; isDeafened: boolean; isSpeaking: boolean;
  currentChannelId?: string | null; currentCallUserId?: string | null; lastSeen?: string;
}

export interface VoiceChannel { id: string; name: string; ownerId: string; maxUsers?: number; createdAt?: string; }
export interface ChannelInvite { senderId: string; senderName: string; channelId: string; channelName: string; }
export interface UserStateUpdate { userId: string; isMuted?: boolean; isDeafened?: boolean; isSpeaking?: boolean; }
export interface ChannelUpdate { channel: VoiceChannel; users: User[]; }
export interface IncomingCall { callerId: string; callerName: string; callerAvatarColor: string; }

interface AppState {
  currentUser: User | null; channels: VoiceChannel[]; friends: User[]; friendRequests: User[]; channelInvites: ChannelInvite[]; voiceUsers: User[]; currentChannelId: string | null;
  channelUsersMap: Record<string, User[]>;
  channelMembers: User[]; selectedChannelForMembers: VoiceChannel | null; userToKick: User | null;
  incomingCall: IncomingCall | null; currentCallUser: User | null; callStatus: 'idle' | 'calling' | 'connected';

  isJoiningChannel: boolean;
  userVolumes: Record<string, number>;
  pendingChannelSwitch: string | null;
  setPendingChannelSwitch: (channelId: string | null) => void;

  // Achievements
  achievementToast: string | null;
  achievementsData: { stats: Record<string, number>; unlockedIds: string[] } | null;
  achievementsViewUserId: string | null;
  setAchievementToast: (id: string | null) => void;
  setAchievementsData: (data: { stats: Record<string, number>; unlockedIds: string[] } | null) => void;
  setAchievementsViewUserId: (id: string | null) => void;

  setCurrentUser: (user: User | null) => void;
  setChannels: (channels: VoiceChannel[]) => void;
  setFriends: (friends: User[]) => void;
  setFriendRequests: (reqs: User[]) => void;
  setChannelInvites: (invites: ChannelInvite[]) => void;
  setVoiceUsers: (users: User[]) => void;
  setCurrentChannelId: (id: string | null) => void;
  setIsJoiningChannel: (isJoining: boolean) => void;

  setChannelUsers: (channelId: string, users: User[]) => void;
  setFullChannelState: (stateMap: Record<string, User[]>) => void;
  addUserToChannelMap: (channelId: string, user: User) => void;
  removeUserFromChannelMap: (channelId: string, userId: string) => void;

  setChannelMembers: (users: User[]) => void;
  setSelectedChannelForMembers: (ch: VoiceChannel | null) => void;
  setUserToKick: (u: User | null) => void;

  setIncomingCall: (call: IncomingCall | null) => void;
  setCurrentCallUser: (user: User | null) => void;
  setCallStatus: (status: 'idle' | 'calling' | 'connected') => void;
  setUserVolume: (userId: string, volume: number) => void;

  updateUserStatus: (userId: string, updates: Partial<User>) => void;
  setSpeakingStatus: (userId: string, isSpeaking: boolean) => void;

  modals: {
    settings: boolean; privacy: boolean; addFriend: boolean; createChannel: boolean;
    profile: boolean; inviteToChannel: boolean; channelEdit: boolean; userVolume: boolean;
    incomingCall: boolean; channelFull: boolean; channelMembers: boolean; kickConfirm: boolean;
    channelSwitch: boolean; achievements: boolean;
  };
  setModal: (modalName: keyof AppState['modals'], isOpen: boolean) => void;
  closeAllModals: () => void;
  closeProfileOnly: () => void;

  selectedProfileUser: User | null; setSelectedProfileUser: (user: User | null) => void;
  selectedChannelForInvite: VoiceChannel | null; setSelectedChannelForInvite: (ch: VoiceChannel | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentUser: null, channels: [], friends: [], friendRequests: [], channelInvites: [], voiceUsers: [],
  currentChannelId: null, channelUsersMap: {}, channelMembers: [], selectedChannelForMembers: null,
  userToKick: null, incomingCall: null, currentCallUser: null, callStatus: 'idle',
  isJoiningChannel: false, userVolumes: {},

  // Achievements
  achievementToast: null,
  achievementsData: null,
  achievementsViewUserId: null,
  setAchievementToast: (id) => set({ achievementToast: id }),
  setAchievementsData: (data) => set({ achievementsData: data }),
  setAchievementsViewUserId: (id) => set({ achievementsViewUserId: id }),

  setCurrentUser: (user) => set({ currentUser: user }),
  setChannels: (channels) => set({ channels }),
  setFriends: (friends) => set({ friends }),
  setFriendRequests: (reqs) => set({ friendRequests: reqs }),
  setChannelInvites: (invites) => set({ channelInvites: invites }),
  setVoiceUsers: (users) => set({ voiceUsers: users }),
  setCurrentChannelId: (id) => set({ currentChannelId: id }),
  setIsJoiningChannel: (isJoining) => set({ isJoiningChannel: isJoining }),

  pendingChannelSwitch: null,
  setPendingChannelSwitch: (channelId) => set({ pendingChannelSwitch: channelId }),

  setChannelUsers: (channelId, users) => set((state) => ({
    channelUsersMap: { ...state.channelUsersMap, [channelId]: [...users] }
  })),
  setFullChannelState: (stateMap) => set({ channelUsersMap: stateMap }),

  addUserToChannelMap: (channelId, user) => set((state) => {
    const list = state.channelUsersMap[channelId];
    if (list?.some(u => u.id === user.id)) return state;
    return {
      channelUsersMap: {
        ...state.channelUsersMap,
        [channelId]: [...(list || []), user],
      },
    };
  }),

  removeUserFromChannelMap: (channelId, userId) => set((state) => {
    if (channelId) {
      const list = state.channelUsersMap[channelId];
      if (!list || !list.some(u => u.id === userId)) return state;
      return {
        channelUsersMap: {
          ...state.channelUsersMap,
          [channelId]: list.filter(u => u.id !== userId),
        },
      };
    }
    let changed = false;
    const newMap: Record<string, User[]> = {};
    for (const [key, users] of Object.entries(state.channelUsersMap)) {
      const filtered = users.filter(u => u.id !== userId);
      if (filtered.length !== users.length) changed = true;
      newMap[key] = filtered;
    }
    return changed ? { channelUsersMap: newMap } : state;
  }),

  setChannelMembers: (users) => set({ channelMembers: users }),
  setSelectedChannelForMembers: (ch) => set({ selectedChannelForMembers: ch }),
  setUserToKick: (u) => set({ userToKick: u }),
  setIncomingCall: (call) => set({ incomingCall: call }),
  setCurrentCallUser: (user) => set({ currentCallUser: user }),
  setCallStatus: (status) => set({ callStatus: status }),
  setUserVolume: (userId, volume) => set((state) => ({ userVolumes: { ...state.userVolumes, [userId]: volume } })),

  setSpeakingStatus: (userId, isSpeaking) => set((state) => ({
    voiceUsers: state.voiceUsers.map(u => u.id === userId ? { ...u, isSpeaking } : u),
    currentCallUser: state.currentCallUser?.id === userId ? { ...state.currentCallUser, isSpeaking } : state.currentCallUser,
    currentUser: state.currentUser?.id === userId ? { ...state.currentUser, isSpeaking } : state.currentUser
  })),

  updateUserStatus: (userId, updates) => set((state) => {
    const hasChannelMapChanges = Object.values(state.channelUsersMap)
      .some(users => users.some(u => u.id === userId));

    const mapCopy = hasChannelMapChanges
      ? Object.fromEntries(
          Object.entries(state.channelUsersMap).map(([chId, users]) => [
            chId,
            users.some(u => u.id === userId)
              ? users.map(u => u.id === userId ? { ...u, ...updates } : u)
              : users,
          ])
        )
      : state.channelUsersMap;

    return {
      voiceUsers: state.voiceUsers.map(u => u.id === userId ? { ...u, ...updates } : u),
      friends: state.friends.map(u => u.id === userId ? { ...u, ...updates } : u),
      channelMembers: state.channelMembers.map(u => u.id === userId ? { ...u, ...updates } : u),
      currentUser: state.currentUser?.id === userId ? { ...state.currentUser, ...updates } : state.currentUser,
      currentCallUser: state.currentCallUser?.id === userId ? { ...state.currentCallUser, ...updates } : state.currentCallUser,
      channelUsersMap: mapCopy,
    };
  }),

  modals: {
    settings: false, privacy: false, addFriend: false, createChannel: false,
    profile: false, inviteToChannel: false, channelEdit: false, userVolume: false,
    incomingCall: false, channelFull: false, channelMembers: false, kickConfirm: false,
    channelSwitch: false, achievements: false,
  },
  setModal: (name, isOpen) => set((state) => ({ modals: { ...state.modals, [name]: isOpen } })),
  closeAllModals: () => set({
    modals: {
      settings: false, privacy: false, addFriend: false, createChannel: false,
      profile: false, inviteToChannel: false, channelEdit: false, userVolume: false,
      incomingCall: false, channelFull: false, channelMembers: false, kickConfirm: false,
      channelSwitch: false, achievements: false,
    },
    pendingChannelSwitch: null
  }),
  closeProfileOnly: () => set((state) => ({ modals: { ...state.modals, profile: false } })),

  selectedProfileUser: null, setSelectedProfileUser: (user) => set({ selectedProfileUser: user }),
  selectedChannelForInvite: null, setSelectedChannelForInvite: (ch) => set({ selectedChannelForInvite: ch })
}));