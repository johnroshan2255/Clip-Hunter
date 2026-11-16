import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import type { Candidate, ClipRecord, VideoMetadata } from '../types.js';
import type { FfmpegTools } from '../media/ffmpeg.js';
import type { ProjectStore } from '../pipeline/projectStore.js';
import { readJson, readJsonOr, assertDiskSpace, exists } from '../util/fsx.js';
import { Semaphore } from '../util/concurrency.js';
import { AppError, errorToJSON, isCancelled } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import { renderClip, renderKey } from './renderClip.js';

export interface RenderJobParams {
  /** Only (re-)render these clip ids. */
  clipIds?: string[];
  /** Re-render even if an identical completed render exists. */
  force?: boolean;
}

export function clipId(index: number): string {
  return `clip-${String(index).padStart(3, '0')}`;
}

/**
 * Sync clip records with the current selection. Completed clips are kept
 * (a later failure never invalidates them); stale incomplete records for
 * deselected moments are dropped.
 */
export function syncClipRecords(existing: ClipRecord[], selected: Candidate[], mode: ClipRecord['compositionRequested']): ClipRecord[] {
  const byCandidate = new Map(existing.map((c) => [c.candidateId, c]));
  const selectedIds = new Set(selected.map((s) => s.id));
  const kept = existing.filter((c) => selectedIds.has(c.candidateId) || c.status === 'completed');
  let nextIndex = existing.reduce((m, c) => Math.max(m, c.index), 0) + 1;
  for (const s of [...selected].sort((a, b) => a.start - b.start)) {
    const prev = byCandidate.get(s.id);
    if (prev) {
      Object.assign(prev, { start: s.start, end: s.end, title: s.title, category: s.category, score: s.finalScore, compositionRequested: mode });
      continue;
    }
    const index = nextIndex++;
    kept.push({
      id: clipId(index),
      candidateId: s.id,
      index,
      start: s.start,
      end: s.end,
      title: s.title,
      category: s.category,
      score: s.finalScore,
      status: 'queued',
      progress: 0,
      compositionRequested: mode,
      attempts: 0,
    });
  }
  return kept.sort((a, b) => a.index - b.index);
}

