import { api, refreshAccessToken, uploadFile } from './axiosClient';
import { API } from '../config';
import type { Attachment, AuthSessionInfo, ChatMessage, ConversationSettings, Favorite, FriendRequest, Group, GroupJoinRequest, GroupMember, SessionPayload, User, UserSettings } from '../types';

/**
 * Typed API surface. Every call is a *thin* declaration — all resilience
 * (tokens, races, dedup, limiting, retry, refresh) lives in axiosClient.
 */

export const authApi = {
  /** `rememberMe` extends the (cookie-held) refresh lifetime to 30 days. */
  register: (body: { username: string; password: string; nickname?: string; rememberMe?: boolean }) =>
    api.post<SessionPayload>('/api/auth/register', body),

  login: (body: { username: string; password: string; rememberMe?: boolean }) =>
    api.post<SessionPayload>('/api/auth/login', body),

  logout: () => api.post<{ ok: boolean }>('/api/auth/logout'),

  /** Restores a soft-deleted account within the cooling window. */
  restore: (body: { username: string; password: string }) => api.post<SessionPayload>('/api/auth/restore', body),

  /** Both fields optional; `avatar: null` clears it back to the initials mark. */
  updateProfile: (body: { nickname?: string; avatar?: string | null; bio?: string | null }) =>
    api.patch<{ user: User; peersNotified: number }>('/api/auth/me', body),

  changePassword: (body: { oldPassword: string; newPassword: string }) =>
    api.post<{ ok: boolean }>('/api/auth/password', body),

  /** Soft-delete (注销) the account; requires the password to confirm. */
  deleteAccount: (password: string) => api.del<{ ok: boolean; coolingDays: number }>('/api/auth/me', { data: { password } }),

  sessions: () => api.get<{ sessions: AuthSessionInfo[] }>('/api/auth/sessions'),

  revokeSession: (sessionId: string) => api.del<{ sessionId: string; revoked: boolean }>(`/api/auth/sessions/${sessionId}`),

  revokeOtherSessions: () => api.post<{ ok: boolean }>('/api/auth/sessions/revoke-others'),
};

/**
 * Adding a friend has two possible outcomes: a pending request was created, or
 * the peer had already requested us and the friendship was established
 * immediately. The backend discriminates them so the UI can react correctly.
 */
export type SendFriendRequestResult =
  | { outcome: 'requested'; request: FriendRequest }
  | { outcome: 'auto-accepted'; friend: User };

export const friendApi = {
  list: () => api.get<{ friends: User[] }>('/api/friends'),

  /** `signal` lets the caller abort a superseded search-as-you-type request. */
  search: (keyword: string, signal?: AbortSignal) =>
    api.get<{ users: User[] }>('/api/friends/search', { params: { q: keyword }, signal }),

  requests: () => api.get<{ requests: FriendRequest[] }>('/api/friends/requests'),

  sendRequest: (toUserId: number, message?: string) =>
    api.post<SendFriendRequestResult>('/api/friends/requests', { toUserId, message }),

  respond: (requestId: number, action: 'accept' | 'reject') =>
    api.post<{ ok: boolean; status: string; friend?: User }>(`/api/friends/requests/${requestId}/${action}`),

  /**
   * One-way removal: drops only my own friend row. The peer keeps me and the
   * thread stays usable in both directions. Idempotent (`removed: false` when
   * they were not in my list).
   */
  remove: (friendId: number) => api.del<{ friendId: number; removed: boolean }>(`/api/friends/${friendId}`),

  /** Private per-friend alias (备注). Empty/null clears it. */
  setRemark: (friendId: number, remark: string | null) =>
    api.patch<{ friendId: number; remark: string | null }>(`/api/friends/${friendId}`, { remark }),

  blocks: () => api.get<{ blocks: Array<User & { blockedAt: string }> }>('/api/friends/blocks'),

  block: (userId: number) => api.post<{ userId: number; blocked: boolean }>('/api/friends/blocks', { userId }),

  unblock: (userId: number) => api.del<{ userId: number; removed: boolean }>(`/api/friends/blocks/${userId}`),

  inviteLinks: () =>
    api.get<{ links: Array<{ token: string; expiresAt: string; revoked: boolean }> }>('/api/friends/invite-links'),

  createInviteLink: () => api.post<{ token: string; expiresAt: string }>('/api/friends/invite-links'),

  revokeInviteLink: (token: string) => api.del<{ token: string; revoked: boolean }>(`/api/friends/invite-links/${token}`),
};

