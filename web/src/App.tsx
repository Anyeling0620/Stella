import { Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider, useAppSession } from './context/AppContext';
import { ToastHost } from './components/ToastHost';
import { FrozenOverlay } from './components/FrozenOverlay';
import { LoginPage } from './pages/LoginPage';
import { ChatShell } from './pages/ChatShell';
import type { ReactNode } from 'react';

/** Route guard driven purely by the session capability in the context. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAppSession();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AppProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <ChatShell />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Global overlays: freeze non-active windows, render toasts everywhere. */}
      <FrozenOverlay />
      <ToastHost />
    </AppProvider>
  );
}
