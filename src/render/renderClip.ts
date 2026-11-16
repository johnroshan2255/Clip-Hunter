import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import type { Candidate, ClipFx, ClipValidation, FacecamRect, VideoMetadata } from '../types.js';
import { runFfmpeg, fmtSec, type FfmpegTools } from '../media/ffmpeg.js';
import { runProcess } from '../util/process.js';
import { ensureDir, removePath, exists } from '../util/fsx.js';
import { buildFilterGraph, parseLoudnorm, type Overlay, type TimelinePiece } from './filters.js';
import { buildCropPath, sampleMotion, type CropPath } from './smartCrop.js';
import { layoutBlocks, layoutKaraoke, renderBoxedTextPng, renderLayoutsPng, renderTextPng, type Layout } from './textOverlay.js';
import { validateClip } from './validate.js';
import { chooseEncoder, encoderArgs, markEncoderBroken, type VideoEncoder } from './encoder.js';
import { toSrt, transcribeSegment, whisperAvailable, type TranscriptSegment } from '../transcribe/whisper.js';
import { translateLines } from '../transcribe/translate.js';
import { buildSubtitleTracks, type SubtitleTrack } from '../transcribe/subtitles.js';
import { classicFrames, fxSummary, hookFor, karaokeFrames, mapFramesToOutput, outputTime, replayWindow, resolveFx, timelinePieces, toVideoFx, voiceWindows, type CaptionFrame, type ResolvedFx } from '../fx/plan.js';
import { demucsAvailable, removeMusic } from '../fx/separate.js';
import type { SoundEffect } from '../fx/sfx.js';
import type { ClaudeCli } from '../ai/claudeCli.js';
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
  /** Claude CLI used to translate subtitles into other languages (optional). */
  claude?: ClaudeCli;
  /** Game name, gives the translator context. */
  game?: string;
  /** Sound effects available to this render. */
  sfxLibrary?: SoundEffect[];
  /** Webcam overlay of the recording (facecam layout). */
  facecam?: FacecamRect | null;
  /**
   * Returns the effects plan for this clip, given its transcript (clip-relative).
   * Used to let the AI plan effects with knowledge of the dialogue. Defaults to candidate.fx.
   */
  planFx?: (transcript: TranscriptSegment[]) => Promise<ClipFx | undefined>;
}

export interface RenderClipResult {
  validation: ClipValidation;
  compositionUsed: 'blur' | 'crop' | 'smart';
  cropPath?: CropPath;
  subtitles: boolean;
  spokenLanguage?: string;
  /** Absolute paths of exported .srt files. */
  subtitleFiles: Array<{ lang: string; file: string }>;
  /** Rendered reels (one per subtitle language in "separate" mode). Absolute paths. */
  variants: Array<{ lang: string | null; file: string; validation: ClipValidation }>;
  /** Absolute path of the main reel (first variant). */
  primaryFile: string;
  warnings: string[];
  renderMs: number;
  /** Effects plan used (may have been generated during this render). */
  fx?: ClipFx;
  fxSummary: string[];
  facecamUsed: boolean;
  encoder: VideoEncoder;
  outputSeconds: number;
  highlight: { start: number; end: number };
}

