import type { FocusPoint } from '../types.js';
import { spawnStreaming } from '../util/process.js';
import type { FfmpegTools } from '../media/ffmpeg.js';
import { fmtSec } from '../media/ffmpeg.js';
import { clamp } from '../util/time.js';

export interface CropKeyframe {
  /** Seconds relative to clip start. */
  t: number;
  /** Left edge of the crop window in source pixels. */
  x: number;
}

export interface CropPath {
  cropWidth: number;
  cropHeight: number;
  keyframes: CropKeyframe[];
  confidence: number;
  source: 'ai' | 'motion' | 'ai+motion' | 'center';
}

/** Even integer helper (yuv420p needs even dimensions). */
export function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Size of a crop window with the target aspect ratio inside a source frame. */
export function cropWindow(srcW: number, srcH: number, outW: number, outH: number): { w: number; h: number } {
  const target = outW / outH;
  if (srcW / srcH > target) return { w: Math.min(srcW, even(srcH * target)), h: srcH - (srcH % 2) };
  return { w: srcW - (srcW % 2), h: Math.min(srcH, even(srcW / target)) };
}

/**
 * Horizontal motion saliency: for each low-res frame, the column-wise mean
 * absolute difference from the previous frame minus the global mean (removes
 * uniform camera motion). Returns centre-of-mass x (0..1) and a peakiness
 * confidence per sample.
 */
export function motionCentroids(frames: Uint8Array[], width: number, height: number, fps: number): FocusPoint[] {
  const out: FocusPoint[] = [];
  for (let f = 1; f < frames.length; f++) {
    const a = frames[f - 1]!;
    const b = frames[f]!;
    const cols = new Float64Array(width);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) cols[x]! += Math.abs(b[row + x]! - a[row + x]!);
    }
    let mean = 0;
    for (let x = 0; x < width; x++) mean += cols[x]!;
    mean /= width;
    let wsum = 0;
    let xsum = 0;
    let maxv = 0;
    for (let x = 0; x < width; x++) {
      const v = Math.max(0, cols[x]! - mean);
      wsum += v;
      xsum += v * x;
      if (v > maxv) maxv = v;
    }
    if (wsum <= 0 || mean <= 0) continue;
    const cx = xsum / wsum / (width - 1);
    // Concentration: how much residual energy there is relative to the mean.
    const conf = clamp((maxv / (mean + 1e-6) - 0.5) / 3, 0, 1) * clamp(mean / 4, 0, 1);
    out.push({ t: f / fps, x: cx, confidence: Math.round(conf * 100) / 100 });
  }
  return out;
}

/** Read low-res grayscale frames of a clip segment from FFmpeg (streamed). */
export async function sampleMotion(tools: FfmpegTools, source: string, start: number, duration: number, signal?: AbortSignal): Promise<FocusPoint[]> {
  const W = 160;
  const H = 90;
  const fps = 4;
  const { child, done } = spawnStreaming(
    tools.ffmpeg,
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', fmtSec(start), '-t', fmtSec(duration), '-i', source, '-map', '0:v:0', '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', 'pipe:1'],
    { signal, label: 'ffmpeg motion sample' },
  );
  const frameSize = W * H;
  const frames: Uint8Array[] = [];
  let pending = Buffer.alloc(0);
  child.stdout!.on('data', (c: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, c]) : c;
    while (pending.length >= frameSize) {
      frames.push(new Uint8Array(pending.subarray(0, frameSize)));
      pending = pending.subarray(frameSize);
    }
  });
  await done;
  return motionCentroids(frames, W, H, fps);
}

/** Smooth focus samples onto a regular grid with a confidence-weighted moving average. */
function resample(points: FocusPoint[], duration: number, step: number, radius: number): Array<{ t: number; x: number; c: number }> {
  const out: Array<{ t: number; x: number; c: number }> = [];
  for (let t = 0; t <= duration + 1e-6; t += step) {
    let w = 0;
    let xs = 0;
    let cs = 0;
    let n = 0;
    for (const p of points) {
      const d = Math.abs(p.t - t);
      if (d > radius) continue;
      const k = (1 - d / radius) * Math.max(0.05, p.confidence);
      w += k;
      xs += k * p.x;
      cs += p.confidence;
      n++;
    }
    out.push(w > 0 ? { t, x: xs / w, c: cs / n } : { t, x: NaN, c: 0 });
  }
  // Fill gaps by carrying neighbours.
  let last = out.find((o) => !Number.isNaN(o.x))?.x ?? 0.5;
  for (const o of out) {
    if (Number.isNaN(o.x)) o.x = last;
    else last = o.x;
  }
  return out;
}

