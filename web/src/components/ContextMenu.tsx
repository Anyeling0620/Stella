import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Gap kept between the menu and the viewport edge. */
const EDGE = 8;

interface ContextMenuProps {
  /** Pointer position in viewport coordinates — the menu's preferred anchor. */
  x: number;
  y: number;
  onClose: () => void;
  testId?: string;
  children: ReactNode;
}

/**
 * Floating action menu (right-click on a message bubble or a conversation row).
 *
 * The position is *measured*, not assumed: the menu is laid out at the pointer
 * and then clamped into the viewport before paint, so a click near the right or
 * bottom edge opens a fully visible menu instead of one hanging off screen (and
 * never one that makes the page scroll). It is also capped to the viewport
 * height so the clamp always has room.
 */
export function ContextMenu({ x, y, onClose, testId, children }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width, height } = element.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - width - EDGE));
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE));
    // Bail out when nothing moved — otherwise every render would set state again.
    setPos((previous) =>
      previous.left === left && previous.top === top ? previous : { left, top }
    );
  }, [x, y, children]);

  // Dismissed by anything outside: a click elsewhere, Escape, or the anchor
  // moving under it (scroll/resize).
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="msg-menu"
      data-testid={testId}
      style={{ left: pos.left, top: pos.top }}
    >
      {children}
    </div>
  );
}
