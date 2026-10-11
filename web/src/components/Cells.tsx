import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * WeChat-style "cells" — the building block for every settings/info surface.
 *
 * The look we are after: content sits in rounded *cards* on the pane
 * background, rows are separated by inset hairlines, a row reads
 * `label …………… value ›`, and destructive actions are centred red text at the
 * bottom of their own card. Nothing is a bare stack of labels and controls.
 */
interface CellSectionProps {
  title?: string;
  /** Small grey line under the card (a hint, a warning). */
  footer?: ReactNode;
  children: ReactNode;
}

export function CellSection({ title, footer, children }: CellSectionProps) {
  return (
    <section className="cell-section">
      {title ? <div className="cell-title">{title}</div> : null}
      <div className="cell-card">{children}</div>
      {footer ? <div className="cell-foot">{footer}</div> : null}
    </section>
  );
}

interface CellProps {
  label: ReactNode;
  /** Secondary text under the label. */
  hint?: ReactNode;
  /** Grey text on the right (a current value, a count). */
  value?: ReactNode;
  /** Shows the › affordance — navigation goes somewhere. */
  arrow?: boolean;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
  onClick?: () => void;
  /** Replaces the right slot entirely (a switch, an input, a badge). */
  children?: ReactNode;
}

export function Cell({
  label,
  hint,
  value,
  arrow = false,
  danger = false,
  disabled = false,
  testId,
  onClick,
  children,
}: CellProps) {
  const body = (
    <>
      <span className="cell-main">
        <span className="cell-label">{label}</span>
        {hint ? <span className="cell-hint">{hint}</span> : null}
      </span>
      {children ?? (
        <span className="cell-side">
          {value ? <span className="cell-value">{value}</span> : null}
          {arrow ? <Icon name="chevron-right" size={16} /> : null}
        </span>
      )}
    </>
  );
  const className = `cell ${danger ? 'danger' : ''}`;

  // A row without an action is a read-only line, not a button.
  if (!onClick) {
    return (
      <div className={className} data-testid={testId}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" className={className} data-testid={testId} disabled={disabled} onClick={onClick}>
      {body}
    </button>
  );
}

/** A row whose right slot is the on/off control. */
export function CellSwitch({
  label,
  hint,
  value,
  disabled,
  testId,
  onToggle,
}: {
  label: ReactNode;
  hint?: ReactNode;
  value: boolean;
  disabled?: boolean;
  testId?: string;
  onToggle: () => void;
}) {
  return (
    <div className="cell">
      <span className="cell-main">
        <span className="cell-label">{label}</span>
        {hint ? <span className="cell-hint">{hint}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={typeof label === 'string' ? label : undefined}
        data-testid={testId}
        className={`settings-switch ${value ? 'on' : ''}`}
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="settings-switch-knob" />
      </button>
    </div>
  );
}
