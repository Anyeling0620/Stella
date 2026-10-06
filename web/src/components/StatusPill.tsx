import { useEffect, useState } from 'react';
import { describeRealtime } from '../lib/format';
import { useAppRealtime } from '../context/AppContext';

const STATE_TONE: Record<string, string> = {
  open: 'ok',
  connecting: 'warn',
  reconnecting: 'warn',
  polling: 'warn',
  idle: 'idle',
  closed: 'bad',
};

/**
 * Bottom-left network status — a live read of *both* layers:
 *   - the device link (`navigator.onLine` + online/offline events): 无网络;
 *   - the realtime link (WS / polling / reconnecting) plus transport and RTT.
 *
 * The `data-*` attributes (`data-state`, `data-transport`, `data-network`, …)
 * are what the browser regression suite reads; the label is for humans.
 */
export function StatusPill() {
  const { status, transport, isLeader, transportMode, latencyMs } = useAppRealtime();
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  const tone = !online ? 'bad' : STATE_TONE[status.state] ?? 'idle';
  const transportLabel = transport === 'shared-worker' ? 'SharedWorker 单连接' : '页内降级连接';
  const roleLabel = isLeader ? '活跃窗口' : '只读窗口';
  const stateLabel = describeRealtime(status.state, status.mode);

  let label: string;
  if (!online) label = '无网络';
  else if (status.state === 'open') label = '已连接';
  else if (status.state === 'polling') label = '轮询中';
  else if (status.state === 'reconnecting') label = status.attempt > 0 ? `重连中 #${status.attempt}` : '重连中';
  else if (status.state === 'connecting') label = '连接中';
  else if (status.state === 'idle') label = '未连接';
  else label = '已断开';

  const latency = online && status.state === 'open' && latencyMs != null ? `${latencyMs}ms` : '';

  const title = [
    online ? '网络：在线' : '网络：离线',
    stateLabel,
    transportMode === 'poll' ? '连接策略：仅轮询' : '连接策略：自动',
    `传输：${transportLabel}`,
    roleLabel,
    latency ? `延迟 ${latency}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      className="status-pill"
      data-testid="status-pill"
      data-state={status.state}
      data-mode={status.mode}
      data-transport={transport}
      data-network={online ? 'online' : 'offline'}
      title={title}
    >
      <span
        className={`dot ${tone}`}
        data-testid="status-dot"
        data-state={status.state}
        data-network={online ? 'online' : 'offline'}
      />
      <span
        data-testid="status-role"
        data-role={isLeader ? 'leader' : 'follower'}
        aria-label={roleLabel}
      />
      <span className="status-text" data-testid="status-text" data-tone={tone}>
        {label}
        {latency && <span className="status-latency">{latency}</span>}
      </span>
    </div>
  );
}
