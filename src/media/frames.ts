import fsp from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, fmtSec, type FfmpegTools } from './ffmpeg.js';
import { ensureDir, exists, readJsonOr, removePath, writeJsonAtomic } from '../util/fsx.js';
import { mapLimit } from '../util/concurrency.js';
import { ProcessError, isCancelled } from '../util/errors.js';
import type { Logger } from '../util/logger.js';
import type { AnalysisFrame, SceneChange } from '../types.js';

export interface ChunkPlan {
  index: number;
  start: number;
  end: number;
}

/** Split [0, duration) into chunks of `chunkSeconds`, aligned to the frame interval. */
export function planChunks(duration: number, chunkSeconds: number, interval: number): ChunkPlan[] {
  const aligned = Math.max(interval, Math.round(chunkSeconds / interval) * interval);
  const chunks: ChunkPlan[] = [];
  for (let s = 0, i = 0; s < duration - 1e-6; s += aligned, i++) {
    chunks.push({ index: i, start: s, end: Math.min(duration, s + aligned) });
  }
  return chunks;
}

/** Parse the output of `metadata=print` after `scdet` into scene changes + activity samples. */
export function parseSceneMetadata(text: string, offset: number): { changes: SceneChange[]; activity: Array<{ t: number; mafd: number }> } {
  const changes: SceneChange[] = [];
  const activity: Array<{ t: number; mafd: number }> = [];
  let t = 0;
  let score = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('frame:')) {
      const m = /pts_time:([\d.\-e]+)/.exec(line);
      t = m ? Number(m[1]) + offset : t;
      score = 0;
    } else if (line.startsWith('lavfi.scd.mafd=')) {
      activity.push({ t, mafd: Number(line.slice(15)) || 0 });
    } else if (line.startsWith('lavfi.scd.score=')) {
      score = Number(line.slice(16)) || 0;
    } else if (line.startsWith('lavfi.scd.time=')) {
      changes.push({ t: Math.round(t * 1000) / 1000, score });
    }
  }
  return { changes, activity };
}

export interface ChunkResult {
  frames: AnalysisFrame[];
  changes: SceneChange[];
  /** Mean scdet MAFD (frame difference) per whole second, keyed by second index. */
  activity: Array<[number, number]>;
}

export interface ExtractOptions {
  tools: FfmpegTools;
  source: string;
  duration: number;
  /** Absolute dir for frames; frame files are written as <dir>/c###/f_######.jpg */
  framesDir: string;
  /** Used to make frame paths relative. */
  projectRoot: string;
  interval: number;
  width: number;
  chunkSeconds: number;
  concurrency: number;
  sceneThreshold: number;
  hardwareDecode: boolean;
  videoStreamIndex?: number;
  signal?: AbortSignal;
  logger?: Logger;
  onProgress?: (fraction: number) => void;
}

async function extractChunk(o: ExtractOptions, chunk: ChunkPlan, hw: boolean, onSeconds: (s: number) => void): Promise<ChunkResult> {
  const finalDir = path.join(o.framesDir, `c${String(chunk.index).padStart(3, '0')}`);
  const doneFile = path.join(finalDir, 'chunk.json');
  const cached = await readJsonOr<ChunkResult | null>(doneFile, null);
  if (cached) {
    onSeconds(chunk.end - chunk.start);
    return cached;
  }
  const work = `${finalDir}.partial`;
  await removePath(work);
  await ensureDir(work);

  const fps = 1 / o.interval;
  const vmap = o.videoStreamIndex !== undefined ? `0:${o.videoStreamIndex}` : '0:v:0';
  const graph =
    `[${vmap}]scale=${o.width}:-2:flags=bilinear,split=2[a][b];` +
    `[a]fps=${fps}:round=near[fa];` +
    `[b]fps=10,scale=160:-2,scdet=threshold=${o.sceneThreshold},metadata=print:file=scenes.txt[sc]`;
  const args = [
    ...(hw ? ['-hwaccel', 'videotoolbox'] : []),
    '-ss', fmtSec(chunk.start),
    // -t before -i limits the *input*, so every output (frames + scene branch) stops at the chunk end.
    '-t', fmtSec(chunk.end - chunk.start),
    '-i', o.source,
    '-filter_complex', graph,
    '-map', '[fa]', '-q:v', '4', '-start_number', '0', 'f_%06d.jpg',
    '-map', '[sc]', '-f', 'null', '-',
  ];
  // cwd = work dir so the metadata file path needs no filtergraph escaping.
  await runFfmpeg(o.tools, args, {
    cwd: work,
    signal: o.signal,
    timeoutMs: Math.max(10 * 60_000, (chunk.end - chunk.start) * 5_000),
    label: `ffmpeg frames chunk ${chunk.index}`,
    onProgress: onSeconds,
  });

  const files = (await fsp.readdir(work)).filter((f) => /^f_\d{6}\.jpg$/.test(f)).sort();
  const sceneText = await fsp.readFile(path.join(work, 'scenes.txt'), 'utf8').catch(() => '');
  await fsp.rm(path.join(work, 'scenes.txt'), { force: true });
  const parsed = parseSceneMetadata(sceneText, chunk.start);

  // Bucket activity per second.
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const a of parsed.activity) {
    const k = Math.floor(a.t);
    const b = buckets.get(k) ?? { sum: 0, n: 0 };
    b.sum += a.mafd;
    b.n++;
    buckets.set(k, b);
  }
  const activity: Array<[number, number]> = [...buckets.entries()].map(([k, b]) => [k, Math.round((b.sum / b.n) * 100) / 100]);

  await removePath(finalDir);
  await fsp.rename(work, finalDir);
  const frames: AnalysisFrame[] = files
    .map((f, k) => ({ t: Math.round((chunk.start + k * o.interval) * 1000) / 1000, file: path.relative(o.projectRoot, path.join(finalDir, f)) }))
    .filter((fr) => fr.t < chunk.end + 1e-6);
  const result: ChunkResult = { frames, changes: parsed.changes, activity };
  await writeJsonAtomic(doneFile, result);
  return result;
}

