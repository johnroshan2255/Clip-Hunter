import { useState } from 'react';
import { api, fmtBytes, fmtTime, urls, type ClipRecord, type ProjectDetail } from './api';
import { Modal, ProgressBar, ScoreBadge, StatusPill, toast, toastError } from './ui';

function ClipCard({ c, project, onChanged, busy }: { c: ClipRecord; project: ProjectDetail; onChanged: () => void; busy: boolean }) {
  const [info, setInfo] = useState(false);
  const v = c.renderedAt ?? '';
  const done = c.status === 'completed' && c.file;
  return (
    <div className={`card clip-card ${c.status}`}>
      <div className="clip-media">
        {done ? (
          <video src={urls.clipVideo(project.id, c.id, v)} poster={c.thumbnail ? urls.clipThumb(project.id, c.id, v) : undefined} controls preload="none" playsInline />
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
        <div className="small muted">
          {fmtTime(c.start, true)} → {fmtTime(c.end, true)} · {(c.end - c.start).toFixed(1)}s · {c.category.replace(/_/g, ' ')}
        </div>
        {c.warnings?.length ? <div className="small warn-text">{c.warnings[0]}</div> : null}
        <div className="row-actions">
          {done && <a className="btn small" href={urls.clipDownload(project.id, c.id)}>Download</a>}
          {(c.status === 'failed' || c.status === 'cancelled') && (
            <button className="btn small primary" disabled={busy} onClick={() => void api.render(project.id, { clipIds: [c.id] }).then(() => toast(`Retrying ${c.id}`, 'ok')).catch(toastError)}>Retry</button>
          )}
          {done && (
            <button className="btn small" disabled={busy} title="Render again with current settings" onClick={() => void api.render(project.id, { clipIds: [c.id], force: true }).then(() => toast(`Re-rendering ${c.id}`, 'ok')).catch(toastError)}>Re-render</button>
          )}
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
            {c.renderMs && <><dt>Render time</dt><dd>{(c.renderMs / 1000).toFixed(1)}s</dd></>}
            <dt>Attempts</dt><dd>{c.attempts}</dd>
          </dl>
        </Modal>
      )}
    </div>
  );
}

export function Clips({ project, onChanged, busy }: { project: ProjectDetail; onChanged: () => void; busy: boolean }) {
  const clips = project.clips;
  const done = clips.filter((c) => c.status === 'completed').length;
  const failed = clips.filter((c) => c.status === 'failed');
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
        {done > 0 && <a className="btn small" href={urls.exportZip(project.id)}>Download all (.zip)</a>}
        {done > 0 && (
          <button className="btn small" onClick={() => void api.exportFolder(project.id).then((r) => toast(`Exported ${r.count} clips to ${r.directory}`, 'ok')).catch(toastError)}>
            Export to folder
          </button>
        )}
      </div>
      <div className="grid clips">
        {clips.map((c) => (
          <ClipCard key={c.id} c={c} project={project} onChanged={onChanged} busy={busy} />
        ))}
      </div>
    </section>
  );
}
