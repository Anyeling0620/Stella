'use strict';

/**
 * Single source of truth for WebSocket frame types.
 *
 * The client handles these as string literals inline (see
 * `web/src/context/AppContext.tsx` and `web/src/pages/ChatShell.tsx`) — there is
 * no shared generated module, so adding an event means updating both sides.
 */
const CLIENT = { // 这是一个定义WebSocket客户端事件类型的对象，用于在客户端和服务器之间进行通信
  PING: 'ping',
  AUTH_REFRESH: 'auth:refresh',
  CHAT_SEND: 'chat:send',
  MESSAGE_READ: 'message:read',
};

const SERVER = {  // 这是一个定义WebSocket服务器端事件类型的对象，用于在客户端和服务器之间进行通信
  READY: 'ready',
  AUTH_OK: 'auth:ok',
  PONG: 'pong',
  CHAT_MESSAGE: 'chat:message',
  CHAT_ERROR: 'chat:error',
  CHAT_STATUS: 'chat:status',
  FRIEND_REQUEST: 'friend:request',
  FRIEND_ACCEPTED: 'friend:accepted',
  /** A one-way removal: only the actor's own tabs receive this. */
  FRIEND_REMOVED: 'friend:removed',
  /** Nickname/avatar changed: sent to the user's own tabs and all their friends. */
  PROFILE_UPDATED: 'profile:updated',
  SYSTEM_NOTICE: 'notice:system',
  SESSION_INVALID: 'session:invalid',
  // Group chat lifecycle. Each is fanned out to every member's tabs.
  GROUP_CREATED: 'group:created',
  GROUP_UPDATED: 'group:updated',
  GROUP_MEMBER_ADDED: 'group:member_added',
  GROUP_MEMBER_REMOVED: 'group:member_removed',
  GROUP_MEMBER_LEFT: 'group:member_left',
  GROUP_DISSOLVED: 'group:dissolved',
  /** An applicant asks to join: pushed to the group owner's tabs. */
  GROUP_JOIN_REQUESTED: 'group:join_requested',
  /** The owner's verdict on my application: pushed to the applicant. */
  GROUP_JOIN_RESULT: 'group:join_result',
};

/**
 * Application close codes (4000-4999 is reserved for app usage).
 * Only the two the server actually sends are declared — the client treats any
 * other unexpected closure as a transient failure and reconnects.
 */
const CLOSE = {
  TOKEN_EXPIRED: 4001,
  SESSION_REVOKED: 4002,
};

module.exports = { CLIENT, SERVER, CLOSE };
