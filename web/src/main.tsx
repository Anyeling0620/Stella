import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyTheme, readStoredTheme } from './lib/theme';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 容器不存在');

// The inline script in index.html already set this before first paint; re-applying
// here normalises a stale/invalid stored value.
applyTheme(readStoredTheme());

// Register the service worker (offline shell + Web Push). Best-effort: a failure
// (e.g. insecure context) must not block the app.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
