import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import { SidePage, SideRow, SideSection } from './SidePage';
import { attachmentRawUrl } from '../lib/api';
import { displayName, formatDateTime } from '../lib/format';
import type { Favorite, User } from '../types';

/**
 * 收藏详情.
 *
 * Same WeChat sheet as 好友资料 / 聊天信息: the saved message leads in its own
 * card, facts and actions sit in following cards, and 删除 opens a dialog — no
 * inline "确定？" left on the page.
 */
interface FavoriteDetailPageProps {
  favorite: Favorite;
  /** Resolved sender name ("我" for my own messages). */
  senderName: string;
  /** Access token used by `attachmentRawUrl` (images/audio can't send headers). */
  token: string | null;
  /** Name of the conversation the message came from, when known. */
  sourceLabel: string | null;
  frozen: boolean;
  onBack: () => void;
  onOpenSource: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

export function FavoriteDetailPage({
  favorite,
  senderName,
  token,
  sourceLabel,
  frozen,
  onBack,
  onOpenSource,
  onCopy,
  onDelete,
}: FavoriteDetailPageProps) {
  const [confirming, setConfirming] = useState(false);
  const url = favorite.attachmentId ? attachmentRawUrl(favorite.attachmentId, token) : null;
  const isImage = favorite.type === 'image' && Boolean(url);

  return (
    <>
      <SidePage title="收藏详情" onBack={onBack} testId="favorite-detail-page">
        <SideSection>
          <div className={`favorite-detail-body ${isImage ? 'is-media' : ''}`}>
            {isImage ? (
              <img className="favorite-detail-image" src={url ?? ''} alt={favorite.content || '图片'} />
            ) : favorite.type === 'file' ? (
              <div className="favorite-detail-file">
                <Icon name="file" size={26} />
                <span className="favorite-detail-file-main">
                  <span className="favorite-detail-file-name">{favorite.content || '文件'}</span>
                  <span className="favorite-detail-file-size">文件</span>
                </span>
              </div>
            ) : favorite.type === 'voice' && url ? (
              <audio className="favorite-detail-audio" controls src={url} />
            ) : (
              <p className="favorite-detail-text">{favorite.content || '（无内容）'}</p>
            )}
          </div>
        </SideSection>

        <SideSection title="信息">
          <SideRow label="收藏者" value={senderName} arrow={false} />
          <SideRow label="收藏时间" value={formatDateTime(favorite.createdAt)} arrow={false} />
        </SideSection>

        <SideSection title="操作">
          {url && (favorite.type === 'image' || favorite.type === 'file') && (
            <SideRow label="下载" arrow={false} testId="favorite-download">
              <a className="btn btn-sm btn-ghost" href={url} download={favorite.content || undefined}>
                <Icon name="download" size={16} /> 下载
              </a>
            </SideRow>
          )}
          {sourceLabel && (
            <SideRow
              label="定位到原消息"
              value={sourceLabel}
              testId="favorite-open-source"
              disabled={frozen}
              onClick={onOpenSource}
            />
          )}
          <SideRow label="复制内容" testId="favorite-copy" disabled={frozen} onClick={onCopy} />
        </SideSection>

        <SideSection title="危险操作">
          <SideRow
            label="删除收藏"
            danger
            testId="favorite-delete"
            disabled={frozen}
            onClick={() => setConfirming(true)}
          />
        </SideSection>
      </SidePage>

      <ConfirmDialog
        open={confirming}
        title="删除收藏"
        message="删除这条收藏？"
        confirmLabel="删除"
        confirmTestId="favorite-delete-confirm"
        disabled={frozen}
        onConfirm={() => {
          setConfirming(false);
          onDelete();
        }}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/** My own messages read as 我; unknown senders fall back to their id. */
export function favoriteSenderName(favorite: Favorite, myId: number, friends: User[]): string {
  if (favorite.fromUserId === myId) return '我';
  const friend = friends.find((item) => item.id === favorite.fromUserId);
  return friend ? displayName(friend) : `用户 #${favorite.fromUserId}`;
}
