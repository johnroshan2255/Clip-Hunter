import { MOMENT_CATEGORIES, type MomentCategory } from '../types.js';
import type { JsonSchema, ValidationOutcome } from './claudeCli.js';

const scoreProp = { type: 'number', minimum: 0, maximum: 10 };

const baseMomentProps = {
  start: { type: 'number', description: 'Absolute start time in seconds from the beginning of the recording' },
  end: { type: 'number', description: 'Absolute end time in seconds' },
  category: { type: 'string', enum: [...MOMENT_CATEGORIES] },
  title: { type: 'string', description: 'Short punchy title, max 60 characters' },
  description: { type: 'string', description: 'What visibly happens, one or two sentences' },
  entertainment_score: scoreProp,
  confidence: { type: 'number', minimum: 0, maximum: 1 },
  reason: { type: 'string', description: 'Why this is (or is not) entertaining for short-form viewers' },
};

export const discoverySchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'game', 'moments'],
  properties: {
    summary: { type: 'string', description: 'One or two sentences describing what generally happens in this stretch of gameplay' },
    game: { type: 'string', description: 'Name of the game shown (best guess), e.g. "GTA V", "Fortnite"' },
    moments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'category', 'title', 'description', 'entertainment_score', 'confidence', 'reason'],
        properties: baseMomentProps,
      },
    },
  },
};

export const inspectionSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'moments'],
  properties: {
    verdict: { type: 'string', enum: ['keep', 'reject'], description: 'reject if nothing here is worth a short-form clip' },
    rejection_reason: { type: 'string' },
    moments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'peak_time', 'category', 'title', 'description', 'entertainment_score', 'confidence', 'reason', 'scores', 'focus'],
        properties: {
          ...baseMomentProps,
          peak_time: { type: 'number', description: 'Absolute time of the key action/payoff' },
          scores: {
            type: 'object',
            additionalProperties: false,
            required: ['unexpectedness', 'visual_clarity', 'intensity', 'context', 'boundary_quality', 'replay_value'],
            properties: {
              unexpectedness: scoreProp,
              visual_clarity: scoreProp,
              intensity: scoreProp,
              context: scoreProp,
              boundary_quality: scoreProp,
              replay_value: scoreProp,
            },
          },
          focus: {
            type: 'array',
            description: 'Where the important action is horizontally in the frame at several times',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['t', 'x', 'confidence'],
              properties: {
                t: { type: 'number' },
                x: { type: 'number', minimum: 0, maximum: 1, description: '0 = left edge, 0.5 = center, 1 = right edge' },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
              },
            },
          },
        },
      },
    },
  },
};

export interface RawMoment {
  start: number;
  end: number;
  category: MomentCategory;
  title: string;
  description: string;
  entertainment_score: number;
  confidence: number;
  reason: string;
}

export interface DiscoveryResult {
  summary: string;
  game: string;
  moments: RawMoment[];
  dropped: string[];
}

export interface InspectedMoment extends RawMoment {
  peak_time: number;
  scores: {
    unexpectedness: number;
    visual_clarity: number;
    intensity: number;
    context: number;
    boundary_quality: number;
    replay_value: number;
  };
  focus: Array<{ t: number; x: number; confidence: number }>;
}

