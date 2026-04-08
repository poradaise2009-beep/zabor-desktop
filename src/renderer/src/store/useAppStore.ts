import { create } from 'zustand';

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarBase64: string;
  avatarColor: string;
  isOnline: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking?: boolean;
  isServerMuted?: boolean;
  isServerDeafened?: boolean;
  isGlobalMuted?: boolean;
  isBot?: boolean;
  currentChannelId?: string | null;
  currentCallUserId?: string | null;
}

export interface VoiceChannel {
  id: string;
  name: string;
  ownerId: string;
}

export interface ChannelUpdate {
  channelId: string;
  name: string;
  users?: User[];
}

export interface ChannelInvite {
  senderId: string;
  senderName: string;
  channelId: string;
  channelName: string;
}

export interface IncomingCall {
  callerId: string;
  callerName: string;
  callerAvatarBase64: string;
  callerAvatarColor: string;
  channelId: string;
  channelName: string;
}

interface AppState {
  currentUser: User | null;
  channels: VoiceChannel[];
  friends: User[];
  friendRequests: User[];
  channelInvites: ChannelInvite[];
  voiceUsers: User[];
  currentChannelId: string | null;
  isJoiningChannel: boolean;
  userVolumes: Record<string, number>;
  pendingChannelSwitch: string | null;
  setPendingChannelSwitch: (channelId: string | null) => void;

  isInitialSyncDone: boolean;
  setInitialSyncDone: (done: boolean) => void;
  isDataReady: boolean;
  setDataReady: (done: boolean) => void;

  achievementToast: string | null;
  achievementsData: { stats: Record<string, number>; unlockedIds: string[] } | null;
  achievementsViewUserId: string | null;
  setAchievementToast: (id: string | null) => void;
  setAchievementsData: (data: { stats: Record<string, number>; unlockedIds: string[] } | null) => void;
  setAchievementsViewUserId: (id: string | null) => void;

  joke: string;
  setJoke: (joke: string) => void;
  isAdmin: boolean;
  setIsAdmin: (isAdmin: boolean) => void;

  setCurrentUser: (user: User | null) => void;
  setChannels: (channels: VoiceChannel[]) => void;
  setFriends: (friends: User[]) => void;
  setFriendRequests: (reqs: User[]) => void;
  setChannelInvites: (invites: ChannelInvite[]) => void;
  setVoiceUsers: (users: User[]) => void;
  setCurrentChannelId: (id: string | null) => void;
  setIsJoiningChannel: (isJoining: boolean) => void;

  channelUsersMap: Record<string, User[]>;
  setChannelUsers: (channelId: string, users: User[]) => void;
  setFullChannelState: (stateMap: Record<string, User[]>) => void;
  addUserToChannelMap: (channelId: string, user: User) => void;
  removeUserFromChannelMap: (channelId: string, userId: string) => void;

  channelMembers: User[];
  setChannelMembers: (users: User[]) => void;
  selectedChannelForMembers: VoiceChannel | null;
  setSelectedChannelForMembers: (ch: VoiceChannel | null) => void;
  userToKick: User | null;
  setUserToKick: (u: User | null) => void;

  incomingCall: IncomingCall | null;
  setIncomingCall: (call: IncomingCall | null) => void;
  currentCallUser: User | null;
  setCurrentCallUser: (user: User | null) => void;
  callStatus: 'idle' | 'calling' | 'connected';
  setCallStatus: (status: 'idle' | 'calling' | 'connected') => void;
  setUserVolume: (userId: string, volume: number) => void;

  updateUserStatus: (userId: string, updates: Partial<User>) => void;
  setSpeakingStatus: (userId: string, isSpeaking: boolean) => void;

  modals: {
    settings: boolean;
    privacy: boolean;
    addFriend: boolean;
    createChannel: boolean;
    profile: boolean;
    inviteToChannel: boolean;
    channelEdit: boolean;
    userVolume: boolean;
    incomingCall: boolean;
    channelFull: boolean;
    channelMembers: boolean;
    kickConfirm: boolean;
    channelSwitch: boolean;
    achievements: boolean;
    adminConsole: boolean;
    adminUserSettings: boolean;
  };
  setModal: (modalName: keyof AppState['modals'], isOpen: boolean) => void;
  closeAllModals: () => void;
  closeProfileOnly: () => void;

  selectedProfileUser: User | null;
  profileSource: 'friends' | 'channelMembers' | 'voiceUsers' | 'none';
  setSelectedProfileUser: (user: User | null, source?: 'friends' | 'channelMembers' | 'voiceUsers' | 'none') => void;

  selectedChannelForInvite: VoiceChannel | null;
  setSelectedChannelForInvite: (ch: VoiceChannel | null) => void;
}

const updateUserInList = (list: User[], userId: string, updates: Partial<User>): User[] => {
  let changed = false;
  const next = list.map(user => {
    if (user.id !== userId) return user;
    changed = true;
    return { ...user, ...updates };
  });
  return changed ? next : list;
};

