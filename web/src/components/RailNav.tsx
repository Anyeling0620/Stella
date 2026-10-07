import { Avatar } from './Avatar';
import type { User } from '../types';

/**
 * WeChat-style left rail.
 *
 * A 72px fixed icon column: the user's avatar on top, the primary destinations
 * in the middle, and a day/night theme toggle pinned to the bottom. It is the
 * first column of `.shell-left`, so the draggable splitter (which resizes
 * `--sidebar-w`) grows the whole left region — the e2e contract reads
 * `shell.firstElementChild` width, which stays the rail + list wrapper.
 *
 * Every destination maps to an existing view. 收藏 / 朋友圈 have no backend and
 * render a placeholder pane.
 */
export type ShellView = 'chats' | 'friends' | 'groups' | 'favorites' | 'moments';

/** Self-drawn 24px line icons — deliberately not WeChat's trademark artwork. */
type IconProps = { children: React.ReactNode };

const Icon = ({ children }: IconProps) => (
  <svg
    className="rail-icon"
    viewBox="0 0 24 24"
    width="24"
    height="24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const ChatIcon = () => (
  <Icon>
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.2v-3.2H6.5A2.5 2.5 0 0 1 4 13.5z" />
  </Icon>
);

const ContactIcon = () => (
  <Icon>
    <circle cx="12" cy="8" r="3.4" />
    <path d="M5.5 19.5c.7-3.2 3.3-5 6.5-5s5.8 1.8 6.5 5" />
  </Icon>
);

const GroupIcon = () => (
  <Icon>
    <circle cx="9" cy="8.5" r="2.9" />
    <path d="M3.6 19c.6-2.8 2.9-4.4 5.4-4.4s4.8 1.6 5.4 4.4" />
    <path d="M16 6.2a2.6 2.6 0 0 1 0 5.1" />
    <path d="M17.2 14.9c1.9.4 3.2 1.8 3.6 4.1" />
  </Icon>
);

const StarIcon = () => (
  <Icon>
    <path d="M12 4.5l2.3 4.7 5.2.7-3.8 3.6.9 5.1-4.6-2.5-4.6 2.5.9-5.1L4.5 9.9l5.2-.7z" />
  </Icon>
);

const MomentsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="5" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="18.6" cy="9.2" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="17.4" cy="17" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="6.6" cy="17" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="5.4" cy="9.2" r="1.3" fill="currentColor" stroke="none" />
  </Icon>
);

const SettingsIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3.5v2M12 18.5v2M4.9 7.5l1.7 1M17.4 15.5l1.7 1M4.9 16.5l1.7-1M17.4 8.5l1.7-1" />
    <path d="M12 3.5a8.5 8.5 0 0 1 7.4 4.3M12 20.5a8.5 8.5 0 0 1-7.4-4.3M19.4 12a8.5 8.5 0 0 1-1.6 4.9M6.2 7.1A8.5 8.5 0 0 0 4.6 12" />
  </Icon>
);

const MoonIcon = () => (
  <Icon>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Icon>
);

const SunIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
  </Icon>
);

interface RailItemProps {
  testId: string;
  label: string;
  active: boolean;
  icon: React.ReactNode;
  /** Numeric unread counter (rendered only when > 0; capped at 99+). */
  count?: number;
  /** Small red dot for mentions / new requests (when no count is shown). */
  dot?: boolean;
  onClick: () => void;
}

function RailItem({ testId, label, active, icon, count = 0, dot = false, onClick }: RailItemProps) {
  const badge = count > 99 ? '99+' : String(count);
  return (
    <button
      type="button"
      className={`rail-item ${active ? 'active' : ''}`}
      data-testid={testId}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={label}
      onClick={onClick}
    >
      {icon}
      {count > 0 ? (
        <span className="rail-badge" aria-label={`${count} 条未读消息`}>
          {badge}
        </span>
      ) : dot ? (
        <span className="rail-dot" aria-label="有新的提醒" />
      ) : null}
    </button>
  );
}

interface RailNavProps {
  user: User;
  view: ShellView;
  /** Total unread across all conversations. */
  unreadTotal: number;
  /** Incoming friend requests awaiting a decision. */
  friendBadge: number;
  /** Any group @-mentions the current user. */
  groupMention: boolean;
  /** True while this window is the non-active (frozen) one. */
  frozen: boolean;
  isDark: boolean;
  onSelect: (view: ShellView) => void;
  onProfile: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
}

export function RailNav({
  user,
  view,
  unreadTotal,
  friendBadge,
  groupMention,
  frozen,
  isDark,
  onSelect,
  onProfile,
  onOpenSettings,
  onToggleTheme,
}: RailNavProps) {
  return (
    <nav className="rail" aria-label="主导航">
      <button
        type="button"
        className="rail-avatar"
        data-testid="profile-open"
        aria-label="我的资料"
        title={`${user.nickname} · @${user.username}`}
        onClick={onProfile}
      >
        <Avatar name={user.nickname} avatar={user.avatar} size={40} />
        <span className="rail-avatar-name">{user.nickname}</span>
      </button>

      <div className="rail-nav">
        <RailItem
          testId="tab-chats"
          label="消息"
          active={view === 'chats'}
          icon={<ChatIcon />}
          count={unreadTotal}
          onClick={() => onSelect('chats')}
        />
        <RailItem
          testId="tab-friends"
          label="通讯录"
          active={view === 'friends'}
          icon={<ContactIcon />}
          count={friendBadge}
          onClick={() => onSelect('friends')}
        />
        <RailItem
          testId="tab-groups"
          label="群聊"
          active={view === 'groups'}
          icon={<GroupIcon />}
          dot={groupMention}
          onClick={() => onSelect('groups')}
        />
        <RailItem
          testId="tab-favorites"
          label="收藏"
          active={view === 'favorites'}
          icon={<StarIcon />}
          onClick={() => onSelect('favorites')}
        />
        <RailItem
          testId="tab-moments"
          label="朋友圈"
          active={view === 'moments'}
          icon={<MomentsIcon />}
          onClick={() => onSelect('moments')}
        />
        <button
          type="button"
          className="rail-item"
          data-testid="settings-open"
          aria-label="设置"
          title="设置"
          onClick={onOpenSettings}
        >
          <SettingsIcon />
        </button>
      </div>

      <button
        type="button"
        className="rail-item rail-bottom"
        data-testid="rail-theme-toggle"
        aria-label="切换主题"
        title={isDark ? '切换到日间' : '切换到夜间'}
        disabled={frozen}
        onClick={onToggleTheme}
      >
        {isDark ? <SunIcon /> : <MoonIcon />}
      </button>
    </nav>
  );
}
