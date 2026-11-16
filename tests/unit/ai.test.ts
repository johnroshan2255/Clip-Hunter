import { describe, expect, it } from 'vitest';
import { extractJson, parseStreamJson, correctivePrompt } from '../../src/ai/claudeCli.js';
import { validateDiscovery, validateInspection } from '../../src/ai/schemas.js';
import { buildDiscoveryPrompt, editorSystemPrompt } from '../../src/ai/prompts.js';
import { redact } from '../../src/util/logger.js';

describe('parseStreamJson', () => {
  it('extracts the result, rate limit info and model', () => {
    const out = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-x' }),
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 123, unifiedWindows: { five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.7 } } } }),
      'garbage line',
      JSON.stringify({ type: 'result', is_error: false, structured_output: { a: 1 } }),
    ].join('\n');
    const p = parseStreamJson(out);
    expect(p.model).toBe('claude-x');
    expect(p.rateLimit?.utilization).toBe(0.7);
    expect(p.result?.structured_output).toEqual({ a: 1 });
  });
});

describe('extractJson', () => {
  it('handles fenced blocks and surrounding prose', () => {
    expect(extractJson('Here you go:\n```json\n{"a": [1, 2, {"b": "}"}]}\n```')).toEqual({ a: [1, 2, { b: '}' }] });
    expect(extractJson('prefix {"x": 1} suffix')).toEqual({ x: 1 });
  });
  it('throws when there is no JSON', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('validateDiscovery', () => {
  const range = { start: 100, end: 340 };
  it('accepts valid moments and clamps small overshoots', () => {
    const r = validateDiscovery(
      { summary: 's', game: 'GTA V', moments: [{ start: 98, end: 120, category: 'vehicle_crash', title: 't', description: 'd', entertainment_score: 8, confidence: 0.9, reason: 'r' }] },
      range,
      3,
    );
    expect(r.ok).toBe(true);
    expect(r.value!.moments[0]!.start).toBe(100);
    expect(r.value!.game).toBe('GTA V');
  });
  it('rejects invented timestamps outside the analysed range', () => {
    const r = validateDiscovery({ summary: '', moments: [{ start: 5000, end: 5020, category: 'funny', entertainment_score: 9, confidence: 1 }] }, range, 3);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/outside the analysed range/);
  });
  it('rejects end <= start and non-numeric scores', () => {
    const r = validateDiscovery({ moments: [{ start: 150, end: 140 }, { start: 150, end: 160, entertainment_score: 'high' }] }, range, 3);
    expect(r.ok).toBe(false);
  });
  it('normalises unknown categories and percentage confidences', () => {
    const r = validateDiscovery({ summary: '', moments: [{ start: 150, end: 170, category: 'weird_thing', entertainment_score: 7, confidence: 85 }] }, range, 3);
    expect(r.value!.moments[0]!.category).toBe('other');
    expect(r.value!.moments[0]!.confidence).toBeCloseTo(0.85);
  });
  it('tolerates a minority of invalid items', () => {
    const good = { start: 150, end: 170, category: 'funny', entertainment_score: 7, confidence: 0.5 };
    const r = validateDiscovery({ moments: [good, good, { start: 9999, end: 10000, entertainment_score: 5 }] }, range, 3);
    expect(r.ok).toBe(true);
    expect(r.value!.dropped).toHaveLength(1);
  });
});

describe('validateInspection', () => {
  it('clamps peak time and focus into range', () => {
    const r = validateInspection(
      {
        verdict: 'keep',
        moments: [{ start: 110, end: 130, peak_time: 200, category: 'explosion', entertainment_score: 8, confidence: 0.8, scores: { intensity: 9 }, focus: [{ t: 115, x: 70, confidence: 0.9 }] }],
      },
      { start: 100, end: 140 },
      1,
    );
    expect(r.ok).toBe(true);
    const m = r.value!.moments[0]!;
    expect(m.peak_time).toBe(130);
    expect(m.focus[0]!.x).toBeCloseTo(0.7);
    expect(m.scores.intensity).toBe(9);
    expect(m.scores.context).toBe(5);
  });
  it('accepts a rejection verdict with no moments', () => {
    const r = validateInspection({ verdict: 'reject', rejection_reason: 'just driving', moments: [] }, { start: 0, end: 30 }, 1);
    expect(r.ok).toBe(true);
    expect(r.value!.verdict).toBe('reject');
  });
});

describe('prompts', () => {
  it('is game-agnostic by default and uses the provided game when given', () => {
    expect(editorSystemPrompt()).toMatch(/identify it from the frames/);
    expect(editorSystemPrompt('Fortnite')).toMatch(/gameplay from Fortnite/);
    expect(editorSystemPrompt('Fortnite')).toMatch(/clutch/);
  });
  it('lists every tile timestamp in the discovery prompt', () => {
    const sheet = { id: 's', file: 'x.jpg', start: 0, end: 4, tiles: [{ index: 1, t: 0 }, { index: 2, t: 2 }, { index: 3, t: 4 }], width: 1, height: 1 };
    const p = buildDiscoveryPrompt({ sheets: [sheet], rangeStart: 0, rangeEnd: 6, interval: 2, videoDuration: 600, audioSummary: '', sceneSummary: '', activitySummary: '', minClip: 10, maxClip: 60, game: 'GTA VI' });
    expect(p).toContain('#01=0.0s #02=2.0s #03=4.0s');
    expect(p).toContain('GTA VI');
  });
  it('corrective prompt carries the problems and previous answer', () => {
    const c = correctivePrompt('ORIGINAL', 'end before start', '{"x":1}');
    expect(c).toContain('ORIGINAL');
    expect(c).toContain('end before start');
    expect(c).toContain('{"x":1}');
  });
});

describe('redact', () => {
  it('removes credentials from log text', () => {
    const s = redact('key sk-ant-abc123XYZ and ANTHROPIC_API_KEY=foo and "access_token": "zzz" Bearer abc.def');
    expect(s).not.toContain('sk-ant-abc123XYZ');
    expect(s).not.toContain('foo');
    expect(s).not.toContain('zzz');
    expect(s).not.toContain('abc.def');
  });
});
