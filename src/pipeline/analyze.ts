import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import type { ClaudeCli } from '../ai/claudeCli.js';
import { discoverySchema, inspectionSchema, validateDiscovery, validateInspection, type DiscoveryResult, type InspectionResult } from '../ai/schemas.js';
import { editorSystemPrompt, buildDiscoveryPrompt, buildInspectionPrompt, describeActivity, describeScenes } from '../ai/prompts.js';
import { probeVideo } from '../media/probe.js';
import { extractAnalysisFrames, extractWindowFrames } from '../media/frames.js';
import { buildContactSheets } from '../media/contactSheet.js';
import { analyseEnvelope, computeAudioEnvelope, describeAudioForRange } from '../media/audio.js';
import type { FfmpegTools } from '../media/ffmpeg.js';
import { assertDiskSpace, ensureDir, exists, readJson, readJsonOr, removePath, writeJsonAtomic } from '../util/fsx.js';
import { mapLimit, throwIfAborted } from '../util/concurrency.js';
import { AppError, ValidationError, errorToJSON, isCancelled } from '../util/errors.js';
import { formatTimestamp, round3 } from '../util/time.js';
import type { Logger } from '../util/logger.js';
import type { AnalysisFrame, AudioAnalysis, AudioEnvelope, Candidate, ContactSheet, SceneChange, StageName, VideoMetadata } from '../types.js';
import { ANALYSIS_STAGES } from '../types.js';
import type { ProjectPaths, ProjectStore } from './projectStore.js';
import {
  dedupeCandidates,
  normaliseBoundaries,
  planInspectionWindows,
  scoreCandidate,
  selectClips,
  snapBoundaries,
  type DiscoveryMoment,
  type InspectionWindow,
} from './selection.js';

export interface PipelineContext {
  store: ProjectStore;
  projectId: string;
  paths: ProjectPaths;
  cfg: AppConfig;
  tools: FfmpegTools;
  claude: ClaudeCli;
  logger: Logger;
  signal: AbortSignal;
}

export interface ScenesFile {
  threshold: number;
  changes: SceneChange[];
  /** Mean frame-difference per second. */
  activity: number[];
}

export interface DiscoveryBatch {
  id: string;
  start: number;
  end: number;
  sheets: string[];
  summary: string;
  game?: string;
  moments: DiscoveryMoment[];
  dropped: string[];
  attempts: number;
  error?: Record<string, unknown>;
}

export interface DiscoveryFile {
  game?: string;
  batches: DiscoveryBatch[];
  moments: DiscoveryMoment[];
  failedBatches: number;
}

export interface InspectionRecord {
  window: InspectionWindow;
  fps: number;
  sheets: string[];
  result?: InspectionResult;
  error?: Record<string, unknown>;
  attempts: number;
}

export interface SelectedFile {
  generatedAt: string;
  notes: string[];
  clips: Array<Pick<Candidate, 'id' | 'start' | 'end' | 'category' | 'title' | 'description' | 'entertainmentScore' | 'finalScore' | 'peakTime'>>;
}

/** Progress throttle: persist stage progress at most every 750ms. */
function progressReporter(ctx: PipelineContext, stage: StageName) {
  let last = 0;
  let lastValue = -1;
  return (fraction: number, message?: string) => {
    const now = Date.now();
    const v = Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 1000;
    if (now - last < 750 && v < 1 && !message) return;
    if (v === lastValue && !message) return;
    last = now;
    lastValue = v;
    void ctx.store.setStage(ctx.projectId, stage, { progress: v, ...(message ? { message } : {}) }).catch(() => undefined);
  };
}

async function sourcePath(ctx: PipelineContext): Promise<string> {
  const p = ctx.store.get(ctx.projectId);
  return ctx.paths.abs(p.sourceFile);
}

async function loadMetadata(ctx: PipelineContext): Promise<VideoMetadata> {
  return readJson<VideoMetadata>(ctx.paths.metadataFile);
}

