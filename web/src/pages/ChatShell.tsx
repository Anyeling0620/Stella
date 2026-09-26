import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { friendApi } from '../lib/api';
import { ApiError, isCancelError } from '../lib/axiosClient';
import { formatDateTime } from '../lib/format';
import { useAppActions, useAppRealtime, useAppSession } from '../context/AppContext';
import { Avatar } from '../components/Avatar';
import { StatusPill } from '../components/StatusPill';
import { ProfileDialog } from '../components/ProfileDialog';
import { ChatWindow } from './ChatWindow';
import { FriendsPanel } from './FriendsPanel';
import type { ChatMessage, FriendRequest, SystemNotice, User } from '../types';

const byNickname = (a: User, b: User) => a.nickname.localeCompare(b.nickname, 'zh-CN');

/**
 * Authenticated application shell.
 *
 * Owns the *page-local* business data (friend list, pending requests, unread
 * counters, latest system notice). All of it is created on mount and released on
 * unmount — the global context holds none of it.
 */
export function ChatShell() {
  const navigate = useNavigate();
  // Only the slices this component actually reads — a toast or a connection
  // blip must not re-render the shell (and therefore the message list).
  const { user, isAuthenticated, activeConversationId } = useAppSession();
  const { isFrozen } = useAppRealtime();
  const {
    signOut,
    updateUser,
    setActiveConversationId,
    subscribeFrames,
    subscribeNotices,
    pushToast,
  } = useAppActions();

  const [friends, setFriends] = useState<User[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [unread, setUnread] = useState<Record<number, number>>({});
  const [view, setView] = useState<'chats' | 'friends'>('chats');
  const [latestNotice, setLatestNotice] = useState<SystemNotice | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);

  // Refs let the frame handler read fresh values without re-subscribing.
  // Written in effects rather than during render (render-phase ref writes break
  // under concurrent rendering).
  const activeRef = useRef<number | null>(activeConversationId);
  const friendsRef = useRef<User[]>(friends);
  useEffect(() => {
    activeRef.current = activeConversationId;
  }, [activeConversationId]);
  useEffect(() => {
    friendsRef.current = friends;
  }, [friends]);

  useEffect(() => {
    if (!isAuthenticated) navigate('/login', { replace: true });
  }, [isAuthenticated, navigate]);

  const loadFriends = useCallback(async () => {
    try {
      const data = await friendApi.list();
      setFriends(data.friends);
    } catch (error) {
      // A superseded request is aborted by the request layer (StrictMode
      // double-mounts the effect, and a reload cancels the previous load).
      // That is normal traffic, never a user-facing failure.
      if (isCancelError(error)) return;
      pushToast({
        kind: 'error',
        title: '加载好友列表失败',
        body: error instanceof ApiError ? error.message : '请稍后重试',
      });
    }
  }, [pushToast]);

  const loadRequests = useCallback(async () => {
    try {
      const data = await friendApi.requests();
      setRequests(data.requests);
    } catch (error) {
      if (isCancelError(error)) return;
      if (error instanceof ApiError && error.code === 'SESSION_REVOKED') return;
      pushToast({ kind: 'error', title: '加载好友申请失败', body: '请稍后重试' });
    }
  }, [pushToast]);

  // HTTP initialisation on mount (存量数据).
  useEffect(() => {
    if (!isAuthenticated) return;
    void loadFriends();
    void loadRequests();
  }, [isAuthenticated, loadFriends, loadRequests]);

  // Release all page state when the user logs out.
  useEffect(() => {
    if (!isAuthenticated) {
      setFriends([]);
      setRequests([]);
      setUnread({});
      setLatestNotice(null);
      setProfileOpen(false);
    }
  }, [isAuthenticated]);

  const dropFriendLocally = useCallback(
    (friendId: number) => {
      setFriends((previous) => previous.filter((item) => item.id !== friendId));
      setUnread((previous) => {
        if (!(friendId in previous)) return previous;
        const next = { ...previous };
        delete next[friendId];
        return next;
      });
      if (activeRef.current === friendId) setActiveConversationId(null);
    },
    [setActiveConversationId]
  );

  // --- page message subscription bus (friend + profile events) --------------
  useEffect(() => {
    if (!isAuthenticated) return undefined;

    return subscribeFrames((frame) => {
      if (frame.type === 'friend:request') {
        const request = frame.request as FriendRequest;
        setRequests((previous) =>
          previous.some((item) => item.id === request.id) ? previous : [request, ...previous]
        );
        pushToast({
          kind: 'info',
          title: '新的好友申请',
          body: `${request.peer.nickname}：${request.message || '请求添加你为好友'}`,
        });
        return;
      }

      if (frame.type === 'friend:accepted') {
        const friend = frame.friend as User;
        setFriends((previous) =>
          previous.some((item) => item.id === friend.id) ? previous : [...previous, friend].sort(byNickname)
        );
        setRequests((previous) => previous.filter((item) => item.peer.id !== friend.id));
        pushToast({ kind: 'success', title: '好友添加成功', body: `你和 ${friend.nickname} 已成为好友` });
        return;
      }

      // A one-way removal emits this to MY tabs only.
      if (frame.type === 'friend:removed') {
        dropFriendLocally(Number(frame.friendId));
        return;
      }

      // Nickname / avatar changes: mine update the session, a friend's update
      // their entry so every list and header re-renders immediately.
      if (frame.type === 'profile:updated') {
        const updated = frame.user as User | undefined;
        if (!updated) return;
        if (user && updated.id === user.id) updateUser(updated);
        else setFriends((previous) => previous.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
        return;
      }

      if (frame.type === 'chat:message') {
        const message = frame.message as ChatMessage;
        if (!user || message.toUserId !== user.id) return;
        // Silent when the conversation is open; toast otherwise.
        if (message.fromUserId === activeRef.current) return;
        setUnread((previous) => ({
          ...previous,
          [message.fromUserId]: (previous[message.fromUserId] ?? 0) + 1,
        }));
        const peer = friendsRef.current.find((item) => item.id === message.fromUserId);
        pushToast({
          kind: 'info',
          title: `新消息 · ${peer?.nickname ?? `用户 #${message.fromUserId}`}`,
          body: message.content,
          conversationId: message.fromUserId,
        });
      }
    });
  }, [isAuthenticated, subscribeFrames, pushToast, user, updateUser, dropFriendLocally]);

  // --- global notice subscription bus (system announcements) ---------------
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    return subscribeNotices((notice) => {
      setLatestNotice(notice);
      pushToast({ kind: 'notice', title: '系统公告', body: notice.content });
    });
  }, [isAuthenticated, subscribeNotices, pushToast]);

  const openConversation = useCallback(
    (friendId: number) => {
      setActiveConversationId(friendId);
      setView('chats');
      setUnread((previous) => ({ ...previous, [friendId]: 0 }));
    },
    [setActiveConversationId]
  );

  const respond = useCallback(
    async (requestId: number, action: 'accept' | 'reject') => {
      try {
        const result = await friendApi.respond(requestId, action);
        setRequests((previous) => previous.filter((item) => item.id !== requestId));
        if (action === 'accept' && result.friend) {
          const friend = result.friend;
          setFriends((previous) =>
            previous.some((item) => item.id === friend.id) ? previous : [...previous, friend].sort(byNickname)
          );
        }
      } catch (error) {
        pushToast({
          kind: 'error',
          title: '处理好友申请失败',
          body: error instanceof ApiError ? error.message : '请稍后重试',
        });
      }
    },
    [pushToast]
  );

  const removeFriend = useCallback(
    async (friend: User) => {
      try {
        await friendApi.remove(friend.id);
        dropFriendLocally(friend.id);
        pushToast({ kind: 'success', title: '已从列表移除', body: `${friend.nickname} 仍保留你为好友` });
      } catch (error) {
        pushToast({
          kind: 'error',
          title: '移除失败',
          body: error instanceof ApiError ? error.message : '请稍后重试',
        });
      }
    },
    [dropFriendLocally, pushToast]
  );

  const handleSignOut = useCallback(async () => {
    await signOut();
    navigate('/login', { replace: true });
  }, [signOut, navigate]);

  const handleBack = useCallback(() => setActiveConversationId(null), [setActiveConversationId]);

  const activePeer = useMemo(
    () => friends.find((friend) => friend.id === activeConversationId) ?? null,
    [friends, activeConversationId]
  );
  const sortedFriends = useMemo(() => [...friends].sort(byNickname), [friends]);
  const incomingCount = useMemo(
    () => requests.reduce((count, request) => (request.direction === 'incoming' ? count + 1 : count), 0),
    [requests]
  );

  if (!user) return null;

  return (
    <div className={`shell ${activeConversationId ? 'conv-open' : ''}`} data-testid="shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <button
            type="button"
            className="me"
            data-testid="profile-open"
            onClick={() => setProfileOpen(true)}
            title="设置资料"
          >
            <Avatar name={user.nickname} avatar={user.avatar} size={42} />
            <span className="me-info">
              <span className="me-name">{user.nickname}</span>
              <span className="me-sub">@{user.username}</span>
            </span>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="signout"
            onClick={() => void handleSignOut()}
          >
            退出
          </button>
        </header>

        <div className="sidebar-tabs">
          <button
            type="button"
            className={view === 'chats' ? 'active' : ''}
            data-testid="tab-chats"
            onClick={() => setView('chats')}
          >
            会话
          </button>
          <button
            type="button"
            className={view === 'friends' ? 'active' : ''}
            data-testid="tab-friends"
            onClick={() => setView('friends')}
          >
            好友
            {incomingCount > 0 && <span className="badge badge-unread">{incomingCount}</span>}
          </button>
        </div>

        <div className="sidebar-body">
          {view === 'friends' ? (
            <FriendsPanel
              friends={friends}
              requests={requests}
              unread={unread}
              onRespond={respond}
              onOpenConversation={openConversation}
              onRemove={removeFriend}
              frozen={isFrozen}
            />
          ) : (
            <div className="conversation-list">
              {sortedFriends.length === 0 && (
                <div className="panel-empty">还没有好友</div>
              )}
              {sortedFriends.map((friend) => (
                <button
                  key={friend.id}
                  type="button"
                  className={`conversation-item ${activeConversationId === friend.id ? 'active' : ''}`}
                  data-testid="conversation-item"
                  data-friend-id={friend.id}
                  onClick={() => openConversation(friend.id)}
                  disabled={isFrozen}
                >
                  <Avatar name={friend.nickname} avatar={friend.avatar} size={40} />
                  <span className="conversation-main">
                    <span className="conversation-name">{friend.nickname}</span>
                    {friend.lastSeenAt && (
                      <span className="conversation-sub">{formatDateTime(friend.lastSeenAt)}</span>
                    )}
                  </span>
                  {(unread[friend.id] ?? 0) > 0 && <span className="badge badge-unread">{unread[friend.id]}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <footer className="sidebar-footer">
          <StatusPill />
          {latestNotice && (
            <div className="notice-line" data-testid="notice-line">
              {latestNotice.content}
            </div>
          )}
        </footer>
      </aside>

      <main className="main">
        {activeConversationId ? (
          <ChatWindow
            friendId={activeConversationId}
            myId={user.id}
            frozen={isFrozen}
            peerHint={activePeer}
            onBack={handleBack}
          />
        ) : (
          <div className="empty-state" data-testid="empty-state">
            <h2>选择一个会话开始聊天</h2>
          </div>
        )}
      </main>

      <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
    </div>
  );
}
