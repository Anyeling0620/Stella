/** Domain types shared by the API layer, the context and the pages. */

export interface User {
  id: number;
  username: string;
  nickname: string;
  avatar: string | null;
  /** Optional self-description ("个性签名"), shown on the profile. */
  bio?: string | null;
  createdAt?: string;
  lastSeenAt?: string | null;
  /** Live presence, kept current by `presence` frames. */
  online?: boolean;
  isFriend?: boolean;
  /** Present on the friend list — the newest 1:1 message, for list previews. */
  lastMessage?: ConversationPreview | null;
  /** Present on the friend list — unread messages from this friend. */
  unread?: number;
  /** Present on the friend list — my private alias; wins over `nickname`. */
  remark?: string | null;
  /** Present on the friend list — when the friendship row was created. */
  friendedAt?: string | null;
}

/** Compact "last message" shown as a conversation-list subtitle. */
export interface ConversationPreview {
  type: string;
  content: string;
  fromUserId: number;
  createdAt: string;
  /** Sender nickname (groups); null when unknown/1:1 (the peer is known). */
  fromNickname?: string | null;
}

/**
 * What the server returns on login/register/refresh. The refresh token is NOT
 * here — it lives in an HttpOnly cookie set by the server and is never readable
 * by JavaScript. Only the short-lived access token comes back in the body.
 */
export interface SessionPayload {
  accessToken: string;
  expiresIn: number;
  user: User;
}

/**
 * The only session data persisted to localStorage. A *hint* used to decide
 * whether to attempt a silent refresh on boot — never a credential. Access
 * tokens live in memory; the refresh token lives in an HttpOnly cookie.
 */
export interface StoredSession {
  user: User;
}

/** Privacy / notification switches (chapter 12). */
export interface UserSettings {
  addByUsername: boolean;
  addByInvite: boolean;
  addByGroup: boolean;
  requireVerification: boolean;
  notifyDesktop: boolean;
  notifySound: boolean;
  notifyPreview: boolean;
}

/** A login lineage shown in the active-session list (device management). */
export interface AuthSessionInfo {
  sessionId: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastUsedAt: string;
  current: boolean;
  revoked: boolean;
}

export interface Attachment {
  id: number;
  kind: 'image' | 'file' | 'voice';
  name: string;
  size: number;
  mime: string;
}

export interface ChatMessage {
  id: number;
  clientMsgId: string | null;
  fromUserId: number;
  toUserId: number;
  /** Set on group messages; `null` for 1:1. */
  groupId?: number | null;
  /** `system` rows are in-thread notices; media rows carry an attachment. */
  type?: 'text' | 'system' | 'image' | 'file' | 'voice';
  /** User ids @-mentioned by this message (group only). */
  mentions?: number[];
  /** Author summary, present on group messages. */
  fromUser?: { id: number; nickname: string; avatar: string | null };
  attachmentId?: number | null;
  attachment?: Attachment | null;
  /** True once the author recalled it (content is cleared). */
  recalled?: boolean;
  recalledAt?: string | null;
  /** The message this one replies to, plus a small snapshot for rendering. */
  quoteId?: number | null;
  quote?: { id: number; content: string | null; type: string; fromUserId: number; recalled: boolean } | null;
  content: string;
  status: number;
  createdAt: string;
  /** Client-only: optimistic row that has not been acknowledged yet. */
  pending?: boolean;
  /** Client-only: local send failed (offers retry). */
  failed?: boolean;
}

/** Per-user pin / mute state for one conversation. */
export interface ConversationSettings {
  peerKind: 'direct' | 'group';
  peerId: number;
  pinned: boolean;
  muted: boolean;
  clearedBeforeId: number;
}

/** A saved message (收藏) — a snapshot, so it survives recall. */
export interface Favorite {
  id: number;
  messageId: number | null;
  type: string;
  content: string;
  attachmentId: number | null;
  fromUserId: number;
  srcConversation: string | null;
  createdAt: string;
}

export interface GroupMember {
  id: number;
  username: string;
  nickname: string;
  avatar: string | null;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
  /** Live presence, kept current by `presence` frames. */
  online?: boolean;
  /** In-group alias (群昵称); falls back to the global nickname. */
  groupNickname?: string | null;
}

export interface GroupLastMessage {
  id: number;
  content: string;
  type: 'text' | 'system';
  fromUserId: number;
  fromNickname: string | null;
  fromAvatar: string | null;
  createdAt: string;
}

/** A group as returned by the list/detail endpoints (fields are additive). */
export interface Group {
  id: number;
  /** Shareable, searchable group number (QQ-style 群号). */
  groupNo?: number | null;
  name: string;
  avatar: string | null;
  ownerId: number;
  announcement: string | null;
  /** When true, joining requires owner/admin approval. */
  joinApproval?: boolean;
  createdAt: string;
  updatedAt: string;
  role?: 'owner' | 'member';
  memberCount?: number;
  /** How many members are online right now (server-computed). */
  onlineCount?: number;
  unread?: number;
  mentioned?: boolean;
  /** My pending join application's status, from group search. */
  requestStatus?: 'pending' | 'approved' | 'rejected' | null;
  lastMessage?: GroupLastMessage | null;
  /** Present on detail / lifecycle payloads. */
  members?: GroupMember[];
}

/** A pending "apply to join" application (owner-facing). */
export interface GroupJoinRequest {
  id: number;
  groupId: number;
  status: 'pending' | 'approved' | 'rejected';
  message: string | null;
  createdAt: string;
  applicant: User;
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
  /** Optional navigation target (opens a conversation): `d:<id>` or `g:<id>`. */
  conversationId?: string;
}
