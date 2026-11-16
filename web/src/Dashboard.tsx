import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fmtTime, subscribe, type ProjectListItem } from './api';
import { ProgressBar, StatusPill, toast, toastError } from './ui';

function ImportPanel({ onCreated }: { onCreated: () => void }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [game, setGame] = useState('');
  const [count, setCount] = useState(20);
  const [mode, setMode] = useState<'blur' | 'crop' | 'smart'>('blur');
  const [busy, setBusy] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [link, setLink] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const settings = () => ({
    analysis: game.trim() ? { gameTitle: game.trim() } : undefined,
    clips: { count },
    render: { compositionMode: mode },
  });

  const submitPath = async () => {
    setBusy(true);
    try {
      const p = await api.createProject({ path, name: name || undefined, settings: settings() });
      toast(`Imported "${p.name}" — analysis queued`, 'ok');
      setPath('');
      setName('');
      onCreated();
      window.location.hash = `#/project/${p.id}`;
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const importLink = async () => {
    setBusy(true);
    try {
      const p = await api.importUrl({ url: link.trim(), name: name || undefined, settings: settings() });
      toast('Downloading — analysis starts automatically when the download finishes', 'ok');
      setLink('');
      onCreated();
      window.location.hash = `#/project/${p.id}`;
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setUploadPct(0);
    try {
      const p = await api.upload(file, { name: name || undefined, settings: settings() }, setUploadPct);
      toast(`Uploaded "${p.name}" — analysis queued`, 'ok');
      onCreated();
      window.location.hash = `#/project/${p.id}`;
    } catch (e) {
      toastError(e);
    } finally {
      setUploadPct(null);
    }
  };

  return (
    <section className="card import">
      <h2>Import a gameplay recording</h2>
      <p className="muted small">Any game — GTA V/VI, Fortnite, Warzone, racing… MP4, MOV, MKV, AVI or WebM. Long recordings (1–3 h) are fine.</p>
      <div className="form-row">
        <label className="grow">
          <span>Local file path</span>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/Movies/gameplay-session.mp4" onKeyDown={(e) => e.key === 'Enter' && path && void submitPath()} />
        </label>
        <button className="btn primary" disabled={!path || busy} onClick={() => void submitPath()}>
          {busy ? 'Importing…' : 'Import & analyze'}
        </button>
        <span className="or">or</span>
        <button className="btn" disabled={uploadPct !== null} onClick={() => fileRef.current?.click()}>
          Upload file…
        </button>
        <input ref={fileRef} type="file" accept="video/*,.mkv,.avi" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
      </div>
      <div className="form-row">
        <label className="grow">
          <span>…or a link to your stream / VOD (YouTube, Twitch, Kick…)</span>
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" onKeyDown={(e) => e.key === 'Enter' && link && void importLink()} />
        </label>
        <button className="btn" disabled={!/^https?:\/\/\S+\.\S+/.test(link.trim()) || busy} onClick={() => void importLink()}>Download & analyze</button>
      </div>
      {uploadPct !== null && (
        <div className="upload-progress">
          <ProgressBar value={uploadPct} /> <span className="small">Uploading {(uploadPct * 100).toFixed(0)}%</span>
        </div>
      )}
      <div className="form-row options">
        <label>
          <span>Project name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="(from file name)" />
        </label>
        <label>
          <span>Game (optional)</span>
          <input value={game} onChange={(e) => setGame(e.target.value)} placeholder="auto-detect" list="games" />
          <datalist id="games">
            {['GTA V', 'GTA VI', 'Fortnite', 'Call of Duty: Warzone', 'Apex Legends', 'Valorant', 'Red Dead Redemption 2', 'Minecraft', 'Rocket League', 'Forza Horizon 5'].map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <label>
          <span>Clips</span>
          <input type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
        </label>
        <label>
          <span>Layout</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="blur">Blurred background</option>
            <option value="crop">Full-screen crop</option>
            <option value="smart">Smart crop (AI tracking)</option>
          </select>
        </label>
      </div>
    </section>
  );
}

function ProjectCard({ p }: { p: ProjectListItem }) {
  const job = p.activeJob;
  return (
    <a className="card project-card" href={`#/project/${p.id}`}>
      <div className="project-card-head">
        <h3>{p.name}</h3>
        <StatusPill status={job?.status === 'running' ? (job.type === 'render' ? 'rendering' : 'analyzing') : p.status} />
      </div>
      <div className="meta small">
        {p.metadata ? (
          <>
            {fmtTime(p.metadata.durationSeconds)} · {p.metadata.video.displayWidth}×{p.metadata.video.displayHeight} · {p.metadata.video.avgFps.toFixed(0)} fps
          </>
        ) : (
          'Metadata pending'
        )}
        {p.game && <> · {p.game}</>}
      </div>
      {p.download && p.download.status !== 'done' && (
        <div className="small muted">{p.download.status === 'failed' ? <span className="danger-text">Download failed: {p.download.error}</span> : `Downloading from ${new URL(p.download.url).hostname}…`}</div>
      )}
      {job && (job.status === 'running' || job.status === 'queued') && (
        <div className="job-line">
          <ProgressBar value={job.progress} />
          <span className="small muted">{job.status === 'queued' ? 'Queued' : job.message ?? `${Math.round(job.progress * 100)}%`}</span>
        </div>
      )}
      <div className="stats">
        <div><b>{p.counts.candidates}</b><span>moments</span></div>
        <div><b>{p.counts.selected}</b><span>selected</span></div>
        <div><b>{p.counts.clipsCompleted}</b><span>clips</span></div>
        {p.counts.clipsFailed > 0 && <div className="danger-text"><b>{p.counts.clipsFailed}</b><span>failed</span></div>}
      </div>
    </a>
  );
}

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const load = useCallback(() => {
    api.projects().then(setProjects).catch(toastError);
  }, []);
  useEffect(() => {
    load();
    let t: ReturnType<typeof setTimeout> | undefined;
    const debounced = () => {
      clearTimeout(t);
      t = setTimeout(load, 400);
    };
    const unsub = subscribe({ project: debounced, job: debounced });
    return () => {
      unsub();
      clearTimeout(t);
    };
  }, [load]);

  return (
    <div className="dashboard">
      <ImportPanel onCreated={load} />
      <section>
        <h2 className="section-title">Projects</h2>
        {projects === null ? (
          <p className="muted">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="muted empty">No projects yet. Import a recording above to get started.</p>
        ) : (
          <div className="grid projects">
            {projects.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
