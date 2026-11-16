import { useState, type FormEvent } from 'react';
import { api } from './api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={(e) => void submit(e)}>
        <div className="brand login-brand">
          <span className="logo">▶</span> ClipHunter
        </div>
        <p className="muted small">This ClipHunter is password protected. Ask the owner for the password.</p>
        <label>
          <span>Password</span>
          <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="alert danger small">{error}</div>}
        <button className="btn primary" type="submit" disabled={!password || busy}>
          {busy ? 'Checking…' : 'Enter'}
        </button>
      </form>
    </div>
  );
}
