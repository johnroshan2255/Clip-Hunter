import crypto from 'node:crypto';
import type { FxConfig } from '../config/schema.js';
import type { ClipFx, FxEvent, FxEventType, VoiceEffect } from '../types.js';
import type { VideoFx } from '../render/filters.js';

/** Effects of one clip, validated and converted to clip-relative seconds. */
export interface ResolvedFx {
  replay: { start: number; end: number; speed: number } | null;
  events: Array<FxEvent & { rel: number }>;
  hook: Record<string, string> | null;
}

const DURATION_LIMITS: Record<FxEventType, [number, number]> = {
  zoom: [0.3, 3],
  shake: [0.2, 2],
  flash: [0, 0],
  glitch: [0.1, 1.5],
  sfx: [0, 0],
  voice: [0.5, 8],
};

export const MAX_EVENTS = 16;

/** Remove emoji / pictographs (the PNG text renderer cannot draw colour emoji). */
export function stripEmoji(s: string): string {
  return s
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍⃣]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanHook(s: string): string {
  const t = stripEmoji(s).replace(/^["'“”]+|["'“”]+$/g, '');
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
}

/** Validate an effects plan against the clip range and the enabled effect types. */
export function resolveFx(fx: ClipFx | undefined, clipStart: number, clipEnd: number, cfg: FxConfig): ResolvedFx {
  const none: ResolvedFx = { replay: null, events: [], hook: null };
  if (!cfg.enabled || !fx) return none;
  const dur = clipEnd - clipStart;
  let replay: ResolvedFx['replay'] = null;
  if (cfg.replay && fx.replay) {
    const end = Math.min(dur, Math.max(0, fx.replay.end - clipStart));
    let start = Math.max(0, fx.replay.start - clipStart);
    if (end - start > cfg.replayMaxSeconds) start = end - cfg.replayMaxSeconds;
    if (end - start >= 0.6) replay = { start: round3(start), end: round3(end), speed: cfg.replaySpeed };
  }
  const enabled: Record<FxEventType, boolean> = { zoom: cfg.zoom, shake: cfg.shake, flash: cfg.flash, glitch: cfg.glitch, sfx: cfg.sfx, voice: cfg.voice };
  const events: ResolvedFx['events'] = [];
  for (const e of [...(fx.events ?? [])].sort((a, b) => a.t - b.t)) {
    if (!enabled[e.type]) continue;
    const rel = e.t - clipStart;
    if (!(rel >= 0 && rel < dur - 0.05)) continue;
    const [lo, hi] = DURATION_LIMITS[e.type];
    const duration = round3(Math.min(hi, Math.max(lo, Number.isFinite(e.duration) ? e.duration : lo), dur - rel));
    if (e.type === 'sfx' && !e.sound) continue;
    if (e.type === 'voice') {
      if (!e.voice) continue;
      // Voice windows must not overlap.
      if (events.some((x) => x.type === 'voice' && rel < x.rel + x.duration)) continue;
    }
    events.push({ ...e, rel: round3(rel), duration, strength: Math.min(1, Math.max(0, e.strength ?? 0.6)) });
    if (events.length >= MAX_EVENTS) break;
  }
  let hook: ResolvedFx['hook'] = null;
  if (cfg.hookTitle && fx.hook) {
    const entries = Object.entries(fx.hook)
      .map(([k, v]) => [k, cleanHook(String(v ?? ''))] as const)
      .filter(([, v]) => v);
    if (entries.length) hook = Object.fromEntries(entries);
  }
  return { replay, events, hook };
}

/** Hook text for a reel language ("hi", "en", null = no subtitles). */
export function hookFor(hook: Record<string, string> | null, lang: string | null): string | null {
  if (!hook) return null;
  const first = lang?.split('+')[0];
  return (first && hook[first]) || hook.default || hook.en || Object.values(hook)[0] || null;
}

/** Map a clip-relative time to the output timeline (shifted by the replay inserted after replay.end). */
export function outputTime(rel: number, replay: ResolvedFx['replay']): number {
  if (!replay || rel <= replay.end) return rel;
  return rel + (replay.end - replay.start) / replay.speed;
}

/** Output-timeline window occupied by the replay. */
export function replayWindow(replay: ResolvedFx['replay']): { start: number; end: number } | null {
  if (!replay) return null;
  return { start: replay.end, end: replay.end + (replay.end - replay.start) / replay.speed };
}

/** Timeline pieces in clip-relative source time: before replay, the replay itself, after. */
export function timelinePieces(duration: number, replay: ResolvedFx['replay']): Array<{ offset: number; seconds: number; speed: number; replay?: boolean }> {
  if (!replay) return [{ offset: 0, seconds: duration, speed: 1 }];
  const pieces = [
    { offset: 0, seconds: replay.end, speed: 1 },
    { offset: replay.start, seconds: replay.end - replay.start, speed: replay.speed, replay: true },
  ];
  if (duration - replay.end > 0.05) pieces.push({ offset: replay.end, seconds: duration - replay.end, speed: 1 });
  return pieces;
}

/** Visual effects on the output timeline. */
export function toVideoFx(r: ResolvedFx): VideoFx {
  const at = (e: { rel: number }) => round3(outputTime(e.rel, r.replay));
  const pick = (t: FxEventType) => r.events.filter((e) => e.type === t);
  return {
    zooms: pick('zoom').map((e) => ({ t: at(e), duration: e.duration, strength: e.strength ?? 0.6 })),
    shakes: pick('shake').map((e) => ({ t: at(e), duration: e.duration, strength: e.strength ?? 0.6 })),
    flashes: pick('flash').map((e) => ({ t: at(e), strength: e.strength ?? 0.6 })),
    glitches: pick('glitch').map((e) => ({ t: at(e), duration: e.duration, strength: e.strength ?? 0.6 })),
  };
}

export function voiceWindows(r: ResolvedFx): Array<{ start: number; end: number; effect: VoiceEffect }> {
  return r.events
    .filter((e) => e.type === 'voice' && e.voice)
    .map((e) => {
      const start = outputTime(e.rel, r.replay);
      // A window that spans the replay keeps its source length on the output timeline.
      return { start: round3(start), end: round3(outputTime(e.rel + e.duration, r.replay)), effect: e.voice! };
    });
}

/** Short human summary, e.g. ["hook", "replay 2.5s @0.5x", "2× zoom", "sfx: boom, whoosh"]. */
export function fxSummary(r: ResolvedFx): string[] {
  const out: string[] = [];
  if (r.hook) out.push('hook title');
  if (r.replay) out.push(`replay ${(r.replay.end - r.replay.start).toFixed(1)}s @${r.replay.speed}x`);
  const counts = new Map<string, number>();
  for (const e of r.events) if (e.type !== 'sfx' && e.type !== 'voice') counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  for (const [k, n] of counts) out.push(n > 1 ? `${n}× ${k}` : k);
  const sounds = r.events.filter((e) => e.type === 'sfx').map((e) => e.sound);
  if (sounds.length) out.push(`sfx: ${[...new Set(sounds)].join(', ')}`);
  const voices = r.events.filter((e) => e.type === 'voice').map((e) => e.voice);
  if (voices.length) out.push(`voice: ${[...new Set(voices)].join(', ')}`);
  return out;
}

/**
 * Signature of the settings an automatic plan depends on: when it changes, the
 * AI re-plans clips whose effects were generated automatically.
 */
export function fxSignature(cfg: FxConfig, languages: string[]): string {
  const rel = { i: cfg.intensity, h: cfg.hookTitle, r: cfg.replay, z: cfg.zoom, s: cfg.shake, f: cfg.flash, g: cfg.glitch, x: cfg.sfx, v: cfg.voice, l: languages };
  return crypto.createHash('sha1').update(JSON.stringify(rel)).digest('hex').slice(0, 10);
}

/** Effect budget per clip for an intensity level. */
export function effectBudget(intensity: FxConfig['intensity']): { min: number; max: number } {
  return intensity === 'subtle' ? { min: 1, max: 3 } : intensity === 'crazy' ? { min: 6, max: 12 } : { min: 3, max: 6 };
}

// ── Captions ──

export interface CaptionFrame {
  start: number;
  end: number;
  /** Words shown together. */
  words: string[];
  /** Index of the highlighted (currently spoken) word, -1 = none. */
  active: number;
}

/**
 * Karaoke captions: each subtitle line is split into short chunks (≤ maxWords
 * words / maxChars characters) shown one at a time, with the word being spoken
 * highlighted. Word timing is distributed by word length within the line.
 */
export function karaokeFrames(segs: Array<{ start: number; end: number; text: string }>, maxWords = 3, maxChars = 20): CaptionFrame[] {
  const frames: CaptionFrame[] = [];
  for (const s of segs) {
    const words = s.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length || !(s.end > s.start)) continue;
    const weights = words.map((w) => w.length + 2);
    const total = weights.reduce((a, b) => a + b, 0);
    const span = s.end - s.start;
    let t = s.start;
    const times = words.map((_, i) => {
      const st = t;
      t += (weights[i]! / total) * span;
      return { start: st, end: t };
    });
    let i = 0;
    while (i < words.length) {
      const chunk: number[] = [i];
      let chars = words[i]!.length;
      while (chunk.length < maxWords && i + chunk.length < words.length && chars + 1 + words[i + chunk.length]!.length <= maxChars) {
        chars += 1 + words[i + chunk.length]!.length;
        chunk.push(i + chunk.length);
      }
      const chunkWords = chunk.map((k) => words[k]!);
      chunk.forEach((k, j) => frames.push({ start: round3(times[k]!.start), end: round3(times[k]!.end), words: chunkWords, active: j }));
      i += chunk.length;
    }
  }
  return frames;
}

/** Whole-line captions (one frame per segment, nothing highlighted). */
export function classicFrames(segs: Array<{ start: number; end: number; text: string }>): CaptionFrame[] {
  return segs.filter((s) => s.text.trim() && s.end > s.start).map((s) => ({ start: s.start, end: Math.max(s.end, s.start + 0.8), words: [s.text.trim()], active: -1 }));
}

/** Move caption frames onto the output timeline; nothing is shown during the replay. */
export function mapFramesToOutput<T extends { start: number; end: number }>(frames: T[], replay: ResolvedFx['replay'], clipDuration: number): T[] {
  const out: T[] = [];
  for (const f of frames) {
    const end = Math.min(f.end, clipDuration);
    if (end <= f.start) continue;
    if (!replay || end <= replay.end) out.push({ ...f, end });
    else if (f.start >= replay.end) out.push({ ...f, start: outputTime(f.start, replay), end: outputTime(end, replay) });
    else {
      out.push({ ...f, end: replay.end });
      out.push({ ...f, start: outputTime(replay.end + 0.001, replay), end: outputTime(end, replay) });
    }
  }
  // No overlaps: each frame ends where the next begins.
  out.sort((a, b) => a.start - b.start);
  for (let i = 0; i + 1 < out.length; i++) if (out[i]!.end > out[i + 1]!.start) out[i]!.end = out[i + 1]!.start;
  return out.filter((f) => f.end - f.start > 0.02).map((f) => ({ ...f, start: round3(f.start), end: round3(f.end) }));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
