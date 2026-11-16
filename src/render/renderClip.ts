import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import type { Candidate, ClipValidation, VideoMetadata } from '../types.js';
import { runFfmpeg, fmtSec, type FfmpegTools } from '../media/ffmpeg.js';
import { runProcess } from '../util/process.js';
import { ensureDir, removePath, exists } from '../util/fsx.js';
import { buildFilterGraph, parseLoudnorm, type Overlay } from './filters.js';
import { buildCropPath, sampleMotion, type CropPath } from './smartCrop.js';
import { renderTextPng } from './textOverlay.js';
import { validateClip } from './validate.js';
import { transcribeSegment, whisperAvailable } from '../transcribe/whisper.js';
import { ValidationError, isCancelled } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export interface RenderClipInput {
  tools: FfmpegTools;
  cfg: AppConfig;
  metadata: VideoMetadata;
  source: string;
  candidate: Candidate;
  start: number;
  end: number;
  outFile: string;
  thumbnailFile: string;
  workDir: string;
  signal?: AbortSignal;
  logger: Logger;
  onProgress?: (fraction: number) => void;
}

export interface RenderClipResult {
  validation: ClipValidation;
  compositionUsed: 'blur' | 'crop' | 'smart';
  cropPath?: CropPath;
  subtitles: boolean;
  warnings: string[];
  renderMs: number;
}

