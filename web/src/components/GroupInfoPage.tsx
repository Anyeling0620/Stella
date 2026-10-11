import { useState } from 'react';
import { groupApi } from '../lib/api';
import { ApiError } from '../lib/axiosClient';
import { useAppActions } from '../context/AppContext';
import { Avatar } from './Avatar';
import { AvatarPickerDialog } from './AvatarPickerDialog';
import { CellSwitch } from './Cells';
import { ConfirmDialog } from './ConfirmDialog';
import { ReportDialog } from './ReportDialog';
import { TextPromptDialog } from './TextPromptDialog';
import { SidePage, SideRow, SideSection } from './SidePage';
import type { Group, GroupMember } from '../types';

interface GroupInfoPageProps {
  group: Group;
  members: GroupMember[];
  myId: number;
  /** Live presence (user id -> online), owned by ChatShell. */
  presence: Record<number, boolean>;
  /** Pending 加群申请 count, loaded by ChatShell. */
  joinRequestCount: number;
  frozen: boolean;
  onBack: () => void;
  onSendMessage: () => void;
  onOpenMembers: () => void;
  onOpenFiles: () => void;
  onOpenRequests: () => void;
  /** Re-fetch group + members after a mutation. */
  onReload: () => Promise<void>;
  onLeave: () => void;
  onDissolve: () => void;
}

type DialogState =
  | null
  | { kind: 'name' }
  | { kind: 'nickname' }
  | { kind: 'announcement' }
  | { kind: 'avatar' }
  | { kind: 'confirm'; action: 'leave' | 'dissolve' }
  | { kind: 'report' };

/**
 * 群聊详情 — the page opened from the 群聊 list (and from 聊天信息 → 群资料).
 *
 * A read-only sheet (hero + cards) exactly like 好友资料 / 聊天信息: every edit
 * opens a dialog, and 群成员 / 群文件 / 加群申请 are their own sub-pages.
 */
