import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { conversationApi, favoriteApi, friendApi, groupApi, messageApi, settingsApi } from '../lib/api';
import { ApiError, isCancelError } from '../lib/axiosClient';
import { STORAGE_KEYS } from '../config';
import { convKey, parseConversationKey } from '../lib/conversation';
import { onPushOpenConversation } from '../lib/push';
import { session } from '../lib/session';
import { displayName, formatListTime } from '../lib/format';
import { exportConversation } from '../lib/export';
import { useAppActions, useAppRealtime, useAppSession } from '../context/AppContext';
import { Avatar } from '../components/Avatar';
import { PresenceAvatar } from '../components/PresenceAvatar';
import { StatusPill } from '../components/StatusPill';
import { ChatInfoPage } from '../components/ChatInfoPage';
import { FavoriteDetailPage, favoriteSenderName } from '../components/FavoriteDetailPage';
import { FriendInfoPage } from '../components/FriendInfoPage';
import { GroupInfoPage } from '../components/GroupInfoPage';
import { GroupMembersPage } from '../components/GroupMembersPage';
import { GroupFilesPage } from '../components/GroupFilesPage';
import { GroupRequestsPage } from '../components/GroupRequestsPage';
import { ChatSearchPage } from '../components/ChatSearchPage';
import { ProfileDialog } from '../components/ProfileDialog';
import { SettingsDialog } from '../components/SettingsDialog';
import { CreateGroupDialog } from '../components/CreateGroupDialog';
import { Icon, type IconName } from '../components/Icon';
import { ContextMenu } from '../components/ContextMenu';
import { GroupsPanel } from '../components/GroupsPanel';
import { RailNav, type ShellView } from '../components/RailNav';
import { ChatWindow } from './ChatWindow';
import { FriendsPanel } from './FriendsPanel';
import { applyTheme, THEME_PAIRS, type ThemeId } from '../lib/theme';
import type { ChatMessage, ConversationPreview, ConversationSettings, Favorite, FriendRequest, Group, GroupJoinRequest, GroupMember, SystemNotice, User, UserSettings } from '../types';

const DEFAULT_NOTIFY: UserSettings = {
  addByUsername: true,
  addByInvite: true,
  addByGroup: true,
  requireVerification: true,
  notifyDesktop: true,
  notifySound: true,
  notifyPreview: true,
};

/** A short two-tone chime via Web Audio — no asset, no autoplay issues once a
 * user gesture has occurred. */
let audioCtx: AudioContext | null = null;
function playChime() {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = audioCtx ?? new Ctor();
    const now = audioCtx.currentTime;
    for (const [freq, offset] of [[880, 0], [1180, 0.12]] as Array<[number, number]>) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.14, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.2);
    }
  } catch {
    /* audio is best-effort */
  }
}

/** A red-dot favicon as an inline SVG data URL (Web has no system badge). */
const FAVICON_DOT =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='13' fill='%2307C160'/%3E%3Ccircle cx='24' cy='8' r='6' fill='%23fa5151'/%3E%3C/svg%3E";

const byNickname = (a: User, b: User) => displayName(a).localeCompare(displayName(b), 'zh-CN');

/**
 * What the main pane shows. `chat` means "the conversation" (or the empty
 * state); the other three are right-hand pages layered over it.
 */
type MainPane =
  | { kind: 'chat' }
  | { kind: 'chat-info'; key: string }
  | { kind: 'chat-search'; key: string }
  | { kind: 'friend-info'; friendId: number }
  | { kind: 'favorite'; favoriteId: number }
  | { kind: 'group-info'; groupId: number }
  | { kind: 'group-members'; groupId: number }
  | { kind: 'group-files'; groupId: number }
  | { kind: 'group-requests'; groupId: number };

const groupActivity = (group: Group) =>
  group.lastMessage?.createdAt ?? group.updatedAt ?? '';

/**
 * One row of the merged conversation list (消息 tab). Friends and groups are
 * rendered from a single ranked list — see `conversationRows`.
 */
type ConversationRow =
  | { kind: 'direct'; key: string; id: number; friend: User }
  | { kind: 'group'; key: string; id: number; group: Group };

/** List-pane heading per rail destination. */
const VIEW_TITLES: Record<ShellView, string> = {
  chats: '消息',
  friends: '通讯录',
  groups: '群聊',
  favorites: '收藏',
  moments: '朋友圈',
};

/** Centred empty state for destinations that have no backend yet. */
function PlaceholderView({
  icon,
  title,
  sub,
}: {
  icon: IconName;
  title: string;
  sub: string;
}) {
  return (
    <div className="placeholder-view">
      <span className="placeholder-art" aria-hidden="true">
        <Icon name={icon} size={56} />
      </span>
      <p className="placeholder-title">{title}</p>
      <p className="placeholder-sub">{sub}</p>
    </div>
  );
}

/**
 * Splitter drag limits. These MIRROR the `.main` min-width tiers in styles.css
 * (`360px` from 768px, `480px` from 1024px) so the drag limit can never squeeze
 * the content pane below the floor the layout itself enforces.
 */
const SPLITTER_W = 5;
const SIDEBAR_MIN_W = 300;
const SIDEBAR_MAX_W = 560;
const CONTENT_MIN_WIDE = 480;
const CONTENT_MIN_NARROW = 360;

