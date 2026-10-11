import { FormEvent, useEffect, useState } from 'react';

interface TextPromptDialogProps {
  open: boolean;
  /** Used as both the dialog title and the field label. */
  title: string;
  initialValue: string;
  placeholder?: string;
  maxLength?: number;
  /** Render a `<textarea>` instead of a single-line `<input>` (群公告). */
  multiline?: boolean;
  rows?: number;
  confirmLabel?: string;
  inputTestId?: string;
  confirmTestId: string;
  /** Disables the confirm button (e.g. frozen account) — 取消 still works. */
  disabled?: boolean;
  /**
   * May be async — the dialog stays open (confirm shows 保存中…) until it
   * settles. Return `false` to keep the dialog open (e.g. validation failed).
   */
  onSubmit: (value: string) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
}

/**
 * A single-field editor in a dialog (备注名 today).
 *
 * Editing lives here, not inline on the page, so the page stays a set of clean
 * rows. The draft resets from `initialValue` each time it opens.
 */
export function TextPromptDialog({
  open,
  title,
  initialValue,
  placeholder,
  maxLength,
  multiline = false,
  rows = 3,
  confirmLabel = '保存',
  inputTestId,
  confirmTestId,
  disabled = false,
  onSubmit,
  onClose,
}: TextPromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setBusy(false);
    }
  }, [open, initialValue]);

  const requestClose = () => {
    if (!busy) onClose();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || busy) return;
    setBusy(true);
    try {
      const result = await onSubmit(value.trim());
      if (result !== false) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-overlay" onMouseDown={requestClose}>
      <form className="dialog" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
        <header className="dialog-head">
          <span className="dialog-title">{title}</span>
          <button type="button" className="icon-btn" onClick={requestClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="dialog-body">
          <label className="field">
            <span>{title}</span>
            {multiline ? (
              <textarea
                className="dialog-textarea"
                data-testid={inputTestId}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={placeholder}
                maxLength={maxLength}
                rows={rows}
                autoFocus
              />
            ) : (
              <input
                data-testid={inputTestId}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={placeholder}
                maxLength={maxLength}
                autoFocus
              />
            )}
          </label>
        </div>
        <footer className="dialog-foot">
          <button type="button" className="btn" onClick={requestClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" data-testid={confirmTestId} disabled={disabled || busy}>
            {busy ? '保存中…' : confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
