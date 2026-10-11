import { useEffect, useState } from 'react';
import { AVATAR_PRESET_IDS } from '../lib/avatarPresets';
import { Avatar } from './Avatar';

interface AvatarPickerDialogProps {
  open: boolean;
  /** Name used for the initial-letter fallback art. */
  name: string;
  value: string | null;
  disabled?: boolean;
  optionTestId?: string;
  confirmTestId?: string;
  /** Return `false` to keep the dialog open (e.g. the save failed). */
  onSubmit: (avatar: string | null) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
}

/** Pick a preset avatar (or none) in a dialog — keeps the info page a clean sheet. */
export function AvatarPickerDialog({
  open,
  name,
  value,
  disabled = false,
  optionTestId = 'avatar-option',
  confirmTestId = 'avatar-save',
  onSubmit,
  onClose,
}: AvatarPickerDialogProps) {
  const [avatar, setAvatar] = useState<string | null>(value);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setAvatar(value);
      setBusy(false);
    }
  }, [open, value]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      const result = await onSubmit(avatar);
      if (result !== false) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay" onMouseDown={() => !busy && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-head">
          <span className="dialog-title">选择头像</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭" disabled={busy}>
            ×
          </button>
        </header>
        <div className="dialog-body">
          <div className="avatar-grid" role="radiogroup" aria-label="头像">
            <button
              type="button"
              className="avatar-option"
              data-testid={optionTestId}
              data-avatar-id="none"
              aria-checked={avatar === null}
              aria-label="不使用头像"
              disabled={disabled || busy}
              onClick={() => setAvatar(null)}
            >
              <Avatar name={name} avatar={null} size={46} tone="muted" />
            </button>
            {AVATAR_PRESET_IDS.map((id) => (
              <button
                key={id}
                type="button"
                className="avatar-option"
                data-testid={optionTestId}
                data-avatar-id={id}
                aria-checked={avatar === id}
                aria-label={id}
                disabled={disabled || busy}
                onClick={() => setAvatar(id)}
              >
                <Avatar name={name} avatar={id} size={46} />
              </button>
            ))}
          </div>
        </div>
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn-primary" data-testid={confirmTestId} disabled={disabled || busy} onClick={() => void submit()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  );
}
