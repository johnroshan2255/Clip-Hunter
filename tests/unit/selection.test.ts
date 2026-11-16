import { describe, expect, it } from 'vitest';
import {
  computeFinalScore,
  dedupeCandidates,
  normaliseBoundaries,
  planInspectionWindows,
  selectClips,
  snapBoundaries,
  type DiscoveryMoment,
} from '../../src/pipeline/selection.js';
import { majorityGame } from '../../src/pipeline/analyze.js';
import type { Candidate } from '../../src/types.js';
import { loadConfig } from '../../src/config/load.js';

const clipsCfg = loadConfig({ root: '/nonexistent' }).clips;

function cand(id: string, start: number, end: number, score: number, extra: Partial<Candidate> = {}): Candidate {
  const c: Candidate = {
    id,
    start,
    end,
    category: 'vehicle_crash',
    title: id,
    description: '',
    entertainmentScore: score,
    confidence: 0.8,
    reason: '',
    audioScore: 0,
    sceneScore: 0,
    finalScore: 0,
    source: 'pass2',
    refined: true,
    status: 'pending',
    selected: false,
    ...extra,
  };
  return { ...c, finalScore: extra.finalScore ?? computeFinalScore(c) };
}

describe('normaliseBoundaries', () => {
  it('extends short clips to the minimum, favouring context before the event', () => {
    const r = normaliseBoundaries({ start: 100, end: 104 }, { minDurationSeconds: 10, maxDurationSeconds: 60 }, 3600);
    expect(r.end - r.start).toBeCloseTo(10);
    expect(100 - r.start).toBeGreaterThan(r.end - 104);
  });
  it('clamps to the video start/end', () => {
    const r = normaliseBoundaries({ start: 1, end: 3 }, { minDurationSeconds: 10, maxDurationSeconds: 60 }, 3600);
    expect(r.start).toBe(0);
    expect(r.end).toBeCloseTo(10);
    const e = normaliseBoundaries({ start: 3597, end: 3599 }, { minDurationSeconds: 10, maxDurationSeconds: 60 }, 3600);
    expect(e.end).toBe(3600);
    expect(e.end - e.start).toBeCloseTo(10);
  });
  it('trims long clips around the peak', () => {
    const r = normaliseBoundaries({ start: 0, end: 200, peakTime: 120 }, { minDurationSeconds: 10, maxDurationSeconds: 60 }, 3600);
    expect(r.end - r.start).toBeCloseTo(60);
    expect(r.start).toBeLessThan(120);
    expect(r.end).toBeGreaterThan(120);
  });
});

describe('snapBoundaries', () => {
  it('snaps to a nearby scene cut', () => {
    const r = snapBoundaries({ start: 100, end: 120, peakTime: 110 }, { radius: 1.5, changes: [{ t: 99, score: 20 }], min: 10, max: 60, duration: 3600 });
    expect(r.start).toBeCloseTo(99.05);
  });
  it('never snaps past the peak or below the minimum duration', () => {
    const r = snapBoundaries({ start: 100, end: 110, peakTime: 105 }, { radius: 1.5, changes: [{ t: 101.4, score: 20 }], min: 10, max: 60, duration: 3600 });
    expect(r).toEqual({ start: 100, end: 110 });
  });
});

