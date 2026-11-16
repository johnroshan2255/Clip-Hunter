import type { AudioAnalysis, AudioEnvelope, Candidate, SceneChange } from '../types.js';
import type { ClipsConfig } from '../config/schema.js';
import { audioScoreForRange, quietestNear } from '../media/audio.js';
import { clamp, overlap, overlapRatio, round3 } from '../util/time.js';

export interface DiscoveryMoment {
  id: string;
  start: number;
  end: number;
  category: Candidate['category'];
  title: string;
  description: string;
  score: number;
  confidence: number;
  reason: string;
}

export interface InspectionWindow {
  id: string;
  start: number;
  end: number;
  members: DiscoveryMoment[];
  priority: number;
}

/**
 * Group pass-1 moments into pass-2 inspection windows: overlapping/adjacent
 * moments are merged, context is added on both sides, and over-long windows
 * are split.
 */
export function planInspectionWindows(
  moments: DiscoveryMoment[],
  o: { minScore: number; context: number; maxWindow: number; duration: number; maxWindows: number; mergeGap?: number },
): InspectionWindow[] {
  const eligible = moments.filter((m) => m.score >= o.minScore).sort((a, b) => a.start - b.start);
  const groups: DiscoveryMoment[][] = [];
  const gap = o.mergeGap ?? 4;
  for (const m of eligible) {
    const g = groups[groups.length - 1];
    const gEnd = g ? Math.max(...g.map((x) => x.end)) : -Infinity;
    const gStart = g ? Math.min(...g.map((x) => x.start)) : 0;
    if (g && m.start <= gEnd + gap && Math.max(gEnd, m.end) - gStart <= o.maxWindow - 2 * o.context) g.push(m);
    else groups.push([m]);
  }
  const windows: InspectionWindow[] = groups.map((g, i) => {
    const s = Math.min(...g.map((x) => x.start));
    const e = Math.max(...g.map((x) => x.end));
    let start = Math.max(0, s - o.context);
    let end = Math.min(o.duration, e + o.context);
    if (end - start > o.maxWindow) {
      // Centre on the best member.
      const best = [...g].sort((a, b) => b.score - a.score)[0]!;
      const c = (best.start + best.end) / 2;
      start = Math.max(0, c - o.maxWindow / 2);
      end = Math.min(o.duration, start + o.maxWindow);
    }
    const priority = Math.max(...g.map((x) => x.score + x.confidence));
    return { id: `w${String(i + 1).padStart(3, '0')}`, start: round3(start), end: round3(end), members: g, priority };
  });
  return windows
    .sort((a, b) => b.priority - a.priority)
    .slice(0, o.maxWindows)
    .sort((a, b) => a.start - b.start);
}

/** Visual evidence score 0-10: scene cuts and motion in the range. */
export function sceneScoreForRange(changes: SceneChange[], activity: number[], start: number, end: number): number {
  const cuts = changes.filter((c) => c.t >= start && c.t <= end).length;
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(activity.length, Math.ceil(end));
  const slice = activity.slice(s, e);
  const avg = slice.length ? slice.reduce((a, v) => a + v, 0) / slice.length : 0;
  const peak = slice.length ? Math.max(...slice) : 0;
  const motion = Math.min(10, avg * 0.8 + peak * 0.2);
  // A few cuts suggest action; very many suggest menus / flicker, so saturate.
  const cutScore = Math.min(4, cuts) * 1.5;
  return Math.round(Math.min(10, motion * 0.7 + cutScore * 0.5) * 10) / 10;
}

/**
 * Combined ranking score. The AI's editorial judgement dominates; audio and
 * motion are supporting evidence only (≤ 15% combined) so a loud but boring
 * moment cannot rank highly on its own.
 */
export function computeFinalScore(c: Pick<Candidate, 'entertainmentScore' | 'confidence' | 'scores' | 'audioScore' | 'sceneScore' | 'refined'>): number {
  const sub = c.scores ? Object.values(c.scores).filter((v): v is number => typeof v === 'number') : [];
  const subAvg = sub.length ? sub.reduce((a, b) => a + b, 0) / sub.length : c.entertainmentScore;
  const ai = c.entertainmentScore * 0.62 + subAvg * 0.13 + c.confidence * 10 * 0.1;
  const evidence = c.audioScore * 0.08 + c.sceneScore * 0.07;
  const unrefinedPenalty = c.refined ? 0 : 0.6;
  return Math.round(clamp(ai + evidence - unrefinedPenalty, 0, 10) * 100) / 100;
}

/** Enforce min/max duration around the event, keeping the peak inside. */
export function normaliseBoundaries(
  c: { start: number; end: number; peakTime?: number },
  clips: Pick<ClipsConfig, 'minDurationSeconds' | 'maxDurationSeconds'>,
  duration: number,
): { start: number; end: number } {
  let { start, end } = c;
  start = clamp(start, 0, duration);
  end = clamp(end, 0, duration);
  const peak = clamp(c.peakTime ?? (start + end) / 2, start, end);
  const min = Math.min(clips.minDurationSeconds, duration);
  const max = clips.maxDurationSeconds;
  if (end - start < min) {
    const missing = min - (end - start);
    // Favour adding context before the event (60/40).
    start -= missing * 0.6;
    end += missing * 0.4;
    if (start < 0) {
      end -= start;
      start = 0;
    }
    if (end > duration) {
      start -= end - duration;
      end = duration;
    }
    start = Math.max(0, start);
  }
  if (end - start > max) {
    // Keep ~40% before the peak, 60% after (payoff + reaction), within original range.
    let s = Math.max(start, peak - max * 0.4);
    let e = s + max;
    if (e > end) {
      e = end;
      s = e - max;
    }
    start = s;
    end = e;
  }
  return { start: round3(start), end: round3(end) };
}