export const useAppStore = create<AppState>((set) => ({
  currentUser: null,
  channels: [],
  friends: [],
  friendRequests: [],
  channelInvites: [],
  voiceUsers: [],
  currentChannelId: null,

  channelUsersMap: {},

  channelMembers: [],
  selectedChannelForMembers: null,
  userToKick: null,

  incomingCall: null,
  currentCallUser: null,
  callStatus: 'idle',

  isJoiningChannel: false,
  userVolumes: {},

  pendingChannelSwitch: null,
  setPendingChannelSwitch: (channelId) => set({ pendingChannelSwitch: channelId }),

  isInitialSyncDone: false,
  setInitialSyncDone: (done) => set({ isInitialSyncDone: done }),
  isDataReady: false,
  setDataReady: (done) => set({ isDataReady: done }),

  achievementToast: null,
  achievementsData: null,
  achievementsViewUserId: null,
  setAchievementToast: (id) => set({ achievementToast: id }),
  setAchievementsData: (data) => set({ achievementsData: data }),
  setAchievementsViewUserId: (id) => set({ achievementsViewUserId: id }),

  joke: '',
  setJoke: (joke) => set({ joke }),
  isAdmin: false,
  setIsAdmin: (isAdmin) => set({ isAdmin }),

  setCurrentUser: (user) => set({ currentUser: user }),
  setChannels: (channels) => set({ channels }),
  setFriends: (friends) => set({ friends }),
  setFriendRequests: (reqs) => set({ friendRequests: reqs }),
  setChannelInvites: (invites) => set({ channelInvites: invites }),
  setVoiceUsers: (users) => set({ voiceUsers: users }),
  setCurrentChannelId: (id) => set({ currentChannelId: id }),
  setIsJoiningChannel: (isJoining) => set({ isJoiningChannel: isJoining }),

  setChannelUsers: (channelId, users) => set((state) => ({
    channelUsersMap: { ...state.channelUsersMap, [channelId]: [...users] },
    voiceUsers: state.currentChannelId === channelId ? [...users] : state.voiceUsers
  })),

  setFullChannelState: (stateMap) => set((state) => {
    const currentChannelId = state.currentChannelId;
    const currentChannelUsers = currentChannelId ? (stateMap[currentChannelId] || []) : [];
    return {
      channelUsersMap: stateMap,
      voiceUsers: currentChannelId ? currentChannelUsers : state.voiceUsers
    };
  }),

  addUserToChannelMap: (channelId, user) => set((state) => {
    const current = state.channelUsersMap[channelId] || [];
    if (current.some(u => u.id === user.id)) return state;
    const next = [...current, user];
    return {
      channelUsersMap: { ...state.channelUsersMap, [channelId]: next },
      voiceUsers: state.currentChannelId === channelId ? next : state.voiceUsers
    };
  }),

  removeUserFromChannelMap: (channelId, userId) => set((state) => {
    const current = state.channelUsersMap[channelId] || [];
    const next = current.filter(u => u.id !== userId);
    return {
      channelUsersMap: { ...state.channelUsersMap, [channelId]: next },
      voiceUsers: state.currentChannelId === channelId ? next : state.voiceUsers
    };
  }),

  setChannelMembers: (users) => set({ channelMembers: users }),
  setSelectedChannelForMembers: (ch) => set({ selectedChannelForMembers: ch }),
  setUserToKick: (u) => set({ userToKick: u }),

  setIncomingCall: (call) => set({ incomingCall: call }),
  setCurrentCallUser: (user) => set({ currentCallUser: user }),
  setCallStatus: (status) => set({ callStatus: status }),

  setUserVolume: (userId, volume) => set((state) => ({
    userVolumes: { ...state.userVolumes, [userId]: volume }
  })),

  updateUserStatus: (userId, updates) => set((state) => {
    const nextFriends = updateUserInList(state.friends, userId, updates);
    const nextChannelMembers = updateUserInList(state.channelMembers, userId, updates);
    const nextVoiceUsers = updateUserInList(state.voiceUsers, userId, updates);

    const nextCCU = (state.currentCallUser && state.currentCallUser.id === userId)
      ? { ...state.currentCallUser, ...updates }
      : state.currentCallUser;

    const nextMap = { ...state.channelUsersMap };
    let mapChanged = false;
    Object.keys(nextMap).forEach(cid => {
      const list = nextMap[cid];
      const nextList = updateUserInList(list, userId, updates);
      if (nextList !== list) {
        nextMap[cid] = nextList;
        mapChanged = true;
      }
    });

    const nextCurrentUser = (state.currentUser && state.currentUser.id === userId)
      ? { ...state.currentUser, ...updates }
      : state.currentUser;

    return {
      friends: nextFriends,
      channelMembers: nextChannelMembers,
      voiceUsers: nextVoiceUsers,
      currentCallUser: nextCCU,
      channelUsersMap: mapChanged ? nextMap : state.channelUsersMap,
      currentUser: nextCurrentUser
    };
  }),

  setSpeakingStatus: (userId, isSpeaking) => set((state) => ({
    voiceUsers: state.voiceUsers.map(u => u.id === userId ? { ...u, isSpeaking } : u),
    currentCallUser: (state.currentCallUser && state.currentCallUser.id === userId)
      ? { ...state.currentCallUser, isSpeaking }
      : state.currentCallUser
  })),

  modals: {
    settings: false,
    privacy: false,
    addFriend: false,
    createChannel: false,
    profile: false,
    inviteToChannel: false,
    channelEdit: false,
    userVolume: false,
    incomingCall: false,
    channelFull: false,
    channelMembers: false,
    kickConfirm: false,
    channelSwitch: false,
    achievements: false,
    adminConsole: false,
    adminUserSettings: false,
  },
  setModal: (name, isOpen) => set((state) => ({
    modals: { ...state.modals, [name]: isOpen }
  })),
  closeAllModals: () => set((state) => ({
    modals: Object.keys(state.modals).reduce((acc, key) => ({ ...acc, [key]: false }), {} as any)
  })),
  closeProfileOnly: () => set((state) => ({
    modals: { ...state.modals, profile: false }
  })),

  selectedProfileUser: null,
  profileSource: 'none',
  setSelectedProfileUser: (user, source = 'none') => set({
    selectedProfileUser: user,
    profileSource: source
  }),

  selectedChannelForInvite: null,
  setSelectedChannelForInvite: (ch) => set({ selectedChannelForInvite: ch }),
}));