/**
 * Build a smoothed crop path. AI focus points (relative to clip start) are
 * primary; motion saliency fills in / corroborates. Pan speed is limited and
 * small movements are ignored (dead zone) to avoid jitter.
 */
export function buildCropPath(o: {
  srcW: number;
  srcH: number;
  outW: number;
  outH: number;
  duration: number;
  aiFocus: FocusPoint[];
  motion: FocusPoint[];
  maxPanPerSecond: number;
  step?: number;
}): CropPath {
  const { w: cw, h: ch } = cropWindow(o.srcW, o.srcH, o.outW, o.outH);
  const step = o.step ?? 0.5;
  const ai = o.aiFocus.filter((p) => p.t >= -1 && p.t <= o.duration + 1);
  const aiConf = ai.length ? ai.reduce((a, p) => a + p.confidence, 0) / ai.length : 0;
  const motionGood = o.motion.filter((m) => m.confidence >= 0.3);
  const motionConf = o.motion.length ? (motionGood.length / o.motion.length) * (motionGood.reduce((a, p) => a + p.confidence, 0) / Math.max(1, motionGood.length)) : 0;

  let points: FocusPoint[];
  let source: CropPath['source'];
  let confidence: number;
  if (ai.length >= 2 && aiConf >= 0.4) {
    // Use motion only where it agrees with the AI (within 0.25 of the interpolated AI x).
    const agree = motionGood.filter((m) => {
      const near = ai.reduce((best, p) => (Math.abs(p.t - m.t) < Math.abs(best.t - m.t) ? p : best), ai[0]!);
      return Math.abs(near.x - m.x) < 0.25;
    });
    points = [...ai.map((p) => ({ ...p, confidence: p.confidence * 1.5 })), ...agree.map((m) => ({ ...m, confidence: m.confidence * 0.5 }))];
    source = agree.length ? 'ai+motion' : 'ai';
    confidence = clamp(aiConf + (agree.length / Math.max(1, motionGood.length)) * 0.1, 0, 1);
  } else if (motionGood.length >= Math.max(3, o.motion.length * 0.5)) {
    points = motionGood;
    source = 'motion';
    confidence = motionConf;
  } else if (ai.length >= 1) {
    points = ai;
    source = 'ai';
    confidence = aiConf * 0.8;
  } else {
    points = [{ t: 0, x: 0.5, confidence: 0.1 }];
    source = 'center';
    confidence = 0;
  }

  const grid = resample(points, o.duration, step, Math.max(1.5, step * 3));
  const maxDelta = o.maxPanPerSecond * o.srcW * step;
  const deadZone = cw * 0.08;
  const keyframes: CropKeyframe[] = [];
  let x = clamp(grid[0]!.x * o.srcW - cw / 2, 0, o.srcW - cw);
  for (const g of grid) {
    const target = clamp(g.x * o.srcW - cw / 2, 0, o.srcW - cw);
    const diff = target - x;
    if (Math.abs(diff) > deadZone) x += clamp(diff - Math.sign(diff) * deadZone, -maxDelta, maxDelta);
    keyframes.push({ t: Math.round(g.t * 1000) / 1000, x: Math.round(x) });
  }
  // Drop redundant keyframes (collinear / unchanged).
  const reduced = keyframes.filter((k, i, arr) => i === 0 || i === arr.length - 1 || k.x !== arr[i - 1]!.x || k.x !== arr[i + 1]!.x);
  return { cropWidth: cw, cropHeight: ch, keyframes: reduced, confidence: Math.round(confidence * 100) / 100, source };
}

/** Piecewise-linear FFmpeg expression of x over t from keyframes. */
export function cropXExpression(keyframes: CropKeyframe[]): string {
  if (!keyframes.length) return '0';
  if (keyframes.length === 1) return String(keyframes[0]!.x);
  let expr = String(keyframes[keyframes.length - 1]!.x);
  for (let i = keyframes.length - 2; i >= 0; i--) {
    const a = keyframes[i]!;
    const b = keyframes[i + 1]!;
    const seg = a.x === b.x ? `${a.x}` : `${a.x}+(${b.x - a.x})*(t-${a.t.toFixed(3)})/${Math.max(0.001, b.t - a.t).toFixed(3)}`;
    expr = `if(lt(t,${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return expr;
}
