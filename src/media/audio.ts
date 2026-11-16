import { spawnStreaming } from '../util/process.js';
import type { AudioAnalysis, AudioEnvelope, AudioEvent } from '../types.js';
import type { FfmpegTools } from './ffmpeg.js';

const SILENCE_DB = -100;

function toDb(x: number): number {
  return x > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(x)) : SILENCE_DB;
}

/**
 * Incrementally computes RMS / peak / zero-crossing-rate per fixed window from
 * signed 16-bit little-endian mono PCM. Memory use is O(number of windows).
 */
export class EnvelopeAccumulator {
  readonly rmsDb: number[] = [];
  readonly peakDb: number[] = [];
  readonly zcr: number[] = [];
  private readonly windowSamples: number;
  private sumSq = 0;
  private peak = 0;
  private crossings = 0;
  private count = 0;
  private prev = 0;
  private carry: Buffer | null = null;

  constructor(readonly sampleRate: number, readonly windowSeconds: number) {
    this.windowSamples = Math.max(1, Math.round(sampleRate * windowSeconds));
  }

  push(chunk: Buffer): void {
    let buf = chunk;
    if (this.carry) {
      buf = Buffer.concat([this.carry, chunk]);
      this.carry = null;
    }
    const usable = buf.length - (buf.length % 2);
    for (let i = 0; i < usable; i += 2) {
      const s = buf.readInt16LE(i) / 32768;
      this.sumSq += s * s;
      const a = Math.abs(s);
      if (a > this.peak) this.peak = a;
      if ((s >= 0) !== (this.prev >= 0)) this.crossings++;
      this.prev = s;
      if (++this.count >= this.windowSamples) this.flush();
    }
    if (usable < buf.length) this.carry = buf.subarray(usable);
  }

  private flush(): void {
    if (this.count === 0) return;
    this.rmsDb.push(Math.round(toDb(Math.sqrt(this.sumSq / this.count)) * 10) / 10);
    this.peakDb.push(Math.round(toDb(this.peak) * 10) / 10);
    this.zcr.push(Math.round((this.crossings / this.count) * 1000) / 1000);
    this.sumSq = 0;
    this.peak = 0;
    this.crossings = 0;
    this.count = 0;
  }

  finish(): AudioEnvelope {
    // Keep a final partial window only if it's at least half full.
    if (this.count >= this.windowSamples / 2) this.flush();
    return { windowSeconds: this.windowSeconds, sampleRate: this.sampleRate, rmsDb: this.rmsDb, peakDb: this.peakDb, zcr: this.zcr };
  }
}

/** Stream the selected audio track as mono PCM through FFmpeg and compute the envelope. */
export async function computeAudioEnvelope(o: {
  tools: FfmpegTools;
  source: string;
  audioStreamIndex: number;
  windowSeconds: number;
  sampleRate?: number;
  duration: number;
  signal?: AbortSignal;
  onProgress?: (f: number) => void;
}): Promise<AudioEnvelope> {
  const sr = o.sampleRate ?? 8000;
  const acc = new EnvelopeAccumulator(sr, o.windowSeconds);
  const { child, done } = spawnStreaming(
    o.tools.ffmpeg,
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', o.source, '-map', `0:${o.audioStreamIndex}`, '-vn', '-ac', '1', '-ar', String(sr), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'],
    { signal: o.signal, label: 'ffmpeg audio envelope' },
  );
  let samples = 0;
  let lastReport = 0;
  child.stdout!.on('data', (c: Buffer) => {
    acc.push(c);
    samples += c.length / 2;
    const f = samples / sr / o.duration;
    if (f - lastReport > 0.01) {
      lastReport = f;
      o.onProgress?.(Math.min(1, f));
    }
  });
  await done;
  return acc.finish();
}

function median(values: number[]): number {
  if (!values.length) return SILENCE_DB;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Rolling median of `values` over ±radius windows (stride-sampled for speed). */
export function rollingMedian(values: number[], radius: number): number[] {
  const out = new Array<number>(values.length);
  const stride = Math.max(1, Math.floor(radius / 20));
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(values.length - 1, i + radius);
    const sample: number[] = [];
    for (let j = lo; j <= hi; j += stride) sample.push(values[j]!);
    out[i] = median(sample);
  }
  return out;
}

/**
 * Detect notable audio events. Audio is supporting evidence only: events are
 * later used to boost / snap AI-identified moments, never to pick clips alone.
 */
