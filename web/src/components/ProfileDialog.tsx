import { FormEvent, useCallback, useEffect, useState } from 'react';
import { authApi } from '../lib/api';
import { ApiError } from '../lib/axiosClient';
import { AVATAR_PRESET_IDS } from '../lib/avatarPresets';
import { THEME_IDS, THEME_LABELS, applyTheme, readStoredTheme, type ThemeId } from '../lib/theme';
import { useAppActions, useAppSession } from '../context/AppContext';
import { Avatar } from './Avatar';

interface ProfileDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Settings dialog: preset avatar picker, nickname, and theme.
 *
 * The avatar/nickname are server state; the theme is device-local (localStorage)
 * and applies instantly to `<html data-theme>`, so it is deliberately not sent
 * to the backend.
 */
export function ProfileDialog({ open, onClose }: ProfileDialogProps) {
  const { user } = useAppSession();
  const { updateUser, pushToast } = useAppActions();
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme());
  const [saving, setSaving] = useState(false);

  // Re-sync the draft each time the dialog opens.
  useEffect(() => {
    if (!open || !user) return;
    setNickname(user.nickname);
    setAvatar(user.avatar ?? null);
    setTheme(readStoredTheme());
    setSaving(false);
  }, [open, user]);

  const close = useCallback(() => {
    if (!saving) onClose();
  }, [onClose, saving]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  if (!open || !user) return null;

  const dirty = nickname.trim() !== user.nickname || (avatar ?? null) !== (user.avatar ?? null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const trimmed = nickname.trim();
    if (trimmed.length === 0) {
      pushToast({ kind: 'error', title: '昵称不能为空' });
      return;
    }

    setSaving(true);
    try {
      const result = await authApi.updateProfile({ nickname: trimmed, avatar });
      updateUser(result.user);
      pushToast({ kind: 'success', title: '资料已更新' });
      onClose();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '保存失败',
        body: error instanceof ApiError ? error.message : '请稍后重试',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-overlay" onMouseDown={close} data-testid="profile-dialog">
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="dialog-head">
          <span className="dialog-title">资料</span>
          <button type="button" className="icon-btn" onClick={close} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="dialog-body">
          <div className="avatar-grid" role="radiogroup" aria-label="头像">
            <button
              type="button"
              className="avatar-option"
              data-testid="avatar-option"
              data-avatar-id="none"
              aria-checked={avatar === null}
              aria-label="不使用头像"
              onClick={() => setAvatar(null)}
            >
              <Avatar name={user.nickname} avatar={null} size={46} tone="muted" />
            </button>
            {AVATAR_PRESET_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className="avatar-option"
                data-testid="avatar-option"
                data-avatar-id={id}
                aria-checked={avatar === id}
                aria-label={id}
                onClick={() => setAvatar(id)}
              >
                <Avatar name={user.nickname} avatar={id} size={46} />
              </button>
            ))}
          </div>

          <label className="field">
            <span>昵称</span>
            <input
              data-testid="nickname-input"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={64}
              required
            />
          </label>

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
                  onClick={() => {
                    setTheme(id);
                    applyTheme(id);
                  }}
                >
                  <span className="theme-option-fill" />
                </button>
              ))}
            </div>
          </div>
        </div>

        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={close} data-testid="profile-cancel">
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !dirty} data-testid="profile-save">
            {saving ? '保存中' : '保存'}
          </button>
        </footer>
      </form>
    </div>
  );
}
