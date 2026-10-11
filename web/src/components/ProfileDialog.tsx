import { FormEvent, useCallback, useEffect, useState } from 'react';
import { authApi } from '../lib/api';
import { ApiError } from '../lib/axiosClient';
import { AVATAR_PRESET_IDS } from '../lib/avatarPresets';
import { useAppActions, useAppSession } from '../context/AppContext';
import { Avatar } from './Avatar';

interface ProfileDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Personal profile editor: preset avatar + nickname.
 *
 * Application settings (theme, transport, account) live in SettingsDialog — this
 * dialog only owns the two fields that are server state.
 */
export function ProfileDialog({ open, onClose }: ProfileDialogProps) {
  const { user } = useAppSession();
  const { updateUser, pushToast } = useAppActions();
  const [nickname, setNickname] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-sync the draft each time the dialog opens.
  useEffect(() => {
    if (!open || !user) return;
    setNickname(user.nickname);
    setBio(user.bio ?? '');
    setAvatar(user.avatar ?? null);
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

  const dirty =
    nickname.trim() !== user.nickname ||
    (bio.trim() || '') !== (user.bio ?? '') ||
    (avatar ?? null) !== (user.avatar ?? null);

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
      const result = await authApi.updateProfile({ nickname: trimmed, avatar, bio: bio.trim() || null });
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
          <span className="dialog-title">个人资料</span>
          <button type="button" className="icon-btn" onClick={close} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="dialog-body">
          <div className="field">
            <span>头像</span>
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

          <label className="field">
            <span>个性签名</span>
            <input
              data-testid="bio-input"
              value={bio}
              onChange={(event) => setBio(event.target.value)}
              maxLength={140}
              placeholder="介绍一下自己"
            />
          </label>

          <div className="field">
            <span>用户名</span>
            <div className="field-readonly">@{user.username}</div>
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
