import { useState } from 'react';
import { api, fmtBytes, fmtTime, urls, type Candidate, type ClipRecord, type MontageRecord, type ProjectDetail } from './api';
import { Modal, ProgressBar, ScoreBadge, StatusPill, toast, toastError } from './ui';
import { FxEditor } from './FxEditor';

const LANG_LABEL: Record<string, string> = { hi: 'Hindi', en: 'English', orig: 'Original', 'hi+en': 'Hindi + English', 'en+hi': 'English + Hindi' };
const langLabel = (l: string | null) => (l ? LANG_LABEL[l] ?? l.toUpperCase() : 'No subtitles');

function ClipCard({ c, project, onChanged, busy }: { c: ClipRecord; project: ProjectDetail; onChanged: () => void; busy: boolean }) {
  const [info, setInfo] = useState(false);
  const [editing, setEditing] = useState<Candidate | null>(null);
  const openFx = () =>
    void api
      .candidates(project.id)
      .then((r) => {
        const cand = r.candidates.find((x) => x.id === c.candidateId);
        if (cand) setEditing(cand);
        else toast('Moment not found', 'error');
      })
      .catch(toastError);
  const reels = c.variants?.length ? c.variants : null;
  const [reelIdx, setReelIdx] = useState(0);
  const reel = reels?.[Math.min(reelIdx, reels.length - 1)] ?? null;
  const v = c.renderedAt ?? '';
  const done = c.status === 'completed' && c.file;
  return (
    <div className={`card clip-card ${c.status}`}>
      <div className="clip-media">
        {done ? (
          <video key={reel?.file ?? 'main'} src={urls.clipVideo(project.id, c.id, v, reel?.lang)} poster={c.thumbnail ? urls.clipThumb(project.id, c.id, v) : undefined} controls preload="none" playsInline />
        ) : (
          <div className="clip-placeholder">
            <StatusPill status={c.status} />
            {(c.status === 'rendering' || c.status === 'validating') && <ProgressBar value={c.progress} />}
            {c.status === 'failed' && <p className="small danger-text">{String(c.error?.message ?? 'Render failed')}</p>}
          </div>
        )}
      </div>
      <div className="clip-body">
        <div className="clip-head">
          <b>{c.id}</b> <ScoreBadge score={c.score} />
        </div>
        <div className="clip-title">{c.title}</div>
        {done && reels && reels.length > 1 && (
          <div className="seg reel-tabs">
            {reels.map((r, i) => (
              <button key={r.file} className={i === reelIdx ? 'active' : ''} onClick={() => setReelIdx(i)}>
                {langLabel(r.lang)}
              </button>
            ))}
          </div>
        )}
        <div className="small muted">
          {fmtTime(c.start, true)} → {fmtTime(c.end, true)} · {(c.end - c.start).toFixed(1)}s · {c.category.replace(/_/g, ' ')}
        </div>
        {c.fxSummary?.length ? <div className="fx-chips">{c.fxSummary.map((f) => <span key={f} className="tag fx">{f}</span>)}</div> : null}
        {c.warnings?.length ? <div className="small warn-text">{c.warnings[0]}</div> : null}
        <div className="row-actions">
          {done &&
            (reels && reels.some((r) => r.lang)
              ? reels.map((r) => (
                  <a key={r.file} className="btn small" href={urls.clipDownload(project.id, c.id, r.lang)} title={`Download the ${langLabel(r.lang)} reel`}>
                    ⬇ {r.lang ? langLabel(r.lang) : 'Reel'}
                  </a>
                ))
              : <a className="btn small" href={urls.clipDownload(project.id, c.id)}>Download</a>)}
          {done &&
            c.subtitleFiles?.map((f) => (
              <a key={f.lang} className="btn small" href={urls.clipSubtitles(project.id, c.id, f.lang)} title={`Download ${f.lang} captions (.srt)`}>
                {f.lang.toUpperCase()} .srt
              </a>
            ))}
          {(c.status === 'failed' || c.status === 'cancelled') && (
            <button className="btn small primary" disabled={busy} onClick={() => void api.render(project.id, { clipIds: [c.id] }).then(() => toast(`Retrying ${c.id}`, 'ok')).catch(toastError)}>Retry</button>
          )}
          {done && (
            <button className="btn small" disabled={busy} title="Render again with current settings" onClick={() => void api.render(project.id, { clipIds: [c.id], force: true }).then(() => toast(`Re-rendering ${c.id}`, 'ok')).catch(toastError)}>Re-render</button>
          )}
          <button className="btn small" onClick={openFx} title="See and edit hook, replay, zooms, sounds…">✨ Effects</button>
          {done && <a className="btn small" href={urls.clipGif(project.id, c.id, reel?.lang)} title="GIF of the best seconds (WhatsApp / Discord)">GIF</a>}
          <button className="btn small" onClick={() => setInfo(true)}>Info</button>
          <button
            className="btn small danger-text"
            disabled={c.status === 'rendering' || c.status === 'validating'}
            onClick={() => confirm(`Delete ${c.id}?`) && void api.deleteClip(project.id, c.id).then(onChanged).catch(toastError)}
          >
            Delete
          </button>
        </div>
      </div>
      {info && (
        <Modal title={`${c.id} · ${c.title}`} onClose={() => setInfo(false)}>
          <dl className="kv">
            <dt>Status</dt><dd>{c.status}</dd>
            <dt>Source range</dt><dd>{fmtTime(c.start, true)} → {fmtTime(c.end, true)}</dd>
            <dt>Category</dt><dd>{c.category}</dd>
            <dt>Layout</dt><dd>{c.compositionRequested}{c.compositionUsed && c.compositionUsed !== c.compositionRequested ? ` → fell back to ${c.compositionUsed}` : ''}</dd>
            {c.validation && (
              <>
                <dt>Output</dt><dd>{c.validation.width}×{c.validation.height} · {c.validation.fps} fps · {c.validation.videoCodec}/{c.validation.audioCodec ?? 'no audio'} · {c.validation.pixFmt}</dd>
                <dt>Duration</dt><dd>{c.validation.durationSeconds.toFixed(2)}s</dd>
                <dt>File size</dt><dd>{fmtBytes(c.validation.sizeBytes)}</dd>
                <dt>Decode check</dt><dd>{c.validation.decodeOk ? 'passed' : 'FAILED'}</dd>
                {c.validation.peakDb !== undefined && <><dt>Audio peak</dt><dd>{c.validation.peakDb} dBFS</dd></>}
                {c.validation.errors.length > 0 && <><dt>Errors</dt><dd className="danger-text">{c.validation.errors.join('; ')}</dd></>}
              </>
            )}
            {c.warnings?.length ? <><dt>Warnings</dt><dd>{c.warnings.join('; ')}</dd></> : null}
            {c.subtitles !== undefined && <><dt>Subtitles</dt><dd>{c.subtitles ? `${c.subtitleFiles?.map((f) => f.lang).join(' + ') || 'yes'} (speech: ${c.spokenLanguage ?? '?'})` : 'none'}</dd></>}
            {c.fxSummary?.length ? <><dt>Effects</dt><dd>{c.fxSummary.join(' · ')}</dd></> : null}
            {c.outputSeconds && <><dt>Reel length</dt><dd>{c.outputSeconds.toFixed(1)}s</dd></>}
            {c.renderMs && <><dt>Render time</dt><dd>{(c.renderMs / 1000).toFixed(1)}s</dd></>}
            <dt>Attempts</dt><dd>{c.attempts}</dd>
          </dl>
        </Modal>
      )}
      {editing && <FxEditor project={project} candidate={editing} clipId={c.id} onClose={() => setEditing(null)} onSaved={onChanged} />}
    </div>
  );
}

