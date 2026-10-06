/** Small display helpers. */

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

export function formatClock(iso: string | undefined): string { // 这是一个将ISO时间字符串格式化为时钟显示的函数。它接收一个可选的ISO时间字符串作为参数，如果该字符串存在且有效，则返回格式化后的时钟字符串（例如 "14:30"），否则返回空字符串。
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`;
}

export function formatDayLabel(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  if (sameDay) return '今天';
  return `${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`;
}

/**
 * Compact timestamp for the conversation list (WeChat style):
 * today -> HH:mm, yesterday -> 昨天, within a week -> 星期X, else MM/DD.
 */
export function formatListTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return formatClock(iso);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';

  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (days >= 0 && days < 7) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** Human readable reason for a non-open realtime state. */
export function describeRealtime(state: string, mode: string): string {  // 这是
  if (state === 'open') return mode === 'ws' ? '长连接已建立' : '连接中';
  if (state === 'connecting') return '正在建立长连接…';
  if (state === 'reconnecting') return '连接中断，正在指数退避重连…';
  if (state === 'polling') return '长连接不可用，已降级为 HTTP 增量轮询';
  if (state === 'idle') return '未登录，未发起连接';
  return '连接已关闭';
}

export const initials = (name: string): string => (name ? name.trim().slice(0, 1).toUpperCase() : '?');

/** Byte size for file cards: 512 B / 3.4 KB / 2.1 MB. */
export function formatBytes(bytes: number | undefined): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
