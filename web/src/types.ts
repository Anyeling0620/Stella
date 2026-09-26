/** Domain types shared by the API layer, the context and the pages. */

export interface User {
  id: number;
  username: string;
  nickname: string;
  avatar: string | null;
  createdAt?: string;
  lastSeenAt?: string | null;
  isFriend?: boolean;
}

export interface SessionPayload {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: User;
}

export interface StoredSession {
  user: User;
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  accessExpiresAt: number;
}

export interface ChatMessage {
  id: number;
  clientMsgId: string | null;
  fromUserId: number;
  toUserId: number;
  content: string;
  status: number;
  createdAt: string;
}

export interface SystemNotice {
  id: number;
  level: string;
  content: string;
  createdAt: string;
}

export interface FriendRequest {
  id: number;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled';
  message: string | null;
  createdAt: string;
  direction: 'incoming' | 'outgoing';
  peer: User;
}

/** Connection state machine exposed to the UI. */
export type RealtimeState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'polling' | 'closed';
export type RealtimeMode = 'none' | 'ws' | 'poll';

export interface RealtimeStatus {
  state: RealtimeState;
  mode: RealtimeMode;
  attempt: number;
  nextRetryMs: number;
  lastError: string | null;
  connected: boolean;
}

/** Transport used for the single global connection. */
export type TransportKind = 'shared-worker' | 'in-tab-fallback';

/** A server push, normalised from either the socket or an incremental poll. */
export interface ServerFrame {
  type: string;
  [key: string]: unknown;
}

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error' | 'notice';
  title: string;
  body?: string;
  /** Optional navigation target (opens a conversation). */
  conversationId?: number;
}