/** Deterministic key of everything that affects a clip's output. */
export function renderKey(cfg: AppConfig, start: number, end: number, sourceId: string): string {
  const relevant = { r: cfg.render, a: cfg.audio, t: cfg.text, start: start.toFixed(3), end: end.toFixed(3), sourceId };
  return crypto.createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

async function measureLoudness(tools: FfmpegTools, source: string, stream: string, start: number, dur: number, target: number, signal?: AbortSignal) {
  try {
    const r = await runProcess(
      tools.ffmpeg,
      ['-hide_banner', '-nostdin', '-ss', fmtSec(start), '-t', fmtSec(dur), '-i', source, '-map', stream, '-vn', '-af', `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'],
      { signal, timeoutMs: 180_000, label: 'ffmpeg loudness measure' },
    );
    return parseLoudnorm(r.stderr);
  } catch (err) {
    if (isCancelled(err)) throw err;
    return undefined;
  }
}

/**
 * Render one vertical clip: compose video (blur / crop / smart crop), process
 * audio, add optional text, encode H.264/AAC MP4 with faststart, then validate.
 * The output is written to a temp file and only moved into place after
 * validation succeeds.
 */
export async function renderClip(o: RenderClipInput): Promise<RenderClipResult> {
  const started = Date.now();
  const { cfg, metadata: md } = o;
  const R = cfg.render;
  const A = cfg.audio;
  const T = cfg.text;
  const duration = Math.round((o.end - o.start) * 1000) / 1000;
  if (!(duration > 0.5)) throw new ValidationError(`Invalid clip range ${o.start}-${o.end}`);
  if (o.start < 0 || o.end > md.durationSeconds + 0.05) throw new ValidationError(`Clip range ${o.start}-${o.end} outside video duration ${md.durationSeconds}`);
  await removePath(o.workDir);
  await ensureDir(o.workDir);
  await ensureDir(path.dirname(o.outFile));
  const warnings: string[] = [];
  const srcW = md.video.displayWidth;
  const srcH = md.video.displayHeight;

  // ── Composition ──
  let mode: 'blur' | 'crop' | 'smart' = R.compositionMode;
  let cropPath: CropPath | undefined;
  if (mode === 'smart') {
    const aiFocus = (o.candidate.focus ?? []).map((f) => ({ ...f, t: f.t - o.start }));
    let motion: Awaited<ReturnType<typeof sampleMotion>> = [];
    try {
      motion = await sampleMotion(o.tools, o.source, o.start, duration, o.signal);
    } catch (err) {
      if (isCancelled(err)) throw err;
      warnings.push('Motion analysis failed; using AI focus only');
    }
    cropPath = buildCropPath({ srcW, srcH, outW: R.width, outH: R.height, duration, aiFocus, motion, maxPanPerSecond: R.smartCropMaxPanPerSecond });
    if (cropPath.confidence < R.smartCropMinConfidence) {
      warnings.push(`Smart-crop tracking confidence ${cropPath.confidence} < ${R.smartCropMinConfidence}; fell back to blurred background`);
      mode = 'blur';
    }
  }

  // ── Inputs ──
  const inputs: string[] = ['-ss', fmtSec(o.start), '-t', fmtSec(duration), '-i', o.source];
  let nextInput = 1;
  let music: string | null = null;
  if (A.backgroundMusicPath) {
    if (await exists(A.backgroundMusicPath)) {
      inputs.push('-stream_loop', '-1', '-i', A.backgroundMusicPath);
      music = `${nextInput}:a:0`;
      nextInput++;
    } else warnings.push(`Background music not found: ${path.basename(A.backgroundMusicPath)}`);
  }
  const gameAudio = A.keepOriginal && md.selectedAudioIndex !== null ? `0:${md.selectedAudioIndex}` : null;

  // ── Text overlays (PNG, no freetype dependency) ──
  const overlays: Overlay[] = [];
  const addText = async (text: string, start: number, end: number, style: typeof T.style, name: string) => {
    const png = path.join(o.workDir, `${name}.png`);
    const { height } = await renderTextPng(text, style, R.width, png);
    inputs.push('-i', png);
    const y = Math.max(0, Math.min(R.height - height, style.positionY * R.height - height / 2));
    overlays.push({ inputIndex: nextInput++, start, end, y });
  };
  if (T.introText.trim()) await addText(T.introText, 0, Math.min(duration, T.introSeconds), T.style, 'intro');
  if (T.aiCaptions && o.candidate.title.trim()) await addText(o.candidate.title, T.introText.trim() ? T.introSeconds : 0, Math.min(duration, (T.introText.trim() ? T.introSeconds : 0) + 3), T.style, 'caption');
  if (T.endingText.trim()) await addText(T.endingText, Math.max(0, duration - T.endingSeconds), duration, T.style, 'ending');

  let subtitles = false;
  if (T.subtitles && md.selectedAudioIndex !== null) {
    const avail = await whisperAvailable({ executable: T.whisperExecutable, modelPath: T.whisperModelPath });
    if (!avail.ok) warnings.push(`Subtitles skipped: ${avail.reason}`);
    else {
      try {
        const segs = await transcribeSegment({
          tools: o.tools,
          whisper: { executable: T.whisperExecutable, modelPath: T.whisperModelPath },
          source: o.source,
          audioStreamIndex: md.selectedAudioIndex,
          start: o.start,
          duration,
          workDir: path.join(o.workDir, 'whisper'),
          signal: o.signal,
        });
        for (const [i, s] of segs.slice(0, 40).entries()) await addText(s.text, s.start, Math.min(duration, s.end), T.subtitleStyle, `sub${i}`);
        subtitles = segs.length > 0;
        if (!segs.length) warnings.push('No speech detected; no subtitles added');
      } catch (err) {
        if (isCancelled(err)) throw err;
        warnings.push(`Transcription failed: ${(err as Error).message.slice(0, 120)}`);
      }
    }
  }

  // ── Loudness (two-pass) ──
  const loudness = gameAudio && A.normalize ? await measureLoudness(o.tools, o.source, gameAudio, o.start, duration, A.targetLufs, o.signal) : undefined;

  const fg = buildFilterGraph({ srcW, srcH, duration, render: R, mode, cropPath, overlays, gameAudio, music, audio: A, loudness });
  await fsp.writeFile(path.join(o.workDir, 'filtergraph.txt'), fg.graph);

  const tmpOut = path.join(path.dirname(o.outFile), `.${path.basename(o.outFile, '.mp4')}.tmp.mp4`);
  const args = [
    ...inputs,
    '-filter_complex', fg.graph,
    '-map', `[${fg.videoOut}]`,
    ...(fg.audioOut ? ['-map', `[${fg.audioOut}]`] : ['-an']),
    '-c:v', 'libx264',
    '-preset', R.preset,
    '-crf', String(R.crf),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-r', String(R.fps),
    ...(R.threadsPerJob > 0 ? ['-threads', String(R.threadsPerJob)] : []),
    ...(fg.audioOut ? ['-c:a', 'aac', '-b:a', `${A.bitrateKbps}k`, '-ar', '48000'] : []),
    '-t', fmtSec(duration),
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '2048',
    '-f', 'mp4',
    tmpOut,
  ];
  try {
    await runFfmpeg(o.tools, args, {
      signal: o.signal,
      timeoutMs: Math.max(5 * 60_000, duration * 30_000),
      label: 'ffmpeg render',
      onProgress: (s) => o.onProgress?.(Math.min(0.97, s / duration)),
    });
  } catch (err) {
    await fsp.rm(tmpOut, { force: true });
    throw err;
  }

  const validation = await validateClip(
    o.tools,
    tmpOut,
    { durationSeconds: duration, width: R.width, height: R.height, fps: R.fps, expectAudio: fg.audioOut !== null, durationTolerance: R.durationToleranceSeconds },
    o.signal,
  );
  validation.warnings.push(...warnings);
  if (!validation.ok) {
    await fsp.rm(tmpOut, { force: true });
    return { validation, compositionUsed: mode, cropPath, subtitles, warnings, renderMs: Date.now() - started };
  }
  await fsp.rename(tmpOut, o.outFile);

  // Thumbnail from the rendered vertical clip at the peak moment.
  const peakRel = Math.min(duration - 0.1, Math.max(0, (o.candidate.peakTime ?? o.start + duration / 2) - o.start));
  try {
    await ensureDir(path.dirname(o.thumbnailFile));
    await runFfmpeg(o.tools, ['-ss', fmtSec(peakRel), '-i', o.outFile, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '3', o.thumbnailFile], {
      signal: o.signal,
      timeoutMs: 60_000,
      label: 'ffmpeg thumbnail',
    });
  } catch (err) {
    if (isCancelled(err)) throw err;
    validation.warnings.push('Thumbnail generation failed');
  }
  o.onProgress?.(1);
  await removePath(o.workDir);
  return { validation, compositionUsed: mode, cropPath, subtitles, warnings, renderMs: Date.now() - started };
}
