import { useCallback, useEffect, useState } from 'react';
import { api, fmtBytes, fmtTime, subscribe, type ProjectDetail, type StageName } from './api';
import { ProgressBar, StatusPill, toast, toastError } from './ui';
import { Moments } from './Moments';
import { Clips } from './Clips';
import { Logs } from './Logs';
import { SettingsPanel } from './Settings';

const STAGE_LABELS: Record<StageName, string> = {
  ingest: 'Import',
  metadata: 'Metadata',
  frames: 'Frames & scenes',
  audio: 'Audio analysis',
  contactSheets: 'Contact sheets',
  discovery: 'AI pass 1 · discovery',
  inspection: 'AI pass 2 · inspection',
  selection: 'Ranking & selection',
};

type Tab = 'moments' | 'clips' | 'logs' | 'settings';

export function ProjectView({ id }: { id: string }) {
  const [p, setP] = useState<ProjectDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>('moments');
  const [candidatesVersion, setCandidatesVersion] = useState(0);

  const load = useCallback(() => {
    api.project(id).then(setP).catch((e: { status?: number }) => (e.status === 404 ? setNotFound(true) : toastError(e)));
  }, [id]);

  useEffect(() => {
    load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const debounced = () => {
      clearTimeout(t);
      t = setTimeout(load, 250);
    };
    const unsub = subscribe({
      project: (e) => {
        if (e.projectId !== id) return;
        if (e.type === 'deleted') setNotFound(true);
        else debounced();
      },
      job: (j) => {
        if (j.projectId !== id) return;
        debounced();
        if (j.status === 'completed' && j.type === 'analyze') setCandidatesVersion((v) => v + 1);
      },
    });
    return () => {
      unsub();
      clearTimeout(t);
    };
  }, [id, load]);

  useEffect(() => {
    if (p && p.clips.length && tab === 'moments' && p.status === 'rendering') setTab('clips');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p?.status]);

  if (notFound) return <p className="muted">Project not found. <a href="#/">Back to dashboard</a></p>;
  if (!p) return <p className="muted">Loading…</p>;

  const active = p.jobs.find((j) => j.status === 'running' || j.status === 'queued');
  const lastFailed = !active ? p.jobs.find((j) => j.status === 'failed') : undefined;
  const analyzed = p.stages.selection.status === 'done';
  const md = p.metadata;

  const act = async (fn: () => Promise<unknown>, msg?: string) => {
    try {
      await fn();
      if (msg) toast(msg, 'ok');
      load();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="project">
      <div className="crumbs"><a href="#/">Projects</a> / {p.name}</div>
      <section className="card project-head">
        <div className="project-title">
          <h1>{p.name}</h1>
          <StatusPill status={active?.status === 'running' ? (active.type === 'render' ? 'rendering' : 'analyzing') : p.status} />
          {p.game && <span className="tag">{p.game}</span>}
        </div>
        {md && (
          <div className="meta-grid">
            <div><span>Duration</span><b>{fmtTime(md.durationSeconds)}</b></div>
            <div><span>Resolution</span><b>{md.video.displayWidth}×{md.video.displayHeight}</b></div>
            <div><span>Frame rate</span><b>{md.video.avgFps.toFixed(2)}{md.video.isVariableFrameRate ? ' (VFR)' : ''}</b></div>
            <div><span>Video</span><b>{md.video.codec}</b></div>
            <div><span>Audio</span><b>{md.audio.length ? md.audio.map((a) => `${a.codec} ${a.channels}ch`).join(', ') : 'none'}</b></div>
            <div><span>Size</span><b>{fmtBytes(md.sizeBytes)}</b></div>
            <div><span>Moments</span><b>{p.counts.candidates}</b></div>
            <div><span>Selected</span><b>{p.counts.selected}</b></div>
            <div><span>Clips</span><b>{p.counts.clipsCompleted}{p.counts.clipsFailed ? ` (+${p.counts.clipsFailed} failed)` : ''}</b></div>
            {p.claudeUsage && <div><span>Claude requests</span><b>{p.claudeUsage.requests}</b></div>}
          </div>
        )}
        <div className="actions">
          {active ? (
            <button className="btn danger" onClick={() => void act(() => api.cancel(p.id), 'Cancelling…')}>Cancel {active.type}</button>
          ) : (
            <>
              {!analyzed && <button className="btn primary" onClick={() => void act(() => api.analyze(p.id), 'Analysis queued')}>{p.stages.ingest.status === 'pending' ? 'Analyze' : 'Resume analysis'}</button>}
              {analyzed && (
                <button className="btn primary" disabled={!p.counts.selected} onClick={() => void act(() => api.render(p.id), 'Rendering queued')}>
                  Render {p.counts.selected} selected clip{p.counts.selected === 1 ? '' : 's'}
                </button>
              )}
              {analyzed && <button className="btn" onClick={() => void act(() => api.analyze(p.id, 'discovery'), 'Re-analysis queued')} title="Re-run the AI passes (frames are reused)">Re-run AI analysis</button>}
            </>
          )}
          <button
            className="btn ghost danger-text"
            disabled={!!active}
            onClick={() => {
              if (confirm(`Delete project "${p.name}" and all its clips? The original video is not touched.`)) void act(() => api.deleteProject(p.id)).then(() => (window.location.hash = '#/'));
            }}
          >
            Delete project
          </button>
        </div>
        {active && (
          <div className="job-line">
            <ProgressBar value={active.progress} />
            <span className="small muted">{active.status === 'queued' ? 'Queued — waiting for a free worker' : `${active.type}: ${Math.round(active.progress * 100)}% ${active.message ?? ''}`}</span>
          </div>
        )}
        {lastFailed && p.status === 'failed' && (
          <div className="alert danger">
            <b>{lastFailed.type} failed:</b> {lastFailed.message ?? lastFailed.error?.message}{' '}
            <button className="btn small" onClick={() => void act(() => api.retryJob(lastFailed.id), 'Retry queued')}>Retry (resumes from checkpoint)</button>
          </div>
        )}
      </section>

      <section className="card stages">
        {(Object.keys(STAGE_LABELS) as StageName[]).map((s) => {
          const st = p.stages[s];
          return (
            <div key={s} className={`stage ${st.status}`} title={st.error ? String((st.error as { message?: string }).message) : st.message}>
              <div className="stage-head">
                <span className="stage-dot" />
                <span className="stage-name">{STAGE_LABELS[s]}</span>
              </div>
              {st.status === 'running' ? <ProgressBar value={st.progress} /> : <div className="stage-msg small muted">{st.status === 'failed' ? 'failed' : st.message ?? st.status}</div>}
            </div>
          );
        })}
      </section>

      <nav className="tabs">
        {(['moments', 'clips', 'logs', 'settings'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'moments' ? `Moments (${p.counts.candidates})` : t === 'clips' ? `Clips (${p.clips.length})` : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === 'moments' && <Moments project={p} version={candidatesVersion} onChanged={load} busy={!!active} />}
      {tab === 'clips' && <Clips project={p} onChanged={load} busy={!!active} />}
      {tab === 'logs' && <Logs projectId={p.id} />}
      {tab === 'settings' && <SettingsPanel project={p} onSaved={load} />}
    </div>
  );
}