/** Deterministic key of everything that affects a clip's output. */
export function renderKey(cfg: AppConfig, start: number, end: number, sourceId: string, extra?: unknown): string {
  const { videoEncoder: _enc, ...render } = cfg.render;
  const relevant = { r: render, a: cfg.audio, t: cfg.text, fx: cfg.fx, start: start.toFixed(3), end: end.toFixed(3), sourceId, extra: extra ?? null };
  return crypto.createHash('sha1').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

async function measureLoudness(tools: FfmpegTools, input: string, stream: string, start: number, dur: number, target: number, signal?: AbortSignal) {
  try {
    const r = await runProcess(
      tools.ffmpeg,
      ['-hide_banner', '-nostdin', ...(start > 0 ? ['-ss', fmtSec(start)] : []), '-t', fmtSec(dur), '-i', input, '-map', stream, '-vn', '-af', `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, '-f', 'null', '-'],
      { signal, timeoutMs: 180_000, label: 'ffmpeg loudness measure' },
    );
    return parseLoudnorm(r.stderr);
  } catch (err) {
    if (isCancelled(err)) throw err;
    return undefined;
  }
}

/** ffconcat list for an image-sequence caption track (blank between captions). */
export function captionConcatList(frames: Array<{ start: number; end: number; file: string }>, blank: string, total: number): string {
  const lines = ['ffconcat version 1.0'];
  let t = 0;
  const push = (file: string, d: number) => {
    if (d <= 0.001) return;
    lines.push(`file '${file.replace(/'/g, "'\\''")}'`, `duration ${d.toFixed(3)}`);
  };
  for (const f of frames) {
    if (f.start > t) push(blank, f.start - t);
    const s = Math.max(t, f.start);
    push(f.file, f.end - s);
    t = Math.max(t, f.end);
  }
  push(blank, Math.max(0.05, total - t));
  // The last entry is repeated so its duration is honoured.
  lines.push(`file '${blank}'`);
  return `${lines.join('\n')}\n`;
}

/**
 * Render one vertical clip: compose video (blur / crop / smart crop / facecam),
 * add fun effects (instant replay, zooms, shakes, flashes, glitches, sound and
 * voice effects, hook title), subtitles, process audio, encode H.264/AAC MP4
 * with faststart, then validate. Outputs are written to temp files and only
 * moved into place after every reel validates.
 */
export async function renderClip(o: RenderClipInput): Promise<RenderClipResult> {
  const started = Date.now();
  const { cfg, metadata: md } = o;
  const R = cfg.render;
  const A = cfg.audio;
  const T = cfg.text;
  const FX = cfg.fx;
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
  const useFacecam = FX.enabled && FX.facecam !== 'off' && !!o.facecam;
  if (FX.enabled && FX.facecam === 'on' && !o.facecam) warnings.push('Facecam layout is on but no webcam position is set; using the normal layout');
  const camH = Math.round((R.height * FX.facecamHeight) / 2) * 2;
  const needsTracking = mode === 'smart';
  if (needsTracking) {
    const aiFocus = (o.candidate.focus ?? []).map((f) => ({ ...f, t: f.t - o.start }));
    let motion: Awaited<ReturnType<typeof sampleMotion>> = [];
    try {
      motion = await sampleMotion(o.tools, o.source, o.start, duration, o.signal);
    } catch (err) {
      if (isCancelled(err)) throw err;
      warnings.push('Motion analysis failed; using AI focus only');
    }
    cropPath = buildCropPath({ srcW, srcH, outW: R.width, outH: useFacecam ? R.height - camH : R.height, duration, aiFocus, motion, maxPanPerSecond: R.smartCropMaxPanPerSecond });
    if (cropPath.confidence < R.smartCropMinConfidence) {
      warnings.push(`Smart-crop tracking confidence ${cropPath.confidence} < ${R.smartCropMinConfidence}; fell back to ${useFacecam ? 'a centred crop' : 'blurred background'}`);
      mode = useFacecam ? 'crop' : 'blur';
      if (useFacecam) cropPath = undefined;
    }
  }

  // ── Subtitles: local whisper.cpp transcription + optional Claude translation (once per clip) ──
  let spokenLanguage: string | undefined;
  let subtitleTracks: SubtitleTrack[] = [];
  let transcriptSegs: TranscriptSegment[] = [];
  const wantTranscript = (T.subtitles || (FX.enabled && FX.auto)) && md.selectedAudioIndex !== null;
  if (wantTranscript) {
    const avail = await whisperAvailable({ executable: T.whisperExecutable, modelPath: T.whisperModelPath });
    if (!avail.ok) {
      if (T.subtitles) warnings.push(`Subtitles skipped: ${avail.reason}`);
    } else {
      try {
        const transcript = await transcribeSegment({
          tools: o.tools,
          whisper: { executable: T.whisperExecutable, modelPath: T.whisperModelPath, vadModelPath: T.whisperVadModelPath },
          source: o.source,
          audioStreamIndex: md.selectedAudioIndex!,
          start: o.start,
          duration,
          language: T.spokenLanguage,
          workDir: path.join(o.workDir, 'whisper'),
          signal: o.signal,
        });
        transcriptSegs = transcript.segments;
        if (T.subtitles) {
          const translate = o.claude
            ? (lines: string[], from: string, to: string) => translateLines(o.claude!, lines, from, to, { hindiScript: T.hindiScript, game: o.game, signal: o.signal })
            : null;
          const res = await buildSubtitleTracks(transcript, T.subtitleLanguages, translate);
          warnings.push(...res.warnings);
          spokenLanguage = res.spokenLanguage;
          subtitleTracks = res.tracks;
          if (!transcript.segments.length) warnings.push('No speech detected; one reel without subtitles');
        }
      } catch (err) {
        if (isCancelled(err)) throw err;
        warnings.push(`Transcription failed: ${(err as Error).message.slice(0, 120)}`);
      }
    }
  }

  // ── Fun effects plan ──
  let fx: ClipFx | undefined = o.candidate.fx;
  if (FX.enabled && o.planFx) {
    try {
      fx = (await o.planFx(transcriptSegs)) ?? fx;
    } catch (err) {
      if (isCancelled(err)) throw err;
      warnings.push(`Effects planning failed: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  const sounds = new Map((o.sfxLibrary ?? []).map((s) => [s.name, s]));
  const resolved: ResolvedFx = resolveFx(fx, o.start, o.end, FX);
  resolved.events = resolved.events.filter((e) => {
    if (e.type !== 'sfx' || sounds.has(e.sound!)) return true;
    warnings.push(`Sound effect "${e.sound}" not found; skipped`);
    return false;
  });
  const replay = resolved.replay;
  const rWin = replayWindow(replay);
  const summary = fxSummary(resolved);
  if (useFacecam) summary.unshift('facecam layout');

  // ── Audio source (optionally with music removed by Demucs) ──
  const inputs: string[] = [];
  let nextInput = 0;
  const addInput = (...args: string[]) => {
    inputs.push(...args);
    return nextInput++;
  };
  let processedAudio: string | null = null;
  if (A.musicRemoval !== 'off' && A.keepOriginal && md.selectedAudioIndex !== null) {
    const av = await demucsAvailable(A.demucsExecutable);
    if (!av.ok) warnings.push(`Music removal skipped: ${av.reason}`);
    else {
      try {
        processedAudio = await removeMusic({ tools: o.tools, demucs: A.demucsExecutable, source: o.source, audioStreamIndex: md.selectedAudioIndex, start: o.start, duration, mode: A.musicRemoval, workDir: o.workDir, signal: o.signal });
        summary.push(A.musicRemoval === 'voices' ? 'music removed (voices only)' : 'music reduced');
      } catch (err) {
        if (isCancelled(err)) throw err;
        warnings.push(`Music removal failed: ${(err as Error).message.slice(0, 120)}`);
      }
    }
  }
  const keepAudio = A.keepOriginal && md.selectedAudioIndex !== null;

  // ── Timeline inputs (one input per piece when a replay is inserted) ──
  let gameAudio: string | null = null;
  let pieces: TimelinePiece[] | undefined;
  if (replay) {
    pieces = timelinePieces(duration, replay).map((p) => {
      const idx = addInput('-ss', fmtSec(o.start + p.offset), '-t', fmtSec(p.seconds), '-i', o.source);
      let audio: string | null = null;
      if (keepAudio) {
        if (processedAudio) audio = `${addInput('-ss', fmtSec(p.offset), '-t', fmtSec(p.seconds), '-i', processedAudio)}:a:0`;
        else audio = `${idx}:${md.selectedAudioIndex}`;
      }
      return { inputIndex: idx, audio, offset: p.offset, seconds: p.seconds, speed: p.speed, replay: p.replay };
    });
  } else {
    addInput('-ss', fmtSec(o.start), '-t', fmtSec(duration), '-i', o.source);
    if (keepAudio) gameAudio = processedAudio ? `${addInput('-i', processedAudio)}:a:0` : `0:${md.selectedAudioIndex}`;
  }
  const outputSeconds = Math.round((replay ? duration + (replay.end - replay.start) / replay.speed : duration) * 1000) / 1000;
  const at = (rel: number) => outputTime(rel, replay);

  let music: string | null = null;
  if (A.backgroundMusicPath) {
    if (await exists(A.backgroundMusicPath)) music = `${addInput('-stream_loop', '-1', '-i', A.backgroundMusicPath)}:a:0`;
    else warnings.push(`Background music not found: ${path.basename(A.backgroundMusicPath)}`);
  }

  // ── Sound effects ──
  const sfx: Array<{ inputIndex: number; at: number; volume: number }> = [];
  const sfxEvents = resolved.events.filter((e) => e.type === 'sfx').map((e) => ({ sound: e.sound!, at: at(e.rel), strength: e.strength ?? 0.6 }));
  if (rWin && FX.sfx && sounds.has('whoosh') && !sfxEvents.some((s) => Math.abs(s.at - rWin.start) < 0.6)) sfxEvents.push({ sound: 'whoosh', at: Math.max(0, rWin.start - 0.25), strength: 0.6 });
  for (const s of sfxEvents) {
    const lib = sounds.get(s.sound)!;
    sfx.push({ inputIndex: addInput('-i', lib.file), at: s.at, volume: FX.sfxVolume * (0.6 + 0.6 * s.strength) });
  }

  // ── Text overlays shared by every reel (PNG, no freetype dependency) ──
  const overlays: Overlay[] = [];
  const addText = async (text: string, start: number, end: number, style: typeof T.style, name: string) => {
    const png = path.join(o.workDir, `${name}.png`);
    const { height } = await renderTextPng(text, style, R.width, png);
    const y = Math.max(0, Math.min(R.height - height, style.positionY * R.height - height / 2));
    overlays.push({ inputIndex: addInput('-i', png), start, end, y });
  };
  if (T.introText.trim()) await addText(T.introText, 0, Math.min(outputSeconds, T.introSeconds), T.style, 'intro');
  if (T.aiCaptions && o.candidate.title.trim() && !resolved.hook) await addText(o.candidate.title, T.introText.trim() ? T.introSeconds : 0, Math.min(outputSeconds, (T.introText.trim() ? T.introSeconds : 0) + 3), T.style, 'caption');
  if (T.endingText.trim()) await addText(T.endingText, Math.max(0, outputSeconds - T.endingSeconds), outputSeconds, T.style, 'ending');
  if (rWin) {
    const png = path.join(o.workDir, 'replay-badge.png');
    const { height } = await renderBoxedTextPng(`REPLAY  ${replay!.speed}x`, { fontSize: 44, color: '#FFFFFF', box: '#E8173C', fontFamily: T.style.fontFamily, maxLines: 1 }, R.width, png);
    overlays.push({ inputIndex: addInput('-i', png), start: rWin.start, end: rWin.end, y: Math.max(0, Math.round(R.height * 0.05 - height * 0.1)) });
  }

  // ── Loudness (two-pass, measured once) ──
  const loudness =
    keepAudio && A.normalize
      ? processedAudio
        ? await measureLoudness(o.tools, processedAudio, '0:a:0', 0, duration, A.targetLufs, o.signal)
        : await measureLoudness(o.tools, o.source, `0:${md.selectedAudioIndex}`, o.start, duration, A.targetLufs, o.signal)
      : undefined;

  // ── Encoder (GPU when available, CPU fallback) ──
  let encoder = await chooseEncoder(o.tools, R.videoEncoder);

  // ── Variants: one reel per subtitle language ("separate"), or one reel with all languages stacked ──
  const plans = planVariants(subtitleTracks, T.subtitleMode);
  const secondary = { ...T.subtitleStyle, fontSize: Math.round(T.subtitleStyle.fontSize * 0.82), color: '#FFE34D' };
  const captionTrack = async (tracks: SubtitleTrack[], tag: string): Promise<{ args: string[]; y: number } | null> => {
    if (!tracks.length) return null;
    const dir = path.join(o.workDir, `captions-${tag}`);
    await ensureDir(dir);
    const segs = tracks[0]!.segments;
    type F = CaptionFrame & { blocks?: Array<{ text: string; style: typeof T.subtitleStyle }> };
    let frames: F[];
    if (tracks.length > 1) {
      frames = segs.map((s, i) => ({
        start: s.start,
        end: Math.max(s.end, s.start + 0.8),
        words: [],
        active: -1,
        blocks: tracks.map((tr, k) => ({ text: tr.segments[i]?.text ?? '', style: k === 0 ? T.subtitleStyle : secondary })).filter((b) => b.text.trim()),
      }));
    } else frames = T.captionStyle === 'karaoke' ? karaokeFrames(segs) : classicFrames(segs);
    const mapped = mapFramesToOutput(frames, replay, duration);
    if (!mapped.length) return null;
    // Render unique frames once.
    const keyOf = (f: F) => JSON.stringify([f.words, f.active, f.blocks?.map((b) => b.text)]);
    const unique = new Map<string, { file: string; f: F }>();
    for (const f of mapped) if (!unique.has(keyOf(f))) unique.set(keyOf(f), { file: `c${unique.size}.png`, f });
    const layouts: Array<{ file: string; layout: Layout | null }> = [...unique.values()].map(({ file, f }) => ({
      file: path.join(dir, file),
      layout: f.blocks ? layoutBlocks(f.blocks, R.width) : f.active >= 0 ? layoutKaraoke(f.words, f.active, T.subtitleStyle, T.highlightColor, R.width) : layoutBlocks([{ text: f.words.join(' '), style: T.subtitleStyle }], R.width),
    }));
    layouts.push({ file: path.join(dir, 'blank.png'), layout: null });
    const canvasH = await renderLayoutsPng(layouts, R.width);
    const list = captionConcatList(mapped.map((f) => ({ start: f.start, end: f.end, file: unique.get(keyOf(f))!.file })), 'blank.png', outputSeconds);
    const listFile = path.join(dir, 'captions.ffconcat');
    await fsp.writeFile(listFile, list);
    const y = Math.max(0, Math.min(R.height - canvasH, T.subtitleStyle.positionY * R.height - canvasH / 2));
    return { args: ['-f', 'concat', '-safe', '0', '-i', listFile], y };
  };

  const stem = o.outFile.replace(/\.mp4$/, '');
  const dir = path.dirname(o.outFile);
  const rendered: Array<{ lang: string | null; tmp: string; final: string; validation: ClipValidation }> = [];
  const cleanupTmps = async () => Promise.all(rendered.map((r) => fsp.rm(r.tmp, { force: true })));
  const videoFx = toVideoFx(resolved);
  const voice = voiceWindows(resolved);
  for (const [k, plan] of plans.entries()) {
    const tag = plan.lang ?? 'none';
    const extraInputs: string[] = [];
    let extraIdx = nextInput;
    const cap = await captionTrack(plan.tracks, tag);
    let capInput: { inputIndex: number; y: number } | undefined;
    if (cap) {
      extraInputs.push(...cap.args);
      capInput = { inputIndex: extraIdx++, y: cap.y };
    }
    const variantOverlays = [...overlays];
    const hook = hookFor(resolved.hook, plan.lang);
    if (hook) {
      const png = path.join(o.workDir, `hook-${tag}.png`);
      const { height } = await renderBoxedTextPng(hook, { fontSize: 66, color: '#111111', box: '#FFE34D', fontFamily: T.style.fontFamily, maxLines: 3, rotate: -2 }, R.width, png);
      extraInputs.push('-i', png);
      const y = useFacecam ? camH - height / 2 : R.height * 0.17 - height / 2;
      variantOverlays.push({ inputIndex: extraIdx++, start: 0, end: Math.min(outputSeconds, FX.hookSeconds), y: Math.max(0, Math.round(y)), slideIn: true });
    }
    const fg = buildFilterGraph({
      srcW,
      srcH,
      duration,
      render: R,
      mode,
      cropPath: useFacecam ? undefined : cropPath,
      facecam: useFacecam ? { rect: o.facecam!, heightFraction: FX.facecamHeight, cropPath: mode === 'smart' ? cropPath : undefined } : undefined,
      overlays: variantOverlays,
      gameAudio,
      music,
      audio: A,
      loudness,
      pieces,
      replayStyle: { smoothing: FX.replaySmoothing, sourceFps: md.video.avgFps || R.fps },
      fx: videoFx,
      captionTrack: capInput,
      sfx,
      voice,
    });
    await fsp.writeFile(path.join(o.workDir, `filtergraph-${tag}.txt`), fg.graph);
    const final = plan.lang && T.subtitleMode === 'separate' ? `${stem}-${plan.lang}.mp4` : o.outFile;
    const tmp = path.join(dir, `.${path.basename(final, '.mp4')}.tmp.mp4`);
    const argsFor = (enc: VideoEncoder) => [
      ...inputs,
      ...extraInputs,
      '-filter_complex', fg.graph,
      '-map', `[${fg.videoOut}]`,
      ...(fg.audioOut ? ['-map', `[${fg.audioOut}]`] : ['-an']),
      ...encoderArgs(enc, R),
      '-r', String(R.fps),
      ...(fg.audioOut ? ['-c:a', 'aac', '-b:a', `${A.bitrateKbps}k`, '-ar', '48000'] : []),
      '-t', fmtSec(outputSeconds),
      '-movflags', '+faststart',
      '-max_muxing_queue_size', '4096',
      '-f', 'mp4',
      tmp,
    ];
    const run = (enc: VideoEncoder) =>
      runFfmpeg(o.tools, argsFor(enc), {
        signal: o.signal,
        timeoutMs: Math.max(5 * 60_000, outputSeconds * (FX.replaySmoothing === 'motion' ? 90_000 : 30_000)),
        label: `ffmpeg render${plan.lang ? ` (${plan.lang})` : ''} [${enc}]`,
        onProgress: (sec) => o.onProgress?.(Math.min(0.97, (k + sec / outputSeconds) / plans.length)),
      });
    try {
      try {
        await run(encoder);
      } catch (err) {
        if (isCancelled(err) || encoder === 'libx264') throw err;
        // GPU encoder failed (driver, session limit…): fall back to the CPU for this and later clips.
        o.logger.warn('Hardware encoder failed; retrying with libx264', { encoder, err });
        warnings.push(`${encoder} failed; encoded on the CPU instead`);
        markEncoderBroken(o.tools, encoder);
        encoder = 'libx264';
        await run(encoder);
      }
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      await cleanupTmps();
      throw err;
    }
    const validation = await validateClip(
      o.tools,
      tmp,
      { durationSeconds: outputSeconds, width: R.width, height: R.height, fps: R.fps, expectAudio: fg.audioOut !== null, durationTolerance: R.durationToleranceSeconds },
      o.signal,
    );
    rendered.push({ lang: plan.lang, tmp, final, validation });
    if (!validation.ok) {
      // A clip is only completed when every language reel validates.
      validation.warnings.push(...warnings);
      if (plan.lang) validation.errors.unshift(`${plan.lang} reel:`);
      await cleanupTmps();
      return {
        validation, compositionUsed: mode, cropPath, subtitles: false, spokenLanguage, subtitleFiles: [], variants: [], primaryFile: o.outFile, warnings, renderMs: Date.now() - started,
        fx, fxSummary: summary, facecamUsed: useFacecam, encoder, outputSeconds, highlight: { start: 0, end: Math.min(outputSeconds, 6) },
      };
    }
  }

  // All variants valid: replace this clip's previous outputs (any language / layout) atomically per file.
  const base = path.basename(stem);
  for (const old of await fsp.readdir(dir).catch(() => [] as string[])) {
    const isOurs = old === `${base}.mp4` || (old.startsWith(`${base}-`) && old.endsWith('.mp4')) || (old.startsWith(`${base}.`) && (old.endsWith('.srt') || old.endsWith('.gif')));
    if (isOurs && !rendered.some((r) => path.basename(r.final) === old)) await fsp.rm(path.join(dir, old), { force: true });
  }
  for (const r of rendered) await fsp.rename(r.tmp, r.final);
  const primary = rendered[0]!;
  const validation = primary.validation;
  validation.warnings.push(...warnings);

  // Caption files (clip-001.hi.srt, clip-001.en.srt) on the output timeline.
  const subtitleFiles: Array<{ lang: string; file: string }> = [];
  if (T.exportSrt) {
    for (const tr of subtitleTracks) {
      const file = `${stem}.${tr.lang}.srt`;
      await fsp.writeFile(file, toSrt(mapFramesToOutput(tr.segments, replay, duration)));
      subtitleFiles.push({ lang: tr.lang, file });
    }
  }

  // Highlight window (GIF export / thumbnail): the replay, else around the peak.
  const peakRel = Math.min(duration - 0.1, Math.max(0, (o.candidate.peakTime ?? o.start + duration / 2) - o.start));
  const peakOut = at(peakRel);
  const highlight = rWin
    ? { start: Math.max(0, rWin.start - 0.5), end: Math.min(outputSeconds, rWin.end) }
    : { start: Math.max(0, Math.min(outputSeconds - 6, peakOut - 3)), end: Math.min(outputSeconds, Math.max(0, peakOut - 3) + 6) };

  try {
    await ensureDir(path.dirname(o.thumbnailFile));
    await runFfmpeg(o.tools, ['-ss', fmtSec(Math.min(outputSeconds - 0.1, peakOut)), '-i', primary.final, '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '3', o.thumbnailFile], {
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
  return {
    validation,
    compositionUsed: mode,
    cropPath,
    subtitles: subtitleTracks.length > 0,
    spokenLanguage,
    subtitleFiles,
    variants: rendered.map((r) => ({ lang: r.lang, file: r.final, validation: r.validation })),
    primaryFile: primary.final,
    warnings,
    renderMs: Date.now() - started,
    fx,
    fxSummary: summary,
    facecamUsed: useFacecam,
    encoder,
    outputSeconds,
    highlight: { start: Math.round(highlight.start * 100) / 100, end: Math.round(highlight.end * 100) / 100 },
  };
}

/**
 * Which reels to render for a clip.
 * - no subtitle tracks (no speech / subtitles off) → one reel without subtitles
 * - "separate" → one reel per language, each with only that language
 * - "stacked"  → one reel with all languages stacked
 */
export function planVariants(tracks: SubtitleTrack[], mode: 'separate' | 'stacked'): Array<{ lang: string | null; tracks: SubtitleTrack[] }> {
  if (!tracks.length) return [{ lang: null, tracks: [] }];
  if (mode === 'stacked') return [{ lang: tracks.map((t) => t.lang).join('+'), tracks }];
  return tracks.map((t) => ({ lang: t.lang, tracks: [t] }));
}