/**
 * Extract analysis frames + scene-change data for the whole video in
 * independently checkpointed chunks. Completed chunks are reused on resume.
 */
export async function extractAnalysisFrames(o: ExtractOptions): Promise<{ frames: AnalysisFrame[]; changes: SceneChange[]; activity: number[] }> {
  await ensureDir(o.framesDir);
  const chunks = planChunks(o.duration, o.chunkSeconds, o.interval);
  const progress = new Array<number>(chunks.length).fill(0);
  const report = () => o.onProgress?.(Math.min(1, progress.reduce((a, b) => a + b, 0) / o.duration));
  let hw = o.hardwareDecode && process.platform === 'darwin';

  const results = await mapLimit(chunks, o.concurrency, async (chunk) => {
    const onSeconds = (s: number) => {
      progress[chunk.index] = Math.min(chunk.end - chunk.start, s);
      report();
    };
    try {
      return await extractChunk(o, chunk, hw, onSeconds);
    } catch (err) {
      if (isCancelled(err) || !hw || !(err instanceof ProcessError)) throw err;
      o.logger?.warn('Hardware decode failed, retrying chunk with software decode', { chunk: chunk.index, err });
      hw = false;
      return extractChunk(o, chunk, false, onSeconds);
    }
  });

  const frames = results.flatMap((r) => r.frames).sort((a, b) => a.t - b.t);
  const changes = results.flatMap((r) => r.changes).sort((a, b) => a.t - b.t);
  const activity = new Array<number>(Math.ceil(o.duration)).fill(0);
  for (const r of results) for (const [k, v] of r.activity) if (k >= 0 && k < activity.length) activity[k] = v;
  return { frames, changes, activity };
}

/**
 * Extract frames for a specific window (pass-2 detailed inspection).
 * Returns frames with absolute timestamps. Idempotent via a done marker.
 */
export async function extractWindowFrames(o: {
  tools: FfmpegTools;
  source: string;
  start: number;
  end: number;
  fps: number;
  width: number;
  outDir: string;
  projectRoot: string;
  hardwareDecode: boolean;
  signal?: AbortSignal;
}): Promise<AnalysisFrame[]> {
  const doneFile = path.join(o.outDir, 'frames.json');
  const cached = await readJsonOr<AnalysisFrame[] | null>(doneFile, null);
  if (cached && (await Promise.all(cached.map((f) => exists(path.join(o.projectRoot, f.file))))).every(Boolean)) return cached;
  await removePath(o.outDir);
  await ensureDir(o.outDir);
  const run = (hw: boolean) =>
    runFfmpeg(
      o.tools,
      [
        ...(hw ? ['-hwaccel', 'videotoolbox'] : []),
        '-ss', fmtSec(o.start),
        '-t', fmtSec(o.end - o.start),
        '-i', o.source,
        '-map', '0:v:0',
        '-vf', `fps=${o.fps}:round=near,scale=${o.width}:-2`,
        '-q:v', '3',
        '-start_number', '0',
        path.join(o.outDir, 'd_%05d.jpg'),
      ],
      { signal: o.signal, timeoutMs: 10 * 60_000, label: 'ffmpeg detail frames' },
    );
  try {
    await run(o.hardwareDecode && process.platform === 'darwin');
  } catch (err) {
    if (isCancelled(err) || !o.hardwareDecode) throw err;
    await run(false);
  }
  const files = (await fsp.readdir(o.outDir)).filter((f) => /^d_\d{5}\.jpg$/.test(f)).sort();
  const frames = files.map((f, k) => ({
    t: Math.round((o.start + k / o.fps) * 1000) / 1000,
    file: path.relative(o.projectRoot, path.join(o.outDir, f)),
  }));
  await writeJsonAtomic(doneFile, frames);
  return frames;
}

/** Extract one frame at time t as JPEG (thumbnails). */
export async function extractSingleFrame(tools: FfmpegTools, source: string, t: number, outFile: string, width: number, signal?: AbortSignal): Promise<void> {
  await ensureDir(path.dirname(outFile));
  await runFfmpeg(tools, ['-ss', fmtSec(Math.max(0, t)), '-i', source, '-frames:v', '1', '-map', '0:v:0', '-vf', `scale=${width}:-2`, '-q:v', '3', outFile], {
    signal,
    timeoutMs: 60_000,
    label: 'ffmpeg thumbnail',
  });
}
