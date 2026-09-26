import { useAppActions, useAppRealtime } from '../context/AppContext';

/**
 * Preemptive single-active-tab guard.
 *
 * Opening the app in a second window preempts the first one; the old window
 * freezes (all interaction blocked) until the user explicitly takes over again.
 * This is what stops two windows from mutating the same data concurrently.
 */
export function FrozenOverlay() {
  const { isFrozen } = useAppRealtime();
  const { claimLeadership } = useAppActions();
  if (!isFrozen) return null;

  return (
    <div className="frozen-overlay" role="dialog" aria-modal="true" data-testid="frozen-overlay">
      <div className="frozen-card">
        <h2>当前窗口已冻结</h2>
        <button type="button" className="btn btn-primary" onClick={claimLeadership} data-testid="claim-leadership">
          在此窗口继续操作
        </button>
      </div>
    </div>
  );
}
