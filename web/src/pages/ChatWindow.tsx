import { ChangeEvent, FormEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { attachmentApi, attachmentRawUrl, favoriteApi, friendApi, groupApi, messageApi, type OutgoingMedia } from '../lib/api';
import { ApiError, isCancelError } from '../lib/axiosClient';
import { STORAGE_KEYS } from '../config';
import { idbGet, idbPut } from '../lib/idb';
import { session } from '../lib/session';
import { uid } from '../lib/storage';
import { displayName, formatBytes, formatClock, formatDayLabel, formatLastSeen } from '../lib/format';
import { useAppActions } from '../context/AppContext';
import { Avatar } from '../components/Avatar';
import { ContextMenu } from '../components/ContextMenu';
import { Icon } from '../components/Icon';
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
  type?: 'text' | 'system' | 'image' | 'file' | 'voice';
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
  /** Recalled by its author (content cleared; shows a system hint). */
  recalled?: boolean;
  recalledAt?: string | null;
  quoteId?: number | null;
  quote?: { id: number; content: string | null; type: string; fromUserId: number; recalled: boolean } | null;
}

/** Context-menu anchor for a message (screen coordinates). */
interface MessageMenuState {
  message: LocalMessage;
  x: number;
  y: number;
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
  /** Set by the shell when a 查找聊天记录 result is picked — scroll to it. */
  focusMessageId?: number;
  /** Called once the focus request has been resolved (found or given up). */
  onFocusConsumed?: () => void;
  /** Opens 聊天信息 — the single ⋯ destination. */
  onManage: () => void;
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
  /** Opens the per-message action menu at the pointer. */
  onContextMenu: (message: LocalMessage, x: number, y: number) => void;
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

/**
 * Linkifies http(s) URLs. External links open in a new tab with
 * `rel="noopener noreferrer"` (reverse-tabnabbing defence) and are visually
 * marked so the user can see where a message points before clicking.
 */
const renderText = (content: string, names: string[]): ReactNode => {
  if (names.length > 0) return renderContent(content, names);
  const parts = content.split(/(https?:\/\/[^\s]+)/g);
  if (parts.length === 1) return content;
  return parts.map((part, index) =>
    /^https?:\/\//.test(part) ? (
      <a
        key={`u${index}`}
        className="msg-link"
        href={part}
        target="_blank"
        rel="noopener noreferrer"
        title="外部链接，将在新标签页打开"
        onClick={(event) => event.stopPropagation()}
      >
        {part}
      </a>
    ) : (
      part
    )
  );
};

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