// ───────────────────────────── Stages ─────────────────────────────

/** Stage 1: place the source video inside the project (hardlink → symlink → copy). */
async function stageIngest(ctx: PipelineContext): Promise<string> {
  const project = ctx.store.get(ctx.projectId);
  const dest = ctx.paths.abs(project.sourceFile);
  if (await exists(dest)) {
    const st = await fsp.stat(dest);
    if (st.size > 0) return `Source present (${(st.size / 1e9).toFixed(2)} GB)`;
  }
  const src = project.originalPath;
  const st = await fsp.stat(src).catch(() => null);
  if (!st?.isFile()) throw new ValidationError(`Source video not found: ${src}`);
  await ensureDir(path.dirname(dest));
  let method: 'hardlink' | 'symlink' | 'copy' = 'copy';
  if (ctx.cfg.storage.importMode === 'link') {
    try {
      await fsp.link(src, dest);
      method = 'hardlink';
    } catch {
      try {
        await fsp.symlink(src, dest);
        method = 'symlink';
      } catch {
        method = 'copy';
      }
    }
  }
  if (method === 'copy') {
    await assertDiskSpace(ctx.paths.root, st.size + ctx.cfg.storage.minFreeDiskGb * 1e9, 'copying the source video');
    const report = progressReporter(ctx, 'ingest');
    const tmp = `${dest}.tmp`;
    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(src);
      const ws = fs.createWriteStream(tmp);
      let copied = 0;
      rs.on('data', (c) => {
        copied += c.length;
        report(copied / st.size);
      });
      const onAbort = () => rs.destroy(new AppError('CANCELLED', 'Import cancelled'));
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', () => {
        ctx.signal.removeEventListener('abort', onAbort);
        resolve();
      });
      rs.pipe(ws);
    });
    await fsp.rename(tmp, dest);
  }
  await ctx.store.update(ctx.projectId, (p) => {
    p.importMethod = method;
  });
  return `Imported via ${method}`;
}

/** Stage 2: probe metadata. */
async function stageMetadata(ctx: PipelineContext): Promise<string> {
  const src = await sourcePath(ctx);
  const md = await probeVideo(ctx.tools, src, { signal: ctx.signal, audioStreamIndex: ctx.cfg.analysis.audioStreamIndex });
  md.path = path.basename(src);
  await writeJsonAtomic(ctx.paths.metadataFile, md);
  await ctx.store.update(ctx.projectId, (p) => {
    p.metadata = md;
  });
  const v = md.video;
  if (v.isVariableFrameRate) ctx.logger.info('Variable frame rate detected; timestamps are taken from presentation time', { avgFps: v.avgFps, rFps: v.rFps });
  return `${formatTimestamp(md.durationSeconds)} · ${v.displayWidth}x${v.displayHeight} · ${v.avgFps.toFixed(2)} fps${v.isVariableFrameRate ? ' (VFR)' : ''} · ${v.codec}${md.audio.length ? ` · ${md.audio.length} audio track(s)` : ' · no audio'}`;
}

