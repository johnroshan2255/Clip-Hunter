import { useEffect, useState } from 'react';
import { api } from './api';

export function Logs({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<'analysis' | 'rendering'>('analysis');
  const [lines, setLines] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.logs(projectId, kind).then((l) => alive && setLines(l)).catch(() => undefined);
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectId, kind]);
  return (
    <section className="card">
      <div className="toolbar">
        <div className="seg">
          <button className={kind === 'analysis' ? 'active' : ''} onClick={() => setKind('analysis')}>analysis.log</button>
          <button className={kind === 'rendering' ? 'active' : ''} onClick={() => setKind('rendering')}>rendering.log</button>
        </div>
      </div>
      <div className="logs">
        {lines.length === 0 && <div className="muted">No log entries yet.</div>}
        {lines.slice().reverse().map((l, i) => {
          const { ts, level, msg, project: _p, ...rest } = l as { ts?: string; level?: string; msg?: string; project?: string };
          return (
            <div key={i} className={`log ${level ?? ''}`}>
              <span className="ts">{ts ? new Date(ts).toLocaleTimeString() : ''}</span>
              <span className="lvl">{level}</span>
              <span className="msg">{msg}</span>
              {Object.keys(rest).length > 0 && <span className="extra">{JSON.stringify(rest)}</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