export function analyseEnvelope(env: AudioEnvelope, opts: { onsetDb: number; minAbsoluteDb?: number; backgroundSeconds?: number }): AudioAnalysis {
  const w = env.windowSeconds;
  const rms = env.rmsDb;
  const minAbs = opts.minAbsoluteDb ?? -45;
  const radius = Math.max(4, Math.round((opts.backgroundSeconds ?? 10) / w));
  const bg = rollingMedian(rms, radius);
  const events: AudioEvent[] = [];

  let i = 0;
  while (i < rms.length) {
    const delta = rms[i]! - bg[i]!;
    if (delta >= opts.onsetDb && rms[i]! >= minAbs) {
      let j = i;
      let peak = env.peakDb[i]!;
      let maxDelta = delta;
      let zSum = 0;
      while (j < rms.length && rms[j]! - bg[j]! >= opts.onsetDb / 2) {
        peak = Math.max(peak, env.peakDb[j]!);
        maxDelta = Math.max(maxDelta, rms[j]! - bg[j]!);
        zSum += env.zcr[j] ?? 0;
        j++;
      }
      const n = j - i;
      const zMean = zSum / n;
      const duration = n * w;
      const quietBefore = i >= 2 && rms[i - 1]! < bg[i]! + 3 && rms[i - 2]! < bg[i]! + 3;
      events.push({
        t: Math.round(i * w * 1000) / 1000,
        duration: Math.round(duration * 1000) / 1000,
        peakDb: peak,
        deltaDb: Math.round(maxDelta * 10) / 10,
        kind: duration >= 3 ? 'sustained_loud' : bg[i]! < -55 && quietBefore ? 'silence_break' : 'onset',
        character: zMean > 0.22 ? 'impulsive_noise' : zMean < 0.07 ? 'tonal' : 'mixed',
      });
      i = j;
    } else i++;
  }

  const audible = rms.filter((v) => v > SILENCE_DB);
  const meanLin = audible.reduce((a, v) => a + 10 ** (v / 10), 0) / Math.max(1, audible.length);
  const clipped = env.peakDb.filter((p) => p >= -0.1).length;
  return {
    meanDb: Math.round(toDb(Math.sqrt(meanLin)) * 10) / 10,
    medianDb: median(rms),
    maxPeakDb: env.peakDb.reduce((a, b) => Math.max(a, b), SILENCE_DB),
    events,
    clippingRatio: env.peakDb.length ? Math.round((clipped / env.peakDb.length) * 10000) / 10000 : 0,
  };
}

/** Audio evidence score (0-10) for a time range, based on detected events. */
export function audioScoreForRange(analysis: AudioAnalysis, start: number, end: number): number {
  let score = 0;
  for (const e of analysis.events) {
    if (e.t + e.duration < start || e.t > end) continue;
    const s = Math.min(10, e.deltaDb / 2.5) * (e.kind === 'sustained_loud' ? 0.8 : 1) * (e.character === 'impulsive_noise' ? 1.1 : 1);
    score = Math.max(score, s);
  }
  return Math.round(Math.min(10, score) * 10) / 10;
}

/** Compact textual summary of audio events in a range for the AI prompt. */
export function describeAudioForRange(analysis: AudioAnalysis, start: number, end: number, fmt: (t: number) => string, limit = 12): string {
  const ev = analysis.events
    .filter((e) => e.t + e.duration >= start && e.t <= end)
    .sort((a, b) => b.deltaDb - a.deltaDb)
    .slice(0, limit)
    .sort((a, b) => a.t - b.t);
  if (!ev.length) return 'No notable audio spikes in this range.';
  return ev
    .map((e) => `${fmt(e.t)} ${e.kind.replace('_', ' ')} +${e.deltaDb}dB over background (${e.duration.toFixed(1)}s, ${e.character.replace('_', ' ')})`)
    .join('\n');
}

/** Find the quietest moment within ±radius of t (for boundary snapping). */
export function quietestNear(env: AudioEnvelope, t: number, radius: number): number {
  const w = env.windowSeconds;
  const lo = Math.max(0, Math.floor((t - radius) / w));
  const hi = Math.min(env.rmsDb.length - 1, Math.ceil((t + radius) / w));
  if (hi < lo) return t;
  let best = Math.round(t / w);
  let bestVal = Infinity;
  for (let i = lo; i <= hi; i++) {
    // Prefer quiet windows, lightly penalise distance from the original point.
    const v = env.rmsDb[i]! + Math.abs(i * w - t) * 2;
    if (v < bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return Math.round(best * w * 1000) / 1000;
}
