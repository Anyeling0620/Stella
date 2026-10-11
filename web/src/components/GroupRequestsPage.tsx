import { useEffect, useState } from 'react';
import { groupApi } from '../lib/api';
import { ApiError } from '../lib/axiosClient';
import { useAppActions } from '../context/AppContext';
import { Avatar } from './Avatar';
import { SidePage } from './SidePage';
import type { GroupJoinRequest } from '../types';

interface GroupRequestsPageProps {
  groupId: number;
  onBack: () => void;
  /** Keep the main page's 加群申请 badge in sync. */
  onCountChange: (count: number) => void;
  /** Refresh the roster after an approval. */
  onReload: () => Promise<void>;
}

/** 加群申请 — the pending-applications sub-page of 群聊详情 (owner/admin). */
export function GroupRequestsPage({ groupId, onBack, onCountChange, onReload }: GroupRequestsPageProps) {
  const { pushToast } = useAppActions();
  const [requests, setRequests] = useState<GroupJoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    groupApi
      .joinRequests(groupId)
      .then((data) => {
        if (!cancelled) {
          setRequests(data.requests);
          onCountChange(data.requests.length);
        }
      })
      .catch(() => {
        if (!cancelled) setRequests([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, onCountChange]);

  const respond = async (request: GroupJoinRequest, action: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(true);
    try {
      await groupApi.respondJoin(groupId, request.id, action);
      setRequests((current) => {
        const next = current.filter((item) => item.id !== request.id);
        onCountChange(next.length);
        return next;
      });
      pushToast({
        kind: 'success',
        title: action === 'approve' ? '已同意加群' : '已拒绝申请',
        body: request.applicant.nickname,
      });
      if (action === 'approve') await onReload();
    } catch (error) {
      pushToast({ kind: 'error', title: '操作失败', body: error instanceof ApiError ? error.message : '请稍后重试' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SidePage title="加群申请" onBack={onBack} testId="group-requests-page">
      {loading && <div className="panel-empty">加载中…</div>}
      {!loading && requests.length === 0 && <div className="panel-empty">暂无待处理的加群申请</div>}
      {requests.map((request) => (
        <div key={request.id} className="list-row" data-testid="group-join-request" data-request-id={request.id}>
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
              disabled={busy}
              onClick={() => void respond(request, 'approve')}
            >
              同意
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              data-testid="group-join-reject"
              disabled={busy}
              onClick={() => void respond(request, 'reject')}
            >
              拒绝
            </button>
          </div>
        </div>
      ))}
    </SidePage>
  );
}
