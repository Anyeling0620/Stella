import { FormEvent, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../lib/api';
import { ApiError } from '../lib/axiosClient';
import { useAppActions, useAppSession } from '../context/AppContext';
import { session } from '../lib/session';

type Mode = 'login' | 'register';

export function LoginPage() {
  const navigate = useNavigate();
  const { signIn } = useAppActions();
  const { isAuthenticated } = useAppSession();

  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isAuthenticated || session.isAuthenticated()) navigate('/', { replace: true });
  }, [isAuthenticated, navigate]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const payload =
        mode === 'login'
          ? await authApi.login({ username: username.trim(), password, rememberMe })
          : await authApi.register({
              username: username.trim(),
              password,
              nickname: nickname.trim() || undefined,
              rememberMe,
            });
      signIn(payload);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="brand-mark">Stella</div>

        <div className="login-tabs">
          <button
            type="button"
            className={mode === 'login' ? 'active' : ''}
            onClick={() => switchMode('login')}
          >
            登录
          </button>
          <button
            type="button"
            className={mode === 'register' ? 'active' : ''}
            onClick={() => switchMode('register')}
          >
            注册
          </button>
        </div>

        <label className="field">
          <span>用户名</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </label>

        {mode === 'register' && (
          <label className="field">
            <span>昵称</span>
            <input
              data-testid="nickname-input"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              maxLength={64}
            />
          </label>
        )}

        <label className="field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
        </label>

        <label className="login-remember">
          <input
            type="checkbox"
            data-testid="remember-me"
            checked={rememberMe}
            onChange={(event) => setRememberMe(event.target.checked)}
          />
          <span>记住我（30 天内免登录）</span>
        </label>

        {error && <div className="form-error">{error}</div>}

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>
      </form>
    </div>
  );
}