function sidebarWidthBounds(): { min: number; max: number } {
  const contentMin = window.innerWidth >= 1024 ? CONTENT_MIN_WIDE : CONTENT_MIN_NARROW;
  const max = Math.max(
    SIDEBAR_MIN_W,
    Math.min(SIDEBAR_MAX_W, window.innerWidth - contentMin - SPLITTER_W)
  );
  return { min: SIDEBAR_MIN_W, max };
}

/** Clamps a `NNNpx` string to the current viewport's bounds. */
function clampSidebarWidth(value: string): string | null {
  const match = /^(\d+)px$/.exec(value.trim());
  if (!match) return null;
  const { min, max } = sidebarWidthBounds();
  return `${Math.round(Math.min(Math.max(Number(match[1]), min), max))}px`;
}

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
  /** userId -> online. Seeded from payloads, kept live by `presence` frames. */
  const [presence, setPresence] = useState<Record<number, boolean>>({});
  /**
   * Live "last message" per conversation key, updated from every
   * `chat:message` frame (incoming AND my own echo) so the list preview stays
   * current without a refetch. Seeded once from the friend/group list.
   */
  const [lastMessages, setLastMessages] = useState<Record<string, ConversationPreview>>({});
  /** conversation key (`d:<id>` / `g:<id>`) -> pin/mute settings. */
  const [convSettings, setConvSettings] = useState<Record<string, ConversationSettings>>({});
  /**
   * What fills the main pane. The conversation underneath stays mounted — the
   * three right-hand pages are layers over it, so 返回 never refetches history.
   */
  const [mainPane, setMainPane] = useState<MainPane>({ kind: 'chat' });
  /** Message the open conversation should scroll to (handed over by 查找聊天记录). */
  const [focusMessageId, setFocusMessageId] = useState<number | null>(null);
  /** Group whose 群聊详情 is open (owned here so it survives the chat page). */
  const [groupInfoId, setGroupInfoId] = useState<number | null>(null);
  const [groupInfoData, setGroupInfoData] = useState<{ group: Group; members: GroupMember[] } | null>(null);
  /** Pending 加群申请 count, for the 群聊详情 badge. */
  const [groupInfoJoinCount, setGroupInfoJoinCount] = useState(0);
  /** Attachment URLs cannot carry an Authorization header, so the token rides along. */
  const accessToken = session.getAccessToken();
  /** Saved messages (收藏). */
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  /** Notification switches (sound / desktop / preview), mirroring Settings. */
  const [notifySettings, setNotifySettings] = useState<UserSettings>(DEFAULT_NOTIFY);
  /** Right-click menu on a conversation row (key + pointer position). */
  const [convMenu, setConvMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  /** Conversations the user deleted locally ("删除会话"). */
  const [hiddenConvs, setHiddenConvs] = useState<Set<string>>(new Set());
  const [view, setView] = useState<ShellView>('chats');
  const [latestNotice, setLatestNotice] = useState<SystemNotice | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  /** Mirrors `html[data-theme]` so the rail's day/night icon tracks the picker. */
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute('data-theme') === 'wechat-dark'
  );

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
    const { min, max } = sidebarWidthBounds();
    const width = Math.round(Math.min(Math.max(dragRef.current.startWidth + dx, min), max));
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

  // Restore a previously saved width before paint (no state, no re-render),
  // clamped to the current viewport so a wide value saved on a big screen can't
  // squeeze the content on a smaller one.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEYS.sidebarWidth);
      const clamped = saved ? clampSidebarWidth(saved) : null;
      if (clamped) shell.style.setProperty('--sidebar-w', clamped);
    } catch {
      /* ignore */
    }
  }, []);

  // Shrinking the window must re-clamp a floating (dragged) width, otherwise the
  // content floor would force a horizontal overflow instead of the list narrowing.
  useEffect(() => {
    const onResize = () => {
      const shell = shellRef.current;
      if (!shell) return;
      const current = shell.style.getPropertyValue('--sidebar-w');
      const clamped = clampSidebarWidth(current);
      if (clamped && clamped !== current.trim()) shell.style.setProperty('--sidebar-w', clamped);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) navigate('/login', { replace: true });
  }, [isAuthenticated, navigate]);

  // You are online by definition while the app is open, but the server never
  // sends you your own presence frame — so seed it, otherwise "N 人在线" would
  // never count yourself.
  useEffect(() => {
    if (!user) return;
    setPresence((previous) => (previous[user.id] ? previous : { ...previous, [user.id]: true }));
  }, [user]);

  // Keep the rail's theme icon in sync with any theme change (rail toggle or
  // the profile dialog's picker), without lifting theme state into the context.
  useEffect(() => {
    const sync = () =>
      setIsDark(document.documentElement.getAttribute('data-theme') === 'wechat-dark');
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const toggleTheme = useCallback(() => {
    const current = (document.documentElement.getAttribute('data-theme') ?? '') as ThemeId;
    // Flip within the active theme family; unknown themes fall back to WeChat.
    applyTheme(THEME_PAIRS[current] ?? 'wechat-dark');
  }, []);

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
      setPresence((previous) => {
        const next = { ...previous };
        for (const friend of data.friends) next[friend.id] = Boolean(friend.online);
        return next;
      });
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

  /** Pin/mute settings for every conversation (merged into the list). */
  const loadConversations = useCallback(async () => {
    try {
      const data = await conversationApi.list();
      const map: Record<string, ConversationSettings> = {};
      for (const entry of data.conversations) {
        map[entry.peerKind === 'group' ? convKey.group(entry.peerId) : convKey.direct(entry.peerId)] = entry;
      }
      setConvSettings(map);
    } catch (error) {
      if (!isCancelError(error)) {
        /* best-effort; the list still renders without pin/mute */
      }
    }
  }, []);

  const loadFavorites = useCallback(async () => {
    try {
      setFavorites((await favoriteApi.list()).favorites);
    } catch {
      /* best-effort */
    }
  }, []);

  const loadNotifySettings = useCallback(async () => {
    try {
      const data = await settingsApi.get();
      setNotifySettings(data.settings);
    } catch {
      /* defaults already applied */
    }
  }, []);

  // HTTP initialisation on mount (存量数据).
  useEffect(() => {
    if (!isAuthenticated) return;
    void loadFriends();
    void loadGroups();
    void loadRequests();
    void loadConversations();
    void loadFavorites();
    void loadNotifySettings();
  }, [isAuthenticated, loadFriends, loadGroups, loadRequests, loadConversations, loadFavorites, loadNotifySettings]);

  // Release all page state when the user logs out.
  useEffect(() => {
    if (!isAuthenticated) {
      setFriends([]);
      setGroups([]);
      setRequests([]);
      setUnread({});
      setMentioned({});
      setPresence({});
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

  // --- Conversation settings (置顶 / 免打扰 / 清空 / 删除) --------------------
  const applyConvSetting = useCallback(
    (key: string, patch: { pinned?: boolean; muted?: boolean }) => {
      const ref = parseConversationKey(key);
      if (!ref) return;
      setConvSettings((previous) => {
        const current =
          previous[key] ??
          ({ peerKind: ref.kind, peerId: ref.id, pinned: false, muted: false, clearedBeforeId: 0 } as ConversationSettings);
        return { ...previous, [key]: { ...current, ...patch } };
      });
      void conversationApi.update(ref.kind, ref.id, patch).catch((error) => {
        pushToast({ kind: 'error', title: '设置失败', body: error instanceof ApiError ? error.message : undefined });
      });
    },
    [pushToast]
  );

  const togglePin = useCallback(
    (key: string) => {
      setConvMenu(null);
      applyConvSetting(key, { pinned: !convSettings[key]?.pinned });
    },
    [applyConvSetting, convSettings]
  );

  const toggleMute = useCallback(
    (key: string) => {
      setConvMenu(null);
      applyConvSetting(key, { muted: !convSettings[key]?.muted });
    },
    [applyConvSetting, convSettings]
  );

  const clearConversation = useCallback(
    (key: string) => {
      setConvMenu(null);
      const ref = parseConversationKey(key);
      if (!ref) return;
      setLastMessages((previous) => {
        if (!(key in previous)) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      });
      clearConversationMarks(key);
      void messageApi.clearConversation(ref.kind, ref.id).catch(() => {});
    },
    [clearConversationMarks]
  );

  const deleteConversation = useCallback(
    (key: string) => {
      setConvMenu(null);
      const ref = parseConversationKey(key);
      if (!ref) return;
      setHiddenConvs((previous) => new Set(previous).add(key));
      setLastMessages((previous) => {
        if (!(key in previous)) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      });
      clearConversationMarks(key);
      if (activeRef.current === key) setActiveConversationId(null);
      void messageApi.clearConversation(ref.kind, ref.id).catch(() => {});
    },
    [clearConversationMarks, setActiveConversationId]
  );

  const removeFavorite = useCallback(
    (id: number) => {
      setFavorites((previous) => previous.filter((f) => f.id !== id));
      void favoriteApi.remove(id).catch(() => {});
    },
    []
  );

  const openConvMenu = useCallback((key: string, x: number, y: number) => setConvMenu({ key, x, y }), []);
  const closeConvMenu = useCallback(() => setConvMenu(null), []);

  /**
   * New-message alert: plays a chime and (only while the tab is hidden) raises
   * an OS notification. Suppressed entirely for a muted conversation.
   */
  const notify = useCallback(
    (key: string, title: string, body: string) => {
      if (convSettings[key]?.muted) return;
      if (notifySettings.notifySound) playChime();
      if (
        notifySettings.notifyDesktop &&
        document.hidden &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        try {
          // eslint-disable-next-line no-new
          new Notification(title, { body: notifySettings.notifyPreview ? body : '收到一条新消息' });
        } catch {
          /* notification is best-effort */
        }
      }
    },
    [convSettings, notifySettings]
  );

  // Notification permission must be requested from a user gesture (chapter 10).
  useEffect(() => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return undefined;
    const ask = () => {
      void Notification.requestPermission().finally(() => {
        window.removeEventListener('pointerdown', ask);
      });
    };
    window.addEventListener('pointerdown', ask, { once: true });
    return () => window.removeEventListener('pointerdown', ask);
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

      // Pin/mute changed on another of my tabs (or echoed back).
      if (frame.type === 'conversation:updated') {
        const peerKind = frame.peerKind === 'group' ? 'group' : 'direct';
        const peerId = Number(frame.peerId);
        const settings = frame.settings as ConversationSettings | undefined;
        if (!settings || !Number.isInteger(peerId)) return;
        const key = peerKind === 'group' ? convKey.group(peerId) : convKey.direct(peerId);
        setConvSettings((previous) => ({ ...previous, [key]: { ...settings, peerKind, peerId } }));
        return;
      }

      // A favourite was added/removed on another device.
      if (frame.type === 'favorite:updated') {
        void loadFavorites();
        return;
      }

      // Presence for a friend or a group co-member.
      if (frame.type === 'presence') {
        const userId = Number(frame.userId);
        if (!Number.isInteger(userId)) return;
        const online = Boolean(frame.online);
        setPresence((previous) => (previous[userId] === online ? previous : { ...previous, [userId]: online }));
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

      if (frame.type === 'group:member_added' || frame.type === 'group:member_updated') {
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
            notify(key, `有人@你 · ${group?.name ?? '群聊'}`, `${message.fromUser?.nickname ?? '有人'}：${message.content}`);
          } else {
            pushToast({
              kind: 'info',
              title: `新消息 · ${group?.name ?? '群聊'}`,
              body: `${message.fromUser?.nickname ?? '成员'}：${message.content}`,
              conversationId: key,
            });
            notify(key, `新消息 · ${group?.name ?? '群聊'}`, `${message.fromUser?.nickname ?? '成员'}：${message.content}`);
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
        notify(key, `新消息 · ${peer?.nickname ?? `用户 #${message.fromUserId}`}`, message.content);
      }
    });
  }, [isAuthenticated, subscribeFrames, pushToast, user, updateUser, dropFriendLocally, dropGroupLocally, upsertGroup, loadGroups, loadFavorites, notify]);

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
      setMainPane({ kind: 'chat' });
      clearConversationMarks(key);
    },
    [setActiveConversationId, clearConversationMarks]
  );

  // --- Right-hand pages -----------------------------------------------------
  const openFriendProfile = useCallback((friendId: number) => {
    setMainPane({ kind: 'friend-info', friendId });
  }, []);

  const openChatInfo = useCallback((key: string) => setMainPane({ kind: 'chat-info', key }), []);

  const openFavorite = useCallback((favoriteId: number) => setMainPane({ kind: 'favorite', favoriteId }), []);

  const closeSidePage = useCallback(() => setMainPane({ kind: 'chat' }), []);

  /** Fetch (or refresh) the open group's detail + pending-application count. */
  const loadGroupInfo = useCallback(async (groupId: number) => {
    try {
      const data = await groupApi.detail(groupId);
      setGroupInfoData({ group: data.group, members: data.members });
      // Best-effort — a non-manager simply gets an error we ignore.
      void groupApi
        .joinRequests(groupId)
        .then((result) => setGroupInfoJoinCount(result.requests.length))
        .catch(() => setGroupInfoJoinCount(0));
    } catch {
      setGroupInfoData(null);
    }
  }, []);

  /** 群聊详情 — fetched on demand so it can be opened from the 群聊 list too. */
  const openGroupInfo = useCallback(
    (groupId: number) => {
      setGroupInfoId(groupId);
      setMainPane({ kind: 'group-info', groupId });
      void loadGroupInfo(groupId);
    },
    [loadGroupInfo]
  );

  const reloadGroupInfo = useCallback(async () => {
    if (groupInfoId) await loadGroupInfo(groupInfoId);
  }, [groupInfoId, loadGroupInfo]);

  const openGroupMembers = useCallback((groupId: number) => setMainPane({ kind: 'group-members', groupId }), []);
  const openGroupFiles = useCallback((groupId: number) => setMainPane({ kind: 'group-files', groupId }), []);
  const openGroupRequests = useCallback((groupId: number) => setMainPane({ kind: 'group-requests', groupId }), []);

  const saveRemark = useCallback(
    async (friendId: number, remark: string) => {
      try {
        await friendApi.setRemark(friendId, remark);
        setFriends((previous) =>
          previous.map((friend) => (friend.id === friendId ? { ...friend, remark: remark || null } : friend))
        );
        pushToast({ kind: 'success', title: remark ? '备注已保存' : '已清除备注' });
      } catch (error) {
        pushToast({
          kind: 'error',
          title: '保存失败',
          body: error instanceof ApiError ? error.message : undefined,
        });
      }
    },
    [pushToast]
  );

  const blockFriend = useCallback(
    async (friend: User) => {
      try {
        await friendApi.block(friend.id);
        pushToast({ kind: 'success', title: '已加入黑名单' });
      } catch (error) {
        pushToast({
          kind: 'error',
          title: '操作失败',
          body: error instanceof ApiError ? error.message : undefined,
        });
      }
    },
    [pushToast]
  );

  const leaveGroup = useCallback(
    async (groupId: number) => {
      try {
        const result = await groupApi.leave(groupId);
        dropGroupLocally(groupId);
        setGroupInfoId(null);
        setMainPane({ kind: 'chat' });
        pushToast({ kind: 'success', title: result.dissolved ? '群聊已解散' : '已退出群聊' });
      } catch (error) {
        pushToast({
          kind: 'error',
          title: '操作失败',
          body: error instanceof ApiError ? error.message : undefined,
        });
      }
    },
    [dropGroupLocally, pushToast]
  );

  const dissolveGroup = useCallback(
    async (groupId: number) => {
      try {
        await groupApi.dissolve(groupId);
        dropGroupLocally(groupId);
        setGroupInfoId(null);
        setMainPane({ kind: 'chat' });
        pushToast({ kind: 'success', title: '群聊已解散' });
      } catch (error) {
        pushToast({
          kind: 'error',
          title: '解散失败',
          body: error instanceof ApiError ? error.message : undefined,
        });
      }
    },
    [dropGroupLocally, pushToast]
  );

  const exportChat = useCallback(
    async (kind: 'direct' | 'group', id: number, title: string) => {
      try {
        await exportConversation(kind, id, title, user?.id ?? 0);
        pushToast({ kind: 'success', title: '聊天记录已导出' });
      } catch {
        pushToast({ kind: 'error', title: '导出失败' });
      }
    },
    [pushToast, user?.id]
  );

  const copyFavorite = useCallback(
    async (content: string) => {
      try {
        await navigator.clipboard.writeText(content);
        pushToast({ kind: 'success', title: '已复制' });
      } catch {
        pushToast({ kind: 'warning', title: '复制失败，请手动选择文本' });
      }
    },
    [pushToast]
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

  // A push notification click reopens the conversation (service worker message).
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    return onPushOpenConversation((conversationId) => openConversation(conversationId));
  }, [isAuthenticated, openConversation]);

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
  /**
   * Per-kind lists for the 通讯录 / 群聊 panes: alphabetical friends, and groups
   * by activity. Pin is deliberately NOT part of these — it is a conversation
   * list concern only.
   */
  const sortedFriends = useMemo(
    () => [...friends].filter((friend) => !hiddenConvs.has(convKey.direct(friend.id))).sort(byNickname),
    [friends, hiddenConvs]
  );
  const sortedGroups = useMemo(
    () =>
      [...groups]
        .filter((group) => !hiddenConvs.has(convKey.group(group.id)))
        .sort((a, b) => groupActivity(b).localeCompare(groupActivity(a))),
    [groups, hiddenConvs]
  );

  const pinRankOf = useCallback((key: string) => (convSettings[key]?.pinned ? 0 : 1), [convSettings]);

  /**
   * The 消息 list: friends and groups share ONE ranking, so 置顶 lifts a card to
   * the very top whatever kind it is. (Rendering two blocks — friends then
   * groups — left a pinned group stuck below every friend.) Within a rank the
   * order is most-recent-activity first, then name, which is how WeChat reads.
   */
  const conversationRows = useMemo<ConversationRow[]>(() => {
    const rows: ConversationRow[] = [];
    for (const friend of friends) {
      const key = convKey.direct(friend.id);
      if (!hiddenConvs.has(key)) rows.push({ kind: 'direct', key, id: friend.id, friend });
    }
    for (const group of groups) {
      const key = convKey.group(group.id);
      if (!hiddenConvs.has(key)) rows.push({ kind: 'group', key, id: group.id, group });
    }
    const activityOf = (row: ConversationRow) => {
      const stamp =
        lastMessages[row.key]?.createdAt ??
        (row.kind === 'group' ? groupActivity(row.group) : row.friend.lastMessage?.createdAt ?? '');
      const ms = stamp ? Date.parse(stamp) : Number.NaN;
      return Number.isFinite(ms) ? ms : 0;
    };
    const nameOf = (row: ConversationRow) => (row.kind === 'group' ? row.group.name : displayName(row.friend));
    return rows.sort(
      (a, b) =>
        pinRankOf(a.key) - pinRankOf(b.key) ||
        activityOf(b) - activityOf(a) ||
        nameOf(a).localeCompare(nameOf(b), 'zh-CN')
    );
  }, [friends, groups, hiddenConvs, lastMessages, pinRankOf]);
  const incomingCount = useMemo(
    () => requests.reduce((count, request) => (request.direction === 'incoming' ? count + 1 : count), 0),
    [requests]
  );
  const unreadTotal = useMemo(
    () => Object.values(unread).reduce((sum, count) => sum + count, 0),
    [unread]
  );

  // Web has no system badge: reflect unread in the tab title + favicon.
  useEffect(() => {
    document.title = unreadTotal > 0 ? `(${unreadTotal}) Stella IM` : 'Stella IM';
    const link = document.querySelector("link[rel='icon']") as HTMLLinkElement | null;
    if (link) link.href = unreadTotal > 0 ? FAVICON_DOT : '/favicon.svg';
  }, [unreadTotal]);
  const groupMention = useMemo(
    () => groups.some((group) => mentioned[convKey.group(group.id)]),
    [groups, mentioned]
  );

  /** The friend shown by the 好友资料 page (null once they are removed). */
  const paneFriend = useMemo(
    () => (mainPane.kind === 'friend-info' ? friends.find((item) => item.id === mainPane.friendId) ?? null : null),
    [mainPane, friends]
  );
  /** The saved message shown by the 收藏详情 page (null once deleted). */
  const paneFavorite = useMemo(
    () =>
      mainPane.kind === 'favorite' ? favorites.find((item) => item.id === mainPane.favoriteId) ?? null : null,
    [mainPane, favorites]
  );
  /** The group shown by a 群聊详情 page — the live list object wins (kept fresh by pushes). */
  const paneGroupId =
    mainPane.kind === 'group-info' ||
    mainPane.kind === 'group-members' ||
    mainPane.kind === 'group-files' ||
    mainPane.kind === 'group-requests'
      ? mainPane.groupId
      : null;
  const paneGroup = paneGroupId
    ? groups.find((item) => item.id === paneGroupId) ?? groupInfoData?.group ?? null
    : null;
  const chatInfoTitle = activePeer
    ? displayName(activePeer)
    : activeGroup?.name ?? (activeRefParsed ? `群聊 #${activeRefParsed.id}` : '');
  const chatInfoAvatar = activePeer?.avatar ?? activeGroup?.avatar ?? null;

  /** Where a saved message came from, for the 前往来源会话 row. */
  const favoriteSourceLabel = useCallback(
    (favorite: Favorite): string | null => {
      const ref = parseConversationKey(favorite.srcConversation);
      if (!ref) return null;
      if (ref.kind === 'group') return groups.find((item) => item.id === ref.id)?.name ?? null;
      const friend = friends.find((item) => item.id === ref.id);
      return friend ? displayName(friend) : null;
    },
    [friends, groups]
  );

  /**
   * A right-hand page must never outlive its subject: dropping the friend,
   * deleting the favourite, or switching/deleting the conversation sends the
   * pane back to the chat.
   */
  useEffect(() => {
    setMainPane((previous) => {
      if (previous.kind === 'friend-info' && !friends.some((item) => item.id === previous.friendId)) {
        return { kind: 'chat' };
      }
      if (previous.kind === 'favorite' && !favorites.some((item) => item.id === previous.favoriteId)) {
        return { kind: 'chat' };
      }
      if (
        (previous.kind === 'chat-info' || previous.kind === 'chat-search') &&
        (!activeConversationId || previous.key !== activeConversationId)
      ) {
        return { kind: 'chat' };
      }
      if (
        (previous.kind === 'group-info' ||
          previous.kind === 'group-members' ||
          previous.kind === 'group-files' ||
          previous.kind === 'group-requests') &&
        !groups.some((item) => item.id === previous.groupId)
      ) {
        return { kind: 'chat' };
      }
      return previous;
    });
  }, [friends, favorites, groups, activeConversationId]);

  if (!user) return null;

  return (
    <div
      className={`shell ${activeConversationId || mainPane.kind !== 'chat' ? 'conv-open' : ''}`}
      data-testid="shell"
      ref={shellRef}
    >
      {/* Rail + list share the first grid column, so the splitter drag (which
          resizes `--sidebar-w`) grows `shell.firstElementChild` — the e2e contract. */}
      <div className="shell-left">
        <RailNav
          user={user}
          view={view}
          unreadTotal={unreadTotal}
          friendBadge={incomingCount}
          groupMention={groupMention}
          frozen={isFrozen}
          isDark={isDark}
          onSelect={setView}
          onProfile={() => setProfileOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleTheme={toggleTheme}
        />

        <aside className="sidebar">
          <header className="sidebar-header">
            <span className="sidebar-title">{VIEW_TITLES[view]}</span>
            <div className="sidebar-header-actions">
              {/* Only the conversation list offers "start a chat" here; the group
                  view has its own button and the placeholder views have none. */}
              {view === 'chats' && (
                <button
                  type="button"
                  className="icon-btn"
                  data-testid="create-group-open"
                  title="发起群聊"
                  aria-label="发起群聊"
                  disabled={isFrozen}
                  onClick={() => setCreateGroupOpen(true)}
                >
                  <Icon name="plus" size={18} />
                </button>
              )}
            </div>
          </header>

          {/* Contacts own their own scroller (fixed search + index bar), so the
              sidebar body must not also scroll — that would double the gutter. */}
          <div className={`sidebar-body ${view === 'friends' ? 'no-scroll' : ''}`}>
            {view === 'friends' ? (
              <FriendsPanel
                friends={friends}
                requests={requests}
                unread={unread}
                presence={presence}
                onRespond={respond}
                onOpenProfile={openFriendProfile}
                onOpenGroups={() => setView('groups')}
                onRemove={removeFriend}
                frozen={isFrozen}
              />
            ) : view === 'groups' ? (
              <GroupsPanel
                groups={sortedGroups}
                unread={unread}
                mentioned={mentioned}
                onOpenGroup={openGroupInfo}
                onCreateGroup={() => setCreateGroupOpen(true)}
                frozen={isFrozen}
              />
            ) : view === 'favorites' ? (
              <div className="favorites-panel" data-testid="favorites-panel">
                {favorites.length === 0 ? (
                  <div className="panel-empty">还没有收藏，右键消息即可收藏</div>
                ) : (
                  favorites.map((fav) => (
                    <div
                      key={fav.id}
                      className={`favorite-item ${
                        mainPane.kind === 'favorite' && mainPane.favoriteId === fav.id ? 'selected' : ''
                      }`}
                      data-testid="favorite-item"
                    >
                      <button
                        type="button"
                        className="favorite-main"
                        data-testid="favorite-open"
                        onClick={() => openFavorite(fav.id)}
                      >
                        <span className="favorite-content">
                          {fav.type === 'image' ? '[图片]' : fav.type === 'file' ? fav.content || '[文件]' : fav.content}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => removeFavorite(fav.id)}
                        aria-label="删除收藏"
                      >
                        删除
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : view === 'moments' ? (
              <PlaceholderView icon="moments" title="朋友圈" sub="功能开发中" />
            ) : (
              <div className="conversation-list">
                {conversationRows.map((row) => {
                  if (row.kind === 'direct') {
                    const { friend, key } = row;
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
                        onContextMenu={(event) => {
                          // Row actions live on the context menu (WeChat-style).
                          event.preventDefault();
                          openConvMenu(key, event.clientX, event.clientY);
                        }}
                        disabled={isFrozen}
                      >
                        <PresenceAvatar
                          name={displayName(friend)}
                          avatar={friend.avatar}
                          size={40}
                          online={presence[friend.id] ?? Boolean(friend.online)}
                        />
                        <span className="conversation-body">
                          <span className="conversation-top">
                            <span className="conversation-name">
                              {convSettings[key]?.pinned && (
                                <span className="conv-flag" title="已置顶">
                                  <Icon name="pin" size={12} />
                                </span>
                              )}
                              {convSettings[key]?.muted && (
                                <span className="conv-flag" title="消息免打扰">
                                  <Icon name="mute" size={12} />
                                </span>
                              )}
                              {displayName(friend)}
                            </span>
                            <span className="conversation-time">{formatListTime(preview?.createdAt)}</span>
                          </span>
                          <span className="conversation-bottom">
                            <span className="conversation-sub">{preview ? preview.content : ''}</span>
                            {unreadCount > 0 && (
                              <span className="badge badge-unread">{unreadCount > 99 ? '99+' : unreadCount}</span>
                            )}
                          </span>
                        </span>
                      </button>
                    );
                  }

                  const { group, key } = row;
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
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openConvMenu(key, event.clientX, event.clientY);
                      }}
                      disabled={isFrozen}
                    >
                      <Avatar name={group.name} avatar={group.avatar} size={40} />
                      <span className="conversation-body">
                        <span className="conversation-top">
                          <span className="conversation-name">
                            {convSettings[key]?.pinned && (
                              <span className="conv-flag" title="已置顶">
                                <Icon name="pin" size={12} />
                              </span>
                            )}
                            {convSettings[key]?.muted && (
                              <span className="conv-flag" title="消息免打扰">
                                <Icon name="mute" size={12} />
                              </span>
                            )}
                            {group.name}
                          </span>
                          <span className="conversation-time">{formatListTime(preview?.createdAt)}</span>
                        </span>
                        <span className="conversation-bottom">
                          <span className="conversation-sub">{previewText ?? `${group.memberCount ?? 0} 位成员`}</span>
                          {mentioned[key] ? (
                            <span className="badge badge-mention">@</span>
                          ) : unreadCount > 0 ? (
                            <span className="badge badge-unread">{unreadCount > 99 ? '99+' : unreadCount}</span>
                          ) : null}
                        </span>
                      </span>
                    </button>
                  );
                })}

                {conversationRows.length === 0 && (
                  <div className="panel-empty">还没有会话，去「通讯录」里加人或发起群聊</div>
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
      </div>

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
            presence={presence}
            focusMessageId={focusMessageId ?? undefined}
            onFocusConsumed={() => setFocusMessageId(null)}
            onManage={() => openChatInfo(activeRefParsed ? (activeConversationId as string) : '')}
            onBack={handleBack}
          />
        ) : (
          <div className="empty-state" data-testid="empty-state">
            <h2>选择一个会话开始聊天</h2>
          </div>
        )}

        {mainPane.kind === 'friend-info' && paneFriend && (
          <FriendInfoPage
            friend={paneFriend}
            online={presence[paneFriend.id] ?? Boolean(paneFriend.online)}
            frozen={isFrozen}
            onBack={closeSidePage}
            onSendMessage={() => openConversation(convKey.direct(paneFriend.id))}
            onSaveRemark={(remark) => saveRemark(paneFriend.id, remark)}
            onRemoveFriend={() => void removeFriend(paneFriend)}
            onBlock={() => void blockFriend(paneFriend)}
          />
        )}

        {mainPane.kind === 'favorite' && paneFavorite && (
          <FavoriteDetailPage
            favorite={paneFavorite}
            senderName={favoriteSenderName(paneFavorite, user.id, friends)}
            token={accessToken}
            sourceLabel={favoriteSourceLabel(paneFavorite)}
            frozen={isFrozen}
            onBack={closeSidePage}
            onOpenSource={() => {
              if (!paneFavorite.srcConversation) return;
              openConversation(paneFavorite.srcConversation);
              if (paneFavorite.messageId) setFocusMessageId(paneFavorite.messageId);
            }}
            onCopy={() => void copyFavorite(paneFavorite.content)}
            onDelete={() => removeFavorite(paneFavorite.id)}
          />
        )}

        {mainPane.kind === 'chat-info' && activeRefParsed && activeConversationId === mainPane.key && (
          <ChatInfoPage
            kind={activeRefParsed.kind}
            targetId={activeRefParsed.id}
            title={chatInfoTitle}
            avatar={chatInfoAvatar}
            online={activePeer ? presence[activePeer.id] ?? Boolean(activePeer.online) : false}
            lastSeenAt={activePeer?.lastSeenAt}
            memberCount={activeGroup?.memberCount}
            pinned={Boolean(convSettings[mainPane.key]?.pinned)}
            muted={Boolean(convSettings[mainPane.key]?.muted)}
            frozen={isFrozen}
            onBack={closeSidePage}
            onTogglePin={() => togglePin(mainPane.key)}
            onToggleMute={() => toggleMute(mainPane.key)}
            onOpenSearch={() => setMainPane({ kind: 'chat-search', key: mainPane.key })}
            onExport={() => void exportChat(activeRefParsed.kind, activeRefParsed.id, chatInfoTitle)}
            onClear={() => clearConversation(mainPane.key)}
            onDelete={() => deleteConversation(mainPane.key)}
            onOpenPeerProfile={
              activeRefParsed.kind === 'direct' ? () => openFriendProfile(activeRefParsed.id) : undefined
            }
            onOpenGroupInfo={
              activeRefParsed.kind === 'group' ? () => void openGroupInfo(activeRefParsed.id) : undefined
            }
            onBlock={
              activeRefParsed.kind === 'direct' && activePeer ? () => void blockFriend(activePeer) : undefined
            }
            onRemoveFriend={
              activeRefParsed.kind === 'direct' && activePeer ? () => void removeFriend(activePeer) : undefined
            }
            onLeaveGroup={
              activeRefParsed.kind === 'group' ? () => void leaveGroup(activeRefParsed.id) : undefined
            }
          />
        )}

        {mainPane.kind === 'chat-search' && activeRefParsed && activeConversationId === mainPane.key && (
          <ChatSearchPage
            peerKind={activeRefParsed.kind}
            peerId={activeRefParsed.id}
            title={chatInfoTitle}
            frozen={isFrozen}
            onBack={() => setMainPane({ kind: 'chat-info', key: mainPane.key })}
            onJump={(messageId) => {
              setFocusMessageId(messageId);
              setMainPane({ kind: 'chat' });
            }}
          />
        )}

        {paneGroup && mainPane.kind === 'group-info' && (
          <GroupInfoPage
            group={paneGroup}
            members={groupInfoData?.members ?? []}
            myId={user.id}
            presence={presence}
            joinRequestCount={groupInfoJoinCount}
            frozen={isFrozen}
            onBack={closeSidePage}
            onSendMessage={() => openConversation(convKey.group(paneGroup.id))}
            onOpenMembers={() => openGroupMembers(paneGroup.id)}
            onOpenFiles={() => openGroupFiles(paneGroup.id)}
            onOpenRequests={() => openGroupRequests(paneGroup.id)}
            onReload={reloadGroupInfo}
            onLeave={() => void leaveGroup(paneGroup.id)}
            onDissolve={() => void dissolveGroup(paneGroup.id)}
          />
        )}

        {paneGroup && groupInfoData && mainPane.kind === 'group-members' && (
          <GroupMembersPage
            group={paneGroup}
            members={groupInfoData.members}
            friends={sortedFriends}
            myId={user.id}
            presence={presence}
            frozen={isFrozen}
            onBack={() => setMainPane({ kind: 'group-info', groupId: paneGroup.id })}
            onReload={reloadGroupInfo}
          />
        )}

        {paneGroup && mainPane.kind === 'group-files' && (
          <GroupFilesPage
            groupId={paneGroup.id}
            onBack={() => setMainPane({ kind: 'group-info', groupId: paneGroup.id })}
          />
        )}

        {paneGroup && mainPane.kind === 'group-requests' && (
          <GroupRequestsPage
            groupId={paneGroup.id}
            onBack={() => setMainPane({ kind: 'group-info', groupId: paneGroup.id })}
            onCountChange={setGroupInfoJoinCount}
            onReload={reloadGroupInfo}
          />
        )}
      </main>

      <ProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSignOut={handleSignOut}
      />
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

      {convMenu && (
        <ContextMenu x={convMenu.x} y={convMenu.y} onClose={closeConvMenu} testId="conv-menu">
          <button
            type="button"
            className="msg-menu-item"
            data-testid="conv-menu-profile"
            onClick={() => {
              const ref = parseConversationKey(convMenu.key);
              if (!ref) return;
              setConvMenu(null);
              if (ref.kind === 'group') void openGroupInfo(ref.id);
              else openFriendProfile(ref.id);
            }}
          >
            {convMenu.key.startsWith('g:') ? '群资料' : '查看资料'}
          </button>
          <button type="button" className="msg-menu-item" onClick={() => togglePin(convMenu.key)}>
            {convSettings[convMenu.key]?.pinned ? '取消置顶' : '置顶会话'}
          </button>
          <button type="button" className="msg-menu-item" onClick={() => toggleMute(convMenu.key)}>
            {convSettings[convMenu.key]?.muted ? '允许消息通知' : '消息免打扰'}
          </button>
          <button type="button" className="msg-menu-item" onClick={() => clearConversation(convMenu.key)}>
            清空聊天记录
          </button>
          <button type="button" className="msg-menu-item danger" onClick={() => deleteConversation(convMenu.key)}>
            删除会话
          </button>
        </ContextMenu>
      )}
    </div>
  );
}
