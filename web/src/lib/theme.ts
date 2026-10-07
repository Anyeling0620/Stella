import { STORAGE_KEYS } from '../config';

/**
 * Theme registry.
 *
 * A theme is nothing but a set of CSS custom properties, so switching is a single
 * attribute on `<html>` — no re-render, no style recalculation beyond what the
 * browser already does for a token change. The palettes live in `styles.css`
 * (`[data-theme='…']` blocks); this file only holds the ids and the plumbing.
 */
export const THEME_IDS = [
  'wechat',
  'wechat-dark',
  'apple',
  'apple-dark',
  'acid',
  'cyan',
  'lime',
  'magenta',
  'ember',
  'blueprint',
  'paper',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = 'wechat';

/** Human labels are only used as `title`/`aria-label`, never as visible copy. */
export const THEME_LABELS: Record<ThemeId, string> = {
  wechat: '微信绿',
  'wechat-dark': '微信深色',
  apple: '苹果',
  'apple-dark': '苹果深色',
  acid: '酸性黄',
  cyan: '青',
  lime: '荧光绿',
  magenta: '洋红',
  ember: '橙焰',
  blueprint: '蓝图',
  paper: '纸白',
};

/**
 * Light/dark counterpart of each theme, used by the rail's day/night toggle so
 * it flips within the active theme family instead of jumping to WeChat dark.
 */
export const THEME_PAIRS: Partial<Record<ThemeId, ThemeId>> = {
  wechat: 'wechat-dark',
  'wechat-dark': 'wechat',
  apple: 'apple-dark',
  'apple-dark': 'apple',
};

const THEME_SET: ReadonlySet<string> = new Set(THEME_IDS);

export const isThemeId = (value: unknown): value is ThemeId =>
  typeof value === 'string' && THEME_SET.has(value);

export function readStoredTheme(): ThemeId {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.theme);
    return isThemeId(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Applies a theme to the document root and persists it for the next visit. */
export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', id);
  try {
    window.localStorage.setItem(STORAGE_KEYS.theme, id);
  } catch {
    /* storage unavailable — the theme still applies for this session */
  }
}
