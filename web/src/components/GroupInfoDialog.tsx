import { useCallback, useEffect, useState } from 'react';
import { friendApi, groupApi } from '../lib/api';
import { ApiError } from '../lib/axiosClient';
import { AVATAR_PRESET_IDS } from '../lib/avatarPresets';
import { useAppActions } from '../context/AppContext';
import { Avatar } from './Avatar';
import { PresenceAvatar } from './PresenceAvatar';
import type { Group, GroupJoinRequest, GroupMember, User } from '../types';

interface GroupInfoDialogProps {
  open: boolean;
  group: Group;
  members: GroupMember[];
  myId: number;
  frozen: boolean;
  /** Live presence (user id -> online), owned by ChatShell. */
  presence: Record<number, boolean>;
  onClose: () => void;
}

/** Members shown before the grid collapses behind a 「查看全部」 link. */
const MEMBER_PREVIEW = 12;

/**
 * Group profile + roster management, laid out as discrete sections
 * (群资料 / 群公告 / 群管理 / 群成员) instead of one long undifferentiated column.
 *
 * The owner may edit name/avatar/announcement and add/remove members; everyone
 * else sees a read-only view plus "退群". Server pushes keep the open thread in
 * sync, so actions here do not need to mutate parent state directly.
 */
export function GroupInfoDialog({
  open,
  group,
  members,
  myId,
  frozen,
  presence,
  onClose,
}: GroupInfoDialogProps) {
  const { pushToast } = useAppActions();
  const isOwner = group.ownerId === myId;

  const [localMembers, setLocalMembers] = useState<GroupMember[]>(members);
  const [name, setName] = useState(group.name);
  const [avatar, setAvatar] = useState<string | null>(group.avatar);
  const [announcement, setAnnouncement] = useState(group.announcement ?? '');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [friends, setFriends] = useState<User[]>([]);
  const [toAdd, setToAdd] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<'leave' | 'dissolve' | null>(null);
  const [joinRequests, setJoinRequests] = useState<GroupJoinRequest[]>([]);
  const [requestsBusy, setRequestsBusy] = useState(false);
  const [tab, setTab] = useState<'profile' | 'announcement' | 'manage' | 'members'>('profile');

  const loadJoinRequests = useCallback(async () => {
    if (group.ownerId !== myId) return;
    try {
      const data = await groupApi.joinRequests(group.id);
      setJoinRequests(data.requests);
    } catch {
      setJoinRequests([]);
    }
  }, [group.id, group.ownerId, myId]);

  useEffect(() => setLocalMembers(members), [members]);

  useEffect(() => {
    if (!open) return;
    setName(group.name);
    setAvatar(group.avatar);
    setAnnouncement(group.announcement ?? '');
    setSaving(false);
    setBusy(false);
    setAddOpen(false);
    setShowAll(false);
    setToAdd(new Set());
    setConfirm(null);
    setTab('profile');
    setJoinRequests([]);
    // Refresh the roster + pending applications from the source of truth.
    void groupApi
      .detail(group.id)
      .then((data) => setLocalMembers(data.members))
      .catch(() => {});
    void loadJoinRequests();
  }, [open, group.id, group.name, group.avatar, group.announcement, loadJoinRequests]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !saving) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, saving, onClose]);

  const save = useCallback(async () => {
    if (saving || !isOwner) return;
    const patch: { name?: string; avatar?: string | null; announcement?: string | null } = {};
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      pushToast({ kind: 'error', title: '群名称不能为空' });
      return;
    }
    if (trimmedName !== group.name) patch.name = trimmedName;
    if ((avatar ?? null) !== (group.avatar ?? null)) patch.avatar = avatar;
    const trimmedAnnouncement = announcement.trim();
    if (trimmedAnnouncement !== (group.announcement ?? '')) {
      patch.announcement = trimmedAnnouncement.length === 0 ? null : trimmedAnnouncement;
    }
    if (Object.keys(patch).length === 0) {
      pushToast({ kind: 'info', title: '没有需要保存的修改' });
      return;
    }
    setSaving(true);
    try {
      await groupApi.update(group.id, patch);
      pushToast({ kind: 'success', title: '群资料已更新' });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '保存失败',
        body: error instanceof ApiError ? error.message : '请稍后重试',
      });
    } finally {
      setSaving(false);
    }
  }, [saving, isOwner, name, avatar, announcement, group, pushToast]);

  const openAdd = useCallback(async () => {
    setAddOpen(true);
    setToAdd(new Set());
    try {
      const data = await friendApi.list();
      setFriends(data.friends);
    } catch {
      setFriends([]);
    }
  }, []);

  const confirmAdd = useCallback(async () => {
    if (toAdd.size === 0 || busy) return;
    setBusy(true);
    try {
      await groupApi.addMembers(group.id, [...toAdd]);
      setAddOpen(false);
      setToAdd(new Set());
      pushToast({ kind: 'success', title: '已添加成员' });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '添加成员失败',
        body: error instanceof ApiError ? error.message : '请稍后重试',
      });
    } finally {
      setBusy(false);
    }
  }, [toAdd, busy, group.id, pushToast]);

  const removeMember = useCallback(
    async (member: GroupMember) => {
      if (busy) return;
      setBusy(true);
      try {
        await groupApi.removeMember(group.id, member.id);
        setLocalMembers((current) => current.filter((m) => m.id !== member.id));
        pushToast({ kind: 'success', title: '已移除成员', body: member.nickname });
      } catch (error) {
        pushToast({
          kind: 'error',
          title: '移除失败',
          body: error instanceof ApiError ? error.message : '请稍后重试',
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, group.id, pushToast]
  );

  const respondJoin = useCallback(
    async (request: GroupJoinRequest, action: 'approve' | 'reject') => {
      if (requestsBusy) return;
      setRequestsBusy(true);
      try {
        await groupApi.respondJoin(group.id, request.id, action);
        setJoinRequests((current) => current.filter((item) => item.id !== request.id));
        pushToast({
          kind: 'success',
          title: action === 'approve' ? '已同意加群' : '已拒绝申请',
          body: request.applicant.nickname,
        });
        if (action === 'approve') void groupApi.detail(group.id).then((data) => setLocalMembers(data.members)).catch(() => {});
      } catch (error) {
        pushToast({
          kind: 'error',
          title: '操作失败',
          body: error instanceof ApiError ? error.message : '请稍后重试',
        });
      } finally {
        setRequestsBusy(false);
      }
    },
    [requestsBusy, group.id, pushToast]
  );

  const leave = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await groupApi.leave(group.id);
      onClose();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '退群失败',
        body: error instanceof ApiError ? error.message : '请稍后重试',
      });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }, [busy, group.id, onClose, pushToast]);

  const dissolve = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await groupApi.dissolve(group.id);
      onClose();
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '解散失败',
        body: error instanceof ApiError ? error.message : '请稍后重试',
      });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }, [busy, group.id, onClose, pushToast]);

  if (!open) return null;

  const memberIds = new Set(localMembers.map((m) => m.id));
  const addable = friends.filter((f) => !memberIds.has(f.id));
  const shownMembers = showAll ? localMembers : localMembers.slice(0, MEMBER_PREVIEW);
  const onlineCount = localMembers.reduce(
    (n, member) => n + ((presence[member.id] ?? member.online) ? 1 : 0),
    0
  );

  return (
    <div className="dialog-overlay" onMouseDown={() => !busy && onClose()} data-testid="group-info-dialog">
      <div className="dialog dialog-wide" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <span className="dialog-title">群信息</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="dialog-split">
          <nav className="dialog-nav" aria-label="群设置分类">
            <button
              type="button"
              className={tab === 'profile' ? 'active' : ''}
              aria-current={tab === 'profile' ? 'true' : undefined}
              onClick={() => setTab('profile')}
            >
              群资料
            </button>
            <button
              type="button"
              className={tab === 'announcement' ? 'active' : ''}
              aria-current={tab === 'announcement' ? 'true' : undefined}
              onClick={() => setTab('announcement')}
            >
              群公告
            </button>
            {isOwner && (
              <button
                type="button"
                className={tab === 'manage' ? 'active' : ''}
                aria-current={tab === 'manage' ? 'true' : undefined}
                onClick={() => setTab('manage')}
              >
                群管理
                {joinRequests.length > 0 && <span className="badge badge-unread">{joinRequests.length}</span>}
              </button>
            )}
            <button
              type="button"
              className={tab === 'members' ? 'active' : ''}
              aria-current={tab === 'members' ? 'true' : undefined}
              onClick={() => setTab('members')}
            >
              群成员
            </button>
          </nav>

          {/* --- 群资料 ------------------------------------------------------ */}
          <section className="dialog-pane" hidden={tab !== 'profile'}>
            <h3 className="dialog-section-title">群资料</h3>

            {isOwner ? (
              <div className="avatar-grid" role="radiogroup" aria-label="群头像">
                <button
                  type="button"
                  className="avatar-option"
                  data-avatar-id="none"
                  aria-checked={avatar === null}
                  onClick={() => setAvatar(null)}
                >
                  <Avatar name={group.name} avatar={null} size={46} tone="muted" />
                </button>
                {AVATAR_PRESET_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="avatar-option"
                    data-testid="group-avatar-option"
                    data-avatar-id={id}
                    aria-checked={avatar === id}
                    onClick={() => setAvatar(id)}
                  >
                    <Avatar name={group.name} avatar={id} size={46} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="group-info-avatar">
                <Avatar name={group.name} avatar={group.avatar} size={64} />
              </div>
            )}

            {isOwner ? (
              <label className="field">
                <span>群名称</span>
                <input
                  data-testid="group-info-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={64}
                />
              </label>
            ) : (
              <div className="group-info-name">{group.name}</div>
            )}

            <div className="group-info-no">
              <span>群号</span>
              <code data-testid="group-no">{group.groupNo ?? '—'}</code>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                data-testid="group-no-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(String(group.groupNo ?? ''));
                  pushToast({ kind: 'success', title: '群号已复制' });
                }}
              >
                复制
              </button>
            </div>
          </section>

          {/* --- 群公告 ------------------------------------------------------ */}
          <section className="dialog-pane" hidden={tab !== 'announcement'}>
            <h3 className="dialog-section-title">群公告</h3>
            {isOwner ? (
              <textarea
                className="dialog-textarea"
                data-testid="group-info-announcement"
                value={announcement}
                onChange={(event) => setAnnouncement(event.target.value)}
                maxLength={500}
                rows={3}
                placeholder="设置群公告（可选）"
              />
            ) : (
              <div className="group-info-announcement-text">{group.announcement || '暂无群公告'}</div>
            )}
          </section>

          {/* --- 群管理（仅群主） -------------------------------------------- */}
          {isOwner && (
            <section className="dialog-pane" hidden={tab !== 'manage'}>
              <h3 className="dialog-section-title">
                群管理
                {joinRequests.length > 0 && <span className="badge badge-unread">{joinRequests.length}</span>}
              </h3>
              {joinRequests.length === 0 && <div className="panel-empty">暂无待处理的加群申请</div>}
              <div className="row-stack">
                {joinRequests.map((request) => (
                <div
                  key={request.id}
                  className="list-row"
                  data-testid="group-join-request"
                  data-request-id={request.id}
                >
                  <Avatar name={request.applicant.nickname} avatar={request.applicant.avatar} size={40} tone="muted" />
                  <div className="list-row-text">
                    <div className="list-row-title">{request.applicant.nickname}</div>
                    <div className="list-row-sub">{request.message || '申请加入群聊'}</div>
                  </div>
                  <div className="list-row-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      data-testid="group-join-approve"
                      disabled={requestsBusy}
                      onClick={() => void respondJoin(request, 'approve')}
                    >
                      同意
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      data-testid="group-join-reject"
                      disabled={requestsBusy}
                      onClick={() => void respondJoin(request, 'reject')}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
                ))}
              </div>
            </section>
          )}

          {/* --- 群成员 ------------------------------------------------------ */}
          <section className="dialog-pane" hidden={tab !== 'members'}>
            <h3 className="dialog-section-title">
              群成员（{localMembers.length}）
              <span className="member-online-count">{onlineCount} 人在线</span>
              {isOwner && (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => void openAdd()}>
                  添加
                </button>
              )}
            </h3>

            {addOpen && (
              <div className="member-picker" data-testid="group-add-picker">
                {addable.length === 0 && <div className="panel-empty">没有可添加的好友</div>}
                {addable.map((friend) => (
                  <button
                    key={friend.id}
                    type="button"
                    className={`member-option ${toAdd.has(friend.id) ? 'selected' : ''}`}
                    data-testid="group-add-option"
                    data-friend-id={friend.id}
                    onClick={() =>
                      setToAdd((current) => {
                        const next = new Set(current);
                        if (next.has(friend.id)) next.delete(friend.id);
                        else next.add(friend.id);
                        return next;
                      })
                    }
                  >
                    <Avatar name={friend.nickname} avatar={friend.avatar} size={30} tone="muted" />
                    <span className="member-option-name">{friend.nickname}</span>
                    <span className="member-option-check">{toAdd.has(friend.id) ? '✓' : ''}</span>
                  </button>
                ))}
                <div className="member-picker-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    data-testid="group-add-confirm"
                    disabled={busy || toAdd.size === 0}
                    onClick={() => void confirmAdd()}
                  >
                    确定添加（{toAdd.size}）
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setAddOpen(false)}>
                    取消
                  </button>
                </div>
              </div>
            )}

            <div className="member-grid">
              {shownMembers.map((member) => (
                <div
                  key={member.id}
                  className="member-tile"
                  data-testid="group-member-row"
                  data-user-id={member.id}
                  title={`@${member.username}`}
                >
                  <div className="member-tile-avatar">
                    <PresenceAvatar
                      name={member.nickname}
                      avatar={member.avatar}
                      size={46}
                      tone="muted"
                      online={presence[member.id] ?? Boolean(member.online)}
                    />
                    {isOwner && member.id !== myId && (
                      <button
                        type="button"
                        className="member-tile-remove"
                        data-testid="group-member-remove"
                        aria-label={`移除 ${member.nickname}`}
                        disabled={busy}
                        onClick={() => void removeMember(member)}
                      >
                        −
                      </button>
                    )}
                  </div>
                  <span className="member-tile-name">{member.nickname}</span>
                  {member.role === 'owner' && <span className="member-tile-role">群主</span>}
                </div>
              ))}

              {isOwner && (
                <button
                  type="button"
                  className="member-tile member-tile-add"
                  onClick={() => void openAdd()}
                  aria-label="添加成员"
                >
                  <span className="member-tile-plus">＋</span>
                  <span className="member-tile-name">添加</span>
                </button>
              )}
            </div>

            {localMembers.length > MEMBER_PREVIEW && (
              <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
                {showAll ? '收起成员' : `查看全部 ${localMembers.length} 位成员`}
              </button>
            )}
          </section>
        </div>

        <footer className="dialog-foot">
          {isOwner ? (
            <button
              type="button"
              className="btn btn-danger"
              data-testid="group-dissolve"
              disabled={busy}
              onClick={() => setConfirm('dissolve')}
            >
              解散群聊
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-danger"
              data-testid="group-leave"
              disabled={busy}
              onClick={() => setConfirm('leave')}
            >
              退出群聊
            </button>
          )}
          <div className="dialog-foot-spacer" />
          {confirm === 'leave' && (
            <>
              <span className="dialog-confirm-text">确定退出？</span>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void leave()}>
                确定退出
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)}>
                取消
              </button>
            </>
          )}
          {confirm === 'dissolve' && (
            <>
              <span className="dialog-confirm-text">解散后不可恢复</span>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void dissolve()}>
                确定解散
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)}>
                取消
              </button>
            </>
          )}
          {!confirm && isOwner && (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="group-info-save"
              disabled={saving || frozen}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
