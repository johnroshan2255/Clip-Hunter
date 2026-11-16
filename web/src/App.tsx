import { useEffect, useState } from 'react';
import { api, subscribe, type ClaudeStatus, type SystemInfo } from './api';
import { Dashboard } from './Dashboard';
import { ProjectView } from './ProjectView';
import { ToastHost } from './ui';

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '');
}

function ClaudeBadge({ status }: { status: ClaudeStatus | null }) {
  if (!status) return <span className="badge muted">Claude…</span>;
  if (!status.available) return <span className="badge danger" title={status.lastError}>Claude CLI not found</span>;
  if (status.authenticated === false) return <span className="badge danger">Claude not logged in</span>;
  const util = status.rateLimit?.utilization;
  if (status.pausedUntil)
    return (
      <span className="badge warn" title={status.pauseReason}>
        Paused until {new Date(status.pausedUntil).toLocaleTimeString()}{' '}
        <button className="link" onClick={() => void api.claudeResume()}>resume</button>
      </span>
    );
  return (
    <span className="badge ok" title={`Claude CLI ${status.version ?? ''} · ${status.totals.requests} requests this session`}>
      Claude {status.model}
      {status.active ? ` · ${status.active} running` : ''}
      {status.queued ? ` · ${status.queued} waiting` : ''}
      {util !== undefined ? ` · usage ${Math.round(util * 100)}%` : ''}
    </span>
  );
}

export function App() {
  const route = useHashRoute();
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);

  useEffect(() => {
    api.system().then((s) => {
      setSys(s);
      setClaude(s.claude);
    }).catch(() => undefined);
    return subscribe({ claude: setClaude });
  }, []);

  const projectId = route.startsWith('project/') ? decodeURIComponent(route.slice(8).split('/')[0]!) : null;

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="logo">▶</span> ClipHunter
        </a>
        <div className="topbar-status">
          {sys && !sys.ffmpeg && <span className="badge danger">FFmpeg not found</span>}
          {sys && <span className="badge muted">{sys.freeDiskGb} GB free</span>}
          <ClaudeBadge status={claude} />
        </div>
      </header>
      <main className="content">{projectId ? <ProjectView id={projectId} /> : <Dashboard />}</main>
      <ToastHost />
    </div>
  );
}