export const settingsApi = {
  get: () => api.get<{ settings: UserSettings }>('/api/settings'),
  update: (patch: Partial<UserSettings>) => api.patch<{ settings: UserSettings }>('/api/settings', patch),
};

export const reportApi = {
  create: (body: { targetType: 'user' | 'group' | 'message'; targetId: number; reason: string; detail?: string }) =>
    api.post<{ id: number; status: string }>('/api/reports', body),
  mine: () => api.get<{ reports: Array<Record<string, unknown>> }>('/api/reports/mine'),
};

/** Media descriptor attached to an outgoing image/file/voice message. */
export interface OutgoingMedia {
  type: 'image' | 'file' | 'voice';
  attachmentId: number;
}

export const messageApi = {
  /** "Source A" of the dual-source strategy: stored history over HTTP. */
  history: (friendId: number, beforeId = 0, limit = 50) =>
    api.get<{ peer: User; messages: ChatMessage[]; settings?: ConversationSettings }>('/api/messages/history', {
      params: { friendId, beforeId, limit },
    }),

  /** HTTP send path (1:1), used when the socket is unavailable. */
  send: (toUserId: number, content: string, clientMsgId: string, media?: OutgoingMedia, quoteId?: number) =>
    api.post<{ message: ChatMessage }>('/api/messages', {
      toUserId,
      content,
      clientMsgId,
      ...(quoteId ? { quoteId } : {}),
      ...(media ?? {}),
    }),

  /** HTTP send path (group). Mirrors the WS `chat:send` payload. */
  sendToGroup: (
    groupId: number,
    content: string,
    clientMsgId: string,
    mentions: number[] = [],
    media?: OutgoingMedia,
    quoteId?: number
  ) =>
    api.post<{ message: ChatMessage }>('/api/messages', {
      groupId,
      content,
      clientMsgId,
      mentions,
      ...(quoteId ? { quoteId } : {}),
      ...(media ?? {}),
    }),

  read: (ids: number[]) => api.post<{ ok: boolean; updated: number }>('/api/messages/read', { ids }),

  /** 撤回 (2-minute window enforced server-side). */
  recall: (messageId: number) => api.post<{ ok: boolean; message: ChatMessage }>(`/api/messages/${messageId}/recall`),

  /** 逐条转发 to friends and/or groups. */
  forward: (messageId: number, targetUserIds: number[], targetGroupIds: number[] = []) =>
    api.post<{ forwarded: number; messages: ChatMessage[] }>(`/api/messages/${messageId}/forward`, {
      targetUserIds,
      targetGroupIds,
    }),

  /** Local delete (my view only). */
  remove: (messageId: number) => api.del<{ ok: boolean; messageId: number }>(`/api/messages/${messageId}`),

  /** Clear my history for one conversation. */
  clearConversation: (peerKind: 'direct' | 'group', peerId: number) =>
    api.post<{ ok: boolean }>(`/api/messages/conversation/clear`, { peerKind, peerId }),

  /** In-conversation search. `from`/`to` (ISO) bound a date window. */
  search: (params: { friendId?: number; groupId?: number; q?: string; from?: string; to?: string }) =>
    api.get<{ messages: ChatMessage[] }>('/api/messages/search', { params }),

  // NB: incremental polling (`GET /api/messages/poll`) is deliberately NOT
  // wrapped here. It is owned by the realtime engine, which runs inside a
  // SharedWorker where this module cannot load (no localStorage, no axios).
  // The engine performs that call with `fetch` + a bearer token directly.
};

/** Pin / mute / clear per conversation. */
export const conversationApi = {
  list: () => api.get<{ conversations: ConversationSettings[] }>('/api/conversations'),
  update: (peerKind: 'direct' | 'group', peerId: number, patch: { pinned?: boolean; muted?: boolean }) =>
    api.patch<{ settings: ConversationSettings }>(`/api/conversations/${peerKind}/${peerId}`, patch),
};

/** 收藏 (saved messages). */
export const favoriteApi = {
  list: () => api.get<{ favorites: Favorite[] }>('/api/favorites'),
  add: (messageId: number, srcConversation?: string) =>
    api.post<{ favorite: Favorite }>('/api/favorites', { messageId, srcConversation }),
  remove: (id: number) => api.del<{ id: number; removed: boolean }>(`/api/favorites/${id}`),
};

