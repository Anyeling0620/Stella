import { memo, type CSSProperties } from 'react';
import { initials } from '../lib/format';
import { PresetArt, isAvatarPreset } from '../lib/avatarPresets';

interface AvatarProps {
  name: string;
  /** Preset id from `User.avatar`; anything unknown falls back to initials. */
  avatar?: string | null;
  size?: number;
  tone?: 'primary' | 'muted';
}

/**
 * Square identity mark.
 *
 * Renders the chosen preset artwork when there is one, otherwise a monogram.
 * Size is passed as a CSS custom property so all colour decisions stay in the
 * stylesheet (the previous version hardcoded a gradient inline, which no
 * restyle could reach).
 */
export const Avatar = memo(function Avatar({ name, avatar, size = 40, tone = 'primary' }: AvatarProps) {
  const preset = isAvatarPreset(avatar) ? avatar : null;

  return (
    <span
      className="avatar"
      data-avatar={preset ?? 'initials'}
      data-tone={tone}
      style={{ '--avatar-size': `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      {preset ? <PresetArt id={preset} /> : <span className="avatar-initials">{initials(name)}</span>}
    </span>
  );
});
