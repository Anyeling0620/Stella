/** Domain types shared by the API layer, the context and the pages. */

export interface User {
  id: number;
  username: string;
  nickname: string;
  avatar: string | null;
  createdAt?: string;
  lastSeenAt?: string | null;
  isFriend?: boolean;
  /** Present on the friend list — the newest 1:1 message, for list previews. */
  lastMessage?: ConversationPreview | null;
  /** Present on the friend list — unread messages from this friend. */
  unread?: number;
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

export interface Attachment {
  id: number;
  kind: 'image' | 'file';
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
  /** `system` rows are in-thread notices; `image`/`file` carry an attachment. */
  type?: 'text' | 'system' | 'image' | 'file';
  /** User ids @-mentioned by this message (group only). */
  mentions?: number[];
  /** Author summary, present on group messages. */
  fromUser?: { id: number; nickname: string; avatar: string | null };
  attachmentId?: number | null;
  attachment?: Attachment | null;
  content: string;
  status: number;
  createdAt: string;
}

export interface GroupMember {
  id: number;
  username: string;
  nickname: string;
  avatar: string | null;
  role: 'owner' | 'member';
  joinedAt: string;
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
  createdAt: string;
  updatedAt: string;
  role?: 'owner' | 'member';
  memberCount?: number;
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