export interface InspectionResult {
  verdict: 'keep' | 'reject';
  rejection_reason?: string;
  moments: InspectedMoment[];
  dropped: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const clampN = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Validate a raw AI moment against the analysed range. Timestamps slightly
 * outside the range (within `tolerance`) are clamped; anything else is rejected.
 */
export function validateMoment(m: unknown, range: { start: number; end: number }, tolerance: number, i: number): { moment?: RawMoment; error?: string } {
  if (!isObj(m)) return { error: `moments[${i}] is not an object` };
  const { start, end } = m;
  if (!finite(start) || !finite(end)) return { error: `moments[${i}]: start/end must be numbers (seconds)` };
  if (end <= start) return { error: `moments[${i}]: end (${end}) must be greater than start (${start})` };
  if (start < range.start - tolerance || end > range.end + tolerance) {
    return { error: `moments[${i}]: ${start}-${end}s is outside the analysed range ${range.start}-${range.end}s` };
  }
  const category = MOMENT_CATEGORIES.includes(m.category as MomentCategory) ? (m.category as MomentCategory) : 'other';
  const score = finite(m.entertainment_score) ? clampN(m.entertainment_score, 0, 10) : NaN;
  if (Number.isNaN(score)) return { error: `moments[${i}]: entertainment_score must be a number 0-10` };
  const confidence = finite(m.confidence) ? clampN(m.confidence > 1 && m.confidence <= 100 ? m.confidence / 100 : m.confidence, 0, 1) : 0.5;
  return {
    moment: {
      start: Math.round(clampN(start, range.start, range.end) * 1000) / 1000,
      end: Math.round(clampN(end, range.start, range.end) * 1000) / 1000,
      category,
      title: String(m.title ?? '').slice(0, 80) || category.replace('_', ' '),
      description: String(m.description ?? '').slice(0, 600),
      entertainment_score: score,
      confidence,
      reason: String(m.reason ?? '').slice(0, 600),
    },
  };
}

export function validateDiscovery(data: unknown, range: { start: number; end: number }, tolerance: number): ValidationOutcome<DiscoveryResult> {
  if (!isObj(data)) return { ok: false, errors: ['Top-level value must be an object with "summary" and "moments"'] };
  if (!Array.isArray(data.moments)) return { ok: false, errors: ['"moments" must be an array'] };
  const moments: RawMoment[] = [];
  const errors: string[] = [];
  data.moments.forEach((m, i) => {
    const r = validateMoment(m, range, tolerance, i);
    if (r.moment) moments.push(r.moment);
    else if (r.error) errors.push(r.error);
  });
  // Tolerate a few bad items; demand a correction if most are bad.
  if (errors.length && errors.length > moments.length) return { ok: false, errors };
  return { ok: true, value: { summary: String(data.summary ?? ''), game: String(data.game ?? '').slice(0, 80), moments, dropped: errors }, errors };
}

export function validateInspection(data: unknown, range: { start: number; end: number }, tolerance: number): ValidationOutcome<InspectionResult> {
  if (!isObj(data)) return { ok: false, errors: ['Top-level value must be an object'] };
  if (!Array.isArray(data.moments)) return { ok: false, errors: ['"moments" must be an array'] };
  const verdict = data.verdict === 'reject' ? 'reject' : 'keep';
  const moments: InspectedMoment[] = [];
  const errors: string[] = [];
  data.moments.forEach((m, i) => {
    const r = validateMoment(m, range, tolerance, i);
    if (!r.moment) {
      if (r.error) errors.push(r.error);
      return;
    }
    const raw = m as Record<string, unknown>;
    let peak = finite(raw.peak_time) ? raw.peak_time : (r.moment.start + r.moment.end) / 2;
    if (peak < r.moment.start || peak > r.moment.end) peak = clampN(peak, r.moment.start, r.moment.end);
    const s = isObj(raw.scores) ? raw.scores : {};
    const sc = (k: string) => (finite(s[k]) ? clampN(s[k] as number, 0, 10) : 5);
    const focus = Array.isArray(raw.focus)
      ? raw.focus
          .filter((f): f is { t: number; x: number; confidence?: number } => isObj(f) && finite(f.t) && finite(f.x))
          .map((f) => ({ t: clampN(f.t, range.start, range.end), x: clampN(f.x > 1 && f.x <= 100 ? f.x / 100 : f.x, 0, 1), confidence: finite(f.confidence) ? clampN(f.confidence, 0, 1) : 0.5 }))
          .sort((a, b) => a.t - b.t)
      : [];
    moments.push({
      ...r.moment,
      peak_time: Math.round(peak * 1000) / 1000,
      scores: {
        unexpectedness: sc('unexpectedness'),
        visual_clarity: sc('visual_clarity'),
        intensity: sc('intensity'),
        context: sc('context'),
        boundary_quality: sc('boundary_quality'),
        replay_value: sc('replay_value'),
      },
      focus,
    });
  });
  if (errors.length && errors.length > moments.length) return { ok: false, errors };
  return {
    ok: true,
    value: { verdict, rejection_reason: typeof data.rejection_reason === 'string' ? data.rejection_reason : undefined, moments, dropped: errors },
    errors,
  };
}
