import { useEffect } from 'react';
import { ReportForm } from './ReportForm';

interface ReportDialogProps {
  open: boolean;
  targetType: 'user' | 'group' | 'message';
  targetId: number;
  disabled?: boolean;
  onClose: () => void;
}

/** 举报 in a dialog — keeps the reason chips / 说明 / 提交 off the info page. */
export function ReportDialog({ open, targetType, targetId, disabled = false, onClose }: ReportDialogProps) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="dialog-overlay" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <span className="dialog-title">举报</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="dialog-body">
          <ReportForm targetType={targetType} targetId={targetId} disabled={disabled} />
        </div>
      </div>
    </div>
  );
}