/** Render all selected clips for a project with bounded concurrency. */
export async function runRenderJob(o: {
  store: ProjectStore;
  projectId: string;
  cfg: AppConfig;
  tools: FfmpegTools;
  logger: Logger;
  signal: AbortSignal;
  params: RenderJobParams;
  onProgress: (fraction: number, message?: string) => void;
}): Promise<string> {
  const { store, projectId, cfg } = o;
  const paths = store.paths(projectId);
  const project = store.get(projectId);
  const md = await readJson<VideoMetadata>(paths.metadataFile).catch(() => {
    throw new AppError('NOT_ANALYZED', 'Analyze the video before rendering');
  });
  const source = paths.abs(project.sourceFile);
  if (!(await exists(source))) throw new AppError('SOURCE_MISSING', 'Source video is missing from the project');
  const candidates = await readJsonOr<Candidate[]>(paths.candidatesFile, []);
  const selected = candidates.filter((c) => c.selected && c.status !== 'rejected');
  if (!selected.length) throw new AppError('NOTHING_SELECTED', 'No moments are selected for rendering');
  const candById = new Map(candidates.map((c) => [c.id, c]));
  const sourceId = `${md.sizeBytes}:${md.durationSeconds}`;

  // Sync clip records and decide what needs rendering.
  let todo: string[] = [];
  await store.update(projectId, (p) => {
    p.status = 'rendering';
    p.clips = syncClipRecords(p.clips, selected, cfg.render.compositionMode);
    for (const c of p.clips) {
      const key = renderKey(cfg, c.start, c.end, sourceId);
      const requested = !o.params.clipIds || o.params.clipIds.includes(c.id);
      const upToDate = c.status === 'completed' && c.renderKey === key && !o.params.force;
      if (requested && !upToDate && candById.has(c.candidateId)) {
        c.status = 'queued';
        c.progress = 0;
        c.error = undefined;
        todo.push(c.id);
      }
    }
  });
  // Completed clips whose file vanished must be re-rendered too.
  for (const c of store.get(projectId).clips) {
    if (c.status === 'completed' && c.file && !(await exists(paths.abs(c.file))) && !todo.includes(c.id)) todo.push(c.id);
  }
  todo = [...new Set(todo)];
  const total = todo.length;
  if (!total) {
    await store.update(projectId, (p) => {
      p.status = 'completed';
    });
    return 'All selected clips are already rendered and up to date';
  }
  o.logger.info('Render job started', { clips: total, concurrency: cfg.render.concurrency, mode: cfg.render.compositionMode });
  const progress = new Map<string, number>();
  const report = (msg?: string) => o.onProgress([...progress.values()].reduce((a, b) => a + b, 0) / total, msg);
  const sem = new Semaphore(cfg.render.concurrency);
  let completed = 0;
  let failed = 0;

  const setClip = (id: string, patch: Partial<ClipRecord>) =>
    store.update(projectId, (p) => {
      const c = p.clips.find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    });

  await Promise.all(
    todo.map((id) =>
      sem.run(async () => {
        const rec = store.get(projectId).clips.find((c) => c.id === id);
        if (!rec) return;
        const cand = candById.get(rec.candidateId)!;
        const outFile = path.join(paths.clipsDir, `${id}.mp4`);
        const thumb = path.join(paths.thumbnailsDir, `${id}.jpg`);
        const key = renderKey(cfg, rec.start, rec.end, sourceId);
        let lastErr: Record<string, unknown> | undefined;
        for (let attempt = 1; attempt <= cfg.render.maxRetries + 1; attempt++) {
          if (o.signal.aborted) break;
          await setClip(id, { status: 'rendering', progress: 0, attempts: rec.attempts + attempt });
          let lastP = 0;
          try {
            await assertDiskSpace(paths.root, (rec.end - rec.start) * 2e6 + cfg.storage.minFreeDiskGb * 1e9, `rendering ${id}`);
            const r = await renderClip({
              tools: o.tools,
              cfg,
              metadata: md,
              source,
              candidate: cand,
              start: rec.start,
              end: rec.end,
              outFile,
              thumbnailFile: thumb,
              workDir: path.join(paths.workDir, id),
              signal: o.signal,
              logger: o.logger,
              onProgress: (f) => {
                progress.set(id, f);
                if (f - lastP > 0.05) {
                  lastP = f;
                  void setClip(id, { progress: Math.round(f * 100) / 100, status: f >= 0.97 ? 'validating' : 'rendering' });
                  report();
                }
              },
            });
            if (!r.validation.ok) {
              lastErr = { code: 'VALIDATION_FAILED', message: r.validation.errors.join('; ') };
              o.logger.warn('Clip failed validation', { clip: id, attempt, errors: r.validation.errors });
              await setClip(id, { validation: r.validation });
              continue;
            }
            completed++;
            progress.set(id, 1);
            await setClip(id, {
              status: 'completed',
              progress: 1,
              file: paths.rel(outFile),
              thumbnail: (await exists(thumb)) ? paths.rel(thumb) : undefined,
              validation: r.validation,
              compositionUsed: r.compositionUsed,
              renderedAt: new Date().toISOString(),
              renderMs: r.renderMs,
              subtitles: r.subtitles,
              renderKey: key,
              warnings: r.validation.warnings,
              error: undefined,
            });
            o.logger.info('Clip rendered and validated', { clip: id, ms: r.renderMs, mode: r.compositionUsed, sizeMb: Math.round(r.validation.sizeBytes / 1e5) / 10, warnings: r.validation.warnings });
            report(`${completed}/${total} clips done`);
            return;
          } catch (err) {
            if (isCancelled(err)) {
              await setClip(id, { status: 'cancelled', progress: 0 });
              throw err;
            }
            lastErr = errorToJSON(err);
            o.logger.error('Clip render attempt failed', { clip: id, attempt, err });
            const retryable = !(err instanceof AppError) || err.retryable;
            if (!retryable) break;
          }
        }
        if (o.signal.aborted) {
          await setClip(id, { status: 'cancelled', progress: 0 });
          return;
        }
        failed++;
        progress.set(id, 1);
        await setClip(id, { status: 'failed', progress: 0, error: lastErr });
        report(`${completed}/${total} clips done, ${failed} failed`);
      }, o.signal),
    ),
  ).catch(async (err) => {
    // Leave completed clips untouched; mark the rest cancelled.
    await store.update(projectId, (p) => {
      for (const c of p.clips) if (c.status === 'queued' || c.status === 'rendering' || c.status === 'validating') c.status = 'cancelled';
      p.status = 'analyzed';
    });
    throw err;
  });

  await fsp.rm(paths.workDir, { recursive: true, force: true });
  await store.update(projectId, (p) => {
    p.counts.clipsCompleted = p.clips.filter((c) => c.status === 'completed').length;
    p.counts.clipsFailed = p.clips.filter((c) => c.status === 'failed').length;
    p.status = p.counts.clipsCompleted > 0 ? 'completed' : 'failed';
  });
  const msg = `${completed} clip(s) rendered and validated${failed ? `, ${failed} failed` : ''}`;
  if (failed && !completed) throw new AppError('RENDER_FAILED', msg, { retryable: true });
  return msg;
}
