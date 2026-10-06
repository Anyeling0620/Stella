import { api, refreshAccessToken, uploadFile } from './axiosClient';
import { API } from '../config';
import type { Attachment, ChatMessage, FriendRequest, Group, GroupJoinRequest, GroupMember, SessionPayload, User } from '../types';

/**
 * Typed API surface. Every call is a *thin* declaration — all resilience
 * (tokens, races, dedup, limiting, retry, refresh) lives in axiosClient.
 */

export const authApi = {
  register: (body: { username: string; password: string; nickname?: string }) =>
    api.post<SessionPayload>('/api/auth/register', body),

  login: (body: { username: string; password: string }) => api.post<SessionPayload>('/api/auth/login', body),

  logout: () => api.post<{ ok: boolean }>('/api/auth/logout'),

  /** Both fields optional; `avatar: null` clears it back to the initials mark. */
  updateProfile: (body: { nickname?: string; avatar?: string | null }) =>
    api.patch<{ user: User; peersNotified: number }>('/api/auth/me', body),
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
};

/** Media descriptor attached to an outgoing image/file message. */
export interface OutgoingMedia {
  type: 'image' | 'file';
  attachmentId: number;
}

export const messageApi = {
  /** "Source A" of the dual-source strategy: stored history over HTTP. */
  history: (friendId: number, beforeId = 0, limit = 50) =>
    api.get<{ peer: User; messages: ChatMessage[] }>('/api/messages/history', {
      params: { friendId, beforeId, limit },
    }),

  /** HTTP send path (1:1), used when the socket is unavailable. */
  send: (toUserId: number, content: string, clientMsgId: string, media?: OutgoingMedia) =>
    api.post<{ message: ChatMessage }>('/api/messages', { toUserId, content, clientMsgId, ...(media ?? {}) }),

  /** HTTP send path (group). Mirrors the WS `chat:send` payload. */
  sendToGroup: (
    groupId: number,
    content: string,
    clientMsgId: string,
    mentions: number[] = [],
    media?: OutgoingMedia
  ) => api.post<{ message: ChatMessage }>('/api/messages', { groupId, content, clientMsgId, mentions, ...(media ?? {}) }),

  read: (ids: number[]) => api.post<{ ok: boolean; updated: number }>('/api/messages/read', { ids }),

  // NB: incremental polling (`GET /api/messages/poll`) is deliberately NOT
  // wrapped here. It is owned by the realtime engine, which runs inside a
  // SharedWorker where this module cannot load (no localStorage, no axios).
  // The engine performs that call with `fetch` + a bearer token directly.
};

/** Uploads an image/file and returns its metadata (referenced when sending). */
export const attachmentApi = {
  upload: (file: File, onProgress?: (percent: number) => void) =>
    uploadFile<{ attachment: Attachment }>('/api/attachments', file, onProgress),
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

  update: (groupId: number, patch: { name?: string; avatar?: string | null; announcement?: string | null }) =>
    api.patch<{ group: Group }>(`/api/groups/${groupId}`, patch),

  addMembers: (groupId: number, userIds: number[]) =>
    api.post<{ groupId: number; added: number[] }>(`/api/groups/${groupId}/members`, { userIds }),

  removeMember: (groupId: number, userId: number) =>
    api.del<{ groupId: number; removedUserId: number }>(`/api/groups/${groupId}/members/${userId}`),

  read: (groupId: number, lastMessageId: number) =>
    api.post<{ ok: boolean; lastMessageId: number }>(`/api/groups/${groupId}/read`, { lastMessageId }),

  leave: (groupId: number) => api.post<{ groupId: number; left?: boolean; dissolved?: boolean }>(`/api/groups/${groupId}/leave`),

  dissolve: (groupId: number) => api.del<{ groupId: number; dissolved: boolean }>(`/api/groups/${groupId}`),

  history: (groupId: number, beforeId = 0, limit = 50) =>
    api.get<{ group: Group; members: GroupMember[]; messages: ChatMessage[] }>(`/api/groups/${groupId}/messages`, {
      params: { beforeId, limit },
    }),
};

export { refreshAccessToken };
