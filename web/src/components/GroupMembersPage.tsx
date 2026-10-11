import { useState } from 'react';
import { groupApi } from '../lib/api';
import { ApiError } from '../lib/axiosClient';
import { useAppActions } from '../context/AppContext';
import { PresenceAvatar } from './PresenceAvatar';
import { MemberPickerDialog } from './MemberPickerDialog';
import { SidePage } from './SidePage';
import { Icon } from './Icon';
import type { Group, GroupMember, User } from '../types';

interface GroupMembersPageProps {
  group: Group;
  members: GroupMember[];
  friends: User[];
  myId: number;
  presence: Record<number, boolean>;
  frozen: boolean;
  onBack: () => void;
  onReload: () => Promise<void>;
}

/** 群成员 — the roster sub-page of 群聊详情. */
export function GroupMembersPage({
  group,
  members,
  friends,
  myId,
  presence,
  frozen,
  onBack,
  onReload,
}: GroupMembersPageProps) {
  const { pushToast } = useAppActions();
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const isOwner = group.ownerId === myId;
  const myRole = members.find((member) => member.id === myId)?.role ?? 'member';
  const canManage = isOwner || myRole === 'admin';
  const onlineCount = members.reduce((n, member) => n + ((presence[member.id] ?? member.online) ? 1 : 0), 0);

  const guard = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await onReload();
    } catch (error) {
      pushToast({ kind: 'error', title: '操作失败', body: error instanceof ApiError ? error.message : '请稍后重试' });
    } finally {
      setBusy(false);
    }
  };

  const addMembers = (ids: number[]) =>
    guard(async () => {
      await groupApi.addMembers(group.id, ids);
      pushToast({ kind: 'success', title: '已添加成员' });
    });

  const removeMember = (member: GroupMember) =>
    guard(async () => {
      await groupApi.removeMember(group.id, member.id);
      pushToast({ kind: 'success', title: '已移除成员', body: member.nickname });
    });

  const changeRole = (member: GroupMember, role: 'admin' | 'member') =>
    guard(async () => {
      await groupApi.setMemberRole(group.id, member.id, role);
      pushToast({ kind: 'success', title: role === 'admin' ? '已设为管理员' : '已取消管理员', body: member.nickname });
    });

  const excludeIds = new Set(members.map((member) => member.id));

  return (
    <>
      <SidePage title="群成员" onBack={onBack} testId="group-members-page">
        <div className="cell-title">
          群成员（{members.length}） · {onlineCount} 人在线
        </div>
        <div className="member-grid">
          {members.map((member) => (
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
                {canManage && member.id !== myId && member.role !== 'owner' && (
                  <button
                    type="button"
                    className="member-tile-remove"
                    data-testid="group-member-remove"
                    aria-label={`移除 ${member.nickname}`}
                    disabled={frozen || busy}
                    onClick={() => void removeMember(member)}
                  >
                    <Icon name="minus" size={16} />
                  </button>
                )}
              </div>
              <span className="member-tile-name">{member.nickname}</span>
              {member.role === 'owner' && <span className="member-tile-role">群主</span>}
              {member.role === 'admin' && <span className="member-tile-role">管理员</span>}
              {isOwner && member.role !== 'owner' && (
                <button
                  type="button"
                  className="link-btn member-tile-admin"
                  data-testid="group-member-admin"
                  disabled={frozen || busy}
                  onClick={() => void changeRole(member, member.role === 'admin' ? 'member' : 'admin')}
                >
                  {member.role === 'admin' ? '取消管理员' : '设管理员'}
                </button>
              )}
            </div>
          ))}

          {canManage && (
            <button
              type="button"
              className="member-tile member-tile-add"
              disabled={frozen}
              onClick={() => setAddOpen(true)}
              aria-label="添加成员"
            >
              <span className="member-tile-plus">
                <Icon name="plus" size={22} />
              </span>
              <span className="member-tile-name">添加</span>
            </button>
          )}
        </div>
      </SidePage>

      <MemberPickerDialog
        open={addOpen}
        friends={friends}
        excludeIds={excludeIds}
        disabled={frozen}
        onConfirm={(ids) => addMembers(ids)}
        onClose={() => setAddOpen(false)}
      />
    </>
  );
}
