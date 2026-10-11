import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { friendApi } from '../lib/api';
import { ApiError, isCancelError } from '../lib/axiosClient';
import { convKey } from '../lib/conversation';
import { displayName } from '../lib/format';
import { useAppActions } from '../context/AppContext';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { PresenceAvatar } from '../components/PresenceAvatar';
import type { FriendRequest, User } from '../types';

interface FriendsPanelProps {
  friends: User[];
  requests: FriendRequest[];
  /** Unread counts keyed by conversation key (`d:<id>`). */
  unread: Record<string, number>;
  /** Live presence, keyed by user id. */
  presence: Record<number, boolean>;
  onRespond: (requestId: number, action: 'accept' | 'reject') => Promise<void>;
  /** Opens 好友资料 in the main pane (WeChat: the row is the profile, not the chat). */
  onOpenProfile: (friendId: number) => void;
  /** Jumps to the group list (the 「群聊」 shortcut row). */
  onOpenGroups: () => void;
  /** One-way removal: drops the friend from MY list only. */
  onRemove: (friend: User) => Promise<void>;
  /** True while this tab is the non-active (frozen) window. */
  frozen: boolean;
}

const byNickname = (a: User, b: User) => displayName(a).localeCompare(displayName(b), 'zh-CN');

/** Section letter for the alphabet index: A–Z, everything else under `#`. */
const initialOf = (name: string): string => {
  const ch = (name ?? '').trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(ch) ? ch : '#';
};

/**
 * Contacts (通讯录).
 *
 * WeChat-shaped: a search box, two shortcut rows (新的朋友 / 群聊), then the
 * friend list grouped under sticky letter headers with a right-edge A–Z index.
 * Incoming friend requests live on their own 「新的朋友」 sub-page rather than
 * being expanded inline — the whole list stays scannable.
 */
