/**
 * Built-in avatar artwork.
 *
 * The server only stores a preset *id* (`server/src/constants/avatars.js` owns the
 * whitelist); the artwork lives here. Both lists must stay in sync — adding a
 * preset means adding the id on both sides.
 *
 * Every preset is square, high-contrast and drawn from three tones (backdrop,
 * ink, accent) so it stays legible at 24px and matches the brutalist treatment.
 */
export const AVATAR_PRESET_IDS = [
  'p01',
  'p02',
  'p03',
  'p04',
  'p05',
  'p06',
  'p07',
  'p08',
  'p09',
  'p10',
  'p11',
  'p12',
] as const;

export type AvatarPresetId = (typeof AVATAR_PRESET_IDS)[number];

const PRESET_SET: ReadonlySet<string> = new Set(AVATAR_PRESET_IDS);

/** True when a stored `avatar` value is one of our presets. */
export function isAvatarPreset(value: string | null | undefined): value is AvatarPresetId {
  return typeof value === 'string' && PRESET_SET.has(value);
}

const INK = 'var(--avatar-ink)';
const ACCENT = 'var(--avatar-accent)';
const BACK = 'var(--avatar-back)';

function shapes(id: AvatarPresetId) {
  switch (id) {
    case 'p01':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <polygon points="0,0 100,0 0,100" fill={ACCENT} />
        </>
      );
    case 'p02':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <rect x="12" y="12" width="76" height="76" fill="none" stroke={INK} strokeWidth="12" />
          <rect x="38" y="38" width="24" height="24" fill={ACCENT} />
        </>
      );
    case 'p03':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <rect y="0" width="100" height="14" fill={ACCENT} />
          <rect y="22" width="100" height="14" fill={INK} />
          <rect y="44" width="100" height="14" fill={ACCENT} />
          <rect y="66" width="100" height="14" fill={INK} />
          <rect y="86" width="100" height="14" fill={ACCENT} />
        </>
      );
    case 'p04':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <rect x="0" y="0" width="50" height="50" fill={INK} />
          <rect x="50" y="50" width="50" height="50" fill={INK} />
          <rect x="50" y="0" width="50" height="50" fill={ACCENT} />
        </>
      );
    case 'p05':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <circle cx="50" cy="50" r="34" fill={ACCENT} />
          <rect x="62" y="62" width="38" height="38" fill={INK} />
        </>
      );
    case 'p06':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <rect x="38" y="6" width="24" height="88" fill={INK} />
          <rect x="6" y="38" width="88" height="24" fill={ACCENT} />
        </>
      );
    case 'p07':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <polyline points="14,30 50,64 86,30" fill="none" stroke={ACCENT} strokeWidth="14" />
          <polyline points="14,58 50,92 86,58" fill="none" stroke={INK} strokeWidth="14" />
        </>
      );
    case 'p08':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <path d="M0,0 A100,100 0 0 1 100,100 L0,100 Z" fill={INK} />
          <circle cx="26" cy="26" r="16" fill={ACCENT} />
        </>
      );
    case 'p09':
      return (
        <>
          <rect width="100" height="100" fill={INK} />
          <g fill={ACCENT}>
            <circle cx="26" cy="26" r="9" />
            <circle cx="50" cy="26" r="9" />
            <circle cx="74" cy="26" r="9" />
            <circle cx="26" cy="50" r="9" />
            <circle cx="50" cy="50" r="9" />
            <circle cx="74" cy="50" r="9" />
            <circle cx="26" cy="74" r="9" />
            <circle cx="50" cy="74" r="9" />
            <circle cx="74" cy="74" r="9" />
          </g>
        </>
      );
    case 'p10':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <polygon points="50,8 74,42 26,42" fill={ACCENT} />
          <polygon points="50,38 82,80 18,80" fill={INK} />
          <rect y="86" width="100" height="14" fill={ACCENT} />
        </>
      );
    case 'p11':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <rect x="8" y="30" width="22" height="70" fill={INK} />
          <rect x="39" y="8" width="22" height="92" fill={ACCENT} />
          <rect x="70" y="46" width="22" height="54" fill={INK} />
        </>
      );
    case 'p12':
      return (
        <>
          <rect width="100" height="100" fill={BACK} />
          <rect x="0" y="0" width="100" height="50" fill={INK} />
          <circle cx="50" cy="50" r="22" fill={ACCENT} />
        </>
      );
    default:
      return null;
  }
}

interface PresetArtProps {
  id: AvatarPresetId;
}

/** Square preset artwork; fills its parent box. */
export function PresetArt({ id }: PresetArtProps) {
  return (
    <svg className="avatar-art" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {shapes(id)}
    </svg>
  );
}
