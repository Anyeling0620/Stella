import { ChangeEvent, FormEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { attachmentApi, attachmentRawUrl, groupApi, messageApi, type OutgoingMedia } from '../lib/api';
import { ApiError, isCancelError } from '../lib/axiosClient';
import { STORAGE_KEYS } from '../config';
import { session } from '../lib/session';
import { uid } from '../lib/storage';
import { formatBytes, formatClock, formatDayLabel } from '../lib/format';
import { useAppActions } from '../context/AppContext';
import { Avatar } from '../components/Avatar';
import { GroupInfoDialog } from '../components/GroupInfoDialog';
import type { Attachment, ChatMessage, Group, GroupMember, User } from '../types';

/**
 * One conversation — 1:1 or group.
 *
 * Implements the dual-source strategy: HTTP history is the baseline loaded on
 * mount, and WebSocket frames are the live increment. All message data lives in
 * this component's local state and is destroyed when the conversation changes or
 * the component unmounts.
 *
 * The two kinds share one code path; they differ only in:
 *   - which history/send endpoint is used,
 *   - how a message is routed (`toUserId` vs `groupId`),
 *   - how the thread is decorated (group sender names, system notices, @mentions).
 */

interface LocalMessage {
  seq: number;
  id: number;
  clientMsgId: string | null;
  fromUserId: number;
  toUserId: number;
  groupId?: number | null;
  type?: 'text' | 'system' | 'image' | 'file';
  mentions?: number[];
  fromUser?: { id: number; nickname: string; avatar: string | null };
  attachment?: Attachment | null;
  /** Object URL for an image being uploaded (used before the server echo). */
  localUrl?: string;
  /** Upload progress 0–100 while the bytes are still in flight. */
  uploading?: number;
  content: string;
  status: number;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
}

const PAGE_SIZE = 50;
/**
 * Hard cap on messages held in memory for one open conversation (design spec:
 * 单会话持有消息上限 1000 条). Because the thread keeps every live frame, a busy
 * conversation would otherwise grow without bound; the oldest rows are evicted
 * and the "load older" entry stays available.
 */
const MAX_MESSAGES = 1000;
const PENDING_TIMEOUT_MS = 8000;
/**
 * Minimum time the "sending" indicator stays on screen. A WebSocket echo lands
 * in a few milliseconds, so without this the spinner would flash for a single
 * frame and be effectively invisible.
 */
const MIN_PENDING_MS = 500;
/** Incoming messages are coalesced into one read-receipt call per window.
    Kept short so the sender's 已读 tick feels immediate. */
const READ_FLUSH_MS = 250;

/** Built-in emoji panel (WeChat-style 表情). Inserted as plain unicode text. */
const EMOJIS = [
  '😀','😁','😂','🤣','😊','😍','😘','😎','🤔','😐','😴','😭',
  '😤','😡','🥺','😱','🤗','🤝','👍','👎','👏','🙏','💪','🤙',
  '🎉','🔥','💯','✨','❤️','💔','🌹','🍺','🍰','🎁','⚽','🚀',
  '✅','❌','⚠️','💡','📌','📎','📷','🎵','☕','🌙','☀️','🐶',
];

/** Keeps at most `MAX_MESSAGES` rows (newest kept) so the thread cannot grow unbounded. */
const capMessages = (list: LocalMessage[]): LocalMessage[] =>
  list.length > MAX_MESSAGES ? list.slice(list.length - MAX_MESSAGES) : list;

interface ChatWindowProps {
  kind: 'direct' | 'group';
  /** Friend id for `direct`, group id for `group`. */
  conversationId: number;
  /** Current user id, passed down so this component needs no session context. */
  myId: number;
  /** True while this tab is the non-active (frozen) window. */
  frozen: boolean;
  /** Live friend entry (direct only) — preferred over the history snapshot. */
  peerHint?: User | null;
  /** Live group entry (group only) — preferred over the history snapshot. */
  groupHint?: Group | null;
  /** Live presence (user id -> online), owned by ChatShell. */
  presence: Record<number, boolean>;
  /** Mobile-only back affordance; the pane is chosen by ChatShell. */
  onBack?: () => void;
}

interface MessageRowProps {
  message: LocalMessage;
  mine: boolean;
  showDay: boolean;
  otherName: string;
  otherAvatar: string | null;
  /** Group threads label each incoming bubble with its author. */
  showSenderName: boolean;
  /** Member nicknames, used to highlight `@name` tokens. */
  mentionNames: string[];
  /** True when this message @-mentions the current user. */
  mentionMe: boolean;
  /** Resolved URL for an image/file bubble (server URL or a local object URL). */
  mediaSrc?: string | null;
  onOpenImage: (src: string) => void;
  onRetry: (message: LocalMessage) => void;
}

const renderContent = (content: string, names: string[]) => {
  if (names.length === 0) return content;
  const escaped = names
    .filter((n) => n.length > 0)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  if (escaped.length === 0) return content;
  const re = new RegExp(`@(?:${escaped.join('|')})`, 'g');
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    if (match.index > last) nodes.push(content.slice(last, match.index));
    nodes.push(
      <span key={`m${match.index}`} className="mention">
        {match[0]}
      </span>
    );
    last = match.index + match[0].length;
  }
  if (last < content.length) nodes.push(content.slice(last));
  return nodes;
};

