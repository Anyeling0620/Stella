import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { friendApi, groupApi } from '../lib/api';
import { ApiError, isCancelError } from '../lib/axiosClient';
import { STORAGE_KEYS } from '../config';
import { convKey, parseConversationKey } from '../lib/conversation';
import { formatListTime } from '../lib/format';
import { useAppActions, useAppRealtime, useAppSession } from '../context/AppContext';
import { Avatar } from '../components/Avatar';
import { StatusPill } from '../components/StatusPill';
import { ProfileDialog } from '../components/ProfileDialog';
import { CreateGroupDialog } from '../components/CreateGroupDialog';
import { GroupsPanel } from '../components/GroupsPanel';
import { ChatWindow } from './ChatWindow';
import { FriendsPanel } from './FriendsPanel';
import type { ChatMessage, ConversationPreview, FriendRequest, Group, GroupJoinRequest, GroupMember, SystemNotice, User } from '../types';

const byNickname = (a: User, b: User) => a.nickname.localeCompare(b.nickname, 'zh-CN');

const groupActivity = (group: Group) =>
  group.lastMessage?.createdAt ?? group.updatedAt ?? '';

/**
 * Authenticated application shell.
 *
 * Owns the *page-local* business data (friends, groups, pending requests, unread
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
  const [groups, setGroups] = useState<Group[]>([]);
  const [requests, setRequests] = useState<FriendRequest[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [mentioned, setMentioned] = useState<Record<string, boolean>>({});
  /**
   * Live "last message" per conversation key, updated from every
   * `chat:message` frame (incoming AND my own echo) so the list preview stays
   * current without a refetch. Seeded once from the friend/group list.
   */
  const [lastMessages, setLastMessages] = useState<Record<string, ConversationPreview>>({});
  const [view, setView] = useState<'chats' | 'friends' | 'groups'>('chats');
  const [latestNotice, setLatestNotice] = useState<SystemNotice | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);

  // Refs let the frame handler read fresh values without re-subscribing.
  // Written in effects rather than during render (render-phase ref writes break
  // under concurrent rendering).
  const activeRef = useRef<string | null>(activeConversationId);
  const friendsRef = useRef<User[]>(friends);
  const groupsRef = useRef<Group[]>(groups);
  useEffect(() => {
    activeRef.current = activeConversationId;
  }, [activeConversationId]);
  useEffect(() => {
    friendsRef.current = friends;
  }, [friends]);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  // -------------------------------------------------------------------------
  // Resizable sidebar (draggable splitter)
  //
  // Perf note: the drag writes the `--sidebar-w` CSS variable straight onto the
  // shell element via a ref — no React state, so dragging never re-renders the
  // (expensive) message list. The width is persisted once, on pointer-up.
  // -------------------------------------------------------------------------
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ startX: 0, startWidth: 0 });

  const onSplitterDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const shell = shellRef.current;
    if (!shell) return;
    const sidebar = shell.firstElementChild as HTMLElement | null;
    dragRef.current = {
      startX: event.clientX,
      startWidth: sidebar ? sidebar.getBoundingClientRect().width : 330,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    shell.classList.add('resizing');
  }, []);

  const onSplitterMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!(event.buttons & 1)) return; // only while the primary button is held
    const shell = shellRef.current;
    if (!shell) return;
    const dx = event.clientX - dragRef.current.startX;
    const max = Math.min(window.innerWidth * 0.6, 560);
    const width = Math.round(Math.min(Math.max(dragRef.current.startWidth + dx, 220), max));
    shell.style.setProperty('--sidebar-w', `${width}px`);
  }, []);

  const onSplitterUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const shell = shellRef.current;
    if (!shell) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    shell.classList.remove('resizing');
    const width = shell.style.getPropertyValue('--sidebar-w').trim();
    if (width) {
      try {
        window.localStorage.setItem(STORAGE_KEYS.sidebarWidth, width);
      } catch {
        /* ignore */
      }
    }
  }, []);

  // Restore a previously saved width before paint (no state, no re-render).
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEYS.sidebarWidth);
      if (saved && /^\d+px$/.test(saved)) shell.style.setProperty('--sidebar-w', saved);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) navigate('/login', { replace: true });
  }, [isAuthenticated, navigate]);

  /**
   * Seeds previews for conversations we don't yet know about. Never overwrites
   * an existing entry: a live frame is always fresher than a list refetch, so
   * only missing keys are filled.
   */
  const seedPreviews = useCallback((entries: Array<[string, ConversationPreview]>) => {
    if (entries.length === 0) return;
    setLastMessages((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [key, preview] of entries) {
        if (!next[key]) {
          next[key] = preview;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, []);

  /** Seeds unread badges for conversations we don't yet track (login snapshot). */
  const seedUnread = useCallback((entries: Array<[string, number]>) => {
    if (entries.length === 0) return;
    setUnread((previous) => {
      const next = { ...previous };
      let changed = false;
      for (const [key, count] of entries) {
        if (!(key in next) && count > 0) {
          next[key] = count;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, []);

  const loadFriends = useCallback(async () => {
    try {
      const data = await friendApi.list();
      setFriends(data.friends);
      seedPreviews(
        data.friends
          .filter((friend) => friend.lastMessage)
          .map((friend) => [
            convKey.direct(friend.id),
            {
              type: friend.lastMessage!.type,
              content: friend.lastMessage!.content,
              fromUserId: friend.lastMessage!.fromUserId,
              createdAt: friend.lastMessage!.createdAt,
              fromNickname: null,
            },
          ])
      );
      seedUnread(data.friends.map((friend) => [convKey.direct(friend.id), friend.unread ?? 0]));
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
  }, [pushToast, seedPreviews, seedUnread]);

  const loadGroups = useCallback(async () => {
    try {
      const data = await groupApi.list();
      setGroups(data.groups);
      seedPreviews(
        data.groups
          .filter((group) => group.lastMessage)
          .map((group) => [
            convKey.group(group.id),
            {
              type: group.lastMessage!.type,
              content: group.lastMessage!.content,
              fromUserId: group.lastMessage!.fromUserId,
              createdAt: group.lastMessage!.createdAt,
              fromNickname: group.lastMessage!.fromNickname,
            },
          ])
      );
      seedUnread(data.groups.map((group) => [convKey.group(group.id), group.unread ?? 0]));
    } catch (error) {
      if (isCancelError(error)) return;
      if (error instanceof ApiError && error.code === 'SESSION_REVOKED') return;
      pushToast({ kind: 'error', title: '加载群聊失败', body: '请稍后重试' });
    }
  }, [pushToast, seedPreviews, seedUnread]);

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
    void loadGroups();
    void loadRequests();
  }, [isAuthenticated, loadFriends, loadGroups, loadRequests]);

  // Release all page state when the user logs out.
  useEffect(() => {
    if (!isAuthenticated) {
      setFriends([]);
      setGroups([]);
      setRequests([]);
      setUnread({});
      setMentioned({});
      setLastMessages({});
      setLatestNotice(null);
      setProfileOpen(false);
      setCreateGroupOpen(false);
    }
  }, [isAuthenticated]);

  const clearConversationMarks = useCallback((key: string) => {
    setUnread((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
    setMentioned((previous) => {
      if (!(key in previous)) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, []);

  const dropFriendLocally = useCallback(
    (friendId: number) => {
      setFriends((previous) => previous.filter((item) => item.id !== friendId));
      clearConversationMarks(convKey.direct(friendId));
      if (activeRef.current === convKey.direct(friendId)) setActiveConversationId(null);
    },
    [clearConversationMarks, setActiveConversationId]
  );

  const dropGroupLocally = useCallback(
    (groupId: number) => {
      setGroups((previous) => previous.filter((item) => item.id !== groupId));
      clearConversationMarks(convKey.group(groupId));
      if (activeRef.current === convKey.group(groupId)) setActiveConversationId(null);
    },
    [clearConversationMarks, setActiveConversationId]
  );

  const upsertGroup = useCallback((group: Group) => {
    setGroups((previous) => {
      const index = previous.findIndex((item) => item.id === group.id);
      if (index < 0) return [group, ...previous];
      // Preserve local unread/mention counts; merge server fields.
      const merged = { ...previous[index], ...group };
      const next = [...previous];
      next[index] = merged;
      return next;
    });
  }, []);

  // --- page message subscription bus (friend + group + profile events) ------
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

      // --- group lifecycle ---------------------------------------------------
      if (frame.type === 'group:created' || frame.type === 'group:updated') {
        const group = frame.group as Group | undefined;
        if (!group) return;
        upsertGroup(group);
        if (frame.type === 'group:updated' && group.ownerId === user?.id) {
          // Own edits are already reflected locally; stay quiet.
          return;
        }
        return;
      }

      if (frame.type === 'group:member_added') {
        const groupId = Number(frame.groupId);
        const members = (frame.members as GroupMember[]) ?? [];
        const existing = groupsRef.current.find((item) => item.id === groupId);
        if (!existing) {
          void loadGroups();
        } else {
          upsertGroup({ ...existing, memberCount: members.length });
        }
        return;
      }

      if (frame.type === 'group:member_removed' || frame.type === 'group:member_left') {
        const groupId = Number(frame.groupId);
        const leftUserId = Number(frame.removedUserId ?? frame.userId);
        if (user && leftUserId === user.id) {
          dropGroupLocally(groupId);
          pushToast({
            kind: 'info',
            title: frame.type === 'group:member_removed' ? '你已被移出群聊' : '已退出群聊',
            body: groupsRef.current.find((g) => g.id === groupId)?.name ?? '',
          });
          return;
        }
        const members = (frame.members as GroupMember[]) ?? [];
        const existing = groupsRef.current.find((item) => item.id === groupId);
        if (existing) upsertGroup({ ...existing, memberCount: members.length });
        return;
      }

      if (frame.type === 'group:dissolved') {
        const groupId = Number(frame.groupId);
        const name = groupsRef.current.find((g) => g.id === groupId)?.name;
        dropGroupLocally(groupId);
        pushToast({ kind: 'warning', title: '群聊已解散', body: name ?? '' });
        return;
      }

      // Someone applied to join a group I own.
      if (frame.type === 'group:join_requested') {
        const request = frame.request as GroupJoinRequest | undefined;
        pushToast({
          kind: 'info',
          title: '新的加群申请',
          body: `${request?.applicant?.nickname ?? '有人'} 申请加入「${String(frame.groupName ?? '群聊')}」`,
        });
        return;
      }

      // The owner decided on a group I applied to.
      if (frame.type === 'group:join_result') {
        if (frame.status === 'approved') {
          pushToast({ kind: 'success', title: '已加入群聊', body: `「${String(frame.groupName ?? '')}」` });
          void loadGroups();
        } else if (frame.status === 'rejected') {
          pushToast({ kind: 'warning', title: '加群申请被拒绝', body: `「${String(frame.groupName ?? '')}」` });
        }
        return;
      }

      if (frame.type === 'chat:message') {
        const message = frame.message as ChatMessage;
        if (!user) return;

        // Update the list preview for BOTH directions — including my own echo —
        // before the unread/toast logic (which only concerns incoming messages).
        const previewKey = message.groupId
          ? convKey.group(Number(message.groupId))
          : convKey.direct(Number(message.fromUserId === user.id ? message.toUserId : message.fromUserId));
        setLastMessages((previous) => ({
          ...previous,
          [previewKey]: {
            type: message.type ?? 'text',
            content: message.content,
            fromUserId: message.fromUserId,
            createdAt: message.createdAt,
            fromNickname: message.fromUser?.nickname ?? null,
          },
        }));

        if (message.fromUserId === user.id) return; // own echo: preview done

        if (message.groupId) {
          const key = convKey.group(Number(message.groupId));
          if (activeRef.current === key) return; // open thread updates silently
          const group = groupsRef.current.find((item) => item.id === Number(message.groupId));
          if (!group) void loadGroups();
          setUnread((previous) => ({ ...previous, [key]: (previous[key] ?? 0) + 1 }));
          const mentionMe = (message.mentions ?? []).includes(user.id);
          if (mentionMe) {
            setMentioned((previous) => ({ ...previous, [key]: true }));
            pushToast({
              kind: 'info',
              title: `有人@你 · ${group?.name ?? '群聊'}`,
              body: `${message.fromUser?.nickname ?? '有人'}：${message.content}`,
              conversationId: key,
            });
          } else {
            pushToast({
              kind: 'info',
              title: `新消息 · ${group?.name ?? '群聊'}`,
              body: `${message.fromUser?.nickname ?? '成员'}：${message.content}`,
              conversationId: key,
            });
          }
          return;
        }

        const key = convKey.direct(message.fromUserId);
        if (activeRef.current === key) return;
        setUnread((previous) => ({ ...previous, [key]: (previous[key] ?? 0) + 1 }));
        const peer = friendsRef.current.find((item) => item.id === message.fromUserId);
        pushToast({
          kind: 'info',
          title: `新消息 · ${peer?.nickname ?? `用户 #${message.fromUserId}`}`,
          body: message.content,
          conversationId: key,
        });
      }
    });
  }, [isAuthenticated, subscribeFrames, pushToast, user, updateUser, dropFriendLocally, dropGroupLocally, upsertGroup, loadGroups]);

  // --- global notice subscription bus (system announcements) ---------------
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    return subscribeNotices((notice) => {
      setLatestNotice(notice);
      pushToast({ kind: 'notice', title: '系统公告', body: notice.content });
    });
  }, [isAuthenticated, subscribeNotices, pushToast]);

  const openConversation = useCallback(
    (key: string) => {
      setActiveConversationId(key);
      setView('chats');
      clearConversationMarks(key);
    },
    [setActiveConversationId, clearConversationMarks]
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

  const activeRefParsed = useMemo(() => parseConversationKey(activeConversationId), [activeConversationId]);
  const activePeer = useMemo(
    () =>
      activeRefParsed?.kind === 'direct'
        ? friends.find((friend) => friend.id === activeRefParsed.id) ?? null
        : null,
    [friends, activeRefParsed]
  );
  const activeGroup = useMemo(
    () =>
      activeRefParsed?.kind === 'group'
        ? groups.find((group) => group.id === activeRefParsed.id) ?? null
        : null,
    [groups, activeRefParsed]
  );
  const sortedFriends = useMemo(() => [...friends].sort(byNickname), [friends]);
  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => groupActivity(b).localeCompare(groupActivity(a))),
    [groups]
  );
  const incomingCount = useMemo(
    () => requests.reduce((count, request) => (request.direction === 'incoming' ? count + 1 : count), 0),
    [requests]
  );

  if (!user) return null;

  return (
    <div className={`shell ${activeConversationId ? 'conv-open' : ''}`} data-testid="shell" ref={shellRef}>
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
          <button
            type="button"
            className={view === 'groups' ? 'active' : ''}
            data-testid="tab-groups"
            onClick={() => setView('groups')}
          >
            群聊
            {groups.some((group) => mentioned[convKey.group(group.id)]) && (
              <span className="badge badge-mention">@</span>
            )}
          </button>
          <button
            type="button"
            className="sidebar-new-group"
            data-testid="create-group-open"
            title="发起群聊"
            aria-label="发起群聊"
            onClick={() => setCreateGroupOpen(true)}
          >
            ＋
          </button>
        </div>

        <div className="sidebar-body">
          {view === 'friends' ? (
            <FriendsPanel
              friends={friends}
              requests={requests}
              unread={unread}
              onRespond={respond}
              onOpenConversation={(friendId) => openConversation(convKey.direct(friendId))}
              onRemove={removeFriend}
              frozen={isFrozen}
            />
          ) : view === 'groups' ? (
            <GroupsPanel
              groups={sortedGroups}
              unread={unread}
              mentioned={mentioned}
              onOpenConversation={openConversation}
              onCreateGroup={() => setCreateGroupOpen(true)}
              frozen={isFrozen}
            />
          ) : (
            <div className="conversation-list">
              {sortedFriends.map((friend) => {
                const key = convKey.direct(friend.id);
                const preview = lastMessages[key];
                const unreadCount = unread[key] ?? 0;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`conversation-item ${activeConversationId === key ? 'active' : ''}`}
                    data-testid="conversation-item"
                    data-friend-id={friend.id}
                    onClick={() => openConversation(key)}
                    disabled={isFrozen}
                  >
                    <Avatar name={friend.nickname} avatar={friend.avatar} size={40} />
                    <span className="conversation-body">
                      <span className="conversation-top">
                        <span className="conversation-name">{friend.nickname}</span>
                        <span className="conversation-time">{formatListTime(preview?.createdAt)}</span>
                      </span>
                      <span className="conversation-bottom">
                        <span className="conversation-sub">{preview ? preview.content : ''}</span>
                        {unreadCount > 0 && <span className="badge badge-unread">{unreadCount}</span>}
                      </span>
                    </span>
                  </button>
                );
              })}

              {sortedGroups.map((group) => {
                const key = convKey.group(group.id);
                const preview = lastMessages[key];
                const previewText = preview
                  ? preview.type === 'system'
                    ? preview.content
                    : `${preview.fromNickname ? `${preview.fromNickname}: ` : ''}${preview.content}`
                  : null;
                const unreadCount = unread[key] ?? 0;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`conversation-item conversation-group ${activeConversationId === key ? 'active' : ''}`}
                    data-testid="group-item"
                    data-group-id={group.id}
                    onClick={() => openConversation(key)}
                    disabled={isFrozen}
                  >
                    <Avatar name={group.name} avatar={group.avatar} size={40} />
                    <span className="conversation-body">
                      <span className="conversation-top">
                        <span className="conversation-name">{group.name}</span>
                        <span className="conversation-time">{formatListTime(preview?.createdAt)}</span>
                      </span>
                      <span className="conversation-bottom">
                        <span className="conversation-sub">{previewText ?? `${group.memberCount ?? 0} 位成员`}</span>
                        {mentioned[key] ? (
                          <span className="badge badge-mention">@</span>
                        ) : unreadCount > 0 ? (
                          <span className="badge badge-unread">{unreadCount}</span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                );
              })}

              {sortedFriends.length === 0 && sortedGroups.length === 0 && (
                <div className="panel-empty">还没有会话，去「好友」里加人或发起群聊</div>
              )}
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

      {/* Drag to resize the sidebar. Pointer events write `--sidebar-w` directly
          (no state), so dragging never re-renders the app. Hidden on phones. */}
      <div
        className="splitter"
        data-testid="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        onPointerDown={onSplitterDown}
        onPointerMove={onSplitterMove}
        onPointerUp={onSplitterUp}
        onPointerCancel={onSplitterUp}
      />

      <main className="main">
        {activeRefParsed ? (
          <ChatWindow
            kind={activeRefParsed.kind}
            conversationId={activeRefParsed.id}
            myId={user.id}
            frozen={isFrozen}
            peerHint={activePeer}
            groupHint={activeGroup}
            onBack={handleBack}
          />
        ) : (
          <div className="empty-state" data-testid="empty-state">
            <h2>选择一个会话开始聊天</h2>
          </div>
        )}
      </main>

      <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
      <CreateGroupDialog
        open={createGroupOpen}
        friends={sortedFriends}
        frozen={isFrozen}
        onClose={() => setCreateGroupOpen(false)}
        onCreated={(group) => {
          upsertGroup(group);
          openConversation(convKey.group(group.id));
        }}
      />
    </div>
  );
}
