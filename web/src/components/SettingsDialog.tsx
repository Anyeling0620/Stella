import { useCallback, useEffect, useState } from 'react';
import { THEME_IDS, THEME_LABELS, applyTheme, readStoredTheme, type ThemeId } from '../lib/theme';
import { useAppActions, useAppRealtime, useAppSession } from '../context/AppContext';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Signs out and returns to the login route (owned by the shell). */
  onSignOut: () => void | Promise<void>;
}

type SettingsTab = 'theme' | 'network' | 'account';

/**
 * Application settings — deliberately separate from the personal profile.
 *
 * Two-pane: a category rail on the left, the selected section on the right, so
 * you never scroll through unrelated settings to find one. All panels stay
 * mounted (inactive ones `hidden`) so nothing is lost when switching.
 */
export function SettingsDialog({ open, onClose, onSignOut }: SettingsDialogProps) {
  const { user } = useAppSession();
  const { transportMode, transportHost, transport } = useAppRealtime();
  const { setTransportMode, setTransportHost } = useAppActions();
  const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme());
  const [tab, setTab] = useState<SettingsTab>('theme');

  useEffect(() => {
    if (open) {
      setTheme(readStoredTheme());
      setTab('theme');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const pickTheme = useCallback((id: ThemeId) => {
    setTheme(id);
    applyTheme(id);
  }, []);

  if (!open) return null;

  return (
    <div className="dialog-overlay" onMouseDown={onClose} data-testid="settings-dialog">
      <div className="dialog dialog-wide" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-head">
          <span className="dialog-title">设置</span>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="关闭"
            data-testid="settings-close"
          >
            ×
          </button>
        </header>

        <div className="dialog-split">
          <nav className="dialog-nav" aria-label="设置分类">
            <button
              type="button"
              className={tab === 'theme' ? 'active' : ''}
              aria-current={tab === 'theme' ? 'true' : undefined}
              onClick={() => setTab('theme')}
            >
              外观
            </button>
            <button
              type="button"
              className={tab === 'network' ? 'active' : ''}
              aria-current={tab === 'network' ? 'true' : undefined}
              onClick={() => setTab('network')}
            >
              网络
            </button>
            <button
              type="button"
              className={tab === 'account' ? 'active' : ''}
              aria-current={tab === 'account' ? 'true' : undefined}
              onClick={() => setTab('account')}
            >
              账号
            </button>
          </nav>

          {/* --- 外观 ------------------------------------------------------- */}
          <section className="dialog-pane" hidden={tab !== 'theme'} aria-label="外观">
            <div className="field">
              <span>主题</span>
              <div className="theme-grid" role="radiogroup" aria-label="主题">
                {THEME_IDS.map((id) => (
                  // `data-theme` on the swatch makes its own tokens resolve here,
                  // so each swatch previews the real palette without duplicating it.
                  <button
                    key={id}
                    type="button"
                    className="theme-option"
                    data-theme={id}
                    data-testid="theme-option"
                    data-theme-id={id}
                    aria-checked={theme === id}
                    aria-label={THEME_LABELS[id]}
                    title={THEME_LABELS[id]}
                    onClick={() => pickTheme(id)}
                  >
                    <span className="theme-option-fill" />
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* --- 网络（高级） ----------------------------------------------- */}
          <section className="dialog-pane" hidden={tab !== 'network'} aria-label="网络">
            <div className="field">
              <span>传输模式</span>
              <div className="segmented" role="radiogroup" aria-label="传输模式">
                <button
                  type="button"
                  className={transport === 'shared-worker' ? 'active' : ''}
                  data-testid="host-shared-worker"
                  aria-checked={transportHost === 'shared-worker'}
                  onClick={() => setTransportHost('shared-worker')}
                >
                  SharedWorker 单连接
                </button>
                <button
                  type="button"
                  className={transport === 'in-tab-fallback' ? 'active' : ''}
                  data-testid="host-in-tab"
                  aria-checked={transportHost === 'in-tab'}
                  onClick={() => setTransportHost('in-tab')}
                >
                  页内单例抢占
                </button>
              </div>
              <p className="field-hint">
                SharedWorker：整个浏览器共享一条长连接（默认，自动检测）。页内单例抢占：不依赖 Worker，由最新打开的窗口独占连接并转发给其它窗口。切换会重建连接。
              </p>
            </div>

            <div className="field">
              <span>连接策略</span>
              <div className="segmented" role="radiogroup" aria-label="连接策略">
                <button
                  type="button"
                  className={transportMode === 'auto' ? 'active' : ''}
                  data-testid="transport-auto"
                  aria-checked={transportMode === 'auto'}
                  onClick={() => setTransportMode('auto')}
                >
                  自动（WebSocket 优先）
                </button>
                <button
                  type="button"
                  className={transportMode === 'poll' ? 'active' : ''}
                  data-testid="transport-poll"
                  aria-checked={transportMode === 'poll'}
                  onClick={() => setTransportMode('poll')}
                >
                  仅轮询（关闭 WS）
                </button>
              </div>
              <p className="field-hint">
                仅轮询会停用 WebSocket，改用 HTTP 增量轮询（用于验证断线降级链路）。改后立即生效，无需保存。
              </p>
            </div>
          </section>

          {/* --- 账号 ------------------------------------------------------- */}
          <section className="dialog-pane" hidden={tab !== 'account'} aria-label="账号">
            <div className="field">
              <span>当前账号</span>
              <div className="settings-account">
                <span className="settings-account-name">{user?.nickname ?? '—'}</span>
                <span className="settings-account-sub">@{user?.username ?? '—'}</span>
              </div>
            </div>
            <button
              type="button"
              className="btn btn-block settings-signout"
              data-testid="signout"
              onClick={() => void onSignOut()}
            >
              退出登录
            </button>
          </section>
        </div>

        <footer className="dialog-foot">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </footer>
      </div>
    </div>
  );
}