/** Stage 3: chunked frame extraction + scene detection. */
async function stageFrames(ctx: PipelineContext): Promise<string> {
  const md = await loadMetadata(ctx);
  const a = ctx.cfg.analysis;
  const expectedFrames = md.durationSeconds / a.frameIntervalSeconds;
  await assertDiskSpace(ctx.paths.root, expectedFrames * 40_000 * 1.5 + ctx.cfg.storage.minFreeDiskGb * 1e9, 'analysis frames');
  const report = progressReporter(ctx, 'frames');
  const res = await extractAnalysisFrames({
    tools: ctx.tools,
    source: await sourcePath(ctx),
    duration: md.durationSeconds,
    framesDir: ctx.paths.framesDir,
    projectRoot: ctx.paths.root,
    interval: a.frameIntervalSeconds,
    width: a.analysisWidth,
    chunkSeconds: a.extractionChunkSeconds,
    concurrency: a.extractionConcurrency,
    sceneThreshold: a.sceneThreshold,
    hardwareDecode: a.hardwareDecode,
    videoStreamIndex: md.video.index,
    signal: ctx.signal,
    logger: ctx.logger,
    onProgress: (f) => report(f),
  });
  if (!res.frames.length) throw new ValidationError('No frames could be extracted from the video');
  // Collapse duplicate detections closer than 0.3s.
  const changes = res.changes.filter((c, i, arr) => i === 0 || c.t - arr[i - 1]!.t > 0.3);
  await writeJsonAtomic(ctx.paths.framesIndexFile, { interval: a.frameIntervalSeconds, width: a.analysisWidth, frames: res.frames });
  await writeJsonAtomic(ctx.paths.scenesFile, { threshold: a.sceneThreshold, changes, activity: res.activity } satisfies ScenesFile);
  return `${res.frames.length} frames, ${changes.length} scene changes`;
}

/** Stage 4 (pass 3 inputs): audio envelope + event detection. */
async function stageAudio(ctx: PipelineContext): Promise<string> {
  const md = await loadMetadata(ctx);
  if (md.selectedAudioIndex === null) {
    await writeJsonAtomic(ctx.paths.audioAnalysisFile, null);
    return 'skipped: video has no audio';
  }
  const report = progressReporter(ctx, 'audio');
  const env = await computeAudioEnvelope({
    tools: ctx.tools,
    source: await sourcePath(ctx),
    audioStreamIndex: md.selectedAudioIndex,
    windowSeconds: ctx.cfg.analysis.audioWindowSeconds,
    duration: md.durationSeconds,
    signal: ctx.signal,
    onProgress: report,
  });
  const analysis = analyseEnvelope(env, { onsetDb: ctx.cfg.analysis.audioOnsetDb });
  await ensureDir(ctx.paths.audioDir);
  await writeJsonAtomic(ctx.paths.audioEnvelopeFile, env);
  await writeJsonAtomic(ctx.paths.audioAnalysisFile, analysis);
  return `${analysis.events.length} audio events, mean ${analysis.meanDb} dBFS${analysis.clippingRatio > 0.001 ? `, source clipping ${(analysis.clippingRatio * 100).toFixed(2)}%` : ''}`;
}

/** Stage 5: timestamped contact sheets for pass 1. */
async function stageContactSheets(ctx: PipelineContext): Promise<string> {
  const md = await loadMetadata(ctx);
  const idx = await readJson<{ frames: AnalysisFrame[] }>(ctx.paths.framesIndexFile);
  const a = ctx.cfg.analysis;
  const report = progressReporter(ctx, 'contactSheets');
  await removePath(ctx.paths.contactSheetsDir);
  const sheets = await buildContactSheets(
    idx.frames,
    ctx.paths.root,
    ctx.paths.contactSheetsDir,
    { columns: a.contactSheetColumns, rows: a.contactSheetRows, tileWidth: a.contactSheetTileWidth, aspect: md.video.displayWidth / md.video.displayHeight },
    { prefix: 'sheet', concurrency: 4, onProgress: report },
  );
  await writeJsonAtomic(ctx.paths.contactSheetsFile, sheets);
  return `${sheets.length} contact sheets`;
}

interface Evidence {
  audio: AudioAnalysis | null;
  envelope: AudioEnvelope | null;
  scenes: ScenesFile;
}

async function loadEvidence(ctx: PipelineContext): Promise<Evidence> {
  return {
    audio: await readJsonOr<AudioAnalysis | null>(ctx.paths.audioAnalysisFile, null),
    envelope: await readJsonOr<AudioEnvelope | null>(ctx.paths.audioEnvelopeFile, null),
    scenes: await readJsonOr<ScenesFile>(ctx.paths.scenesFile, { threshold: 0, changes: [], activity: [] }),
  };
}

