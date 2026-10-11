import { useState } from 'react';
import { Avatar } from './Avatar';
import { PresenceAvatar } from './PresenceAvatar';
import { CellSwitch } from './Cells';
import { ConfirmDialog } from './ConfirmDialog';
import { ReportDialog } from './ReportDialog';
import { SidePage, SideRow, SideSection } from './SidePage';
import { formatLastSeen } from '../lib/format';

interface ChatInfoPageProps {
  kind: 'direct' | 'group';
  /** The peer (user id or group id) — also the 举报 target. */
  targetId: number;
  title: string;
  avatar: string | null;
  /** 1:1 only — drives the presence dot and the 最后活跃 line. */
  online?: boolean;
  lastSeenAt?: string | null;
  /** Group only — shown under the name. */
  memberCount?: number;
  pinned: boolean;
  muted: boolean;
  frozen: boolean;
  onBack: () => void;
  onTogglePin: () => void;
  onToggleMute: () => void;
  onOpenSearch: () => void;
  onExport: () => void;
  onClear: () => void;
  onDelete: () => void;
  /** 1:1 — opens 好友资料. */
  onOpenPeerProfile?: () => void;
  /** Group — opens 群资料. */
  onOpenGroupInfo?: () => void;
  onBlock?: () => void;
  onRemoveFriend?: () => void;
  onLeaveGroup?: () => void;
}

type DialogState = null | { kind: 'confirm'; action: 'clear' | 'delete' | 'remove' | 'block' | 'leave' } | { kind: 'report' };

/**
 * 聊天信息 — the single destination behind the header's ⋯ button.
 *
 * A read-only sheet: 置顶 / 免打扰 stay as inline switches (WeChat keeps them
 * inline), everything else is a row that opens a dialog. The three cards keep
 * unrelated actions apart: 对方 / 会话 / 危险操作.
 */
export function ChatInfoPage({
  kind,
  targetId,
  title,
  avatar,
  online = false,
  lastSeenAt,
  memberCount,
  pinned,
  muted,
  frozen,
  onBack,
  onTogglePin,
  onToggleMute,
  onOpenSearch,
  onExport,
  onClear,
  onDelete,
  onOpenPeerProfile,
  onOpenGroupInfo,
  onBlock,
  onRemoveFriend,
  onLeaveGroup,
}: ChatInfoPageProps) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = () => setDialog(null);
  const isGroup = kind === 'group';

  return (
    <>
      <SidePage title="聊天信息" onBack={onBack} testId="chat-info-page">
        <div className="profile-hero">
          {isGroup ? (
            <Avatar name={title} avatar={avatar} size={72} />
          ) : (
            <PresenceAvatar name={title} avatar={avatar} size={72} online={online} />
          )}
          <div className="profile-hero-text">
            <div className="profile-hero-name">{title}</div>
            <div className="profile-hero-sub">
              {isGroup ? `${memberCount ?? 0} 位成员` : online ? '在线' : formatLastSeen(lastSeenAt)}
            </div>
          </div>
        </div>

        <SideSection title={isGroup ? '群聊' : '对方'}>
          {isGroup
            ? onOpenGroupInfo && (
                <SideRow label="群资料" testId="chat-info-group" disabled={frozen} onClick={onOpenGroupInfo} />
              )
            : onOpenPeerProfile && (
                <SideRow label="好友资料" testId="chat-info-profile" disabled={frozen} onClick={onOpenPeerProfile} />
              )}
        </SideSection>

        <SideSection title="会话">
          <CellSwitch
            label="置顶会话"
            hint="置顶的会话始终排在最前"
            value={pinned}
            disabled={frozen}
            testId="chat-info-pin"
            onToggle={onTogglePin}
          />
          <CellSwitch
            label="消息免打扰"
            hint="仍会收到消息，但不提示"
            value={muted}
            disabled={frozen}
            testId="chat-info-mute"
            onToggle={onToggleMute}
          />
          <SideRow label="查找聊天记录" testId="chat-info-search" disabled={frozen} onClick={onOpenSearch} />
          <SideRow label="导出聊天记录" testId="chat-info-export" disabled={frozen} onClick={onExport} />
          <SideRow
            label="清空聊天记录"
            danger
            testId="chat-info-clear"
            disabled={frozen}
            onClick={() => setDialog({ kind: 'confirm', action: 'clear' })}
          />
        </SideSection>

        <SideSection title="危险操作">
          <SideRow
            label="删除会话"
            danger
            testId="chat-info-delete"
            disabled={frozen}
            onClick={() => setDialog({ kind: 'confirm', action: 'delete' })}
          />

          {isGroup ? (
            <SideRow
              label="退出群聊"
              danger
              testId="chat-info-leave"
              disabled={frozen || !onLeaveGroup}
              onClick={() => setDialog({ kind: 'confirm', action: 'leave' })}
            />
          ) : (
            <>
              <SideRow
                label="删除好友"
                danger
                testId="chat-info-remove"
                disabled={frozen || !onRemoveFriend}
                onClick={() => setDialog({ kind: 'confirm', action: 'remove' })}
              />
              <SideRow
                label="加入黑名单"
                danger
                testId="chat-info-block"
                disabled={frozen || !onBlock}
                onClick={() => setDialog({ kind: 'confirm', action: 'block' })}
              />
            </>
          )}

          <SideRow
            label="举报"
            testId="chat-info-report"
            disabled={frozen}
            onClick={() => setDialog({ kind: 'report' })}
          />
        </SideSection>
      </SidePage>

      <ConfirmDialog
        open={dialog?.kind === 'confirm' && dialog.action === 'clear'}
        title="清空聊天记录"
        message="清空后我这一侧的聊天记录会被清除。"
        confirmLabel="清空"
        confirmTestId="chat-info-clear-confirm"
        disabled={frozen}
        onConfirm={() => {
          close();
          onClear();
        }}
        onClose={close}
      />

      <ConfirmDialog
        open={dialog?.kind === 'confirm' && dialog.action === 'delete'}
        title="删除会话"
        message="删除会话？聊天记录会一并清除。"
        confirmLabel="删除"
        confirmTestId="chat-info-delete-confirm"
        disabled={frozen}
        onConfirm={() => {
          close();
          onDelete();
        }}
        onClose={close}
      />

      <ConfirmDialog
        open={dialog?.kind === 'confirm' && dialog.action === 'leave'}
        title="退出群聊"
        message="退出后不再接收该群消息。"
        confirmLabel="退出"
        confirmTestId="chat-info-leave-confirm"
        disabled={frozen}
        onConfirm={() => {
          close();
          onLeaveGroup?.();
        }}
        onClose={close}
      />

      <ConfirmDialog
        open={dialog?.kind === 'confirm' && dialog.action === 'remove'}
        title="删除好友"
        message="从我的好友列表移除？"
        confirmLabel="移除"
        confirmTestId="chat-info-remove-confirm"
        disabled={frozen}
        onConfirm={() => {
          close();
          onRemoveFriend?.();
        }}
        onClose={close}
      />

      <ConfirmDialog
        open={dialog?.kind === 'confirm' && dialog.action === 'block'}
        title="加入黑名单"
        message="加入黑名单后对方无法再给你发消息。"
        confirmLabel="拉黑"
        confirmTestId="chat-info-block-confirm"
        disabled={frozen}
        onConfirm={() => {
          close();
          onBlock?.();
        }}
        onClose={close}
      />

      <ReportDialog
        open={dialog?.kind === 'report'}
        targetType={isGroup ? 'group' : 'user'}
        targetId={targetId}
        disabled={frozen}
        onClose={close}
      />
    </>
  );
}
