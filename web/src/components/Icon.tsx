import type { ReactNode } from 'react';

/**
 * The app's single icon language.
 *
 * One 24×24 grid, 1.7px stroke, round joins, `currentColor` only — the same
 * geometry the rail and composer glyphs already used, now in one place. An icon
 * therefore inherits the surrounding text colour and every theme gets it for
 * free, and there is exactly one stroke weight to tune.
 *
 * No emoji and no "text that happens to look like an icon" (＋ ✓ ‹ › ◍ …): those
 * shift with the platform font, come out multi-coloured on some systems and
 * break the monochrome look.
 */
const PATHS: Record<string, ReactNode> = {
  // --- rail -----------------------------------------------------------------
  chat: (
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4 3.2v-3.2H6.5A2.5 2.5 0 0 1 4 13.5z" />
  ),
  contacts: (
    <>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 19.5c.7-3.2 3.3-5 6.5-5s5.8 1.8 6.5 5" />
    </>
  ),
  group: (
    <>
      <circle cx="9" cy="8.5" r="2.9" />
      <path d="M3.6 19c.6-2.8 2.9-4.4 5.4-4.4s4.8 1.6 5.4 4.4" />
      <path d="M16 6.2a2.6 2.6 0 0 1 0 5.1" />
      <path d="M17.2 14.9c1.9.4 3.2 1.8 3.6 4.1" />
    </>
  ),
  star: <path d="M12 4.5l2.3 4.7 5.2.7-3.8 3.6.9 5.1-4.6-2.5-4.6 2.5.9-5.1L4.5 9.9l5.2-.7z" />,
  moments: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18.6" cy="9.2" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="17.4" cy="17" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="6.6" cy="17" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="5.4" cy="9.2" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2M12 18.5v2M4.9 7.5l1.7 1M17.4 15.5l1.7 1M4.9 16.5l1.7-1M17.4 8.5l1.7-1" />
      <path d="M12 3.5a8.5 8.5 0 0 1 7.4 4.3M12 20.5a8.5 8.5 0 0 1-7.4-4.3M19.4 12a8.5 8.5 0 0 1-1.6 4.9M6.2 7.1A8.5 8.5 0 0 0 4.6 12" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
    </>
  ),

  // --- composer -------------------------------------------------------------
  emoji: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.4 14.4a4.6 4.6 0 0 0 7.2 0" />
      <circle cx="9.2" cy="9.6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="9.6" r="0.7" fill="currentColor" stroke="none" />
    </>
  ),
  'plus-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8.4v7.2M8.4 12h7.2" />
    </>
  ),
  mention: (
    <>
      <circle cx="12" cy="12" r="3.6" />
      <path d="M15.6 8.4v5.1a2.55 2.55 0 0 0 5.1 0V12a8.7 8.7 0 1 0-3.4 6.9" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M4.5 17.2l4.3-4.3 3.7 3.7 2.6-2.6 4.4 4.4" />
    </>
  ),
  file: (
    <>
      <path d="M6.5 4.3c0-1 .8-1.8 1.8-1.8h5.2l5 5v12.2c0 1-.8 1.8-1.8 1.8H8.3c-1 0-1.8-.8-1.8-1.8z" />
      <path d="M13.5 2.5v4.9h4.9" />
    </>
  ),
  mic: (
    <>
      <rect x="9.5" y="3.5" width="5" height="9" rx="2.5" />
      <path d="M6 11.5a6 6 0 0 0 12 0" />
      <path d="M12 17.5V21" />
    </>
  ),

  // --- generic --------------------------------------------------------------
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  'chevron-left': <path d="M14.5 5.5 8 12l6.5 6.5" />,
  'chevron-right': <path d="M9.5 5.5 16 12l-6.5 6.5" />,
  /** 置顶 — a pushpin: flat head tapering into a needle. */
  pin: (
    <>
      <path d="M8.2 4.2h7.6l-1 4.3L12 12.6 9.2 8.5z" />
      <path d="M12 12.6v7.9" />
    </>
  ),
  /** 消息免打扰 — a bell crossed out. */
  mute: (
    <>
      <path d="M18 8.6a6 6 0 1 0-12 0c0 4.6-2 6.2-2 6.2h16s-.7-1.1-1.3-2.8" />
      <path d="M9.6 19a2.5 2.5 0 0 0 4.8 0" />
      <path d="M4.6 4.6l14.8 14.8" />
    </>
  ),
  /** The recording dot — the one filled mark in the set. */
  record: <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />,
  /** 更多 / 管理 — the horizontal three-dot affordance. */
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </>
  ),

  // --- status / toasts ------------------------------------------------------
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M7.9 12.4l2.9 2.9 5.6-6" />
    </>
  ),
  'close-circle': (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.4 3.5 19.6h17z" />
      <path d="M12 10v4.2" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 10.6v2.8a1.5 1.5 0 0 0 1.5 1.5h2L16 19.4V4.6L7.5 9.1H5.5A1.5 1.5 0 0 0 4 10.6z" />
      <path d="M18.4 8.6a4 4 0 0 1 0 6.8" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

interface IconProps {
  name: IconName;
  /** Rendered size in px (square). */
  size?: number;
  className?: string;
  strokeWidth?: number;
  /** Provide only when the icon carries meaning on its own. */
  title?: string;
}

export function Icon({ name, size = 20, className, strokeWidth = 1.7, title }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
