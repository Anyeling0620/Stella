import { useCallback, useEffect, useState } from 'react';
import { THEME_IDS, THEME_LABELS, applyTheme, readStoredTheme, type ThemeId } from '../lib/theme';
import { useAppActions, useAppRealtime, useAppSession } from '../context/AppContext';
import { authApi, friendApi, settingsApi } from '../lib/api';
import { ApiError } from '../lib/axiosClient';
import { disablePush, enablePush, isPushSubscribed, pushSupported } from '../lib/push';
import { idbClear, storageEstimate } from '../lib/idb';
import { formatBytes } from '../lib/format';
import type { AuthSessionInfo, User, UserSettings } from '../types';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Signs out and returns to the login route (owned by the shell). */
  onSignOut: () => void | Promise<void>;
}

type SettingsTab = 'theme' | 'network' | 'privacy' | 'security' | 'account' | 'storage';

const DEFAULT_SETTINGS: UserSettings = {
  addByUsername: true,
  addByInvite: true,
  addByGroup: true,
  requireVerification: true,
  notifyDesktop: true,
  notifySound: true,
  notifyPreview: true,
};

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
  const { setTransportMode, setTransportHost, pushToast } = useAppActions();
  const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme());
  const [tab, setTab] = useState<SettingsTab>('theme');

  // --- privacy / security data (loaded when the dialog opens) --------------
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [sessions, setSessions] = useState<AuthSessionInfo[]>([]);
  const [blocks, setBlocks] = useState<Array<User & { blockedAt: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);

  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [delPw, setDelPw] = useState('');

  useEffect(() => {
    if (open) {
      setTheme(readStoredTheme());
      setTab('theme');
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
      setDelPw('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    void settingsApi.get().then((r) => setSettings(r.settings)).catch(() => {});
    void authApi.sessions().then((r) => setSessions(r.sessions)).catch(() => {});
    void friendApi.blocks().then((r) => setBlocks(r.blocks)).catch(() => {});
    void isPushSubscribed().then(setPushOn).catch(() => {});
    void storageEstimate().then(setUsage).catch(() => {});
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

  /** Optimistically flips a privacy/notification switch. */
  const toggleSetting = useCallback(
    async (key: keyof UserSettings) => {
      const next = { ...settings, [key]: !settings[key] };
      setSettings(next);
      try {
        const r = await settingsApi.update({ [key]: next[key] });
        setSettings(r.settings);
      } catch (err) {
        setSettings(settings); // revert
        pushToast({ kind: 'error', title: '设置保存失败', body: err instanceof ApiError ? err.message : undefined });
      }
    },
    [settings, pushToast]
  );

  /** 青少年模式 (simplified): flips all "add me by" switches at once. */
  const toggleTeenMode = useCallback(async () => {
    const turnOn = settings.addByUsername || settings.addByInvite || settings.addByGroup;
    const patch = turnOn
      ? { addByUsername: false, addByInvite: false, addByGroup: false }
      : { addByUsername: true, addByInvite: true, addByGroup: true };
    const previous = settings;
    setSettings({ ...settings, ...patch });
    try {
      const r = await settingsApi.update(patch);
      setSettings(r.settings);
    } catch {
      setSettings(previous);
      pushToast({ kind: 'error', title: '设置保存失败' });
    }
  }, [settings, pushToast]);

  /** Enable / disable Web Push for this browser. */
  const togglePush = useCallback(async () => {
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
        pushToast({ kind: 'info', title: '已关闭离线推送' });
      } else {
        await enablePush();
        setPushOn(true);
        pushToast({ kind: 'success', title: '已开启离线推送', body: '页面关闭后仍可收到新消息提醒' });
      }
    } catch (error) {
      pushToast({ kind: 'error', title: '操作失败', body: error instanceof Error ? error.message : undefined });
    }
  }, [pushOn, pushToast]);

  const changePassword = useCallback(async () => {    if (newPw !== confirmPw) {
      pushToast({ kind: 'warning', title: '两次输入的新密码不一致' });
      return;
    }
    setBusy(true);
    try {
      await authApi.changePassword({ oldPassword: oldPw, newPassword: newPw });
      pushToast({ kind: 'success', title: '密码已修改', body: '其他设备已被登出' });
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
      void authApi.sessions().then((r) => setSessions(r.sessions));
    } catch (err) {
      pushToast({ kind: 'error', title: '修改失败', body: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }, [oldPw, newPw, confirmPw, pushToast]);

  const revokeSession = useCallback(
    async (sessionId: string) => {
      try {
        await authApi.revokeSession(sessionId);
        setSessions((list) => list.filter((s) => s.sessionId !== sessionId));
      } catch (err) {
        pushToast({ kind: 'error', title: '操作失败', body: err instanceof ApiError ? err.message : undefined });
      }
    },
    [pushToast]
  );

  const revokeOthers = useCallback(async () => {
    try {
      await authApi.revokeOtherSessions();
      setSessions((list) => list.filter((s) => s.current));
      pushToast({ kind: 'success', title: '已登出其他设备' });
    } catch (err) {
      pushToast({ kind: 'error', title: '操作失败', body: err instanceof ApiError ? err.message : undefined });
    }
  }, [pushToast]);

  const unblock = useCallback(
    async (id: number) => {
      try {
        await friendApi.unblock(id);
        setBlocks((list) => list.filter((b) => b.id !== id));
      } catch {
        /* ignore */
      }
    },
    []
  );

  const deleteAccount = useCallback(async () => {
    setBusy(true);
    try {
      const r = await authApi.deleteAccount(delPw);
      pushToast({ kind: 'info', title: '账号已注销', body: `${r.coolingDays} 天内可联系恢复` });
      await onSignOut();
    } catch (err) {
      pushToast({ kind: 'error', title: '注销失败', body: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  }, [delPw, onSignOut, pushToast]);

  /** Clears the best-effort local caches (IndexedDB + service-worker shell). */
  const clearLocalCache = useCallback(async () => {
    await idbClear();
    try {
      navigator.serviceWorker?.controller?.postMessage({ type: 'clear-cache' });
    } catch {
      /* ignore */
    }
    pushToast({ kind: 'success', title: '本地缓存已清理' });
    void storageEstimate().then(setUsage).catch(() => {});
  }, [pushToast]);

  const exportData = useCallback(async () => {    try {
      const me = user;
      const blob = new Blob([JSON.stringify({ user: me, exportedAt: new Date().toISOString() }, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `stella-profile-${me?.id ?? 'me'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      pushToast({ kind: 'error', title: '导出失败' });
    }
  }, [user, pushToast]);

  if (!open) return null;

  const Switch = ({ label, hint, value, onToggle }: { label: string; hint?: string; value: boolean; onToggle: () => void }) => (
    <div className="settings-row">
      <div className="settings-row-text">
        <span>{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        className={`settings-switch ${value ? 'on' : ''}`}
        onClick={onToggle}
      >
        <span className="settings-switch-knob" />
      </button>
    </div>
  );

  return (
    <div className="dialog-overlay" onMouseDown={onClose} data-testid="settings-dialog">
      <div className="dialog dialog-wide dialog-fixed" onMouseDown={(event) => event.stopPropagation()}>
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
            {(
              [
                ['theme', '外观'],
                ['network', '网络'],
                ['privacy', '隐私'],
                ['security', '账号安全'],
                ['storage', '存储与数据'],
                ['account', '账号'],
              ] as Array<[SettingsTab, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={tab === id ? 'active' : ''}
                aria-current={tab === id ? 'true' : undefined}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
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

          {/* --- 隐私 ------------------------------------------------------- */}
          <section className="dialog-pane" hidden={tab !== 'privacy'} aria-label="隐私" data-testid="privacy-pane">
            <div className="field">
              <span>添加我的方式</span>
              <Switch
                label="允许通过用户名搜索添加"
                value={settings.addByUsername}
                onToggle={() => toggleSetting('addByUsername')}
              />
              <Switch
                label="允许通过邀请链接添加"
                value={settings.addByInvite}
                onToggle={() => toggleSetting('addByInvite')}
              />
              <Switch
                label="允许通过群聊成员添加"
                value={settings.addByGroup}
                onToggle={() => toggleSetting('addByGroup')}
              />
            </div>

            <div className="field">
              <span>好友验证</span>
              <Switch
                label="加我为好友时需要验证"
                hint={settings.requireVerification ? '关闭后任何人都能直接添加你，可能收到骚扰' : '当前任何人添加你都会直接成为好友'}
                value={settings.requireVerification}
                onToggle={() => toggleSetting('requireVerification')}
              />
            </div>

            <div className="field">
              <span>青少年模式</span>
              <Switch
                label="限制陌生人添加"
                hint="开启后关闭全部「添加我的方式」，仅已建立的关系不受影响"
                value={!settings.addByUsername && !settings.addByInvite && !settings.addByGroup}
                onToggle={() => void toggleTeenMode()}
              />
            </div>

            <div className="field">
              <span>通知</span>
              <Switch label="桌面 / 系统通知" value={settings.notifyDesktop} onToggle={() => toggleSetting('notifyDesktop')} />
              <Switch label="新消息提示音" value={settings.notifySound} onToggle={() => toggleSetting('notifySound')} />
              <Switch
                label="通知显示消息内容"
                hint="关闭后仅提示「收到一条新消息」"
                value={settings.notifyPreview}
                onToggle={() => toggleSetting('notifyPreview')}
              />
              {pushSupported() && (
                <Switch
                  label="离线推送（关闭页面后仍可收到）"
                  hint="iOS 需先「添加到主屏幕」，且需 HTTPS"
                  value={pushOn}
                  onToggle={() => void togglePush()}
                />
              )}
            </div>

            <div className="field">
              <span>黑名单</span>
              {blocks.length === 0 ? (
                <p className="field-hint">暂无被拉黑的用户</p>
              ) : (
                <ul className="settings-list" data-testid="block-list">
                  {blocks.map((b) => (
                    <li key={b.id}>
                      <span>{b.nickname}</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void unblock(b.id)}>
                        移出黑名单
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* --- 账号安全 --------------------------------------------------- */}
          <section className="dialog-pane" hidden={tab !== 'security'} aria-label="账号安全" data-testid="security-pane">
            <div className="field">
              <span>修改密码</span>
              <input
                type="password"
                placeholder="当前密码"
                value={oldPw}
                onChange={(e) => setOldPw(e.target.value)}
                autoComplete="current-password"
              />
              <input
                type="password"
                placeholder="新密码（6-64 位）"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                autoComplete="new-password"
              />
              <input
                type="password"
                placeholder="确认新密码"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="btn btn-primary"
                data-testid="change-password"
                disabled={busy || !oldPw || !newPw}
                onClick={() => void changePassword()}
              >
                修改密码
              </button>
              <p className="field-hint">修改后，除当前设备外的所有登录会话将被强制登出。</p>
            </div>

            <div className="field">
              <span>活跃会话</span>
              <ul className="settings-list" data-testid="session-list">
                {sessions.map((s) => (
                  <li key={s.sessionId}>
                    <span className="settings-session">
                      <span>{(s.userAgent || '未知设备').slice(0, 40)}</span>
                      <span className="settings-row-hint">
                        {s.ip || '—'} · {new Date(s.lastUsedAt).toLocaleString()}
                        {s.current ? ' · 当前设备' : ''}
                      </span>
                    </span>
                    {!s.current && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => void revokeSession(s.sessionId)}
                      >
                        登出
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revokeOthers()}>
                登出其他所有设备
              </button>
            </div>

            <div className="field">
              <span>注销账号</span>
              <input
                type="password"
                placeholder="输入密码以确认"
                value={delPw}
                onChange={(e) => setDelPw(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-danger"
                data-testid="delete-account"
                disabled={busy || !delPw}
                onClick={() => void deleteAccount()}
              >
                注销账号
              </button>
              <p className="field-hint">注销后有 7 天冷静期，期间可用账号密码恢复；之后数据将被清除。</p>
            </div>
          </section>

          {/* --- 存储与数据 ------------------------------------------------- */}
          <section className="dialog-pane" hidden={tab !== 'storage'} aria-label="存储与数据">
            <div className="field">
              <span>数据导出</span>
              <button type="button" className="btn btn-ghost" onClick={() => void exportData()}>
                导出我的资料
              </button>
              <p className="field-hint">聊天记录存储在服务端，可在会话顶部「导出」按会话下载。</p>
            </div>
            <div className="field">
              <span>本地缓存</span>
              <p className="field-hint">
                {usage
                  ? `已用 ${formatBytes(usage.usage)}${usage.quota ? ` / 配额 ${formatBytes(usage.quota)}` : ''}`
                  : '本地缓存用于加速首屏，可随时清理；聊天记录以服务端为准'}
              </p>
              <button type="button" className="btn btn-ghost" data-testid="clear-cache" onClick={() => void clearLocalCache()}>
                清理本地缓存
              </button>
            </div>
            <div className="field">
              <span>隐私政策</span>
              <p className="field-hint">
                我们仅收集提供服务所必需的信息（用户名、昵称、头像、消息内容），不向第三方出售数据。
                敏感操作会留存最小必要的审计日志，用于安全追溯。
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
