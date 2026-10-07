import { Avatar } from './Avatar';

interface PresenceAvatarProps {
  name: string;
  avatar: string | null;
  size?: number;
  tone?: 'primary' | 'muted';
  online: boolean;
}

/**
 * Avatar with a small "online" badge pinned to its bottom-right corner.
 *
 * Kept as a wrapper (rather than a dot inside `Avatar`) so the badge can sit
 * outside the avatar's rounded clip and overlap it, WeChat-style.
 */
export function PresenceAvatar({ name, avatar, size = 40, tone, online }: PresenceAvatarProps) {
  return (
    <span className="presence-wrap">
      <Avatar name={name} avatar={avatar} size={size} tone={tone} />
      {online && <span className="presence-dot" role="img" aria-label="在线" />}
    </span>
  );
}
