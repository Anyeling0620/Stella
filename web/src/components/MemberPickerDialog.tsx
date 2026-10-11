import { useEffect, useState } from 'react';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import type { User } from '../types';

interface MemberPickerDialogProps {
  open: boolean;
  friends: User[];
  /** Friends already in the group — hidden from the list. */
  excludeIds: Set<number>;
  disabled?: boolean;
  onConfirm: (ids: number[]) => void | Promise<void>;
  onClose: () => void;
}

/** Tick friends to add to a group. Mirrors 发起群聊's picker, in a dialog. */
export function MemberPickerDialog({
  open,
  friends,
  excludeIds,
  disabled = false,
  onConfirm,
  onClose,
}: MemberPickerDialogProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;

  const addable = friends.filter((friend) => !excludeIds.has(friend.id));

  const toggle = (id: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    if (disabled || busy || selected.size === 0) return;
    setBusy(true);
    try {
      await onConfirm([...selected]);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay" onMouseDown={() => !busy && onClose()} data-testid="group-add-picker">
      <div className="dialog" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-head">
          <span className="dialog-title">添加成员</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭" disabled={busy}>
            ×
          </button>
        </header>
        <div className="dialog-body">
          <div className="field">
            <span>选择好友（{selected.size}）</span>
            <div className="member-picker">
              {addable.length === 0 && <div className="panel-empty">没有可添加的好友</div>}
              {addable.map((friend) => (
                <button
                  key={friend.id}
                  type="button"
                  className={`member-option ${selected.has(friend.id) ? 'selected' : ''}`}
                  data-testid="group-add-option"
                  data-friend-id={friend.id}
                  aria-pressed={selected.has(friend.id)}
                  disabled={disabled || busy}
                  onClick={() => toggle(friend.id)}
                >
                  <Avatar name={friend.nickname} avatar={friend.avatar} size={34} tone="muted" />
                  <span className="member-option-name">{friend.nickname}</span>
                  <span className="member-option-check">{selected.has(friend.id) && <Icon name="check" size={18} />}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="group-add-confirm"
            disabled={disabled || busy || selected.size === 0}
            onClick={() => void submit()}
          >
            {busy ? '添加中…' : `确定添加（${selected.size}）`}
          </button>
        </footer>
      </div>
    </div>
  );
}
