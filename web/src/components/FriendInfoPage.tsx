import { useState } from 'react';
import { PresenceAvatar } from './PresenceAvatar';
import { ConfirmDialog } from './ConfirmDialog';
import { ReportDialog } from './ReportDialog';
import { TextPromptDialog } from './TextPromptDialog';
import { SidePage, SideRow, SideSection } from './SidePage';
import { displayName, formatDateTime, formatLastSeen } from '../lib/format';
import type { User } from '../types';

/**
 * 好友资料.
 *
 * A read-only sheet: the hero leads with the person, the cards list facts, and
 * every edit or destructive action opens its own dialog (备注名 / 删除 / 拉黑 /
 * 举报) so the page itself never becomes a form.
 */
interface FriendInfoPageProps {
  friend: User;
  online: boolean;
  frozen: boolean;
  onBack: () => void;
  onSendMessage: () => void;
  /** Persists 备注 (empty string clears it). */
  onSaveRemark: (remark: string) => Promise<void>;
  onRemoveFriend: () => void;
  onBlock: () => void;
}

type DialogState =
  | null
  | { kind: 'remark' }
  | { kind: 'confirm'; action: 'remove' | 'block' }
  | { kind: 'report' };

export function FriendInfoPage({
  friend,
  online,
  frozen,
  onBack,
  onSendMessage,
  onSaveRemark,
  onRemoveFriend,
  onBlock,
}: FriendInfoPageProps) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const close = () => setDialog(null);

  return (
    <>
      <SidePage title="好友资料" onBack={onBack} testId="friend-info-page">
        <div className="profile-hero">
          <PresenceAvatar name={displayName(friend)} avatar={friend.avatar} size={72} online={online} />
          <div className="profile-hero-text">
            <div className="profile-hero-name" data-testid="friend-info-name">
              {displayName(friend)}
            </div>
            <div className="profile-hero-sub">@{friend.username}</div>
            <div className="profile-hero-sub">{online ? '在线' : formatLastSeen(friend.lastSeenAt)}</div>
          </div>
        </div>

        <SideSection title="资料">
          <SideRow
            label="备注名"
            value={friend.remark?.trim() || '未设置'}
            testId="friend-remark-row"
            disabled={frozen}
            onClick={() => setDialog({ kind: 'remark' })}
          />
          <SideRow label="个性签名" hint={friend.bio?.trim() || '这个人很懒，什么都没写'} arrow={false} />
          <SideRow label="用户名" value={`@${friend.username}`} arrow={false} />
          <SideRow label="成为好友时间" value={formatDateTime(friend.friendedAt) || '—'} arrow={false} />
        </SideSection>

        <SideSection title="操作">
          <SideRow primary label="发消息" testId="friend-info-send" disabled={frozen} onClick={onSendMessage} />
        </SideSection>

        <SideSection title="危险操作">
          <SideRow
            label="删除好友"
            danger
            testId="friend-info-remove"
            disabled={frozen}
            onClick={() => setDialog({ kind: 'confirm', action: 'remove' })}
          />
          <SideRow
            label="加入黑名单"
            danger
            testId="friend-info-block"
            disabled={frozen}
            onClick={() => setDialog({ kind: 'confirm', action: 'block' })}
          />
          <SideRow label="举报" testId="friend-info-report" disabled={frozen} onClick={() => setDialog({ kind: 'report' })} />
        </SideSection>
      </SidePage>

      <TextPromptDialog
        open={dialog?.kind === 'remark'}
        title="备注名"
        initialValue={friend.remark ?? ''}
        placeholder={friend.nickname}
        maxLength={64}
        inputTestId="friend-remark-input"
        confirmTestId="friend-remark-save"
        disabled={frozen}
        onSubmit={(value) => onSaveRemark(value)}
        onClose={close}
      />

      <ConfirmDialog
        open={dialog?.kind === 'confirm' && dialog.action === 'remove'}
        title="删除好友"
        message="确定从我的好友列表移除？对方仍保留你。"
        confirmLabel="移除"
        confirmTestId="friend-info-remove-confirm"
        disabled={frozen}
        onConfirm={() => {
          close();
          onRemoveFriend();
        }}
        onClose={close}
      />

      <ConfirmDialog
        open={dialog?.kind === 'confirm' && dialog.action === 'block'}
        title="加入黑名单"
        message="加入黑名单后对方无法再给你发消息。"
        confirmLabel="拉黑"
        confirmTestId="friend-info-block-confirm"
        disabled={frozen}
        onConfirm={() => {
          close();
          onBlock();
        }}
        onClose={close}
      />

      <ReportDialog
        open={dialog?.kind === 'report'}
        targetType="user"
        targetId={friend.id}
        disabled={frozen}
        onClose={close}
      />
    </>
  );
}
