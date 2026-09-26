import { FormEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { messageApi } from '../lib/api';
import { ApiError, isCancelError } from '../lib/axiosClient';
import { uid } from '../lib/storage';
import { formatClock, formatDayLabel } from '../lib/format';
import { useAppActions } from '../context/AppContext';
import { Avatar } from '../components/Avatar';
import type { ChatMessage, User } from '../types';

/**
 * One conversation.
 *
 * Implements the dual-source strategy: HTTP history is the baseline loaded on
 * mount, and WebSocket frames are the live increment. All message data lives in
 * this component's local state and is destroyed when the conversation changes or
 * the component unmounts.
 *
 * Performance notes:
 *   - this component reads *no* app state from context, only stable actions, and
 *     receives `myId`/`frozen` as props — so a toast or a connection blip cannot
 *     re-render the thread;
 *   - each row is memoized and message objects keep their identity across
 *     updates, so appending one message re-renders exactly one row;
 *   - read receipts are queued and flushed in batches instead of one HTTP call
 *     per incoming message.
 */

interface LocalMessage {
  seq: number;
  id: number;
  clientMsgId: string | null;
  fromUserId: number;
  toUserId: number;
  content: string;
  status: number;
  createdAt: string;
  pending?: boolean;
  failed?: boolean;
}

const PAGE_SIZE = 50;
const PENDING_TIMEOUT_MS = 8000;
/** Incoming messages are coalesced into one read-receipt call per window. */
const READ_FLUSH_MS = 400;

interface ChatWindowProps {
  friendId: number;
  /** Current user id, passed down so this component needs no session context. */
  myId: number;
  /** True while this tab is the non-active (frozen) window. */
  frozen: boolean;
  /**
   * Live entry from the friend list. Preferred over the history snapshot so a
   * peer's nickname/avatar edit shows up immediately; `null` when the peer is no
   * longer in my list (e.g. after a one-way removal), in which case the snapshot
   * from the history response is used instead.
   */
  peerHint?: User | null;
  /** Mobile-only back affordance; the pane is chosen by ChatShell. */
  onBack?: () => void;
}

interface MessageRowProps {
  message: LocalMessage;
  mine: boolean;
  showDay: boolean;
  peerName: string;
  peerAvatar: string | null;
  onRetry: (message: LocalMessage) => void;
}

/**
 * A single bubble. Memoized: message objects keep their identity between
 * updates, so appending a message leaves every other row untouched.
 */
const MessageRow = memo(function MessageRow({
  message,
  mine,
  showDay,
  peerName,
  peerAvatar,
  onRetry,
}: MessageRowProps) {
  return (
    <div>
      {showDay && <div className="day-separator">{formatDayLabel(message.createdAt)}</div>}
      <div className={`bubble-row ${mine ? 'mine' : 'theirs'}`}>
        {!mine && <Avatar name={peerName} avatar={peerAvatar} size={32} tone="muted" />}
        <div className="bubble-column">
          <div className={`bubble ${mine ? 'bubble-mine' : 'bubble-theirs'} ${message.failed ? 'bubble-failed' : ''}`}>
            {message.content}
          </div>
          <div className="bubble-meta">
            {formatClock(message.createdAt)}
            {mine && message.pending && <span className="bubble-state">发送中…</span>}
            {mine && message.failed && (
              <>
                <span className="bubble-state failed">发送失败</span>
                <button type="button" className="bubble-retry" onClick={() => onRetry(message)}>
                  重发
                </button>
              </>
            )}
            {mine && !message.pending && !message.failed && (
              <span className="bubble-state">{message.status >= 2 ? '已读' : '已送达'}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export const ChatWindow = memo(function ChatWindow({ friendId, myId, frozen, peerHint, onBack }: ChatWindowProps) {
  const { subscribeFrames, publishCursor, sendFrame, pushToast } = useAppActions();

  const [peer, setPeer] = useState<User | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const seqRef = useRef(0);
  /** Older pages count *down* so they sort before the live thread. */
  const olderSeqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingTimers = useRef(new Map<string, number>());
  const pendingReadIds = useRef(new Set<number>());
  const readFlushTimer = useRef<number | null>(null);

  const nextSeq = useCallback(() => {
    seqRef.current += 1;
    return seqRef.current;
  }, []);

  const clearPendingTimer = useCallback((clientMsgId: string) => {
    const timer = pendingTimers.current.get(clientMsgId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      pendingTimers.current.delete(clientMsgId);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Read receipts — batched
  // -------------------------------------------------------------------------
  const flushReads = useCallback(() => {
    if (readFlushTimer.current !== null) {
      window.clearTimeout(readFlushTimer.current);
      readFlushTimer.current = null;
    }
    if (pendingReadIds.current.size === 0) return;
    const ids = [...pendingReadIds.current];
    pendingReadIds.current.clear();
    void messageApi.read(ids).catch(() => {
      /* read receipts are best-effort */
    });
  }, []);

  const queueRead = useCallback(
    (ids: number[]) => {
      let added = false;
      for (const id of ids) {
        if (id > 0 && !pendingReadIds.current.has(id)) {
          pendingReadIds.current.add(id);
          added = true;
        }
      }
      if (!added) return;
      // Coalesce a burst into a single call rather than one request per message.
      if (readFlushTimer.current === null) {
        readFlushTimer.current = window.setTimeout(flushReads, READ_FLUSH_MS);
      }
    },
    [flushReads]
  );

  // Never lose the last batch when leaving the thread.
  useEffect(() => () => flushReads(), [flushReads]);

  /** Insert or reconcile a message, keyed by client id then server id. */
  const upsert = useCallback(
    (incoming: ChatMessage) => {
      if (incoming.clientMsgId) clearPendingTimer(incoming.clientMsgId);

      setMessages((previous) => {
        if (incoming.clientMsgId) {
          const index = previous.findIndex((m) => m.clientMsgId && m.clientMsgId === incoming.clientMsgId);
          if (index >= 0) {
            const next = [...previous];
            next[index] = { ...incoming, seq: previous[index].seq };
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
        return [...previous, { ...incoming, seq: nextSeq() }];
      });
    },
    [clearPendingTimer, nextSeq]
  );

  // -------------------------------------------------------------------------
  // Load history whenever the conversation changes (HTTP baseline)
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    seqRef.current = 0;
    olderSeqRef.current = 0;
    pendingTimers.current.forEach((timer) => window.clearTimeout(timer));
    pendingTimers.current.clear();
    flushReads();
    setMessages([]);
    setPeer(null);
    setHasMore(false);
    setDraft('');

    if (!friendId) return undefined;

    setLoading(true);
    messageApi
      .history(friendId, 0, PAGE_SIZE)
      .then((data) => {
        if (cancelled) return;
        setPeer(data.peer);
        setMessages(data.messages.map((message) => ({ ...message, seq: nextSeq() })));
        setHasMore(data.messages.length >= PAGE_SIZE);
        const maxId = data.messages.reduce((acc, m) => (m.id > acc ? m.id : acc), 0);
        if (maxId > 0) publishCursor({ messageId: maxId });
        queueRead(data.messages.filter((m) => m.toUserId === myId && m.status < 2).map((m) => m.id));
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
  }, [friendId, myId, nextSeq, publishCursor, queueRead, pushToast, flushReads]);

  // -------------------------------------------------------------------------
  // Live increment (WebSocket frames, including normalised poll results)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!friendId) return undefined;

    return subscribeFrames((frame) => {
      if (frame.type === 'chat:message') {
        const message = frame.message as ChatMessage | undefined;
        if (!message) return;
        const involves =
          (message.fromUserId === friendId && message.toUserId === myId) ||
          (message.fromUserId === myId && message.toUserId === friendId);
        if (!involves) return;
        upsert(message);
        if (message.toUserId === myId && message.id > 0) queueRead([message.id]);
        return;
      }

      if (frame.type === 'chat:status') {
        const ids = (frame.ids as number[]) ?? [];
        const readerId = Number(frame.readerId);
        if (readerId !== friendId || ids.length === 0) return;
        setMessages((previous) =>
          previous.map((message) => (ids.includes(message.id) ? { ...message, status: 2 } : message))
        );
        return;
      }

      // Keep the header fresh when the peer edits their profile while this
      // conversation is open (the friend-list hint is null for non-friends).
      if (frame.type === 'profile:updated') {
        const updated = frame.user as User | undefined;
        if (!updated || updated.id !== friendId) return;
        setPeer((previous) => (previous ? { ...previous, ...updated } : previous));
      }
    });
  }, [friendId, myId, subscribeFrames, upsert, queueRead]);

  // Keep the view pinned to the newest message.
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, friendId]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const loadOlder = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const oldest = messages.find((message) => message.id > 0);
    if (!oldest) return;
    setLoadingMore(true);
    try {
      const data = await messageApi.history(friendId, oldest.id, PAGE_SIZE);
      setHasMore(data.messages.length >= PAGE_SIZE);
      if (data.messages.length > 0) {
        setMessages((previous) => {
          const known = new Set(previous.map((m) => m.id));
          // Negative, decreasing seqs place older pages ahead of the live thread
          // *without* touching the identity of any existing row.
          const older = data.messages
            .filter((m) => !known.has(m.id))
            .map((m) => ({ ...m, seq: (olderSeqRef.current -= 1) }));
          return older.length === 0 ? previous : [...older, ...previous];
        });
      }
    } catch (error) {
      if (!isCancelError(error)) {
        pushToast({ kind: 'error', title: '加载更早消息失败', body: '请稍后重试' });
      }
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, messages, friendId, pushToast]);

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
    async (clientMsgId: string, content: string) => {
      const viaSocket = sendFrame({ type: 'chat:send', clientMsgId, toUserId: friendId, content });
      if (viaSocket) return; // the server echo reconciles the optimistic entry

      // Socket unavailable -> identical HTTP path (same service on the server).
      setSending(true);
      try {
        const { message } = await messageApi.send(friendId, content, clientMsgId);
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
    [friendId, sendFrame, upsert, pushToast]
  );

  const submit = useCallback(() => {
    const content = draft.trim();
    if (!content || !friendId || sending) return;

    const clientMsgId = uid();
    const optimistic: LocalMessage = {
      seq: nextSeq(),
      id: 0,
      clientMsgId,
      fromUserId: myId,
      toUserId: friendId,
      content,
      status: 0,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    setMessages((previous) => [...previous, optimistic]);
    setDraft('');
    armPendingTimeout(clientMsgId);
    void deliver(clientMsgId, content);
  }, [draft, friendId, sending, myId, nextSeq, armPendingTimeout, deliver]);

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
      setMessages((previous) =>
        previous.map((m) => (m.seq === message.seq ? { ...m, failed: false, pending: true } : m))
      );
      armPendingTimeout(message.clientMsgId);
      void deliver(message.clientMsgId, message.content);
    },
    [armPendingTimeout, deliver]
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const displayPeer = peerHint ?? peer ?? null;
  const peerName = displayPeer?.nickname ?? displayPeer?.username ?? '?';
  const peerAvatar = displayPeer?.avatar ?? null;

  // `messages` is already in seq order in practice; the memo keeps the sort off
  // unrelated re-renders.
  const ordered = useMemo(() => [...messages].sort((a, b) => a.seq - b.seq), [messages]);

  return (
    <section className="chat-window">
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
        <Avatar name={peerName} avatar={peerAvatar} size={38} />
        <div className="chat-header-info">
          <div className="chat-header-name">{displayPeer?.nickname ?? `用户 #${friendId}`}</div>
          <div className="chat-header-sub">@{displayPeer?.username ?? friendId}</div>
        </div>
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        {hasMore && (
          <div className="chat-load-more">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="load-older"
              onClick={loadOlder}
              disabled={loadingMore}
            >
              {loadingMore ? '加载中…' : '加载更早的消息'}
            </button>
          </div>
        )}

        {loading && <div className="chat-placeholder">正在加载历史消息…</div>}

        {!loading && ordered.length === 0 && <div className="chat-placeholder">还没有消息</div>}

        {ordered.map((message, index) => {
          const previous = ordered[index - 1];
          return (
            <MessageRow
              key={message.clientMsgId ?? `m${message.id}`}
              message={message}
              mine={message.fromUserId === myId}
              showDay={!previous || formatDayLabel(previous.createdAt) !== formatDayLabel(message.createdAt)}
              peerName={peerName}
              peerAvatar={peerAvatar}
              onRetry={retry}
            />
          );
        })}
      </div>

      <form className="chat-composer" onSubmit={onSubmit}>
        <textarea
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
        <button
          type="submit"
          className="btn btn-primary"
          data-testid="composer-send"
          disabled={frozen || sending || draft.trim().length === 0}
        >
          发送
        </button>
      </form>
    </section>
  );
});
