import type { ReactNode } from 'react';
import { Cell, CellSection } from './Cells';
import { Icon } from './Icon';

/**
 * Shell for the "right-hand pages" (聊天信息 / 好友资料 / 收藏详情).
 *
 * These live inside `<main>` and completely cover the conversation, so the chat
 * underneath stays mounted — going back never refetches history or loses the
 * scroll position. The left sidebar and rail keep working the whole time.
 */
interface SidePageProps {
  title: string;
  onBack: () => void;
  /** Distinguishes the three pages in tests and in the mobile back flow. */
  testId: string;
  children: ReactNode;
}

export function SidePage({ title, onBack, testId, children }: SidePageProps) {
  return (
    <section className="side-page" data-testid={testId}>
      <header className="side-page-head">
        <button
          type="button"
          className="icon-btn"
          data-testid="side-page-back"
          aria-label="返回"
          title="返回"
          onClick={onBack}
        >
          <Icon name="chevron-left" size={20} />
        </button>
        <span className="side-page-title">{title}</span>
      </header>
      <div className="side-page-body">{children}</div>
    </section>
  );
}

/** One card of related rows — the unit that keeps actions from intermingling. */
export function SideSection({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <CellSection title={title} footer={footer}>
      {children}
    </CellSection>
  );
}

interface SideRowProps {
  label: ReactNode;
  /** Secondary text under the label. */
  hint?: ReactNode;
  /** Grey text on the right (a value, a count). */
  value?: ReactNode;
  arrow?: boolean;
  danger?: boolean;
  primary?: boolean;
  disabled?: boolean;
  testId?: string;
  onClick?: () => void;
  /** Replaces the right slot (an input, a switch…). */
  children?: ReactNode;
}

/** A row inside a `SideSection`. */
export function SideRow({ label, hint, value, arrow = true, danger, primary, disabled, testId, onClick, children }: SideRowProps) {
  if (primary) {
    return (
      <button
        type="button"
        className="cell cell-primary"
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </button>
    );
  }
  return (
    <Cell label={label} hint={hint} value={value} arrow={arrow} danger={danger} disabled={disabled} testId={testId} onClick={onClick}>
      {children}
    </Cell>
  );
}
