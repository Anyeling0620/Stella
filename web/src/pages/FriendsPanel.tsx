import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { friendApi } from '../lib/api';
import { ApiError, isCancelError } from '../lib/axiosClient';
import { convKey } from '../lib/conversation';
import { useAppActions } from '../context/AppContext';
import { Avatar } from '../components/Avatar';
import type { FriendRequest, User } from '../types';

interface FriendsPanelProps {
  friends: User[];
  requests: FriendRequest[];
  /** Unread counts keyed by conversation key (`d:<id>`). */
  unread: Record<string, number>;
  onRespond: (requestId: number, action: 'accept' | 'reject') => Promise<void>;
  onOpenConversation: (friendId: number) => void;
  /** One-way removal: drops the friend from MY list only. */
  onRemove: (friend: User) => Promise<void>;
  /** True while this tab is the non-active (frozen) window. */
  frozen: boolean;
}

const byNickname = (a: User, b: User) => a.nickname.localeCompare(b.nickname, 'zh-CN');

/**
 * Friend discovery, requests, and list management.
 *
 * Search is debounced and the previous query is explicitly aborted, so a slow
 * response can never overwrite a newer one.
 */
export const FriendsPanel = memo(function FriendsPanel({
  friends,
  requests,
  unread,
  onRespond,
  onOpenConversation,
  onRemove,
  frozen,
}: FriendsPanelProps) {
  const { pushToast } = useAppActions();

  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [requested, setRequested] = useState<Set<number>>(new Set());
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Debounced search with explicit race cancellation of the previous query.
  useEffect(() => {
    const term = keyword.trim();
    if (term.length === 0) {
      abortRef.current?.abort();
      setResults([]);
      setSearching(false);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setSearching(true);
      friendApi
        .search(term, controller.signal)
        .then((data) => setResults(data.users))
        .catch((error) => {
          if (!isCancelError(error)) {
            pushToast({ kind: 'error', title: '搜索失败', body: error instanceof ApiError ? error.message : '' });
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [keyword, pushToast]);

  const sendRequest = async (target: User) => {
    try {
      const result = await friendApi.sendRequest(target.id);
      if (result.outcome === 'auto-accepted') {
        // The peer had already requested us: the friendship is live now (their
        // list updates from the WS push), so don't claim we are still waiting.
        pushToast({ kind: 'success', title: '好友添加成功', body: `你和 ${target.nickname} 已成为好友` });
        return;
      }
      setRequested((previous) => new Set(previous).add(target.id));
      pushToast({ kind: 'success', title: '好友申请已发送', body: `等待 ${target.nickname} 确认` });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '发送好友申请失败',
        body: error instanceof ApiError ? error.message : '请稍后重试',
      });
    }
  };

  const confirmRemove = async (friend: User) => {
    if (removing) return;
    setRemoving(true);
    try {
      await onRemove(friend);
      setConfirmingId(null);
    } finally {
      setRemoving(false);
    }
  };

  const incoming = useMemo(() => requests.filter((r) => r.direction === 'incoming'), [requests]);
  const outgoing = useMemo(() => requests.filter((r) => r.direction === 'outgoing'), [requests]);
  const sortedFriends = useMemo(() => [...friends].sort(byNickname), [friends]);

  return (
    <div className="friends-panel">
      <div className="search-box">
        <input
          data-testid="search-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索"
          disabled={frozen}
        />
        {searching && <span className="search-spinner">…</span>}
      </div>

      {keyword.trim().length > 0 && (
        <div className="panel-section">
          <div className="panel-title">搜索结果</div>
          {results.length === 0 && !searching && <div className="panel-empty">没有找到匹配的用户</div>}
          {results.map((candidate) => (
            <div key={candidate.id} className="list-row" data-testid="search-result-row">
              <Avatar name={candidate.nickname} avatar={candidate.avatar} size={34} tone="muted" />
              <div className="list-row-main">
                <div className="list-row-title">{candidate.nickname}</div>
                <div className="list-row-sub">@{candidate.username}</div>
              </div>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                data-testid="add-friend"
                disabled={frozen || requested.has(candidate.id) || candidate.isFriend}
                onClick={() => void sendRequest(candidate)}
              >
                {requested.has(candidate.id) ? '已申请' : '添加'}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="panel-section">
        <div className="panel-title">
          好友申请
          {incoming.length > 0 && <span className="badge">{incoming.length}</span>}
        </div>
        {incoming.length === 0 && outgoing.length === 0 && <div className="panel-empty">暂无好友申请</div>}
        {incoming.map((request) => (
          <div key={request.id} className="list-row" data-testid="incoming-request">
            <Avatar name={request.peer.nickname} avatar={request.peer.avatar} size={34} tone="muted" />
            <div className="list-row-main">
              <div className="list-row-title">{request.peer.nickname}</div>
              <div className="list-row-sub">{request.message || '请求添加你为好友'}</div>
            </div>
            <div className="list-row-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={frozen}
                onClick={() => void onRespond(request.id, 'accept')}
              >
                同意
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={frozen}
                onClick={() => void onRespond(request.id, 'reject')}
              >
                拒绝
              </button>
            </div>
          </div>
        ))}
        {outgoing.map((request) => (
          <div key={request.id} className="list-row muted">
            <Avatar name={request.peer.nickname} avatar={request.peer.avatar} size={34} tone="muted" />
            <div className="list-row-main">
              <div className="list-row-title">{request.peer.nickname}</div>
              <div className="list-row-sub">等待对方确认…</div>
            </div>
          </div>
        ))}
      </div>

      <div className="panel-section">
        <div className="panel-title">我的好友（{sortedFriends.length}）</div>
        {sortedFriends.length === 0 && <div className="panel-empty">还没有好友</div>}
        {sortedFriends.map((friend) =>
          confirmingId === friend.id ? (
            <div key={friend.id} className="list-row row-confirm" data-testid="friend-row" data-friend-id={friend.id}>
              <Avatar name={friend.nickname} avatar={friend.avatar} size={34} />
              <div className="list-row-main">
                <div className="list-row-title">{friend.nickname}</div>
                <div className="list-row-sub">仅从我的列表移除</div>
              </div>
              <div className="list-row-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  data-testid="friend-remove-confirm"
                  disabled={frozen || removing}
                  onClick={() => void confirmRemove(friend)}
                >
                  移除
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={frozen || removing}
                  onClick={() => setConfirmingId(null)}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <div key={friend.id} className="list-row" data-testid="friend-row" data-friend-id={friend.id}>
              <button
                type="button"
                className="list-row-main clickable"
                data-testid="friend-open"
                onClick={() => onOpenConversation(friend.id)}
                disabled={frozen}
              >
                <Avatar name={friend.nickname} avatar={friend.avatar} size={34} />
                <span className="list-row-text">
                  <span className="list-row-title">{friend.nickname}</span>
                  <span className="list-row-sub">@{friend.username}</span>
                </span>
                {(unread[convKey.direct(friend.id)] ?? 0) > 0 && (
                  <span className="badge badge-unread">{unread[convKey.direct(friend.id)]}</span>
                )}
              </button>
              <button
                type="button"
                className="icon-btn"
                data-testid="friend-row-remove"
                aria-label="移除好友"
                title="仅从我的列表移除；对方仍保留你，双方仍可继续聊天"
                disabled={frozen}
                onClick={() => setConfirmingId(friend.id)}
              >
                ×
              </button>
            </div>
          )
        )}
      </div>
    </div>
  );
});
