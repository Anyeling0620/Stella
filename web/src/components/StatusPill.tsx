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

/** Two characters is enough when something needs attention. */
const STATE_SHORT: Record<string, string> = {
  idle: '离线',
  connecting: '连接中',
  reconnecting: '重连',
  polling: '轮询',
  closed: '断开',
};

/**
 * Connection + window-role indicator, reduced to two marks.
 *
 * Silence means healthy: a short label appears only when the link is not a
 * normal open socket. Everything technical (exact state, transport, retry
 * count) stays on `data-*` attributes and in the tooltip, which is what the
 * browser regression suite reads.
 */
export function StatusPill() {
  const { status, transport, isLeader } = useAppRealtime();
  const tone = STATE_TONE[status.state] ?? 'idle';
  const transportLabel = transport === 'shared-worker' ? 'SharedWorker 单连接' : '页内降级连接';
  const roleLabel = isLeader ? '活跃窗口' : '只读窗口';
  const stateLabel = describeRealtime(status.state, status.mode);
  const retryLabel =
    status.state === 'reconnecting' && status.attempt > 0
      ? `重连 #${status.attempt}${status.nextRetryMs > 0 ? `（${Math.round(status.nextRetryMs / 1000)}s）` : ''}`
      : '';

  const healthy = status.state === 'open';
  const short = STATE_SHORT[status.state] ?? '';

  return (
    <div
      className="status-pill"
      data-testid="status-pill"
      data-state={status.state}
      data-mode={status.mode}
      data-transport={transport}
      title={[stateLabel, transportLabel, roleLabel, retryLabel].filter(Boolean).join(' · ')}
    >
      <span className={`dot ${tone}`} data-testid="status-dot" data-state={status.state} />
      <span
        className={`role-marker ${isLeader ? 'leader' : 'follower'}`}
        data-testid="status-role"
        data-role={isLeader ? 'leader' : 'follower'}
        aria-label={roleLabel}
      />
      {!healthy && short && (
        <span className="status-warn" data-testid="status-warn">
          {short}
        </span>
      )}
    </div>
  );
}
