import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtTime, parseTime, urls, type Candidate, type ProjectDetail } from './api';
import { Modal, ScoreBadge, StatusPill, toast, toastError } from './ui';
import { FxEditor } from './FxEditor';

type Filter = 'all' | 'selected' | 'approved' | 'rejected';

function TimeInput({ value, onCommit, disabled }: { value: number; onCommit: (v: number) => void; disabled?: boolean }) {
  const [text, setText] = useState(fmtTime(value, true));
  useEffect(() => setText(fmtTime(value, true)), [value]);
  const commit = () => {
    const v = parseTime(text);
    if (Number.isFinite(v) && Math.abs(v - value) > 0.04) onCommit(v);
    else setText(fmtTime(value, true));
  };
  return (
    <input
      className="time-input"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      aria-label="timestamp"
    />
  );
}

function MomentRow({ c, projectId, onUpdate, onPreview, onFx, disabled }: { c: Candidate; projectId: string; onUpdate: (patch: Partial<Candidate>) => void; onPreview: () => void; onFx: () => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className={`moment ${c.status} ${c.selected ? 'is-selected' : ''}`}>
        <td>
          <input type="checkbox" checked={c.selected && c.status !== 'rejected'} disabled={disabled || c.status === 'rejected'} onChange={(e) => onUpdate({ selected: e.target.checked })} aria-label="selected" />
        </td>
        <td className="thumb-cell">
          <button className="thumb-btn" onClick={onPreview} title="Preview this moment">
            <img src={urls.frame(projectId, c.peakTime ?? (c.start + c.end) / 2)} alt="" loading="lazy" />
            <span className="play">▶</span>
          </button>
        </td>
        <td>
          <div className="moment-title">{c.title}</div>
          <div className="small muted">
            <span className="tag">{c.category.replace(/_/g, ' ')}</span> {c.refined ? 'refined' : 'pass-1 estimate'}
            {c.edited && <span className="tag">edited</span>}
            {c.source === 'manual' && <span className="tag">manual</span>}
          </div>
          <button className="link small" onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button>
        </td>
        <td className="times">
          <TimeInput value={c.start} disabled={disabled} onCommit={(v) => onUpdate({ start: v })} />
          <span className="muted">→</span>
          <TimeInput value={c.end} disabled={disabled} onCommit={(v) => onUpdate({ end: v })} />
          <div className="small muted">{(c.end - c.start).toFixed(1)}s</div>
        </td>
        <td className="num"><ScoreBadge score={c.entertainmentScore} /></td>
        <td className="num"><ScoreBadge score={c.finalScore} /></td>
        <td className="num small">{Math.round(c.confidence * 100)}%</td>
        <td>
          <div className="row-actions">
            <button className={`btn small ${c.fx ? 'fx-on' : ''}`} onClick={onFx} title={c.fx ? `Effects: ${c.fx.source === 'manual' ? 'edited by you' : 'planned by AI'}` : 'Add effects (hook, replay, zooms, sounds…)'}>✨</button>
            <button className={`btn small ${c.status === 'approved' ? 'ok' : ''}`} disabled={disabled} onClick={() => onUpdate({ status: c.status === 'approved' ? 'pending' : 'approved' })} title="Always include">✓</button>
            <button className={`btn small ${c.status === 'rejected' ? 'danger' : ''}`} disabled={disabled} onClick={() => onUpdate({ status: c.status === 'rejected' ? 'pending' : 'rejected' })} title="Never include">✕</button>
          </div>
          {c.status !== 'pending' && <StatusPill status={c.status === 'approved' ? 'completed' : 'failed'} />}
        </td>
      </tr>
      {open && (
        <tr className="details-row">
          <td colSpan={8}>
            <p><b>What happens:</b> {c.description}</p>
            <p><b>Why:</b> {c.reason}</p>
            {c.scores && (
              <p className="small">
                {Object.entries(c.scores).map(([k, v]) => (
                  <span key={k} className="subscore">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}: <b>{v}</b></span>
                ))}
              </p>
            )}
            <p className="small muted">
              Audio evidence {c.audioScore}/10 · visual activity {c.sceneScore}/10{c.peakTime !== undefined ? ` · peak at ${fmtTime(c.peakTime, true)}` : ''}
              {c.notes?.length ? ` · ${c.notes.join('; ')}` : ''}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

export function Moments({ project, version, onChanged, busy }: { project: ProjectDetail; version: number; onChanged: () => void; busy: boolean }) {
  const [list, setList] = useState<Candidate[] | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<'time' | 'score'>('time');
  const [preview, setPreview] = useState<Candidate | null>(null);
  const [fxFor, setFxFor] = useState<Candidate | null>(null);
  const [adding, setAdding] = useState(false);
  const [newStart, setNewStart] = useState('');
  const [newEnd, setNewEnd] = useState('');

  const load = useCallback(() => {
    api.candidates(project.id).then((r) => {
      setList(r.candidates);
      setNotes(r.selection?.notes ?? []);
    }).catch(toastError);
  }, [project.id]);
  useEffect(load, [load, version, project.counts.candidates]);

  const update = async (c: Candidate, patch: Partial<Candidate>) => {
    try {
      const next = await api.updateCandidate(project.id, c.id, patch);
      setList((xs) => xs?.map((x) => (x.id === c.id ? next : x)) ?? null);
      onChanged();
    } catch (e) {
      toastError(e);
    }
  };

  const shown = useMemo(() => {
    let xs = list ?? [];
    if (filter === 'selected') xs = xs.filter((c) => c.selected && c.status !== 'rejected');
    if (filter === 'approved') xs = xs.filter((c) => c.status === 'approved');
    if (filter === 'rejected') xs = xs.filter((c) => c.status === 'rejected');
    return [...xs].sort(sort === 'time' ? (a, b) => a.start - b.start : (a, b) => b.finalScore - a.finalScore);
  }, [list, filter, sort]);

  if (project.stages.selection.status !== 'done' && !(list && list.length)) {
    return <div className="card muted empty">Moments appear here once the analysis finishes.</div>;
  }
  if (!list) return <p className="muted">Loading…</p>;

  const addManual = async () => {
    const s = parseTime(newStart);
    const e = parseTime(newEnd);
    if (!Number.isFinite(s) || !Number.isFinite(e)) return toast('Enter times like 1:02:30 or 3750', 'error');
    try {
      await api.addCandidate(project.id, { start: s, end: e, title: 'Manual clip' });
      setAdding(false);
      setNewStart('');
      setNewEnd('');
      load();
      onChanged();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <section className="card moments">
      <div className="toolbar">
        <div className="seg">
          {(['all', 'selected', 'approved', 'rejected'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <div className="seg">
          <button className={sort === 'time' ? 'active' : ''} onClick={() => setSort('time')}>by time</button>
          <button className={sort === 'score' ? 'active' : ''} onClick={() => setSort('score')}>by score</button>
        </div>
        <span className="spacer" />
        <button className="btn small" disabled={busy} onClick={() => setAdding(!adding)}>+ Add moment</button>
        <button className="btn small" disabled={busy} title="Re-rank with your approvals/rejections applied" onClick={() => void api.reselect(project.id).then(() => { load(); onChanged(); toast('Selection updated', 'ok'); }).catch(toastError)}>
          Re-run selection
        </button>
      </div>
      {adding && (
        <div className="form-row add-moment">
          <label><span>Start</span><input value={newStart} onChange={(e) => setNewStart(e.target.value)} placeholder="12:30" /></label>
          <label><span>End</span><input value={newEnd} onChange={(e) => setNewEnd(e.target.value)} placeholder="12:52" /></label>
          <button className="btn primary small" onClick={() => void addManual()}>Add</button>
        </div>
      )}
      {notes.map((n) => <div key={n} className="alert warn small">{n}</div>)}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th title="Include in render">Use</th>
              <th>Preview</th>
              <th>Moment</th>
              <th>Start → End</th>
              <th className="num" title="AI entertainment score">AI</th>
              <th className="num" title="Final ranking score (AI + audio + visual evidence)">Rank</th>
              <th className="num">Conf.</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <MomentRow key={c.id} c={c} projectId={project.id} disabled={busy} onUpdate={(patch) => void update(c, patch)} onPreview={() => setPreview(c)} onFx={() => setFxFor(c)} />
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="muted empty">No moments match this filter.</p>}
      </div>
      {preview && (
        <Modal title={`${preview.title} · ${fmtTime(preview.start, true)} → ${fmtTime(preview.end, true)}`} onClose={() => setPreview(null)} wide>
          <video key={`${preview.id}-${preview.start}-${preview.end}`} className="preview-video" src={urls.preview(project.id, preview.id, preview.start, preview.end)} controls autoPlay />
          <p className="small muted">Low-resolution source preview (rendered on demand; first load may take a few seconds).</p>
          <p>{preview.description}</p>
        </Modal>
      )}
      {fxFor && (
        <FxEditor
          project={project}
          candidate={fxFor}
          clipId={project.clips.find((x) => x.candidateId === fxFor.id && x.status === 'completed')?.id}
          onClose={() => setFxFor(null)}
          onSaved={() => {
            load();
            onChanged();
          }}
        />
      )}
    </section>
  );
}
