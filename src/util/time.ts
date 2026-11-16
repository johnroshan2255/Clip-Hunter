/** Format seconds as H:MM:SS(.mmm) or M:SS(.mmm). */
export function formatTimestamp(seconds: number, withMillis = false): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const secStr = withMillis ? sec.toFixed(1).padStart(4, '0') : Math.floor(sec).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${secStr}` : `${m}:${secStr}`;
}

/** Parse "1:02:03.5", "02:03", "123.4" → seconds. Returns NaN on invalid input. */
export function parseTimestamp(input: string | number): number {
  if (typeof input === 'number') return input;
  const t = input.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return Number.NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Overlap length of two [start,end] ranges. */
export function overlap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Overlap relative to the shorter range (0..1). */
export function overlapRatio(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shorter <= 0 ? 0 : overlap(a, b) / shorter;
}