/** Web Push subscriptions. */
export const pushApi = {
  publicKey: () => api.get<{ enabled: boolean; publicKey: string }>('/api/push/public-key'),
  subscribe: (subscription: PushSubscriptionJSON) => api.post<{ ok: boolean }>('/api/push/subscribe', { subscription }),
  unsubscribe: (endpoint: string) => api.post<{ ok: boolean }>('/api/push/unsubscribe', { endpoint }),
};

/** Uploads an image/file/voice and returns its metadata (referenced when sending). */
export const attachmentApi = {
  upload: (file: File, onProgress?: (percent: number) => void, kind?: 'voice') =>
    uploadFile<{ attachment: Attachment }>('/api/attachments', file, onProgress, kind ? { kind } : undefined),
};

/**
 * Absolute URL for an attachment's bytes. `<img>`/downloads cannot send an
 * Authorization header, so the access token rides along as `?token=`.
 */
export const attachmentRawUrl = (id: number, token: string | null): string =>
  `${API.base}/api/attachments/${id}/raw${token ? `?token=${encodeURIComponent(token)}` : ''}`;

/** Group lifecycle + messaging REST surface (direct-add / WeChat-style). */
export const groupApi = {
  list: () => api.get<{ groups: Group[] }>('/api/groups'),

  create: (name: string, memberIds: number[]) =>
    api.post<{ group: Group }>('/api/groups', { name, memberIds }),

  /** Find groups by 群号 (exact) or name (substring); excludes groups I'm in. */
  search: (keyword: string, signal?: AbortSignal) =>
    api.get<{ groups: Group[] }>('/api/groups/search', { params: { q: keyword }, signal }),

  /** Apply to join (QQ-style). Notifies the owner. */
  requestJoin: (groupId: number, message?: string) =>
    api.post<{ id: number; groupId: number; status: string }>(`/api/groups/${groupId}/join-requests`, { message }),

  /** Pending applications for a group (owner only). */
  joinRequests: (groupId: number) =>
    api.get<{ requests: GroupJoinRequest[] }>(`/api/groups/${groupId}/join-requests`),

  respondJoin: (groupId: number, requestId: number, action: 'approve' | 'reject') =>
    api.post<{ ok: boolean; status: string }>(`/api/groups/${groupId}/join-requests/${requestId}/${action}`),

  detail: (groupId: number) => api.get<{ group: Group; members: GroupMember[] }>(`/api/groups/${groupId}`),

  update: (groupId: number, patch: { name?: string; avatar?: string | null; announcement?: string | null; joinApproval?: boolean }) =>
    api.patch<{ group: Group }>(`/api/groups/${groupId}`, patch),

  /** Set my in-group nickname (null clears it). */
  setGroupNickname: (groupId: number, nickname: string | null) =>
    api.patch<{ groupId: number; groupNickname: string | null }>(`/api/groups/${groupId}/members/me`, { nickname }),

  /** Owner appoints/demotes an admin. */
  setMemberRole: (groupId: number, userId: number, role: 'admin' | 'member') =>
    api.patch<{ groupId: number; memberId: number; role: string }>(`/api/groups/${groupId}/members/${userId}/role`, { role }),

  /** Files shared in the group. */
  files: (groupId: number) =>
    api.get<{ files: Array<{ messageId: number; attachmentId: number; name: string; size: number; mime: string; fromUserId: number; fromNickname: string | null; createdAt: string }> }>(
      `/api/groups/${groupId}/files`
    ),

  addMembers: (groupId: number, userIds: number[]) =>
    api.post<{ groupId: number; added: number[] }>(`/api/groups/${groupId}/members`, { userIds }),

  removeMember: (groupId: number, userId: number) =>
    api.del<{ groupId: number; removedUserId: number }>(`/api/groups/${groupId}/members/${userId}`),

  read: (groupId: number, lastMessageId: number) =>
    api.post<{ ok: boolean; lastMessageId: number }>(`/api/groups/${groupId}/read`, { lastMessageId }),

  leave: (groupId: number) => api.post<{ groupId: number; left?: boolean; dissolved?: boolean }>(`/api/groups/${groupId}/leave`),

  dissolve: (groupId: number) => api.del<{ groupId: number; dissolved: boolean }>(`/api/groups/${groupId}`),

  history: (groupId: number, beforeId = 0, limit = 50) =>
    api.get<{ group: Group; members: GroupMember[]; messages: ChatMessage[]; settings?: ConversationSettings }>(
      `/api/groups/${groupId}/messages`,
      { params: { beforeId, limit } }
    ),
};

export { refreshAccessToken };
