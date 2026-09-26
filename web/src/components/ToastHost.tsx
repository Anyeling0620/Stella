import { useAppActions, useToasts } from '../context/AppContext';

const ICONS: Record<string, string> = {
  info: '💬',
  success: '✅',
  warning: '⚠️',
  error: '⛔',
  notice: '📢',
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
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          data-testid="toast"
          data-kind={toast.kind}
        >
          <span className="toast-icon" aria-hidden="true">
            {ICONS[toast.kind] ?? '💬'}
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
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
