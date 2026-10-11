import type { CSSProperties } from 'react';
import { useAppActions, useToasts } from '../context/AppContext';
import { Icon, type IconName } from './Icon';

const ICONS: Record<string, IconName> = {
  info: 'chat',
  success: 'check-circle',
  warning: 'warning',
  error: 'close-circle',
  notice: 'megaphone',
};

/**
 * Global toast host.
 *
 * Chat messages from the active conversation update silently; everything else
 * (other conversations, friend events, system announcements) surfaces here.
 */
export function ToastHost() {
  const toasts = useToasts();
  const { dismissToast, setActiveConversationId } = useAppActions();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((toast, index) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          data-testid="toast"
          data-kind={toast.kind}
          // 0 = newest (front, nearest the screen edge); older ones tuck behind.
          style={{ '--depth': String(toasts.length - 1 - index) } as CSSProperties}
        >
          <span className="toast-icon" aria-hidden="true">
            <Icon name={ICONS[toast.kind] ?? 'chat'} size={18} />
          </span>
          <div className="toast-body">
            <div className="toast-title">{toast.title}</div>
            {toast.body && <div className="toast-text">{toast.body}</div>}
          </div>
          <div className="toast-actions">
            {toast.conversationId != null && (
              <button
                type="button"
                className="toast-link"
                onClick={() => {
                  setActiveConversationId(toast.conversationId ?? null);
                  dismissToast(toast.id);
                }}
              >
                查看
              </button>
            )}
            <button type="button" className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="关闭">
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