describe('selectClips', () => {
  it('picks the best non-overlapping candidates up to the requested count', () => {
    const cands = [cand('a', 0, 20, 9), cand('b', 5, 25, 8), cand('c', 100, 120, 7), cand('d', 200, 220, 6.5)];
    const r = selectClips({ candidates: cands, clips: { ...clipsCfg, count: 2 }, duration: 3600 });
    expect(r.selected.map((s) => s.id)).toEqual(['a', 'c']);
  });
  it('respects user approval and rejection', () => {
    const cands = [cand('a', 0, 20, 9, { status: 'rejected' }), cand('b', 100, 120, 3, { status: 'approved' }), cand('c', 200, 220, 8)];
    const r = selectClips({ candidates: cands, clips: { ...clipsCfg, count: 2 }, duration: 3600 });
    expect(r.selected.map((s) => s.id).sort()).toEqual(['b', 'c']);
  });
  it('enforces the minimum entertainment score and reports shortfalls', () => {
    const cands = [cand('a', 0, 20, 9), cand('b', 100, 120, 3)];
    const r = selectClips({ candidates: cands, clips: { ...clipsCfg, count: 5, minEntertainmentScore: 6 }, duration: 3600 });
    expect(r.selected.map((s) => s.id)).toEqual(['a']);
    expect(r.notes.join(' ')).toMatch(/Only 1 of 5/);
  });
  it('can relax the threshold slightly to fill the count', () => {
    const cands = [cand('a', 0, 20, 9), cand('b', 100, 120, 5), cand('c', 200, 220, 2)];
    const r = selectClips({ candidates: cands, clips: { ...clipsCfg, count: 3, minEntertainmentScore: 6 }, duration: 3600, relaxThreshold: true });
    expect(r.selected.map((s) => s.id)).toEqual(['a', 'b']);
  });
  it('trims a lower-ranked clip to remove partial overlap when possible', () => {
    const cands = [cand('a', 100, 120, 9), cand('b', 110, 140, 8, { peakTime: 130 })];
    const r = selectClips({ candidates: cands, clips: { ...clipsCfg, count: 2 }, duration: 3600 });
    const b = r.selected.find((s) => s.id === 'b')!;
    expect(b.start).toBe(120);
    expect(b.end).toBe(140);
  });
});

describe('computeFinalScore', () => {
  it('lets AI judgement dominate audio evidence', () => {
    const boringButLoud = computeFinalScore({ entertainmentScore: 3, confidence: 0.5, audioScore: 10, sceneScore: 10, refined: true });
    const greatButQuiet = computeFinalScore({ entertainmentScore: 9, confidence: 0.9, audioScore: 0, sceneScore: 0, refined: true });
    expect(greatButQuiet).toBeGreaterThan(boringButLoud + 3);
  });
  it('penalises unrefined (pass-1 only) candidates', () => {
    const a = computeFinalScore({ entertainmentScore: 8, confidence: 0.8, audioScore: 0, sceneScore: 0, refined: true });
    const b = computeFinalScore({ entertainmentScore: 8, confidence: 0.8, audioScore: 0, sceneScore: 0, refined: false });
    expect(a).toBeGreaterThan(b);
  });
});

describe('dedupeCandidates', () => {
  it('keeps the refined/better of two near-identical ranges', () => {
    const r = dedupeCandidates([cand('p1', 100, 120, 9, { refined: false, finalScore: 9 }), cand('p2', 101, 121, 7, { finalScore: 7 })]);
    expect(r.map((c) => c.id)).toEqual(['p2']);
  });
});

describe('planInspectionWindows', () => {
  const m = (id: string, start: number, end: number, score: number): DiscoveryMoment => ({ id, start, end, score, category: 'action', title: id, description: '', confidence: 0.7, reason: '' });
  it('merges adjacent moments and adds context', () => {
    const w = planInspectionWindows([m('a', 100, 110, 7), m('b', 112, 118, 8), m('c', 500, 510, 6)], { minScore: 5, context: 8, maxWindow: 90, duration: 3600, maxWindows: 10 });
    expect(w).toHaveLength(2);
    expect(w[0]!.start).toBe(92);
    expect(w[0]!.end).toBe(126);
    expect(w[0]!.members).toHaveLength(2);
  });
  it('drops low scores and limits the number of windows by priority', () => {
    const w = planInspectionWindows([m('a', 100, 110, 4), m('b', 300, 310, 9), m('c', 600, 610, 6)], { minScore: 5, context: 5, maxWindow: 90, duration: 3600, maxWindows: 1 });
    expect(w.map((x) => x.members[0]!.id)).toEqual(['b']);
  });
});

describe('majorityGame', () => {
  it('picks the most common game name, ignoring unknowns', () => {
    expect(majorityGame(['Fortnite', 'fortnite', 'unknown', 'GTA V', undefined])).toBe('Fortnite');
    expect(majorityGame([undefined, 'unknown'])).toBeUndefined();
  });
});
