import { api, refreshAccessToken } from './axiosClient';
import type { ChatMessage, FriendRequest, SessionPayload, User } from '../types';

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

export const messageApi = {
  /** "Source A" of the dual-source strategy: stored history over HTTP. */
  history: (friendId: number, beforeId = 0, limit = 50) =>
    api.get<{ peer: User; messages: ChatMessage[] }>('/api/messages/history', {
      params: { friendId, beforeId, limit },
    }),

  /** HTTP send path, used when the socket is unavailable. */
  send: (toUserId: number, content: string, clientMsgId: string) =>
    api.post<{ message: ChatMessage }>('/api/messages', { toUserId, content, clientMsgId }),

  read: (ids: number[]) => api.post<{ ok: boolean; updated: number }>('/api/messages/read', { ids }),

  // NB: incremental polling (`GET /api/messages/poll`) is deliberately NOT
  // wrapped here. It is owned by the realtime engine, which runs inside a
  // SharedWorker where this module cannot load (no localStorage, no axios).
  // The engine performs that call with `fetch` + a bearer token directly.
};

export { refreshAccessToken };
