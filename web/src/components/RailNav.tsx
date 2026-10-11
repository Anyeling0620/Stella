import { Avatar } from './Avatar';
import { Icon, type IconName } from './Icon';
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

/**
 * Every rail icon comes from the shared set (`Icon`), so the rail, the composer
 * and the menus are literally the same line art — one grid, one stroke weight.
 */
const RailIcon = ({ name }: { name: IconName }) => <Icon name={name} size={24} className="rail-icon" />;

interface RailItemProps {
  testId: string;
  label: string;
  active: boolean;
  icon: IconName;
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
      <RailIcon name={icon} />
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
          icon="chat"
          count={unreadTotal}
          onClick={() => onSelect('chats')}
        />
        <RailItem
          testId="tab-friends"
          label="通讯录"
          active={view === 'friends'}
          icon="contacts"
          count={friendBadge}
          onClick={() => onSelect('friends')}
        />
        <RailItem
          testId="tab-groups"
          label="群聊"
          active={view === 'groups'}
          icon="group"
          dot={groupMention}
          onClick={() => onSelect('groups')}
        />
        <RailItem
          testId="tab-favorites"
          label="收藏"
          active={view === 'favorites'}
          icon="star"
          onClick={() => onSelect('favorites')}
        />
        <RailItem
          testId="tab-moments"
          label="朋友圈"
          active={view === 'moments'}
          icon="moments"
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
          <RailIcon name="settings" />
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
        {isDark ? <RailIcon name="sun" /> : <RailIcon name="moon" />}
      </button>
    </nav>
  );
}
