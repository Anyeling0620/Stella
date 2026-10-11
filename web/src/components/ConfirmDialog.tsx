import { useEffect } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmTestId: string;
  /** Red confirm button (destructive). Defaults to true. */
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * "确定？" asked in a small dialog.
 *
 * The info pages are display-only rows — anything destructive opens this rather
 * than morphing the row in place, so the page never turns into a form.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  confirmTestId,
  danger = true,
  disabled = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
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
          <span className="dialog-title">{title}</span>
        </header>
        <div className="dialog-body">
          <p className="dialog-confirm-text">{message}</p>
        </div>
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            data-testid={confirmTestId}
            disabled={disabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