/** Stage 6 (pass 1): broad discovery over batches of contact sheets. */
async function stageDiscovery(ctx: PipelineContext): Promise<string> {
  const md = await loadMetadata(ctx);
  const sheets = await readJson<ContactSheet[]>(ctx.paths.contactSheetsFile);
  const ev = await loadEvidence(ctx);
  const a = ctx.cfg.analysis;
  const c = ctx.cfg.clips;
  await ensureDir(ctx.paths.discoveryDir);
  const groups: ContactSheet[][] = [];
  for (let i = 0; i < sheets.length; i += a.sheetsPerRequest) groups.push(sheets.slice(i, i + a.sheetsPerRequest));
  const report = progressReporter(ctx, 'discovery');
  let done = 0;

  const batches = await mapLimit(groups, ctx.cfg.claude.maxConcurrent, async (group, gi): Promise<DiscoveryBatch> => {
    throwIfAborted(ctx.signal);
    const id = `batch-${String(gi + 1).padStart(4, '0')}`;
    const cacheFile = path.join(ctx.paths.discoveryDir, `${id}.json`);
    const cached = await readJsonOr<DiscoveryBatch | null>(cacheFile, null);
    if (cached && !cached.error) {
      report(++done / groups.length);
      return cached;
    }
    const start = group[0]!.start;
    // Range extends to the next frame interval after the last tile.
    const end = Math.min(md.durationSeconds, group[group.length - 1]!.end + a.frameIntervalSeconds);
    const fmt = (t: number) => `${t.toFixed(1)}s`;
    const prompt = buildDiscoveryPrompt({
      sheets: group,
      rangeStart: start,
      rangeEnd: end,
      interval: a.frameIntervalSeconds,
      videoDuration: md.durationSeconds,
      audioSummary: ev.audio ? describeAudioForRange(ev.audio, start, end, fmt) : 'No audio track.',
      sceneSummary: describeScenes(ev.scenes.changes, start, end),
      activitySummary: describeActivity(ev.scenes.activity, start, end),
      minClip: c.minDurationSeconds,
      maxClip: c.maxDurationSeconds,
      game: a.gameTitle || undefined,
    });
    const batch: DiscoveryBatch = { id, start, end, sheets: group.map((s) => s.file), summary: '', moments: [], dropped: [], attempts: 0 };
    try {
      const res = await ctx.claude.invoke<DiscoveryResult>({
        label: `discovery ${id}`,
        systemPrompt: editorSystemPrompt(a.gameTitle),
        prompt,
        images: group.map((s) => ctx.paths.abs(s.file)),
        schema: discoverySchema,
        validate: (d) => validateDiscovery(d, { start, end }, a.frameIntervalSeconds * 1.5),
        signal: ctx.signal,
      });
      batch.summary = res.value.summary;
      batch.game = res.value.game;
      batch.dropped = res.value.dropped;
      batch.attempts = res.attempts;
      batch.moments = res.value.moments.map((m, k) => ({
        id: `${id}-m${k + 1}`,
        start: m.start,
        end: m.end,
        category: m.category,
        title: m.title,
        description: m.description,
        score: m.entertainment_score,
        confidence: m.confidence,
        reason: m.reason,
      }));
      await recordUsage(ctx, res.usage);
      ctx.logger.info('Discovery batch analysed', { batch: id, range: `${fmt(start)}-${fmt(end)}`, moments: batch.moments.length, attempts: res.attempts, ms: res.durationMs });
    } catch (err) {
      if (isCancelled(err)) throw err;
      if (err instanceof AppError && (err.code === 'CLAUDE_AUTH' || err.code === 'CLAUDE_NOT_FOUND')) throw err;
      batch.error = errorToJSON(err);
      ctx.logger.error('Discovery batch failed', { batch: id, err });
    }
    await writeJsonAtomic(cacheFile, batch);
    report(++done / groups.length, `${done}/${groups.length} batches`);
    return batch;
  });

  const failed = batches.filter((b) => b.error).length;
  if (failed > Math.max(1, Math.floor(batches.length * 0.25))) {
    throw new AppError('DISCOVERY_FAILED', `${failed} of ${batches.length} discovery batches failed; retry analysis to resume (completed batches are kept)`, { retryable: true });
  }
  const moments = batches.flatMap((b) => b.moments);
  const game = a.gameTitle || majorityGame(batches.map((b) => b.game));
  await writeJsonAtomic(ctx.paths.discoveryFile, { game, batches, moments, failedBatches: failed } satisfies DiscoveryFile);
  if (game) {
    await ctx.store.update(ctx.projectId, (p) => {
      p.game = game;
    });
  }
  return `${moments.length} promising ranges from ${batches.length} requests${game ? ` · game: ${game}` : ''}${failed ? ` (${failed} batch(es) failed)` : ''}`;
}