const TRANSITIONS: Array<[string, string]> = [
  ['smoothleft', 'Smooth slide'],
  ['fade', 'Fade'],
  ['zoomin', 'Zoom in'],
  ['circleopen', 'Circle open'],
  ['wipeleft', 'Wipe'],
  ['pixelize', 'Pixelize'],
  ['dissolve', 'Dissolve'],
  ['radial', 'Radial'],
  ['none', 'Hard cut'],
];

function MontageDialog({ project, onClose, onDone }: { project: ProjectDetail; onClose: () => void; onDone: () => void }) {
  const done = project.clips.filter((c) => c.status === 'completed');
  const langs = [...new Set(done.flatMap((c) => (c.variants ?? []).map((v) => v.lang)).filter((l): l is string => !!l))];
  const [picked, setPicked] = useState<string[]>(done.map((c) => c.id));
  const [orientation, setOrientation] = useState<'vertical' | 'horizontal'>('vertical');
  const [lang, setLang] = useState<string | null>(langs[0] ?? null);
  const [transition, setTransition] = useState('smoothleft');
  const [busy, setBusy] = useState(false);
  const total = done.filter((c) => picked.includes(c.id)).reduce((a, c) => a + (c.outputSeconds ?? c.end - c.start), 0);
  const submit = async () => {
    setBusy(true);
    try {
      await api.createMontage(project.id, { clipIds: picked, orientation, lang: orientation === 'vertical' ? lang : null, transition });
      toast('Montage queued — it appears at the top of the Clips tab', 'ok');
      onDone();
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Make a best-of montage" onClose={onClose} wide>
      <div className="form-grid">
        <label>
          <span>Format</span>
          <select value={orientation} onChange={(e) => setOrientation(e.target.value as typeof orientation)}>
            <option value="vertical">Vertical 9:16 (Shorts / Reels) — with effects & subtitles</option>
            <option value="horizontal">Widescreen 16:9 (YouTube) — original gameplay</option>
          </select>
        </label>
        {orientation === 'vertical' && langs.length > 0 && (
          <label>
            <span>Subtitle language</span>
            <select value={lang ?? ''} onChange={(e) => setLang(e.target.value || null)}>
              {langs.map((l) => <option key={l} value={l}>{LANG_LABEL[l] ?? l}</option>)}
            </select>
          </label>
        )}
        <label>
          <span>Transition</span>
          <select value={transition} onChange={(e) => setTransition(e.target.value)}>
            {TRANSITIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      <div className="montage-pick">
        <div className="small muted">
          {picked.length} clips · about {Math.round(total / 60)} min {Math.round(total % 60)} s ·{' '}
          <button className="link small" onClick={() => setPicked(done.map((c) => c.id))}>all</button> · <button className="link small" onClick={() => setPicked([])}>none</button> ·{' '}
          <button className="link small" onClick={() => setPicked([...done].sort((a, b) => b.score - a.score).slice(0, 10).map((c) => c.id))}>top 10</button>
        </div>
        <div className="montage-list">
          {done.map((c) => (
            <label key={c.id} className="check">
              <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
              <b>{c.id}</b> {c.title} <span className="muted small">({c.score.toFixed(1)})</span>
            </label>
          ))}
        </div>
      </div>
      <div className="actions">
        <button className="btn primary" disabled={busy || picked.length < 2} onClick={() => void submit()}>Make montage</button>
      </div>
    </Modal>
  );
}

function MontageCard({ m, project, onChanged }: { m: MontageRecord; project: ProjectDetail; onChanged: () => void }) {
  return (
    <div className="card montage-card">
      {m.status === 'completed' && m.file ? (
        <video src={urls.montageVideo(project.id, m.id)} controls preload="none" playsInline className={m.orientation} />
      ) : (
        <div className="clip-placeholder">
          <StatusPill status={m.status} />
          {m.status === 'rendering' && <ProgressBar value={m.progress} />}
          {m.status === 'failed' && <p className="small danger-text">{m.error}</p>}
        </div>
      )}
      <div className="clip-body">
        <b>🎬 Montage</b> <span className="small muted">{m.orientation === 'vertical' ? '9:16' : '16:9'}{m.lang ? ` · ${LANG_LABEL[m.lang] ?? m.lang}` : ''} · {m.clipIds.length} clips{m.durationSeconds ? ` · ${Math.round(m.durationSeconds)}s` : ''}{m.sizeBytes ? ` · ${fmtBytes(m.sizeBytes)}` : ''}</span>
        <div className="row-actions">
          {m.status === 'completed' && <a className="btn small" href={urls.montageDownload(project.id, m.id)}>Download</a>}
          {(m.status === 'completed' || m.status === 'failed') && (
            <button className="btn small danger-text" onClick={() => confirm('Delete this montage?') && void api.deleteMontage(project.id, m.id).then(onChanged).catch(toastError)}>Delete</button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Clips({ project, onChanged, busy }: { project: ProjectDetail; onChanged: () => void; busy: boolean }) {
  const clips = project.clips;
  const done = clips.filter((c) => c.status === 'completed').length;
  const failed = clips.filter((c) => c.status === 'failed');
  const [montage, setMontage] = useState(false);
  if (!clips.length) return <div className="card muted empty">No clips yet. Review the moments, then click “Render”.</div>;
  return (
    <section>
      <div className="toolbar card">
        <span>
          <b>{done}</b> completed{failed.length ? <> · <span className="danger-text">{failed.length} failed</span></> : null}
          {clips.length - done - failed.length > 0 ? ` · ${clips.length - done - failed.length} pending` : ''}
        </span>
        <span className="spacer" />
        {failed.length > 0 && (
          <button className="btn small primary" disabled={busy} onClick={() => void api.render(project.id, { clipIds: failed.map((f) => f.id) }).then(() => toast('Retrying failed clips', 'ok')).catch(toastError)}>
            Retry failed
          </button>
        )}
        {done > 1 && <button className="btn small" disabled={busy} onClick={() => setMontage(true)} title="Join clips into one video with transitions">🎬 Make montage</button>}
        {done > 0 && <a className="btn small" href={urls.exportZip(project.id)}>Download all (.zip)</a>}
        {done > 0 && (
          <button className="btn small" onClick={() => void api.exportFolder(project.id).then((r) => toast(`Exported ${r.count} clips to ${r.directory}`, 'ok')).catch(toastError)}>
            Export to folder
          </button>
        )}
      </div>
      {project.montages?.length ? (
        <div className="grid montages">
          {[...project.montages].reverse().map((m) => <MontageCard key={m.id} m={m} project={project} onChanged={onChanged} />)}
        </div>
      ) : null}
      {montage && <MontageDialog project={project} onClose={() => setMontage(false)} onDone={onChanged} />}
      <div className="grid clips">
        {clips.map((c) => (
          <ClipCard key={c.id} c={c} project={project} onChanged={onChanged} busy={busy} />
        ))}
      </div>
    </section>
  );
}