/**
 * Snap boundaries to natural edit points (hard cuts, then quiet audio) within
 * ±radius, without breaking duration limits or cutting off the peak.
 */
export function snapBoundaries(
  c: { start: number; end: number; peakTime?: number },
  o: { radius: number; changes: SceneChange[]; envelope?: AudioEnvelope; min: number; max: number; duration: number },
): { start: number; end: number } {
  if (o.radius <= 0) return { start: c.start, end: c.end };
  const peak = c.peakTime ?? (c.start + c.end) / 2;
  const nearestCut = (t: number) =>
    o.changes.filter((ch) => Math.abs(ch.t - t) <= o.radius).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0]?.t;
  let start = nearestCut(c.start) ?? (o.envelope ? quietestNear(o.envelope, c.start, o.radius) : c.start);
  let end = nearestCut(c.end) ?? (o.envelope ? quietestNear(o.envelope, c.end, o.radius) : c.end);
  // A cut right at the start means the clip begins on the new shot; keep a tiny offset to avoid a 1-frame flash.
  if (start !== c.start && o.changes.some((ch) => ch.t === start)) start += 0.05;
  if (end !== c.end && o.changes.some((ch) => ch.t === end)) end -= 0.05;
  start = clamp(start, 0, o.duration);
  end = clamp(end, 0, o.duration);
  const len = end - start;
  if (start > peak - 1 || end < peak + 1 || len < o.min - 0.01 || len > o.max + 0.01) return { start: c.start, end: c.end };
  return { start: round3(start), end: round3(end) };
}

export interface SelectionInput {
  candidates: Candidate[];
  clips: ClipsConfig;
  duration: number;
  relaxThreshold?: boolean;
}

export interface SelectionResult {
  selected: Candidate[];
  notes: string[];
}

/**
 * Final selection (pass 4): approved moments first, then highest final score,
 * removing duplicates / overlaps and honouring the score threshold.
 */
export function selectClips(input: SelectionInput): SelectionResult {
  const { clips } = input;
  const notes: string[] = [];
  const pool = input.candidates.filter((c) => c.status !== 'rejected');
  const approved = pool.filter((c) => c.status === 'approved').sort((a, b) => b.finalScore - a.finalScore);
  const rest = pool.filter((c) => c.status !== 'approved').sort((a, b) => b.finalScore - a.finalScore || b.confidence - a.confidence);
  const selected: Candidate[] = [];

  const tryAdd = (c: Candidate, force: boolean): boolean => {
    let cand = { ...c };
    for (const s of selected) {
      if (overlap(cand, s) <= 0) continue;
      if (overlapRatio(cand, s) <= clips.maxOverlapRatio) continue;
      if (force) continue; // user-approved: keep even if overlapping
      // Try trimming the lower-ranked candidate away from the overlap.
      const trimmed = cand.start < s.start ? { start: cand.start, end: s.start } : { start: s.end, end: cand.end };
      const peak = cand.peakTime ?? (cand.start + cand.end) / 2;
      if (trimmed.end - trimmed.start >= clips.minDurationSeconds && peak >= trimmed.start + 1 && peak <= trimmed.end - 1) {
        cand = { ...cand, ...trimmed, notes: [...(cand.notes ?? []), `Trimmed to avoid overlap with ${s.id}`] };
      } else return false;
    }
    selected.push(cand);
    return true;
  };

  for (const c of approved) tryAdd(c, true);
  for (const c of rest) {
    if (selected.length >= clips.count) break;
    if (c.entertainmentScore < clips.minEntertainmentScore) continue;
    tryAdd(c, false);
  }
  if (selected.length < clips.count && input.relaxThreshold) {
    const floor = Math.max(0, clips.minEntertainmentScore - 2);
    let added = 0;
    for (const c of rest) {
      if (selected.length >= clips.count) break;
      if (selected.some((s) => s.id === c.id)) continue;
      if (c.entertainmentScore >= floor && c.entertainmentScore < clips.minEntertainmentScore) {
        if (tryAdd({ ...c, notes: [...(c.notes ?? []), 'Selected below score threshold to reach requested clip count'] }, false)) added++;
      }
    }
    if (added) notes.push(`${added} clip(s) selected with entertainment score below ${clips.minEntertainmentScore} (down to ${floor}) to reach the requested count.`);
  }
  if (selected.length < clips.count) {
    notes.push(`Only ${selected.length} of ${clips.count} requested clips met the selection criteria.`);
  }
  selected.sort((a, b) => a.start - b.start);
  return { selected, notes };
}

/** Attach evidence scores and final score to a candidate. */
export function scoreCandidate(c: Candidate, ev: { audio?: AudioAnalysis; changes: SceneChange[]; activity: number[] }): Candidate {
  const audioScore = ev.audio ? audioScoreForRange(ev.audio, c.start, c.end) : 0;
  const sceneScore = sceneScoreForRange(ev.changes, ev.activity, c.start, c.end);
  const next = { ...c, audioScore, sceneScore };
  return { ...next, finalScore: computeFinalScore(next) };
}

/** Remove near-duplicate candidates (e.g. the same event reported by two passes). Keeps the better one. */
export function dedupeCandidates(cands: Candidate[], threshold = 0.6): Candidate[] {
  const sorted = [...cands].sort((a, b) => Number(b.refined) - Number(a.refined) || b.finalScore - a.finalScore);
  const kept: Candidate[] = [];
  for (const c of sorted) {
    if (kept.some((k) => overlapRatio(k, c) >= threshold)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.start - b.start);
}