/** Most frequently reported game name across batches (case-insensitive). */
export function majorityGame(names: Array<string | undefined>): string | undefined {
  const counts = new Map<string, { n: number; name: string }>();
  for (const raw of names) {
    const name = raw?.trim();
    if (!name || /^(unknown|n\/a|none)$/i.test(name)) continue;
    const k = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const e = counts.get(k) ?? { n: 0, name };
    e.n++;
    counts.set(k, e);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.name;
}

async function recordUsage(ctx: PipelineContext, u: { requests: number; failures: number; inputTokens: number; outputTokens: number; costUsdEquivalent: number }): Promise<void> {
  await ctx.store.update(ctx.projectId, (p) => {
    const t = p.claudeUsage ?? { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, costUsdEquivalent: 0 };
    t.requests += u.requests;
    t.failures += u.failures;
    t.inputTokens += u.inputTokens;
    t.outputTokens += u.outputTokens;
    t.costUsdEquivalent = Math.round((t.costUsdEquivalent + u.costUsdEquivalent) * 10000) / 10000;
    p.claudeUsage = t;
  });
}

/** Stage 7 (pass 2): dense re-sampling of promising windows for precise boundaries. */
async function stageInspection(ctx: PipelineContext): Promise<string> {
  const md = await loadMetadata(ctx);
  const disc = await readJson<DiscoveryFile>(ctx.paths.discoveryFile);
  const ev = await loadEvidence(ctx);
  const a = ctx.cfg.analysis;
  const c = ctx.cfg.clips;
  await ensureDir(ctx.paths.inspectionDir);
  const planFile = path.join(ctx.paths.inspectionDir, 'plan.json');
  const maxWindows = a.maxDetailInspections > 0 ? a.maxDetailInspections : Math.max(20, Math.ceil(c.count * 2.5));
  let plan = await readJsonOr<InspectionWindow[] | null>(planFile, null);
  if (!plan) {
    plan = planInspectionWindows(disc.moments, {
      minScore: Math.min(a.discoveryMinScore, c.minEntertainmentScore),
      context: a.detailContextSeconds,
      maxWindow: a.detailMaxWindowSeconds,
      duration: md.durationSeconds,
      maxWindows,
    });
    await writeJsonAtomic(planFile, plan);
  }
  const report = progressReporter(ctx, 'inspection');
  let done = 0;
  const layout = { columns: a.contactSheetColumns, rows: a.contactSheetRows, tileWidth: a.contactSheetTileWidth, aspect: md.video.displayWidth / md.video.displayHeight };
  const maxFrames = a.contactSheetColumns * a.contactSheetRows * 4;
  // User-provided title wins; otherwise use what pass 1 detected.
  const game = a.gameTitle || disc.game || undefined;

  const records = await mapLimit(plan, ctx.cfg.claude.maxConcurrent, async (w): Promise<InspectionRecord> => {
    throwIfAborted(ctx.signal);
    const cacheFile = path.join(ctx.paths.inspectionDir, `${w.id}.json`);
    const cached = await readJsonOr<InspectionRecord | null>(cacheFile, null);
    if (cached && !cached.error) {
      report(++done / plan!.length);
      return cached;
    }
    const len = w.end - w.start;
    const fps = Math.max(0.5, Math.min(a.detailFps, Math.floor((maxFrames / len) * 4) / 4));
    const outDir = path.join(ctx.paths.detailDir, w.id);
    const rec: InspectionRecord = { window: w, fps, sheets: [], attempts: 0 };
    try {
      const frames = await extractWindowFrames({
        tools: ctx.tools,
        source: await sourcePath(ctx),
        start: w.start,
        end: w.end,
        fps,
        width: a.analysisWidth,
        outDir: path.join(outDir, 'frames'),
        projectRoot: ctx.paths.root,
        hardwareDecode: a.hardwareDecode,
        signal: ctx.signal,
      });
      const sheets = await buildContactSheets(frames, ctx.paths.root, outDir, layout, { prefix: `${w.id}-sheet`, concurrency: 2 });
      rec.sheets = sheets.map((s) => s.file);
      const fmt = (t: number) => `${t.toFixed(2)}s`;
      const prompt = buildInspectionPrompt({
        sheets,
        windowStart: w.start,
        windowEnd: w.end,
        fps,
        hypothesis: w.members.map((m) => ({ start: m.start, end: m.end, category: m.category, description: m.description, score: m.score })),
        audioSummary: ev.audio ? describeAudioForRange(ev.audio, w.start, w.end, fmt, 10) : 'No audio track.',
        sceneSummary: describeScenes(ev.scenes.changes, w.start, w.end),
        minClip: c.minDurationSeconds,
        preferredMin: c.preferredMinSeconds,
        preferredMax: c.preferredMaxSeconds,
        maxClip: c.maxDurationSeconds,
        frameAspect: `${md.video.displayWidth}x${md.video.displayHeight}`,
        game,
      });
      const res = await ctx.claude.invoke<InspectionResult>({
        label: `inspection ${w.id}`,
        systemPrompt: editorSystemPrompt(game),
        prompt,
        images: sheets.map((s) => ctx.paths.abs(s.file)),
        schema: inspectionSchema,
        validate: (d) => validateInspection(d, { start: w.start, end: w.end }, 1 / fps + 0.5),
        signal: ctx.signal,
      });
      rec.result = res.value;
      rec.attempts = res.attempts;
      await recordUsage(ctx, res.usage);
      ctx.logger.info('Window inspected', { window: w.id, verdict: res.value.verdict, moments: res.value.moments.length, ms: res.durationMs });
    } catch (err) {
      if (isCancelled(err)) throw err;
      if (err instanceof AppError && (err.code === 'CLAUDE_AUTH' || err.code === 'CLAUDE_NOT_FOUND' || err.code === 'DISK_SPACE_LOW')) throw err;
      rec.error = errorToJSON(err);
      ctx.logger.error('Window inspection failed; pass-1 estimate will be used', { window: w.id, err });
    }
    await writeJsonAtomic(cacheFile, rec);
    report(++done / plan!.length, `${done}/${plan!.length} windows`);
    return rec;
  });

  // Build candidates.
  const candidates: Candidate[] = [];
  const covered = new Set<string>();
  for (const r of records) {
    for (const m of r.window.members) covered.add(m.id);
    if (r.result) {
      r.result.moments.forEach((m, k) => {
        candidates.push({
          id: `${r.window.id}-c${k + 1}`,
          start: m.start,
          end: m.end,
          peakTime: m.peak_time,
          category: m.category,
          title: m.title,
          description: m.description,
          entertainmentScore: m.entertainment_score,
          confidence: m.confidence,
          reason: m.reason,
          scores: {
            unexpectedness: m.scores.unexpectedness,
            visualClarity: m.scores.visual_clarity,
            intensity: m.scores.intensity,
            context: m.scores.context,
            boundaryQuality: m.scores.boundary_quality,
            replayValue: m.scores.replay_value,
          },
          focus: m.focus,
          audioScore: 0,
          sceneScore: 0,
          finalScore: 0,
          source: 'pass2',
          refined: true,
          status: 'pending',
          selected: false,
          parentId: r.window.members.map((x) => x.id).join(','),
        });
      });
    } else {
      // Inspection failed: fall back to the pass-1 estimates (unrefined).
      for (const m of r.window.members) candidates.push(fromDiscovery(m, ['Pass-2 inspection failed; using pass-1 estimate']));
    }
  }
  // Pass-1 moments that were not inspected (budget) remain available as unrefined candidates.
  for (const m of disc.moments) if (!covered.has(m.id) && m.score >= c.minEntertainmentScore) candidates.push(fromDiscovery(m, ['Not inspected in pass 2 (inspection budget)']));
  await writeJsonAtomic(path.join(ctx.paths.inspectionDir, 'raw-candidates.json'), candidates);
  const rejected = records.filter((r) => r.result?.verdict === 'reject').length;
  const failed = records.filter((r) => r.error).length;
  return `${records.length} windows inspected → ${candidates.length} candidates (${rejected} rejected${failed ? `, ${failed} failed` : ''})`;
}

function fromDiscovery(m: DiscoveryMoment, notes: string[]): Candidate {
  return {
    id: `${m.id}`,
    start: m.start,
    end: m.end,
    category: m.category,
    title: m.title,
    description: m.description,
    entertainmentScore: m.score,
    confidence: m.confidence,
    reason: m.reason,
    audioScore: 0,
    sceneScore: 0,
    finalScore: 0,
    source: 'pass1',
    refined: false,
    status: 'pending',
    selected: false,
    notes,
  };
}

/** Stage 8 (pass 4): combine evidence, rank, dedupe, resolve overlaps, select. */
export async function stageSelection(ctx: PipelineContext): Promise<string> {
  const md = await loadMetadata(ctx);
  const ev = await loadEvidence(ctx);
  const c = ctx.cfg.clips;
  const raw = await readJson<Candidate[]>(path.join(ctx.paths.inspectionDir, 'raw-candidates.json'));
  // Preserve user decisions (approve/reject/manual edits) from a previous selection run.
  const previous = await readJsonOr<Candidate[]>(ctx.paths.candidatesFile, []);
  const prevById = new Map(previous.map((p) => [p.id, p]));
  const manual = previous.filter((p) => p.source === 'manual');

  const prepared = [...raw, ...manual].map((cand) => {
    const prev = prevById.get(cand.id);
    let next: Candidate = { ...cand };
    if (prev?.edited) {
      next = { ...next, start: prev.start, end: prev.end, edited: true };
    } else {
      const norm = normaliseBoundaries(next, c, md.durationSeconds);
      const snapped = snapBoundaries(
        { ...norm, peakTime: next.peakTime },
        { radius: c.boundarySnapSeconds, changes: ev.scenes.changes, envelope: ev.envelope ?? undefined, min: c.minDurationSeconds, max: c.maxDurationSeconds, duration: md.durationSeconds },
      );
      next = { ...next, ...snapped };
    }
    if (prev) next.status = prev.status;
    return scoreCandidate(next, { audio: ev.audio ?? undefined, changes: ev.scenes.changes, activity: ev.scenes.activity });
  });
  const deduped = dedupeCandidates(prepared);
  const { selected, notes } = selectClips({ candidates: deduped, clips: c, duration: md.durationSeconds, relaxThreshold: true });
  const selectedById = new Map(selected.map((s) => [s.id, s]));
  const finalCandidates = deduped.map((d) => {
    const s = selectedById.get(d.id);
    return s ? { ...s, selected: true } : { ...d, selected: false };
  });
  await writeJsonAtomic(ctx.paths.candidatesFile, finalCandidates);
  const selectedFile: SelectedFile = {
    generatedAt: new Date().toISOString(),
    notes,
    clips: selected.map((s) => ({ id: s.id, start: round3(s.start), end: round3(s.end), peakTime: s.peakTime, category: s.category, title: s.title, description: s.description, entertainmentScore: s.entertainmentScore, finalScore: s.finalScore })),
  };
  await writeJsonAtomic(ctx.paths.selectedFile, selectedFile);
  await ctx.store.update(ctx.projectId, (p) => {
    p.counts.candidates = finalCandidates.length;
    p.counts.selected = selected.length;
  });
  for (const n of notes) ctx.logger.warn(n);
  return `${finalCandidates.length} candidates → ${selected.length} selected`;
}

const STAGE_FNS: Record<StageName, (ctx: PipelineContext) => Promise<string>> = {
  ingest: stageIngest,
  metadata: stageMetadata,
  frames: stageFrames,
  audio: stageAudio,
  contactSheets: stageContactSheets,
  discovery: stageDiscovery,
  inspection: stageInspection,
  selection: stageSelection,
};

/** Stages whose output invalidates later stages when re-run. */
export function stagesFrom(stage: StageName): StageName[] {
  return ANALYSIS_STAGES.slice(ANALYSIS_STAGES.indexOf(stage));
}

/**
 * Run (or resume) the analysis pipeline. Stages already marked done are
 * skipped; their checkpointed outputs are reused.
 */
export async function runAnalysis(ctx: PipelineContext): Promise<void> {
  const log = ctx.logger;
  await ctx.store.update(ctx.projectId, (p) => {
    p.status = 'analyzing';
    p.error = undefined;
  });
  for (const stage of ANALYSIS_STAGES) {
    throwIfAborted(ctx.signal);
    const state = ctx.store.get(ctx.projectId).stages[stage];
    if (state.status === 'done' || state.status === 'skipped') continue;
    const started = Date.now();
    await ctx.store.setStage(ctx.projectId, stage, { status: 'running', progress: 0, startedAt: new Date().toISOString(), error: undefined, message: undefined, finishedAt: undefined });
    log.info(`Stage ${stage} started`);
    try {
      const message = await STAGE_FNS[stage](ctx);
      const skipped = message.startsWith('skipped');
      await ctx.store.setStage(ctx.projectId, stage, { status: skipped ? 'skipped' : 'done', progress: 1, message, finishedAt: new Date().toISOString() });
      log.info(`Stage ${stage} finished`, { message, ms: Date.now() - started });
    } catch (err) {
      const cancelled = isCancelled(err);
      await ctx.store.setStage(ctx.projectId, stage, {
        status: cancelled ? 'pending' : 'failed',
        error: cancelled ? undefined : errorToJSON(err),
        message: cancelled ? 'Cancelled' : (err as Error).message,
      });
      if (!cancelled) log.error(`Stage ${stage} failed`, { err });
      throw err;
    }
  }
  if (ctx.cfg.storage.cleanupFramesAfterAnalysis) await removePath(ctx.paths.framesDir);
  await ctx.store.update(ctx.projectId, (p) => {
    p.status = 'analyzed';
  });
}

/** Reset a stage (and everything after it) so the next run recomputes it. */
export async function resetStages(store: ProjectStore, projectId: string, from: StageName): Promise<void> {
  const paths = store.paths(projectId);
  const toReset = stagesFrom(from);
  // Clear caches that would otherwise be reused.
  if (toReset.includes('frames')) await removePath(paths.framesDir);
  if (toReset.includes('discovery')) await removePath(paths.discoveryDir);
  if (toReset.includes('inspection')) {
    await removePath(paths.inspectionDir);
    await removePath(paths.detailDir);
  }
  await store.update(projectId, (p) => {
    for (const s of toReset) p.stages[s] = { status: 'pending', progress: 0 };
  });
}
