import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { runFfmpeg, fmtSec, type FfmpegTools } from '../media/ffmpeg.js';
import { ffprobeJson } from '../media/probe.js';
import { ensureDir } from '../util/fsx.js';
import { ValidationError, isCancelled } from '../util/errors.js';
import { chooseEncoder, encoderArgs, markEncoderBroken } from './encoder.js';
import { validateClip } from './validate.js';
import type { ClipValidation } from '../types.js';

export const TRANSITIONS = ['fade', 'smoothleft', 'slideleft', 'wipeleft', 'circleopen', 'zoomin', 'dissolve', 'pixelize', 'radial', 'none'] as const;
export type Transition = (typeof TRANSITIONS)[number];

export type MontageItem =
  /** An already rendered vertical reel. */
  | { kind: 'reel'; file: string }
  /** A range of the source video (horizontal montage). */
  | { kind: 'source'; file: string; start: number; end: number; audioIndex: number | null };

async function probeMedia(tools: FfmpegTools, file: string): Promise<{ duration: number; hasAudio: boolean }> {
  const j = (await ffprobeJson(tools, file)) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
  return { duration: Number(j.format?.duration ?? 0), hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio') };
}

/** xfade offsets: each transition starts `d` seconds before the end of the accumulated video. */
export function xfadeOffsets(durations: number[], d: number): number[] {
  const offs: number[] = [];
  let acc = durations[0] ?? 0;
  for (let i = 1; i < durations.length; i++) {
    offs.push(Math.max(0, acc - d));
    acc += durations[i]! - d;
  }
  return offs;
}

/**
 * Join clips into one video with transitions (xfade + acrossfade). Vertical
 * montages reuse the rendered reels (effects and subtitles included);
 * horizontal ones are cut from the source at 1920×1080 for YouTube.
 */
export async function renderMontage(o: {
  tools: FfmpegTools;
  cfg: AppConfig;
  items: MontageItem[];
  orientation: 'vertical' | 'horizontal';
  transition: Transition;
  outFile: string;
  signal?: AbortSignal;
  onProgress?: (f: number) => void;
}): Promise<{ durationSeconds: number; sizeBytes: number; validation: ClipValidation }> {
  if (o.items.length < 2) throw new ValidationError('A montage needs at least 2 clips');
  if (o.items.length > 60) throw new ValidationError('A montage can have at most 60 clips');
  const R = o.cfg.render;
  const F = R.fps;
  const [W, H] = o.orientation === 'vertical' ? [R.width, R.height] : [1920, 1080];
  const inputs: string[] = [];
  const durations: number[] = [];
  const audio: boolean[] = [];
  for (const it of o.items) {
    if (it.kind === 'reel') {
      const m = await probeMedia(o.tools, it.file);
      inputs.push('-i', it.file);
      durations.push(m.duration);
      audio.push(m.hasAudio);
    } else {
      inputs.push('-ss', fmtSec(it.start), '-t', fmtSec(it.end - it.start), '-i', it.file);
      durations.push(it.end - it.start);
      audio.push(it.audioIndex !== null);
    }
  }
  const d = o.transition === 'none' ? 0 : Math.min(0.5, Math.min(...durations) / 4);
  const parts: string[] = [];
  o.items.forEach((it, i) => {
    const fit = it.kind === 'source' ? `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,` : `scale=${W}:${H},`;
    parts.push(`[${i}:v:0]${fit}setsar=1,fps=${F},format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
    const src = it.kind === 'source' && it.audioIndex !== null ? `${i}:${it.audioIndex}` : `${i}:a:0`;
    if (audio[i]) {
      const norm = it.kind === 'source' ? ',loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000' : '';
      parts.push(`[${src}]aresample=48000,aformat=channel_layouts=stereo${norm},asetpts=PTS-STARTPTS,atrim=duration=${durations[i]!.toFixed(3)}[a${i}]`);
    } else parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${durations[i]!.toFixed(3)}[a${i}]`);
  });
  let total: number;
  if (d === 0) {
    parts.push(`${o.items.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${o.items.length}:v=1:a=1[vout][aout]`);
    total = durations.reduce((a, b) => a + b, 0);
  } else {
    const offs = xfadeOffsets(durations, d);
    let lv = 'v0';
    let la = 'a0';
    for (let i = 1; i < o.items.length; i++) {
      const nv = i === o.items.length - 1 ? 'vout' : `xv${i}`;
      const na = i === o.items.length - 1 ? 'aout' : `xa${i}`;
      parts.push(`[${lv}][v${i}]xfade=transition=${o.transition}:duration=${d.toFixed(3)}:offset=${offs[i - 1]!.toFixed(3)}[${nv}]`);
      parts.push(`[${la}][a${i}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri[${na}]`);
      lv = nv;
      la = na;
    }
    total = durations.reduce((a, b) => a + b, 0) - d * (o.items.length - 1);
  }
  await ensureDir(path.dirname(o.outFile));
  const tmp = o.outFile.replace(/\.mp4$/, '.tmp.mp4');
  let enc = await chooseEncoder(o.tools, R.videoEncoder);
  const run = (e: typeof enc) =>
    runFfmpeg(
      o.tools,
      [...inputs, '-filter_complex', parts.join(';'), '-map', '[vout]', '-map', '[aout]', ...encoderArgs(e, R), '-r', String(F), '-c:a', 'aac', '-b:a', `${o.cfg.audio.bitrateKbps}k`, '-ar', '48000', '-movflags', '+faststart', '-max_muxing_queue_size', '4096', '-f', 'mp4', tmp],
      { signal: o.signal, timeoutMs: Math.max(10 * 60_000, total * 20_000), label: `ffmpeg montage [${e}]`, onProgress: (s) => o.onProgress?.(Math.min(0.97, s / total)) },
    );
  try {
    try {
      await run(enc);
    } catch (err) {
      if (isCancelled(err) || enc === 'libx264') throw err;
      markEncoderBroken(o.tools, enc);
      enc = 'libx264';
      await run(enc);
    }
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  const validation = await validateClip(o.tools, tmp, { durationSeconds: total, width: W, height: H, fps: F, expectAudio: true, durationTolerance: 0.6 + 0.05 * o.items.length }, o.signal);
  if (!validation.ok) {
    await fsp.rm(tmp, { force: true });
    throw new ValidationError(`Montage failed validation: ${validation.errors.join('; ')}`);
  }
  await fsp.rename(tmp, o.outFile);
  return { durationSeconds: validation.durationSeconds, sizeBytes: validation.sizeBytes, validation };
}
