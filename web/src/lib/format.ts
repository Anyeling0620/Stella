/** Small display helpers. */

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

export function formatClock(iso: string | undefined): string {
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

/** Human readable reason for a non-open realtime state. */
export function describeRealtime(state: string, mode: string): string {
  if (state === 'open') return mode === 'ws' ? '长连接已建立' : '连接中';
  if (state === 'connecting') return '正在建立长连接…';
  if (state === 'reconnecting') return '连接中断，正在指数退避重连…';
  if (state === 'polling') return '长连接不可用，已降级为 HTTP 增量轮询';
  if (state === 'idle') return '未登录，未发起连接';
  return '连接已关闭';
}

export const initials = (name: string): string => (name ? name.trim().slice(0, 1).toUpperCase() : '?');