// Composer / attachment glyphs live in `components/Icon` with the rest of the
// set — same 24px grid, same 1.7 stroke, `currentColor`.

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
  onContextMenu,
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

  // A recalled message collapses to a centred hint (no bubble).
  if (message.recalled) {
    return (
      <div>
        {day}
        <div className="chat-system chat-recalled">
          {mine ? '你撤回了一条消息' : `${otherName} 撤回了一条消息`}
        </div>
      </div>
    );
  }

  const quoteBlock = message.quote ? (
    <div className="bubble-quote">
      <span className="bubble-quote-text">
        {message.quote.recalled ? '消息已撤回' : message.quote.content || '[消息]'}
      </span>
    </div>
  ) : null;

  return (
    <div data-message-id={message.id > 0 ? message.id : undefined}>
      {day}
      <div
        className={`bubble-row ${mine ? 'mine' : 'theirs'}`}
        onContextMenu={(event) => {
          if (message.pending || message.failed) return;
          event.preventDefault();
          onContextMenu(message, event.clientX, event.clientY);
        }}
      >
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
            {quoteBlock}
            {message.type === 'voice' ? (
              <div className="bubble-voice">
                {mediaSrc ? (
                  <audio controls preload="metadata" src={mediaSrc} className="voice-audio" />
                ) : (
                  <span className="media-placeholder">语音</span>
                )}
                {message.uploading != null && <span className="media-progress">{message.uploading}%</span>}
              </div>
            ) : message.type === 'image' ? (
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
                  <Icon name="file" size={26} className="file-icon-svg" />
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
              renderText(message.content, mentionNames)
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
  focusMessageId,
  onFocusConsumed,
  onManage,
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
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentioned, setMentioned] = useState<number[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** Full-screen image preview src (null when closed). */
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  /** Right-click action menu anchored at a message. */
  const [menu, setMenu] = useState<MessageMenuState | null>(null);
  /** Message being quoted (引用回复). */
  const [quote, setQuote] = useState<LocalMessage | null>(null);
  /** Message being forwarded (opens the target picker). */
  const [forwardOf, setForwardOf] = useState<LocalMessage | null>(null);
  /** Forward picker source lists (loaded when the picker opens). */
  const [forwardFriends, setForwardFriends] = useState<User[]>([]);
  const [forwardGroups, setForwardGroups] = useState<Group[]>([]);
  const [forwardPicked, setForwardPicked] = useState<Set<string>>(new Set());
  /** Voice recording state. */
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
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
  /** Bounded retries for scrolling to a 查找聊天记录 result (loads older pages). */
  const focusTriesRef = useRef(0);
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
  /** Conversation whose baseline history has loaded (gates 查找聊天记录 focus). */
  const loadedConvRef = useRef<number | null>(null);
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
    loadedConvRef.current = null;
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
    setAttachOpen(false);
    setEmojiOpen(false);
    setPreviewSrc(null);
    setMenu(null);
    setQuote(null);
    setForwardOf(null);
    // Stop any in-progress voice recording when leaving the thread.
    if (recorderRef.current) {
      try {
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      } catch {
        /* ignore */
      }
      recorderRef.current = null;
    }
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
    setHasMore(false);
    setDraft('');
    // A freshly opened thread always starts parked at the newest message.
    atBottomRef.current = true;
    pendingPrependRef.current = null;

    if (!conversationId) return undefined;

    // Instant first paint from the local cache (best-effort; server is truth).
    const cacheKey = `${isGroup ? 'g' : 'd'}:${conversationId}:messages`;
    void idbGet<ChatMessage[]>(cacheKey).then((cached) => {
      if (cached && !cancelled && conversationRef.current === conversationId && cached.length > 0) {
        setMessages(cached.map((message) => ({ ...message, seq: nextSeq() })));
      }
    });

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
        loadedConvRef.current = conversationId;
        // Cache the newest page for an offline / fast first paint next time.
        void idbPut(cacheKey, data.messages.slice(-100));
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

      // 撤回: collapse the bubble to a system hint.
      if (frame.type === 'chat:recalled') {
        const messageId = Number(frame.messageId);
        const involves = isGroup
          ? Number(frame.groupId) === conversationId
          : Number(frame.fromUserId) === conversationId || Number(frame.toUserId) === conversationId;
        if (!messageId || !involves) return;
        setMessages((previous) =>
          previous.map((m) => (m.id === messageId ? { ...m, recalled: true, content: '' } : m))
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
          frame.type === 'group:member_left' ||
          frame.type === 'group:member_updated'
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
    async (clientMsgId: string, content: string, mentions: number[], quoteId?: number | null) => {
      const viaSocket = sendFrame(
        isGroup
          ? { type: 'chat:send', clientMsgId, groupId: conversationId, content, mentions, ...(quoteId ? { quoteId } : {}) }
          : { type: 'chat:send', clientMsgId, toUserId: conversationId, content, ...(quoteId ? { quoteId } : {}) }
      );
      if (viaSocket) return; // the server echo reconciles the optimistic entry

      // Socket unavailable -> identical HTTP path (same service on the server).
      setSending(true);
      try {
        const { message } = isGroup
          ? await messageApi.sendToGroup(conversationId, content, clientMsgId, mentions, undefined, quoteId ?? undefined)
          : await messageApi.send(conversationId, content, clientMsgId, undefined, quoteId ?? undefined);
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

  /** Uploads a recorded voice clip and sends it (语音消息). */
  const sendVoice = useCallback(
    async (blob: Blob) => {
      if (!conversationId || blob.size === 0) return;
      const clientMsgId = uid();
      const mime = blob.type || 'audio/webm';
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: mime });
      const localUrl = URL.createObjectURL(blob);
      trackObjectUrl(localUrl);
      const optimistic: LocalMessage = {
        seq: nextSeq(),
        id: 0,
        clientMsgId,
        fromUserId: myId,
        toUserId: isGroup ? 0 : conversationId,
        groupId: isGroup ? conversationId : null,
        type: 'voice',
        attachment: { id: 0, kind: 'voice', name: '语音', size: blob.size, mime },
        localUrl,
        uploading: 0,
        content: '[语音]',
        status: 0,
        createdAt: new Date().toISOString(),
        pending: true,
      };
      setMessages((previous) => capMessages([...previous, optimistic]));
      beginPending(clientMsgId);
      try {
        const { attachment } = await attachmentApi.upload(
          file,
          (percent) => setMessages((previous) => previous.map((m) => (m.clientMsgId === clientMsgId ? { ...m, uploading: percent } : m))),
          'voice'
        );
        setMessages((previous) =>
          previous.map((m) => (m.clientMsgId === clientMsgId ? { ...m, attachment, uploading: undefined } : m))
        );
        armPendingTimeout(clientMsgId);
        await deliverMedia(clientMsgId, { type: 'voice', attachmentId: attachment.id });
      } catch (error) {
        setMessages((previous) =>
          previous.map((m) => (m.clientMsgId === clientMsgId ? { ...m, pending: false, failed: true, uploading: undefined } : m))
        );
        pushToast({ kind: 'error', title: '语音发送失败', body: error instanceof ApiError ? error.message : undefined });
      }
    },
    [conversationId, isGroup, myId, nextSeq, beginPending, armPendingTimeout, deliverMedia, pushToast, trackObjectUrl]
  );

  const startRecording = useCallback(async () => {
    if (recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      pushToast({ kind: 'warning', title: '当前浏览器不支持录音' });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(recordChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size > 0) void sendVoice(blob);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      pushToast({ kind: 'error', title: '无法访问麦克风', body: '请在浏览器设置中允许麦克风权限' });
    }
  }, [recording, pushToast, sendVoice]);

  const stopRecording = useCallback((cancel = false) => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
    if (!recorder) return;
    if (cancel) {
      recorder.onstop = () => {
        recorder.stream.getTracks().forEach((track) => track.stop());
      };
      recordChunksRef.current = [];
    }
    if (recorder.state !== 'inactive') recorder.stop();
  }, []);

  // Release the microphone if the window unmounts mid-recording.
  useEffect(() => () => stopRecording(true), [stopRecording]);

  const submit = useCallback(() => {
    const content = draft.trim();
    if (!content || !conversationId || sending) return;

    const clientMsgId = uid();
    const mentions = isGroup ? mentioned : [];
    const quoteId = quote?.id && quote.id > 0 ? quote.id : null;
    const optimistic: LocalMessage = {
      seq: nextSeq(),
      id: 0,
      clientMsgId,
      fromUserId: myId,
      toUserId: isGroup ? 0 : conversationId,
      groupId: isGroup ? conversationId : null,
      type: 'text',
      mentions,
      quoteId,
      quote: quote
        ? { id: quote.id, content: quote.content, type: quote.type ?? 'text', fromUserId: quote.fromUserId, recalled: Boolean(quote.recalled) }
        : null,
      content,
      status: 0,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((previous) => capMessages([...previous, optimistic]));
    setDraft('');
    setMentioned([]);
    setMentionOpen(false);
    setQuote(null);
    beginPending(clientMsgId);
    armPendingTimeout(clientMsgId);
    void deliver(clientMsgId, content, mentions, quoteId);
  }, [draft, conversationId, sending, myId, isGroup, mentioned, quote, nextSeq, beginPending, armPendingTimeout, deliver]);

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
  // Message actions (context menu: 撤回 / 引用 / 转发 / 复制 / 收藏 / 删除)
  // -------------------------------------------------------------------------
  const openMessageMenu = useCallback((message: LocalMessage, x: number, y: number) => {
    setMenu({ message, x, y });
  }, []);

  const closeMessageMenu = useCallback(() => setMenu(null), []);

  const recallMessage = useCallback(
    async (message: LocalMessage) => {
      setMenu(null);
      try {
        await messageApi.recall(message.id);
        setMessages((previous) =>
          previous.map((m) => (m.id === message.id ? { ...m, recalled: true, content: '' } : m))
        );
      } catch (error) {
        pushToast({ kind: 'error', title: '撤回失败', body: error instanceof ApiError ? error.message : undefined });
      }
    },
    [pushToast]
  );

  const deleteMessage = useCallback((message: LocalMessage) => {
    setMenu(null);
    // Local-first: remove immediately, persist in the background.
    setMessages((previous) => previous.filter((m) => m.id !== message.id || m.id === 0));
    void messageApi.remove(message.id).catch(() => {});
  }, []);

  const copyMessage = useCallback(
    async (message: LocalMessage) => {
      setMenu(null);
      try {
        await navigator.clipboard.writeText(message.content);
        pushToast({ kind: 'success', title: '已复制' });
      } catch {
        pushToast({ kind: 'warning', title: '复制失败，请手动选择文本' });
      }
    },
    [pushToast]
  );

  const favoriteMessage = useCallback(
    async (message: LocalMessage) => {
      setMenu(null);
      try {
        await favoriteApi.add(message.id, `${isGroup ? 'g' : 'd'}:${conversationId}`);
        pushToast({ kind: 'success', title: '已收藏' });
      } catch (error) {
        pushToast({ kind: 'error', title: '收藏失败', body: error instanceof ApiError ? error.message : undefined });
      }
    },
    [conversationId, isGroup, pushToast]
  );

  const startQuote = useCallback((message: LocalMessage) => {
    setMenu(null);
    setQuote(message);
    composerRef.current?.focus();
  }, []);

  const startForward = useCallback((message: LocalMessage) => {
    setMenu(null);
    setForwardPicked(new Set());
    setForwardOf(message);
  }, []);

  // Load the friend/group targets when the forward picker opens.
  useEffect(() => {
    if (!forwardOf) return undefined;
    let cancelled = false;
    void friendApi.list().then((r) => !cancelled && setForwardFriends(r.friends)).catch(() => {});
    void groupApi.list().then((r) => !cancelled && setForwardGroups(r.groups)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [forwardOf]);

  const toggleForwardPick = useCallback((key: string) => {
    setForwardPicked((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const doForward = useCallback(
    async (targetUserIds: number[], targetGroupIds: number[]) => {
      const message = forwardOf;
      setForwardOf(null);
      if (!message || message.id <= 0) return;
      try {
        const result = await messageApi.forward(message.id, targetUserIds, targetGroupIds);
        pushToast({ kind: 'success', title: `已转发给 ${result.forwarded} 个会话` });
      } catch (error) {
        pushToast({ kind: 'error', title: '转发失败', body: error instanceof ApiError ? error.message : undefined });
      }
    },
    [forwardOf, pushToast]
  );

  const confirmForward = useCallback(() => {
    const userIds: number[] = [];
    const groupIds: number[] = [];
    for (const key of forwardPicked) {
      const [kind, id] = key.split(':');
      if (kind === 'd') userIds.push(Number(id));
      else groupIds.push(Number(id));
    }
    if (userIds.length + groupIds.length === 0) return;
    void doForward(userIds, groupIds);
  }, [forwardPicked, doForward]);

  const onContextMenu = useCallback(
    (message: LocalMessage, x: number, y: number) => openMessageMenu(message, x, y),
    [openMessageMenu]
  );

  // -------------------------------------------------------------------------
  // Focus a message chosen in 查找聊天记录 — load older pages until it appears.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!focusMessageId) return;
    // Wait until THIS conversation's baseline page has loaded — otherwise a
    // switch-in would scan the previous conversation's rows (and could fetch
    // older pages with a stale cursor).
    if (loadedConvRef.current !== conversationId) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${focusMessageId}"]`);
    if (element) {
      element.scrollIntoView({ block: 'center' });
      element.classList.add('msg-focus');
      window.setTimeout(() => element.classList.remove('msg-focus'), 2000);
      focusTriesRef.current = 0;
      onFocusConsumed?.();
      return;
    }
    if (loadingMore) return; // wait for the in-flight page
    if (hasMore && focusTriesRef.current < 10) {
      focusTriesRef.current += 1;
      void loadOlder();
      return;
    }
    // Not in the loaded window (or predates a clear) — give up loudly.
    focusTriesRef.current = 0;
    pushToast({ kind: 'info', title: '无法定位该消息' });
    onFocusConsumed?.();
  }, [focusMessageId, conversationId, messages, hasMore, loadingMore, loadOlder, onFocusConsumed, pushToast]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const displayPeer = peerHint ?? peer ?? null;
  const displayGroup = groupHint ?? group ?? null;
  const peerName = displayPeer ? displayName(displayPeer) : '?';
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
    if (message.type !== 'image' && message.type !== 'file' && message.type !== 'voice') return null;
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
          <Icon name="chevron-left" size={20} />
        </button>
        <Avatar name={isGroup ? groupName : peerName} avatar={isGroup ? groupAvatar : peerAvatar} size={38} />
        <div className="chat-header-info">
          <div className="chat-header-name">
            {isGroup ? groupName : displayPeer ? displayName(displayPeer) : `用户 #${conversationId}`}
          </div>
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
        {/* Everything conversation-wide lives in 聊天信息 now — one entry
            point, like WeChat's ⋯, instead of three header buttons. */}
        <button
          type="button"
          className="icon-btn chat-header-action chat-manage"
          data-testid="chat-manage-open"
          title="聊天信息"
          aria-label="聊天信息"
          onClick={onManage}
        >
          <Icon name="more" size={20} />
        </button>
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
              onContextMenu={onContextMenu}
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
        {quote && (
          <div className="composer-quote" data-testid="composer-quote">
            <span className="composer-quote-text">
              引用：{quote.recalled ? '消息已撤回' : (quote.content || '[消息]').slice(0, 80)}
            </span>
            <button
              type="button"
              className="icon-btn composer-quote-close"
              aria-label="取消引用"
              onClick={() => setQuote(null)}
            >
              ×
            </button>
          </div>
        )}
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
              <Icon name="image" size={18} className="attach-icon" />
              图片
            </button>
            <button
              type="button"
              className="attach-option"
              data-testid="attach-file"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="file" size={18} className="attach-icon" />
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
            maxLength={2000}
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
                <Icon name="mention" size={22} className="composer-icon" />
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
              <Icon name="plus-circle" size={22} className="composer-icon" />
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
              <Icon name="emoji" size={22} className="composer-icon" />
            </button>
            <button
              type="button"
              className={`icon-btn composer-tool ${recording ? 'recording' : ''}`}
              data-testid="composer-voice"
              aria-label={recording ? `停止录音 ${recordSeconds}s` : '录音'}
              title={recording ? '点击停止录音' : '录音'}
              disabled={frozen}
              onClick={() => (recording ? stopRecording(false) : void startRecording())}
            >
              {recording ? (
                <>
                  <Icon name="record" size={14} />
                  {recordSeconds}s
                </>
              ) : (
                <Icon name="mic" size={20} />
              )}
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

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={closeMessageMenu} testId="msg-menu">
          {menu.message.fromUserId === myId &&
            !menu.message.recalled &&
            menu.message.id > 0 &&
            Date.now() - new Date(menu.message.createdAt).getTime() < 2 * 60 * 1000 && (
              <button type="button" className="msg-menu-item" onClick={() => void recallMessage(menu.message)}>
                撤回
              </button>
            )}
          <button type="button" className="msg-menu-item" onClick={() => startQuote(menu.message)}>
            引用回复
          </button>
          <button type="button" className="msg-menu-item" onClick={() => startForward(menu.message)}>
            转发
          </button>
          {menu.message.type !== 'image' && menu.message.type !== 'file' && (
            <button type="button" className="msg-menu-item" onClick={() => void copyMessage(menu.message)}>
              复制
            </button>
          )}
          {menu.message.id > 0 && (
            <button type="button" className="msg-menu-item" onClick={() => void favoriteMessage(menu.message)}>
              收藏
            </button>
          )}
          <button type="button" className="msg-menu-item danger" onClick={() => deleteMessage(menu.message)}>
            删除
          </button>
        </ContextMenu>
      )}

      {forwardOf && (
        <div className="dialog-overlay" onMouseDown={() => setForwardOf(null)} data-testid="forward-dialog">
          <div className="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <header className="dialog-head">
              <span className="dialog-title">转发给</span>
              <button type="button" className="icon-btn" onClick={() => setForwardOf(null)} aria-label="关闭">
                ×
              </button>
            </header>
            <div className="dialog-body">
              {forwardFriends.length === 0 && forwardGroups.length === 0 && (
                <div className="panel-empty">还没有可转发的会话</div>
              )}
              {forwardFriends.length > 0 && (
                <>
                  <div className="forward-section-title">好友</div>
                  {forwardFriends.map((friend) => {
                    const key = `d:${friend.id}`;
                    return (
                      <label key={key} className="forward-row">
                        <input
                          type="checkbox"
                          checked={forwardPicked.has(key)}
                          onChange={() => toggleForwardPick(key)}
                        />
                        <Avatar name={displayName(friend)} avatar={friend.avatar} size={30} />
                        <span>{displayName(friend)}</span>
                      </label>
                    );
                  })}
                </>
              )}
              {forwardGroups.length > 0 && (
                <>
                  <div className="forward-section-title">群聊</div>
                  {forwardGroups.map((grp) => {
                    const key = `g:${grp.id}`;
                    return (
                      <label key={key} className="forward-row">
                        <input
                          type="checkbox"
                          checked={forwardPicked.has(key)}
                          onChange={() => toggleForwardPick(key)}
                        />
                        <Avatar name={grp.name} avatar={grp.avatar} size={30} />
                        <span>{grp.name}</span>
                      </label>
                    );
                  })}
                </>
              )}
            </div>
            <footer className="dialog-foot">
              <button type="button" className="btn" onClick={() => setForwardOf(null)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="forward-confirm"
                disabled={forwardPicked.size === 0}
                onClick={confirmForward}
              >
                转发
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
});
