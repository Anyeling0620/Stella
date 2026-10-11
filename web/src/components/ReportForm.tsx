import { useState } from 'react';
import { reportApi } from '../lib/api';
import { ApiError } from '../lib/axiosClient';
import { useAppActions } from '../context/AppContext';

/** Preset reasons keep a report one tap away; 其他 accepts free text. */
const REASONS: Record<'user' | 'group' | 'message', string[]> = {
  user: ['骚扰或垃圾信息', '欺诈', '不适当内容', '冒充他人', '其他'],
  group: ['色情或违法内容', '垃圾广告', '欺诈', '不适当内容', '其他'],
  message: ['骚扰或垃圾信息', '不适当内容', '欺诈', '其他'],
};

interface ReportFormProps {
  targetType: 'user' | 'group' | 'message';
  targetId: number;
  disabled?: boolean;
}

/**
 * 举报 — shared by 好友资料 and 聊天信息.
 *
 * Submits straight to `POST /api/reports` (rate-limited server side) and never
 * opens a nested dialog, so a report can be filed from any page.
 */
export function ReportForm({ targetType, targetId, disabled = false }: ReportFormProps) {
  const { pushToast } = useAppActions();
  const reasons = REASONS[targetType];
  const [reason, setReason] = useState(reasons[0]);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    return <p className="field-hint">举报已提交，我们会尽快处理。</p>;
  }

  const submit = async () => {
    setBusy(true);
    try {
      await reportApi.create({ targetType, targetId, reason, detail: detail.trim() || undefined });
      setDone(true);
      pushToast({ kind: 'success', title: '举报已提交' });
    } catch (error) {
      pushToast({
        kind: 'error',
        title: '举报失败',
        body: error instanceof ApiError ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="report-form">
      <div className="report-reasons">
        {reasons.map((item) => (
          <button
            key={item}
            type="button"
            className={`chip ${reason === item ? 'chip-on' : ''}`}
            data-testid="report-reason"
            aria-pressed={reason === item}
            disabled={disabled || busy}
            onClick={() => setReason(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <textarea
        className="dialog-textarea"
        data-testid="report-detail"
        value={detail}
        onChange={(event) => setDetail(event.target.value)}
        placeholder="补充说明（可选）"
        rows={3}
        disabled={disabled || busy}
      />
      <button
        type="button"
        className="btn btn-sm btn-danger"
        data-testid="report-submit"
        disabled={disabled || busy}
        onClick={() => void submit()}
      >
        {busy ? '提交中…' : '提交举报'}
      </button>
    </div>
  );
}
