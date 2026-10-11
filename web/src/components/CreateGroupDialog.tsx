import { FormEvent, useCallback, useEffect, useState } from 'react';
import { groupApi } from '../lib/api';
import { ApiError } from '../lib/axiosClient';
import { useAppActions } from '../context/AppContext';
import { Avatar } from './Avatar';
import { Icon } from './Icon';
import type { Group, User } from '../types';

interface CreateGroupDialogProps {
  open: boolean;
  friends: User[];
  frozen: boolean;
  onClose: () => void;
  onCreated: (group: Group) => void;
}

/**
 * WeChat-style group creation: name it, tick friends, done. Members are pulled
 * in directly (no consent step) — the server only admits the caller's friends.
 */
export function CreateGroupDialog({ open, friends, frozen, onClose, onCreated }: CreateGroupDialogProps) {
  const { pushToast } = useAppActions();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setSelected(new Set());
    setCreating(false);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !creating) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, creating, onClose]);

  const toggle = useCallback((id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (creating || frozen) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      pushToast({ kind: 'error', title: '请输入群名称' });
      return;
    }
    setCreating(true);
    try {
      const { group } = await groupApi.create(trimmed, [...selected]);
      pushToast({ kind: 'success', title: '群聊已创建', body: `「${group.name}」 · 群号 ${group.groupNo ?? '—'}` });
      onCreated(group);
      onClose();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '创建群聊失败',
        body: error instanceof ApiError ? error.message : '请稍后重试',
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="dialog-overlay" onMouseDown={() => !creating && onClose()} data-testid="create-group-dialog">
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="dialog-head">
          <span className="dialog-title">发起群聊</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="dialog-body">
          <label className="field">
            <span>群名称</span>
            <input
              data-testid="group-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={64}
              placeholder="给群聊起个名字"
              required
            />
          </label>

          <div className="field">
            <span>选择好友（{selected.size}）</span>
            <div className="member-picker">
              {friends.length === 0 && <div className="panel-empty">还没有好友可以拉入</div>}
              {friends.map((friend) => (
                <button
                  key={friend.id}
                  type="button"
                  className={`member-option ${selected.has(friend.id) ? 'selected' : ''}`}
                  data-testid="group-friend-option"
                  data-friend-id={friend.id}
                  aria-pressed={selected.has(friend.id)}
                  onClick={() => toggle(friend.id)}
                >
                  <Avatar name={friend.nickname} avatar={friend.avatar} size={34} tone="muted" />
                  <span className="member-option-name">{friend.nickname}</span>
                  <span className="member-option-check">
                    {selected.has(friend.id) && <Icon name="check" size={18} />}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={onClose} data-testid="create-group-cancel">
            取消
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={creating || frozen || name.trim().length === 0 || selected.size === 0}
            data-testid="create-group-confirm"
          >
            {creating ? '创建中…' : '创建'}
          </button>
        </footer>
      </form>
    </div>
  );
}