/** "最后活跃 …" shown for an offline 1:1 peer. */
function formatLastSeen(iso?: string | null): string {
  if (!iso) return '离线';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '离线';
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return '刚刚活跃';
  if (minutes < 60) return `${minutes} 分钟前活跃`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} 小时前活跃`;
  return '离线';
}

/** Single tick — the message reached the server (已送达). */
const SentIcon = () => (
  <svg className="bubble-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path
      d="M3 8.4l3.2 3.2L13 4.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Double tick — the peer has read it (已读). */
const ReadIcon = () => (
  <svg className="bubble-check" viewBox="0 0 20 16" width="18" height="14" aria-hidden="true">
    <path
      d="M1.4 8.4l3.2 3.2L11 4.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M7 8.4l3.2 3.2L16.6 4.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Composer glyphs — drawn as line art on the same grid as the rail icons, so
 * they read as one icon language instead of stray emoji/text characters.
 */
const glyphProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const EmojiIcon = () => (
  <svg className="composer-icon" width="22" height="22" {...glyphProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.4 14.4a4.6 4.6 0 0 0 7.2 0" />
    <circle cx="9.2" cy="9.6" r="0.7" fill="currentColor" stroke="none" />
    <circle cx="14.8" cy="9.6" r="0.7" fill="currentColor" stroke="none" />
  </svg>
);

const PlusCircleIcon = () => (
  <svg className="composer-icon" width="22" height="22" {...glyphProps}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8.4v7.2M8.4 12h7.2" />
  </svg>
);

const MentionIcon = () => (
  <svg className="composer-icon" width="22" height="22" {...glyphProps}>
    <circle cx="12" cy="12" r="3.6" />
    <path d="M15.6 8.4v5.1a2.55 2.55 0 0 0 5.1 0V12a8.7 8.7 0 1 0-3.4 6.9" />
  </svg>
);

const PhotoIcon = () => (
  <svg className="attach-icon" width="18" height="18" {...glyphProps}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
    <circle cx="9" cy="10" r="1.5" />
    <path d="M4.5 17.2l4.3-4.3 3.7 3.7 2.6-2.6 4.4 4.4" />
  </svg>
);

const DocumentIcon = () => (
  <svg className="file-icon-svg" width="26" height="26" {...glyphProps}>
    <path d="M6.5 4.3c0-1 .8-1.8 1.8-1.8h5.2l5 5v12.2c0 1-.8 1.8-1.8 1.8H8.3c-1 0-1.8-.8-1.8-1.8z" />
    <path d="M13.5 2.5v4.9h4.9" />
  </svg>
);

/**
 * A single bubble. Memoized: message objects keep their identity between
 * updates, so appending a message leaves every other row untouched.
 */
const MessageRow = memo(function MessageRow({
  message,
  mine,
  showDay,
  otherName,
  otherAvatar,
  showSenderName,
  mentionNames,
  mentionMe,
  mediaSrc,
  onOpenImage,
  onRetry,
}: MessageRowProps) {
  const day = showDay ? <div className="day-separator">{formatDayLabel(message.createdAt)}</div> : null;

  if (message.type === 'system') {
    return (
      <div>
        {day}
        <div className="chat-system">{message.content}</div>
      </div>
    );
  }

  return (
    <div>
      {day}
      <div className={`bubble-row ${mine ? 'mine' : 'theirs'}`}>
        {!mine && <Avatar name={otherName} avatar={otherAvatar} size={32} tone="muted" />}
        <div className="bubble-column">
          {!mine && showSenderName && <div className="bubble-sender">{otherName}</div>}
          <div className={`bubble-line ${mine ? 'mine' : ''}`}>
            {/* Sending: spinner on the leading edge, centred on the bubble itself
                (not on the bubble + timestamp row). */}
            {mine && message.pending && (
              <span className="spinner bubble-spinner" role="status" aria-label="发送中" />
            )}
            <div
            className={`bubble ${mine ? 'bubble-mine' : 'bubble-theirs'} ${
              message.failed ? 'bubble-failed' : ''
            } ${message.pending ? 'bubble-pending' : ''} ${mentionMe ? 'bubble-mention' : ''} ${
              message.type === 'image' || message.type === 'file' ? 'bubble-media' : ''
            }`}
          >
            {message.type === 'image' ? (
              <button
                type="button"
                className="bubble-image-btn"
                onClick={() => mediaSrc && onOpenImage(mediaSrc)}
                disabled={!mediaSrc}
                aria-label="查看图片"
              >
                {mediaSrc ? (
                  <img className="bubble-image" src={mediaSrc} alt={message.attachment?.name ?? '图片'} />
                ) : (
                  <span className="media-placeholder">图片</span>
                )}
                {message.uploading != null && <span className="media-progress">{message.uploading}%</span>}
              </button>
            ) : message.type === 'file' ? (
              <div className="bubble-file">
                <span className="file-icon" aria-hidden="true">
                  <DocumentIcon />
                </span>
                <span className="file-main">
                  <span className="file-name">{message.attachment?.name ?? '文件'}</span>
                  <span className="file-size">{formatBytes(message.attachment?.size)}</span>
                </span>
                {message.uploading != null ? (
                  <span className="file-progress">{message.uploading}%</span>
                ) : mediaSrc ? (
                  <a
                    className="file-download"
                    href={mediaSrc}
                    download={message.attachment?.name ?? undefined}
                    onClick={(event) => event.stopPropagation()}
                  >
                    下载
                  </a>
                ) : null}
              </div>
            ) : (
              renderContent(message.content, mentionNames)
            )}
            </div>
          </div>
          <div className="bubble-meta">
            {formatClock(message.createdAt)}
            {mine && message.failed && (
              <>
                <span className="bubble-state failed">发送失败</span>
                <button type="button" className="bubble-retry" onClick={() => onRetry(message)}>
                  重发
                </button>
              </>
            )}
            {/* Group messages have no per-message read state (WeChat style). */}
            {mine && !message.pending && !message.failed && showSenderName === false && (
              <span
                className="bubble-state"
                title={message.status >= 2 ? '已读' : '已送达'}
                aria-label={message.status >= 2 ? '已读' : '已送达'}
              >
                {message.status >= 2 ? <ReadIcon /> : <SentIcon />}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export const ChatWindow = memo(function ChatWindow({
  kind,
  conversationId,
  myId,
  frozen,
  peerHint,
  groupHint,
  presence,
  onBack,
}: ChatWindowProps) {
  const { subscribeFrames, publishCursor, sendFrame, pushToast } = useAppActions();
  const isGroup = kind === 'group';

  const [peer, setPeer] = useState<User | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [groupInfoOpen, setGroupInfoOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentioned, setMentioned] = useState<number[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** Full-screen image preview src (null when closed). */
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // Composer height: dragged via its top edge; written to `--composer-h` on the
  // window element (no state). Once dragged, the textarea stops auto-growing and
  // simply fills + scrolls. Double-click the handle resets to auto-grow.
  const windowRef = useRef<HTMLElement | null>(null);
  const composerFormRef = useRef<HTMLFormElement | null>(null);
  const manualComposerRef = useRef(false);
  const composerDragRef = useRef({ startY: 0, startH: 0 });

  const seqRef = useRef(0);
  /** Older pages count *down* so they sort before the live thread. */
  const olderSeqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * Scroll anchoring. The thread must follow new messages but must NOT yank the
   * view while the user reads history:
   *   - `atBottom` tracks whether the viewport is parked at the newest message;
   *   - `pendingPrepend` captures the scroll metrics before an "older page" is
   *     inserted, so the same content stays under the cursor afterwards.
   */
  const atBottomRef = useRef(true);
  /** Mirrors `conversationId` so deferred callbacks can bail if it changed. */
  const conversationRef = useRef(conversationId);
  const pendingPrependRef = useRef<{ height: number; top: number } | null>(null);
  const pendingTimers = useRef(new Map<string, number>());
  /** When each optimistic bubble first showed "sending" (for MIN_PENDING_MS). */
  const pendingSinceRef = useRef(new Map<string, number>());
  const pendingReadIds = useRef(new Set<number>());
  const pendingGroupReadId = useRef(0);
  const readFlushTimer = useRef<number | null>(null);

  const nextSeq = useCallback(() => {
    seqRef.current += 1;
    return seqRef.current;
  }, []);

  /**
   * Object URLs created for image uploads (shown before the server echo). They
   * pin the underlying Blob in memory until revoked, so every one we create is
   * tracked and released as soon as it is no longer rendered.
   */
  const objectUrls = useRef(new Set<string>());
  const trackObjectUrl = useCallback((url: string) => {
    objectUrls.current.add(url);
  }, []);
  /** Revokes one tracked object URL (no-op if already revoked). */
  const revokeObjectUrl = useCallback((url?: string | null) => {
    if (url && objectUrls.current.delete(url)) URL.revokeObjectURL(url);
  }, []);
  const revokeAllObjectUrls = useCallback(() => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current.clear();
  }, []);
  // Release every preview URL when the window unmounts.
  useEffect(() => () => revokeAllObjectUrls(), [revokeAllObjectUrls]);

  const clearPendingTimer = useCallback((clientMsgId: string) => {
    const timer = pendingTimers.current.get(clientMsgId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pendingTimers.current.delete(clientMsgId);
    }
  }, []);

  /** Stamps the moment a bubble enters the "sending" state. */
  const beginPending = useCallback((clientMsgId: string) => {
    pendingSinceRef.current.set(clientMsgId, performance.now());
  }, []);

  // -------------------------------------------------------------------------
  // Read receipts — batched. Direct marks message rows; group advances a cursor.
  // -------------------------------------------------------------------------
  const flushReads = useCallback(() => {
    if (readFlushTimer.current !== null) {
      window.clearTimeout(readFlushTimer.current);
      readFlushTimer.current = null;
    }
    if (isGroup) {
      const lastId = pendingGroupReadId.current;
      if (lastId <= 0) return;
      pendingGroupReadId.current = 0;
      void groupApi.read(conversationId, lastId).catch(() => {
        /* read cursor is best-effort */
      });
      return;
    }
    if (pendingReadIds.current.size === 0) return;
    const ids = [...pendingReadIds.current];
    pendingReadIds.current.clear();
    void messageApi.read(ids).catch(() => {
      /* read receipts are best-effort */
    });
  }, [conversationId, isGroup]);

  const scheduleFlush = useCallback(() => {
    if (readFlushTimer.current === null) {
      readFlushTimer.current = window.setTimeout(flushReads, READ_FLUSH_MS);
    }
  }, [flushReads]);

  const queueRead = useCallback(
    (ids: number[]) => {
      let added = false;
      for (const id of ids) {
        if (id > 0 && !pendingReadIds.current.has(id)) {
          pendingReadIds.current.add(id);
          added = true;
        }
      }
      if (added) scheduleFlush();
    },
    [scheduleFlush]
  );

  const queueGroupRead = useCallback(
    (id: number) => {
      if (id <= pendingGroupReadId.current) return;
      pendingGroupReadId.current = id;
      scheduleFlush();
    },
    [scheduleFlush]
  );

  // Never lose the last batch when leaving the thread.
  useEffect(() => () => flushReads(), [flushReads]);

  /** Insert or reconcile a message, keyed by client id then server id. */
  const upsert = useCallback(
    (incoming: ChatMessage) => {
      const clientMsgId = incoming.clientMsgId;
      if (clientMsgId) clearPendingTimer(clientMsgId);

      const forConversation = conversationId;
      // Keep the "sending" look for a beat so a fast echo doesn't flicker.
      const since = clientMsgId ? pendingSinceRef.current.get(clientMsgId) : undefined;
      if (clientMsgId) pendingSinceRef.current.delete(clientMsgId);
      const holdMs = since === undefined ? 0 : Math.max(0, MIN_PENDING_MS - (performance.now() - since));

      setMessages((previous) => {
        // Never apply an echo after the user switched threads.
        if (conversationRef.current !== forConversation) return previous;
        if (clientMsgId) {
          const index = previous.findIndex((m) => m.clientMsgId && m.clientMsgId === clientMsgId);
          if (index >= 0) {
            const next = [...previous];
            // The echo replaces the optimistic bubble: release its preview Blob.
            revokeObjectUrl(previous[index].localUrl);
            // Adopt the server state NOW (real id + status) so a read receipt
            // arriving during the hold can still match this message by id; only
            // the visual "sending" flag is held back.
            next[index] = { ...incoming, seq: previous[index].seq, pending: holdMs > 0 };
            return next;
          }
        }
        if (incoming.id > 0) {
          const existing = previous.find((m) => m.id === incoming.id);
          if (existing) {
            return previous.map((m) =>
              m.id === incoming.id ? { ...m, status: Math.max(m.status, incoming.status) } : m
            );
          }
        }
        return capMessages([...previous, { ...incoming, seq: nextSeq() }]);
      });

      if (holdMs > 0 && clientMsgId) {
        window.setTimeout(() => {
          if (conversationRef.current !== forConversation) return;
          setMessages((previous) =>
            previous.map((m) => (m.clientMsgId === clientMsgId && m.pending ? { ...m, pending: false } : m))
          );
        }, holdMs);
      }
    },
    [clearPendingTimer, conversationId, nextSeq, revokeObjectUrl]
  );

  // -------------------------------------------------------------------------
  // Load history whenever the conversation changes (HTTP baseline)
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    conversationRef.current = conversationId;
    seqRef.current = 0;
    olderSeqRef.current = 0;
    pendingTimers.current.forEach((timer) => window.clearTimeout(timer));
    pendingTimers.current.clear();
    pendingSinceRef.current.clear();
    pendingReadIds.current.clear();
    pendingGroupReadId.current = 0;
    flushReads();
    revokeAllObjectUrls();
    setMessages([]);
    setPeer(null);
    setGroup(null);
    setMembers([]);
    setMentioned([]);
    setMentionOpen(false);
    setGroupInfoOpen(false);
    setAttachOpen(false);
    setEmojiOpen(false);
    setPreviewSrc(null);
    setHasMore(false);
    setDraft('');
    // A freshly opened thread always starts parked at the newest message.
    atBottomRef.current = true;
    pendingPrependRef.current = null;

    if (!conversationId) return undefined;

    setLoading(true);
    const request = isGroup
      ? groupApi.history(conversationId, 0, PAGE_SIZE).then((data) => ({
          peer: null as User | null,
          group: data.group,
          members: data.members,
          messages: data.messages,
        }))
      : messageApi.history(conversationId, 0, PAGE_SIZE).then((data) => ({
          peer: data.peer,
          group: null as Group | null,
          members: [] as GroupMember[],
          messages: data.messages,
        }));

    request
      .then((data) => {
        if (cancelled) return;
        setPeer(data.peer);
        setGroup(data.group);
        setMembers(data.members);
        setMessages(data.messages.map((message) => ({ ...message, seq: nextSeq() })));
        setHasMore(data.messages.length >= PAGE_SIZE);
        const maxId = data.messages.reduce((acc, m) => (m.id > acc ? m.id : acc), 0);
        if (maxId > 0) publishCursor({ messageId: maxId });
        if (isGroup) {
          const lastIncoming = data.messages.reduce(
            (acc, m) => (m.fromUserId !== myId && m.type !== 'system' && m.id > acc ? m.id : acc),
            0
          );
          if (lastIncoming > 0) queueGroupRead(lastIncoming);
        } else {
          queueRead(data.messages.filter((m) => m.toUserId === myId && m.status < 2).map((m) => m.id));
        }
      })
      .catch((error) => {
        if (cancelled || isCancelError(error)) return;
        pushToast({
          kind: 'error',
          title: '加载历史消息失败',
          body: error instanceof ApiError ? error.message : '请稍后重试',
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId, isGroup, myId, nextSeq, publishCursor, queueRead, queueGroupRead, pushToast, flushReads, revokeAllObjectUrls]);

  // Once the cap starts evicting the oldest rows there is, by definition, older
  // history to fetch — keep the "load older" entry available.
  useEffect(() => {
    if (messages.length >= MAX_MESSAGES && !hasMore) setHasMore(true);
  }, [messages.length, hasMore]);

  // -------------------------------------------------------------------------
  // Live increment (WebSocket frames, including normalised poll results)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!conversationId) return undefined;

    return subscribeFrames((frame) => {
      if (frame.type === 'chat:message') {
        const message = frame.message as ChatMessage | undefined;
        if (!message) return;
        const involves = isGroup
          ? Number(message.groupId) === conversationId
          : (message.fromUserId === conversationId && message.toUserId === myId) ||
            (message.fromUserId === myId && message.toUserId === conversationId);
        if (!involves) return;
        upsert(message);
        if (message.fromUserId !== myId && message.id > 0 && message.type !== 'system') {
          if (isGroup) queueGroupRead(message.id);
          else queueRead([message.id]);
        }
        return;
      }

      if (frame.type === 'chat:status') {
        if (isGroup) return; // groups have no per-message read state
        const ids = (frame.ids as number[]) ?? [];
        const readerId = Number(frame.readerId);
        if (readerId !== conversationId || ids.length === 0) return;
        setMessages((previous) =>
          previous.map((message) =>
            // A read receipt is definitive proof of delivery, so it also ends any
            // "sending" hold immediately — the double tick must not wait it out.
            ids.includes(message.id) ? { ...message, status: 2, pending: false } : message
          )
        );
        return;
      }

      // Group roster / profile changes for the open group.
      if (isGroup) {
        if (frame.type === 'group:updated') {
          const updated = frame.group as Group | undefined;
          if (updated && updated.id === conversationId) setGroup(updated);
          return;
        }
        if (
          frame.type === 'group:member_added' ||
          frame.type === 'group:member_removed' ||
          frame.type === 'group:member_left'
        ) {
          if (Number(frame.groupId) === conversationId && Array.isArray(frame.members)) {
            setMembers(frame.members as GroupMember[]);
          }
          return;
        }
      }

      // Keep the header fresh when the peer edits their profile while this
      // conversation is open (the friend-list hint is null for non-friends).
      if (frame.type === 'profile:updated') {
        const updated = frame.user as User | undefined;
        if (!updated || updated.id !== conversationId) return;
        setPeer((previous) => (previous ? { ...previous, ...updated } : previous));
      }
    });
  }, [conversationId, isGroup, myId, subscribeFrames, upsert, queueRead, queueGroupRead]);

  /** Tracks whether the viewport is parked at the newest message. */
  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    atBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }, []);

  /**
   * Scroll management.
   *
   * Runs before paint so there is no visible jump:
   *   - after inserting an older page, restore the previous reading position
   *     (offset by how much the content grew above);
   *   - otherwise, follow new messages only when the user was already at the
   *     bottom — reading history is never interrupted.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const pending = pendingPrependRef.current;
    if (pending) {
      pendingPrependRef.current = null;
      element.scrollTop = pending.top + (element.scrollHeight - pending.height);
      return;
    }
    if (atBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [messages]);

  /** Content-driven composer height (capped). Ignored once the user drags it. */
  const sizeComposerToContent = useCallback(() => {
    const element = composerRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, []);

  /**
   * Auto-grow the composer up to a cap, then let it scroll — WeChat-like.
   * Written via a ref (no extra state/re-render). Skipped once the user has
   * manually resized the composer (then it fills a fixed height and scrolls).
   */
  useLayoutEffect(() => {
    if (manualComposerRef.current) return;
    sizeComposerToContent();
  }, [draft, sizeComposerToContent]);

  // --- Draggable composer height (drag its top edge) -----------------------
  const onComposerResizeDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const form = composerFormRef.current;
    if (!form) return;
    composerDragRef.current = { startY: event.clientY, startH: form.getBoundingClientRect().height };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onComposerResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!(event.buttons & 1)) return;
    const win = windowRef.current;
    if (!win) return;
    const dy = event.clientY - composerDragRef.current.startY;
    const max = Math.min(window.innerHeight * 0.6, 480);
    const height = Math.round(Math.min(Math.max(composerDragRef.current.startH - dy, 72), max));
    manualComposerRef.current = true;
    const area = composerRef.current;
    if (area) area.style.height = ''; // let the textarea stretch to fill the composer
    win.style.setProperty('--composer-h', `${height}px`);
  }, []);

  const onComposerResizeUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    const height = windowRef.current?.style.getPropertyValue('--composer-h').trim();
    if (height) {
      try {
        window.localStorage.setItem(STORAGE_KEYS.composerHeight, height);
      } catch {
        /* ignore */
      }
    }
  }, []);

  /** Double-click the handle: forget the manual height, back to auto-grow. */
  const resetComposerHeight = useCallback(() => {
    manualComposerRef.current = false;
    windowRef.current?.style.removeProperty('--composer-h');
    try {
      window.localStorage.removeItem(STORAGE_KEYS.composerHeight);
    } catch {
      /* ignore */
    }
    sizeComposerToContent();
  }, [sizeComposerToContent]);

  // Restore a previously dragged composer height (no state, before paint).
  useEffect(() => {
    const win = windowRef.current;
    if (!win) return;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEYS.composerHeight);
      if (saved && /^\d+px$/.test(saved)) {
        manualComposerRef.current = true;
        win.style.setProperty('--composer-h', saved);
        const area = composerRef.current;
        if (area) area.style.height = '';
      }
    } catch {
      /* ignore */
    }
  }, []);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const loadOlder = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const oldest = messages.find((message) => message.id > 0);
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const data = isGroup
        ? await groupApi.history(conversationId, oldest.id, PAGE_SIZE)
        : await messageApi.history(conversationId, oldest.id, PAGE_SIZE);
      setHasMore(data.messages.length >= PAGE_SIZE);
      if (data.messages.length > 0) {
        const known = new Set(messages.map((m) => m.id));
        // Negative, decreasing seqs place older pages ahead of the live thread
        // *without* touching the identity of any existing row.
        const older = data.messages
          .filter((m) => !known.has(m.id))
          .map((m) => ({ ...m, seq: (olderSeqRef.current -= 1) }));
        if (older.length > 0) {
          // Capture metrics first so the layout effect can keep the reading
          // position stable while the older page grows the content above.
          const element = scrollRef.current;
          if (element) {
            pendingPrependRef.current = { height: element.scrollHeight, top: element.scrollTop };
          }
          setMessages((previous) => {
            const existing = new Set(previous.map((m) => m.id));
            const fresh = older.filter((m) => !existing.has(m.id));
            return fresh.length === 0 ? previous : [...fresh, ...previous];
          });
        }
      }
    } catch (error) {
      if (!isCancelError(error)) {
        pushToast({ kind: 'error', title: '加载更早消息失败', body: '请稍后重试' });
      }
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, messages, conversationId, isGroup, pushToast]);

  const armPendingTimeout = useCallback(
    (clientMsgId: string) => {
      clearPendingTimer(clientMsgId);
      pendingTimers.current.set(
        clientMsgId,
        window.setTimeout(() => {
          pendingTimers.current.delete(clientMsgId);
          setMessages((previous) =>
            previous.map((message) =>
              message.clientMsgId === clientMsgId && message.pending
                ? { ...message, pending: false, failed: true }
                : message
            )
          );
        }, PENDING_TIMEOUT_MS)
      );
    },
    [clearPendingTimer]
  );

  const deliver = useCallback(
    async (clientMsgId: string, content: string, mentions: number[]) => {
      const viaSocket = sendFrame(
        isGroup
          ? { type: 'chat:send', clientMsgId, groupId: conversationId, content, mentions }
          : { type: 'chat:send', clientMsgId, toUserId: conversationId, content }
      );
      if (viaSocket) return; // the server echo reconciles the optimistic entry

      // Socket unavailable -> identical HTTP path (same service on the server).
      setSending(true);
      try {
        const { message } = isGroup
          ? await messageApi.sendToGroup(conversationId, content, clientMsgId, mentions)
          : await messageApi.send(conversationId, content, clientMsgId);
        upsert(message);
      } catch (error) {
        setMessages((previous) =>
          previous.map((message) =>
            message.clientMsgId === clientMsgId ? { ...message, pending: false, failed: true } : message
          )
        );
        pushToast({
          kind: 'error',
          title: '消息发送失败',
          body: error instanceof ApiError ? error.message : '请检查网络后重试',
        });
      } finally {
        setSending(false);
      }
    },
    [conversationId, isGroup, sendFrame, upsert, pushToast]
  );

  /** Sends an already-uploaded media message (retry path — no re-upload). */
  const deliverMedia = useCallback(
    async (clientMsgId: string, media: OutgoingMedia) => {
      // NB: no `type` field here — `type` is the WS frame discriminator. The
      // server derives image/file from the attachment itself.
      const viaSocket = sendFrame(
        isGroup
          ? { type: 'chat:send', clientMsgId, groupId: conversationId, attachmentId: media.attachmentId, content: '' }
          : { type: 'chat:send', clientMsgId, toUserId: conversationId, attachmentId: media.attachmentId, content: '' }
      );
      if (viaSocket) return;
      try {
        const { message } = isGroup
          ? await messageApi.sendToGroup(conversationId, '', clientMsgId, [], media)
          : await messageApi.send(conversationId, '', clientMsgId, media);
        upsert(message);
      } catch (error) {
        setMessages((previous) =>
          previous.map((m) => (m.clientMsgId === clientMsgId ? { ...m, pending: false, failed: true } : m))
        );
        pushToast({ kind: 'error', title: '消息发送失败', body: error instanceof ApiError ? error.message : '请稍后重试' });
      }
    },
    [conversationId, isGroup, sendFrame, upsert, pushToast]
  );

  /**
   * Picks an image/file: uploads it (showing progress), then sends the message.
   * The optimistic bubble carries a local object URL so an image appears
   * instantly; the server echo swaps in the stored attachment.
   */
  const sendMedia = useCallback(
    async (file: File, kind: 'image' | 'file') => {
      if (!conversationId) return;
      const clientMsgId = uid();
      // Preview the image instantly; the URL is tracked so it can be revoked once
      // the server echo replaces the optimistic bubble (or the thread is closed).
      const localUrl = kind === 'image' ? URL.createObjectURL(file) : undefined;
      if (localUrl) trackObjectUrl(localUrl);
      const optimistic: LocalMessage = {
        seq: nextSeq(),
        id: 0,
        clientMsgId,
        fromUserId: myId,
        toUserId: isGroup ? 0 : conversationId,
        groupId: isGroup ? conversationId : null,
        type: kind,
        attachment: { id: 0, kind, name: file.name, size: file.size, mime: file.type || 'application/octet-stream' },
        localUrl,
        uploading: 0,
        content: kind === 'image' ? '[图片]' : `[文件] ${file.name}`,
        status: 0,
        createdAt: new Date().toISOString(),
        pending: true,
      };
      setMessages((previous) => capMessages([...previous, optimistic]));
      beginPending(clientMsgId);
      setAttachOpen(false);
      try {
        const { attachment } = await attachmentApi.upload(file, (percent) => {
          setMessages((previous) =>
            previous.map((m) => (m.clientMsgId === clientMsgId ? { ...m, uploading: percent } : m))
          );
        });
        setMessages((previous) =>
          previous.map((m) => (m.clientMsgId === clientMsgId ? { ...m, attachment, uploading: undefined } : m))
        );
        armPendingTimeout(clientMsgId);
        await deliverMedia(clientMsgId, { type: kind, attachmentId: attachment.id });
      } catch (error) {
        setMessages((previous) =>
          previous.map((m) =>
            m.clientMsgId === clientMsgId ? { ...m, pending: false, failed: true, uploading: undefined } : m
          )
        );
        pushToast({
          kind: 'error',
          title: '发送失败',
          body: error instanceof ApiError ? error.message : '上传或发送失败',
        });
      }
    },
    [conversationId, isGroup, myId, nextSeq, beginPending, armPendingTimeout, deliverMedia, pushToast, trackObjectUrl]
  );

  const submit = useCallback(() => {
    const content = draft.trim();
    if (!content || !conversationId || sending) return;

    const clientMsgId = uid();
    const mentions = isGroup ? mentioned : [];
    const optimistic: LocalMessage = {
      seq: nextSeq(),
      id: 0,
      clientMsgId,
      fromUserId: myId,
      toUserId: isGroup ? 0 : conversationId,
      groupId: isGroup ? conversationId : null,
      type: 'text',
      mentions,
      content,
      status: 0,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((previous) => capMessages([...previous, optimistic]));
    setDraft('');
    setMentioned([]);
    setMentionOpen(false);
    beginPending(clientMsgId);
    armPendingTimeout(clientMsgId);
    void deliver(clientMsgId, content, mentions);
  }, [draft, conversationId, sending, myId, isGroup, mentioned, nextSeq, beginPending, armPendingTimeout, deliver]);

  const onSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      submit();
    },
    [submit]
  );

  const retry = useCallback(
    (message: LocalMessage) => {
      if (!message.clientMsgId) return;
      if (message.type === 'image' || message.type === 'file') {
        if (!message.attachment?.id) {
          pushToast({ kind: 'error', title: '无法重发', body: '请重新选择文件' });
          return;
        }
        setMessages((previous) =>
          previous.map((m) => (m.seq === message.seq ? { ...m, failed: false, pending: true } : m))
        );
        beginPending(message.clientMsgId);
        armPendingTimeout(message.clientMsgId);
        void deliverMedia(message.clientMsgId, { type: message.type, attachmentId: message.attachment.id });
        return;
      }
      setMessages((previous) =>
        previous.map((m) => (m.seq === message.seq ? { ...m, failed: false, pending: true } : m))
      );
      beginPending(message.clientMsgId);
      armPendingTimeout(message.clientMsgId);
      void deliver(message.clientMsgId, message.content, message.mentions ?? []);
    },
    [beginPending, armPendingTimeout, deliver, deliverMedia, pushToast]
  );

  const insertEmoji = useCallback((emoji: string) => {
    setDraft((current) => `${current}${emoji}`);
  }, []);

  const onImagePicked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void sendMedia(file, 'image');
    },
    [sendMedia]
  );

  const onFilePicked = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void sendMedia(file, 'file');
    },
    [sendMedia]
  );

  const insertMention = useCallback((member: GroupMember) => {
    setDraft((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@${member.nickname} `);
    setMentioned((current) => (current.includes(member.id) ? current : [...current, member.id]));
    setMentionOpen(false);
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const displayPeer = peerHint ?? peer ?? null;
  const displayGroup = groupHint ?? group ?? null;
  const peerName = displayPeer?.nickname ?? displayPeer?.username ?? '?';
  const peerAvatar = displayPeer?.avatar ?? null;
  const groupName = displayGroup?.name ?? `群聊 #${conversationId}`;
  const groupAvatar = displayGroup?.avatar ?? null;
  const memberCount = displayGroup?.memberCount ?? members.length;
  const peerOnline = presence[Number(conversationId)] ?? Boolean(displayPeer?.online);
  // Prefer the roster we hold (live presence) and fall back to the server count.
  const onlineMemberCount = members.length
    ? members.reduce((n, member) => n + ((presence[member.id] ?? member.online) ? 1 : 0), 0)
    : displayGroup?.onlineCount ?? 0;
  const mentionNames = useMemo(() => members.map((m) => m.nickname), [members]);
  const mentionCandidates = useMemo(() => members.filter((m) => m.id !== myId), [members, myId]);

  // `messages` is already in seq order in practice; the memo keeps the sort off
  // unrelated re-renders.
  const ordered = useMemo(() => [...messages].sort((a, b) => a.seq - b.seq), [messages]);

  // Access token for attachment URLs: `<img>`/download links cannot send an
  // Authorization header, so the token rides as `?token=` (see attachmentRawUrl).
  const token = session.getAccessToken();
  const mediaSrcOf = (message: LocalMessage): string | null => {
    if (message.type !== 'image' && message.type !== 'file') return null;
    if (message.localUrl && (!message.attachment || message.attachment.id === 0)) return message.localUrl;
    return message.attachment && message.attachment.id > 0
      ? attachmentRawUrl(message.attachment.id, token)
      : null;
  };

  return (
    <section className="chat-window" ref={windowRef}>
      <header className="chat-header">
        <button
          type="button"
          className="icon-btn chat-back"
          data-testid="chat-back"
          aria-label="返回"
          onClick={onBack}
        >
          ‹
        </button>
        <Avatar name={isGroup ? groupName : peerName} avatar={isGroup ? groupAvatar : peerAvatar} size={38} />
        <div className="chat-header-info">
          <div className="chat-header-name">{isGroup ? groupName : displayPeer?.nickname ?? `用户 #${conversationId}`}</div>
          <div className="chat-header-sub">
            {isGroup ? (
              `${onlineMemberCount} 人在线 · 共 ${memberCount} 人`
            ) : peerOnline ? (
              <span className="is-online">在线</span>
            ) : (
              formatLastSeen(displayPeer?.lastSeenAt)
            )}
          </div>
        </div>
        {isGroup && (
          <button
            type="button"
            className="btn btn-ghost btn-sm chat-header-action"
            data-testid="group-info-open"
            onClick={() => setGroupInfoOpen(true)}
          >
            群信息
          </button>
        )}
      </header>

      {isGroup && displayGroup?.announcement && (
        <div className="group-announcement" data-testid="group-announcement">
          {displayGroup.announcement}
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {hasMore && (
          <div className="chat-load-more">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="load-older"
              onClick={loadOlder}
              disabled={loadingMore}
            >
              {loadingMore ? (
                <>
                  <span className="spinner spinner-sm" aria-hidden="true" />
                  加载中
                </>
              ) : (
                '加载更早的消息'
              )}
            </button>
          </div>
        )}

        {loading && (
          <div className="chat-placeholder" role="status">
            <span className="spinner spinner-sm" aria-hidden="true" />
            正在加载历史消息…
          </div>
        )}

        {!loading && ordered.length === 0 && <div className="chat-placeholder">还没有消息</div>}

        {ordered.map((message, index) => {
          const previous = ordered[index - 1];
          const sender = message.fromUser;
          const mentionMe = isGroup && !message.pending && (message.mentions ?? []).includes(myId);
          return (
            <MessageRow
              key={message.clientMsgId ?? `m${message.id}`}
              message={message}
              mine={message.fromUserId === myId}
              showDay={!previous || formatDayLabel(previous.createdAt) !== formatDayLabel(message.createdAt)}
              otherName={isGroup ? sender?.nickname ?? `用户 #${message.fromUserId}` : peerName}
              otherAvatar={isGroup ? sender?.avatar ?? null : peerAvatar}
              showSenderName={isGroup}
              mentionNames={isGroup ? mentionNames : []}
              mentionMe={mentionMe}
              mediaSrc={mediaSrcOf(message)}
              onOpenImage={setPreviewSrc}
              onRetry={retry}
            />
          );
        })}
      </div>

      <div
        className="composer-resizer"
        data-testid="composer-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整输入区高度"
        title="拖动调整输入区高度（双击复位）"
        onPointerDown={onComposerResizeDown}
        onPointerMove={onComposerResizeMove}
        onPointerUp={onComposerResizeUp}
        onPointerCancel={onComposerResizeUp}
        onDoubleClick={resetComposerHeight}
      />

      <form className="chat-composer" onSubmit={onSubmit} ref={composerFormRef}>
        {isGroup && mentionOpen && (
          <div className="mention-popover" data-testid="mention-popover">
            <div className="mention-popover-title">选择要提醒的人</div>
            {mentionCandidates.length === 0 && <div className="panel-empty">没有其他成员</div>}
            {mentionCandidates.map((member) => (
              <button
                key={member.id}
                type="button"
                className="mention-option"
                data-testid="mention-option"
                onClick={() => insertMention(member)}
              >
                <Avatar name={member.nickname} avatar={member.avatar} size={26} tone="muted" />
                <span>{member.nickname}</span>
              </button>
            ))}
          </div>
        )}
        {attachOpen && (
          <div className="attach-menu" data-testid="attach-menu">
            <button
              type="button"
              className="attach-option"
              data-testid="attach-image"
              onClick={() => imageInputRef.current?.click()}
            >
              <PhotoIcon />
              图片
            </button>
            <button
              type="button"
              className="attach-option"
              data-testid="attach-file"
              onClick={() => fileInputRef.current?.click()}
            >
              <DocumentIcon />
              文件
            </button>
          </div>
        )}

        {emojiOpen && (
          <div className="emoji-panel" data-testid="emoji-panel">
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="emoji-option"
                data-testid="emoji-option"
                onClick={() => insertEmoji(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        <div className="composer-row">
          {/* WeChat order: the text field sits above the icon/send toolbar. */}
          <textarea
            ref={composerRef}
            data-testid="composer-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={frozen ? '当前窗口已冻结' : '消息'}
            rows={2}
            disabled={frozen}
          />

          <div className="composer-toolbar">
            {isGroup && (
              <button
                type="button"
                className="icon-btn composer-tool"
                data-testid="composer-mention"
                aria-label="@某人"
                title="@某人"
                disabled={frozen}
                onClick={() => {
                  setAttachOpen(false);
                  setEmojiOpen(false);
                  setMentionOpen((open) => !open);
                }}
              >
                <MentionIcon />
              </button>
            )}
            <button
              type="button"
              className="icon-btn composer-tool"
              data-testid="composer-attach"
              aria-label="发送图片或文件"
              title="图片 / 文件"
              disabled={frozen}
              onClick={() => {
                setEmojiOpen(false);
                setAttachOpen((open) => !open);
              }}
            >
              <PlusCircleIcon />
            </button>
            <button
              type="button"
              className="icon-btn composer-tool"
              data-testid="composer-emoji"
              aria-label="表情"
              title="表情"
              disabled={frozen}
              onClick={() => {
                setAttachOpen(false);
                setEmojiOpen((open) => !open);
              }}
            >
              <EmojiIcon />
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              data-testid="composer-send"
              disabled={frozen || sending || draft.trim().length === 0}
            >
              发送
            </button>
          </div>
        </div>

        {/* Hidden pickers driven by the attach menu. */}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          hidden
          data-testid="image-input"
          onChange={onImagePicked}
        />
        <input ref={fileInputRef} type="file" hidden data-testid="file-input" onChange={onFilePicked} />
      </form>

      {previewSrc && (
        <div className="image-preview" data-testid="image-preview" onClick={() => setPreviewSrc(null)}>
          <img src={previewSrc} alt="图片预览" />
        </div>
      )}

      {isGroup && displayGroup && (
        <GroupInfoDialog
          open={groupInfoOpen}
          group={displayGroup}
          members={members}
          myId={myId}
          frozen={frozen}
          presence={presence}
          onClose={() => setGroupInfoOpen(false)}
        />
      )}
    </section>
  );
});