export const FriendsPanel = memo(function FriendsPanel({
  friends,
  requests,
  unread,
  presence,
  onRespond,
  onOpenProfile,
  onOpenGroups,
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
  const [sub, setSub] = useState<'list' | 'requests'>('list');
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

    return () => {
      window.clearTimeout(timer);
      // Cancel the in-flight query too, so leaving the panel (or typing again)
      // never leaves an orphaned request resolving into a dead component.
      abortRef.current?.abort();
    };
  }, [keyword, pushToast]);

  const sendRequest = async (target: User) => {
    try {
      const result = await friendApi.sendRequest(target.id);
      if (result.outcome === 'auto-accepted') {
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

  // Group by initial letter; letters sort A→Z with `#` last.
  const sections = useMemo(() => {
    const map = new Map<string, User[]>();
    for (const friend of sortedFriends) {
      const letter = initialOf(friend.nickname);
      const bucket = map.get(letter);
      if (bucket) bucket.push(friend);
      else map.set(letter, [friend]);
    }
    return [...map.entries()].sort(([a], [b]) =>
      a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)
    );
  }, [sortedFriends]);

  const jumpTo = (letter: string) => {
    document.getElementById(`contact-sec-${letter}`)?.scrollIntoView({ block: 'start' });
  };

  const renderFriendRow = (friend: User) => {
    if (confirmingId === friend.id) {
      return (
        <div key={friend.id} className="list-row row-confirm" data-testid="friend-row" data-friend-id={friend.id}>
          <PresenceAvatar
            name={displayName(friend)}
            avatar={friend.avatar}
            size={40}
            online={presence[friend.id] ?? Boolean(friend.online)}
          />
          <div className="list-row-text">
            <div className="list-row-title">{displayName(friend)}</div>
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
      );
    }

    const unreadCount = unread[convKey.direct(friend.id)] ?? 0;
    return (
      <div key={friend.id} className="list-row" data-testid="friend-row" data-friend-id={friend.id}>
        <button
          type="button"
          className="list-row-main clickable"
          data-testid="friend-open"
          onClick={() => onOpenProfile(friend.id)}
          disabled={frozen}
        >
          <PresenceAvatar
            name={displayName(friend)}
            avatar={friend.avatar}
            size={40}
            online={presence[friend.id] ?? Boolean(friend.online)}
          />
          <span className="list-row-text">
            <span className="list-row-title">{displayName(friend)}</span>
          </span>
          {unreadCount > 0 && (
            <span className="badge badge-unread">{unreadCount > 99 ? '99+' : unreadCount}</span>
          )}
        </button>
        <button
          type="button"
          className="icon-btn contact-remove"
          data-testid="friend-row-remove"
          aria-label="移除好友"
          title="仅从我的列表移除；对方仍保留你，双方仍可继续聊天"
          disabled={frozen}
          onClick={() => setConfirmingId(friend.id)}
        >
          ×
        </button>
      </div>
    );
  };

  // --- 「新的朋友」 sub-page ------------------------------------------------
  if (sub === 'requests') {
    return (
      <div className="contacts-panel" data-testid="contacts-requests">
        <header className="contacts-sub-head">
          <button
            type="button"
            className="icon-btn"
            data-testid="contacts-back"
            aria-label="返回"
            onClick={() => setSub('list')}
          >
            <Icon name="chevron-left" size={20} />
          </button>
          <span className="contacts-sub-title">新的朋友</span>
        </header>
        <div className="contacts-scroll">
          {incoming.length === 0 && outgoing.length === 0 && <div className="panel-empty">暂无新的朋友</div>}

          {incoming.map((request) => (
            <div key={request.id} className="list-row" data-testid="incoming-request">
              <Avatar name={request.peer.nickname} avatar={request.peer.avatar} size={40} tone="muted" />
              <div className="list-row-text">
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
              <Avatar name={request.peer.nickname} avatar={request.peer.avatar} size={40} tone="muted" />
              <div className="list-row-text">
                <div className="list-row-title">{request.peer.nickname}</div>
                <div className="list-row-sub">等待对方确认…</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const searchActive = keyword.trim().length > 0;

  return (
    <div className="contacts-panel">
      <div className="contacts-head">
        <input
          className="contacts-search"
          data-testid="search-input"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索"
          disabled={frozen}
        />
        {searching && <span className="search-spinner">…</span>}
      </div>

      <div className="contacts-scroll">
        {searchActive ? (
          <>
            <div className="panel-title">搜索结果</div>
            {results.length === 0 && !searching && <div className="panel-empty">没有找到匹配的用户</div>}
            {results.map((candidate) => (
              <div key={candidate.id} className="list-row" data-testid="search-result-row">
                <Avatar name={candidate.nickname} avatar={candidate.avatar} size={40} tone="muted" />
                <div className="list-row-text">
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
          </>
        ) : (
          <>
            <button
              type="button"
              className="entry-row"
              data-testid="new-friends-entry"
              disabled={frozen}
              onClick={() => setSub('requests')}
            >
              <span className="entry-icon entry-icon-new" aria-hidden="true">
                <Icon name="plus" size={20} />
              </span>
              <span className="entry-title">新的朋友</span>
              {incoming.length > 0 && (
                <span className="badge badge-unread">{incoming.length > 99 ? '99+' : incoming.length}</span>
              )}
              <span className="entry-chevron" aria-hidden="true">
                <Icon name="chevron-right" size={16} />
              </span>
            </button>

            <button
              type="button"
              className="entry-row"
              data-testid="contacts-groups-entry"
              disabled={frozen}
              onClick={onOpenGroups}
            >
              <span className="entry-icon entry-icon-groups" aria-hidden="true">
                <Icon name="group" size={20} />
              </span>
              <span className="entry-title">群聊</span>
              <span className="entry-chevron" aria-hidden="true">
                <Icon name="chevron-right" size={16} />
              </span>
            </button>

            {sortedFriends.length === 0 ? (
              <div className="panel-empty">通讯录还是空的，去「新的朋友」添加</div>
            ) : (
              sections.map(([letter, list]) => (
                <section key={letter} className="contacts-group" id={`contact-sec-${letter}`}>
                  <div className="contacts-group-title">{letter}</div>
                  {list.map(renderFriendRow)}
                </section>
              ))
            )}

            {sortedFriends.length > 0 && (
              <div className="contacts-count">共 {sortedFriends.length} 位朋友</div>
            )}
          </>
        )}
      </div>

      {!searchActive && sections.length > 1 && (
        <div className="alpha-index" aria-label="字母索引">
          {sections.map(([letter]) => (
            <button key={letter} type="button" onClick={() => jumpTo(letter)}>
              {letter}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