export function GroupInfoPage({
  group,
  members,
  myId,
  presence,
  joinRequestCount,
  frozen,
  onBack,
  onSendMessage,
  onOpenMembers,
  onOpenFiles,
  onOpenRequests,
  onReload,
  onLeave,
  onDissolve,
}: GroupInfoPageProps) {
  const { pushToast } = useAppActions();
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = () => setDialog(null);

  const isOwner = group.ownerId === myId;
  const myRole = members.find((member) => member.id === myId)?.role ?? 'member';
  const canManage = isOwner || myRole === 'admin';
  const myGroupNickname = members.find((member) => member.id === myId)?.groupNickname ?? '';
  const onlineCount = members.reduce((n, member) => n + ((presence[member.id] ?? member.online) ? 1 : 0), 0);
  // The roster may still be loading — fall back to the count on the list entry.
  const memberCount = members.length || group.memberCount || 0;

  /** Returns `false` on failure so the dialog stays open with the user's draft. */
  const runUpdate = async (
    patch: { name?: string; avatar?: string | null; announcement?: string | null; joinApproval?: boolean },
    ok: string
  ): Promise<boolean | void> => {
    try {
      await groupApi.update(group.id, patch);
      pushToast({ kind: 'success', title: ok });
      await onReload();
    } catch (error) {
      pushToast({ kind: 'error', title: '保存失败', body: error instanceof ApiError ? error.message : '请稍后重试' });
      return false;
    }
  };

  const saveName = async (value: string): Promise<boolean | void> => {
    if (value.length === 0) {
      pushToast({ kind: 'error', title: '群名称不能为空' });
      return false;
    }
    if (value === group.name) return;
    return runUpdate({ name: value }, '群名称已更新');
  };

  const saveNickname = async (value: string): Promise<boolean | void> => {
    try {
      await groupApi.setGroupNickname(group.id, value.length === 0 ? null : value);
      pushToast({ kind: 'success', title: '群昵称已更新' });
      await onReload();
    } catch (error) {
      pushToast({ kind: 'error', title: '更新失败', body: error instanceof ApiError ? error.message : undefined });
      return false;
    }
  };

  const saveAnnouncement = async (value: string): Promise<boolean | void> => {
    if (value === (group.announcement ?? '')) return;
    return runUpdate({ announcement: value.length === 0 ? null : value }, '群公告已更新');
  };

  const toggleJoinApproval = async () => {
    if (!isOwner || frozen) return;
    const next = !group.joinApproval;
    try {
      await groupApi.update(group.id, { joinApproval: next });
      pushToast({ kind: 'success', title: next ? '已开启入群确认' : '已关闭入群确认，任何人可直接加入' });
      await onReload();
    } catch (error) {
      pushToast({ kind: 'error', title: '设置失败', body: error instanceof ApiError ? error.message : undefined });
    }
  };

  return (
    <>
      <SidePage title="群聊详情" onBack={onBack} testId="group-info-page">
        <div className="profile-hero">
          <Avatar name={group.name} avatar={group.avatar} size={72} />
          <div className="profile-hero-text">
            <div className="profile-hero-name">{group.name}</div>
            <div className="profile-hero-sub">
              {memberCount} 位成员 · {onlineCount} 人在线
            </div>
          </div>
        </div>

        <SideSection title="群资料">
          {isOwner && (
            <SideRow label="群头像" testId="group-avatar-row" disabled={frozen} onClick={() => setDialog({ kind: 'avatar' })} />
          )}
          {isOwner ? (
            <SideRow
              label="群聊名称"
              value={group.name}
              testId="group-name-row"
              disabled={frozen}
              onClick={() => setDialog({ kind: 'name' })}
            />
          ) : (
            <SideRow label="群聊名称" value={group.name} arrow={false} />
          )}
          <SideRow label="群号" arrow={false} testId="group-no">
            <span className="cell-side">
              <span className="cell-value">{group.groupNo ?? '—'}</span>
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
            </span>
          </SideRow>
          <SideRow
            label="我的群昵称"
            value={myGroupNickname || '未设置'}
            testId="group-nickname-row"
            disabled={frozen}
            onClick={() => setDialog({ kind: 'nickname' })}
          />
          {isOwner ? (
            <SideRow
              label="群公告"
              hint={group.announcement?.trim() || '未设置'}
              testId="group-announcement-row"
              disabled={frozen}
              onClick={() => setDialog({ kind: 'announcement' })}
            />
          ) : (
            <SideRow label="群公告" hint={group.announcement?.trim() || '暂无群公告'} arrow={false} />
          )}
        </SideSection>

        <SideSection title="群聊">
          <SideRow label="群成员" value={memberCount} testId="group-members-row" disabled={frozen} onClick={onOpenMembers} />
          <SideRow label="群文件" testId="group-files-row" disabled={frozen} onClick={onOpenFiles} />
          {canManage && (
            <SideRow
              label="加群申请"
              value={joinRequestCount > 0 ? joinRequestCount : undefined}
              testId="group-requests-row"
              disabled={frozen}
              onClick={onOpenRequests}
            />
          )}
          {isOwner && (
            <CellSwitch
              label="入群确认"
              hint="开启后，申请入群需群主或管理员同意"
              value={Boolean(group.joinApproval)}
              disabled={frozen}
              testId="group-join-approval"
              onToggle={() => void toggleJoinApproval()}
            />
          )}
        </SideSection>

        <SideSection title="操作">
          <SideRow primary label="发消息" testId="group-info-send" disabled={frozen} onClick={onSendMessage} />
        </SideSection>

        <SideSection title="危险操作">
          <SideRow label="举报" testId="group-report" disabled={frozen} onClick={() => setDialog({ kind: 'report' })} />
          {isOwner ? (
            <SideRow
              label="解散群聊"
              danger
              testId="group-dissolve"
              disabled={frozen}
              onClick={() => setDialog({ kind: 'confirm', action: 'dissolve' })}
            />
          ) : (
            <SideRow
              label="退出群聊"
              danger
              testId="group-leave"
              disabled={frozen}
              onClick={() => setDialog({ kind: 'confirm', action: 'leave' })}
            />
          )}
        </SideSection>
      </SidePage>

      <TextPromptDialog
        open={dialog?.kind === 'name'}
        title="群聊名称"
        initialValue={group.name}
        maxLength={64}
        inputTestId="group-info-name"
        confirmTestId="group-info-name-save"
        disabled={frozen}
        onSubmit={(value) => saveName(value)}
        onClose={close}
      />

      <TextPromptDialog
        open={dialog?.kind === 'nickname'}
        title="我的群昵称"
        initialValue={myGroupNickname}
        placeholder="留空则显示昵称"
        maxLength={64}
        inputTestId="group-nickname"
        confirmTestId="group-nickname-save"
        disabled={frozen}
        onSubmit={(value) => saveNickname(value)}
        onClose={close}
      />

      <TextPromptDialog
        open={dialog?.kind === 'announcement'}
        title="群公告"
        initialValue={group.announcement ?? ''}
        placeholder="设置群公告（可选）"
        maxLength={500}
        multiline
        inputTestId="group-info-announcement"
        confirmTestId="group-info-announcement-save"
        disabled={frozen}
        onSubmit={(value) => saveAnnouncement(value)}
        onClose={close}
      />

      <AvatarPickerDialog
        open={dialog?.kind === 'avatar'}
        name={group.name}
        value={group.avatar}
        disabled={frozen}
        optionTestId="group-avatar-option"
        confirmTestId="group-avatar-save"
        onSubmit={(avatar) => runUpdate({ avatar }, '群头像已更新')}
        onClose={close}
      />

      <ConfirmDialog
        open={dialog?.kind === 'confirm' && dialog.action === 'leave'}
        title="退出群聊"
        message="退出后不再接收该群消息。"
        confirmLabel="退出"
        confirmTestId="group-leave-confirm"
        disabled={frozen}
        onConfirm={() => {
          close();
          onLeave();
        }}
        onClose={close}
      />

      <ConfirmDialog
        open={dialog?.kind === 'confirm' && dialog.action === 'dissolve'}
        title="解散群聊"
        message="解散后不可恢复，所有成员将被移出。"
        confirmLabel="解散"
        confirmTestId="group-dissolve-confirm"
        disabled={frozen}
        onConfirm={() => {
          close();
          onDissolve();
        }}
        onClose={close}
      />

      <ReportDialog open={dialog?.kind === 'report'} targetType="group" targetId={group.id} disabled={frozen} onClose={close} />
    </>
  );
}
