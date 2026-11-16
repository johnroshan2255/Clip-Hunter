import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../util/process.js';
import { runFfmpeg, fmtSec, type FfmpegTools } from '../media/ffmpeg.js';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  /** Language of this segment (ISO code). Clips can mix languages, e.g. Hindi + English. */
  lang?: string;
}

export interface Transcript {
  /** Dominant language, or "a+b" when the clip mixes languages (e.g. "hi+en"). */
  language: string;
  segments: TranscriptSegment[];
  /** Mean token probability of the kept segments (0..1), when available. */
  confidence?: number;
}

/** Non-speech tokens whisper emits for music/noise; these are never shown as dialogue. */
const NON_SPEECH = /^[\s[(♪*]*(music|applause|laughter|laughs|noise|silence|blank_audio|inaudible|engine|sound|sounds|gunshots?|explosion|static|background noise|no speech|speaking in foreign language)[\s\])♪*]*\.?$/i;

/** Phrases whisper is known to hallucinate on silence / game audio. */
const HALLUCINATIONS = [
  /thanks? (you )?for watching/i,
  /please subscribe/i,
  /like and subscribe/i,
  /subtitles? (by|from)/i,
  /amara\.org/i,
  /^\s*(you|bye|\.+)\s*$/i,
  /देखने के लिए धन्यवाद/,
  /सब्सक्राइब/,
];

export interface WhisperConfig {
  executable: string;
  modelPath: string;
  /** Silero VAD model (ggml-silero-*.bin). Enables per-utterance language detection. */
  vadModelPath?: string;
}

/** Parse "Speech segment N: start = 99.00, end = 173.00" lines (centiseconds) from whisper-vad-speech-segments. */
export function parseVadSegments(stdout: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const m of stdout.matchAll(/Speech segment \d+: start = ([\d.]+), end = ([\d.]+)/g)) {
    out.push({ start: Number(m[1]) / 100, end: Number(m[2]) / 100 });
  }
  return out;
}

/** Group VAD speech regions into utterances (merge small gaps, cap length, pad edges). */
export function groupUtterances(regions: Array<{ start: number; end: number }>, duration: number, o: { maxGap?: number; maxLen?: number; pad?: number } = {}): Array<{ start: number; end: number }> {
  const maxGap = o.maxGap ?? 0.8;
  const maxLen = o.maxLen ?? 15;
  const pad = o.pad ?? 0.25;
  const groups: Array<{ start: number; end: number }> = [];
  for (const r of regions) {
    const g = groups[groups.length - 1];
    if (g && r.start - g.end <= maxGap && r.end - g.start <= maxLen) g.end = r.end;
    else groups.push({ ...r });
  }
  return groups.map((g) => ({ start: Math.max(0, g.start - pad), end: Math.min(duration, g.end + pad) })).filter((g) => g.end - g.start >= 0.3);
}

/** Minimal 16-bit PCM mono WAV reader/writer (for slicing utterances without extra processes). */
function readWavPcm(buf: Buffer): { sampleRate: number; pcm: Buffer } {
  let off = 12;
  let sampleRate = 16000;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') sampleRate = buf.readUInt32LE(off + 12);
    if (id === 'data') return { sampleRate, pcm: buf.subarray(off + 8, off + 8 + size) };
    off += 8 + size + (size % 2);
  }
  throw new Error('Invalid WAV file');
}

function writeWav(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const SHORT_UTTERANCE_S = 2.5;

/**
 * Language of the clip's longer utterances (≥ 2.5 s) by speaking time, if one clearly
 * dominates (≥ 60%). Restricted to `allowed` when given. Exported for tests.
 */
export function dominantLanguage(utts: Array<{ start: number; end: number }>, parsed: Array<{ language: string; segments: unknown[] }>, allowed: string[] | null): string | null {
  const time = new Map<string, number>();
  utts.forEach((u, i) => {
    const p = parsed[i];
    const d = u.end - u.start;
    if (!p || d < SHORT_UTTERANCE_S || !p.segments.length || (allowed && !allowed.includes(p.language))) return;
    time.set(p.language, (time.get(p.language) ?? 0) + d);
  });
  const total = [...time.values()].reduce((a, b) => a + b, 0);
  const best = [...time.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && total > 0 && best[1] / total >= 0.6 ? best[0] : null;
}

/** Parse a spoken-language setting: "auto", "hi", or a set like "hi+en". */
export function parseSpokenLanguage(v: string | undefined): { mode: 'auto' | 'fixed' | 'set'; langs: string[] } {
  if (!v || v === 'auto') return { mode: 'auto', langs: [] };
  const langs = v.split('+').filter(Boolean);
  return { mode: langs.length > 1 ? 'set' : 'fixed', langs };
}

/** Summarise per-segment languages: "hi", or "hi+en" ordered by speaking time. */
export function summariseLanguages(segs: TranscriptSegment[]): string {
  const time = new Map<string, number>();
  for (const s of segs) if (s.lang) time.set(s.lang, (time.get(s.lang) ?? 0) + (s.end - s.start));
  const langs = [...time.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  return langs.length ? langs.join('+') : 'und';
}

/** Whether optional local speech recognition is usable (never required). */
export async function whisperAvailable(cfg: WhisperConfig): Promise<{ ok: boolean; reason?: string; multilingual?: boolean }> {
  if (!cfg.modelPath) return { ok: false, reason: 'No whisper model configured (text.whisperModelPath)' };
  if (!fs.existsSync(cfg.modelPath)) return { ok: false, reason: `Whisper model not found: ${cfg.modelPath}` };
  try {
    await runProcess(cfg.executable, ['--help'], { timeoutMs: 15_000, label: 'whisper --help', okExitCodes: [0, 1] });
  } catch {
    return { ok: false, reason: `whisper.cpp executable not found: ${cfg.executable}` };
  }
  // English-only models are named *.en.bin and cannot transcribe Hindi etc.
  return { ok: true, multilingual: !/\.en(\.|-)/.test(path.basename(cfg.modelPath)) };
}

interface WhisperToken {
  text?: string;
  p?: number;
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{ offsets?: { from: number; to: number }; text?: string; tokens?: WhisperToken[] }>;
}

/**
 * Parse whisper.cpp `-ojf` / `-oj` JSON output. Drops non-speech markers, known
 * hallucinations and (when token probabilities are present) low-confidence segments.
 * Exported for tests.
 */
export function parseWhisperJson(json: unknown, minConfidence = 0.35): Transcript {
  const j = json as WhisperJson;
  const kept = (j.transcription ?? [])
    .map((s) => {
      const toks = (s.tokens ?? []).filter((t) => t.text && !/^\[_[A-Z]+_?\d*\]$|^\[_TT_\d+\]$|^<\|/.test(t.text) && typeof t.p === 'number');
      const conf = toks.length ? toks.reduce((a, t) => a + (t.p ?? 0), 0) / toks.length : 1;
      return { start: (s.offsets?.from ?? 0) / 1000, end: (s.offsets?.to ?? 0) / 1000, text: (s.text ?? '').replace(/\s+/g, ' ').trim(), conf };
    })
    .filter((s) => s.text.length > 1 && s.end > s.start && !NON_SPEECH.test(s.text) && !HALLUCINATIONS.some((h) => h.test(s.text)) && s.conf >= minConfidence);
  const confidence = kept.length ? kept.reduce((a, k) => a + k.conf, 0) / kept.length : 0;
  return {
    language: (j.result?.language ?? 'und').toLowerCase(),
    segments: kept.map(({ start, end, text }) => ({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text })),
    confidence: Math.round(confidence * 1000) / 1000,
  };
}

/**
 * Transcribe a clip segment locally with whisper.cpp (Metal-accelerated on Apple
 * Silicon). With a VAD model, speech is first split into utterances and the
 * language is detected per utterance in a single whisper run, so clips that mix
 * languages (e.g. Hindi and English) are transcribed correctly. Returns no
 * segments when there is no detectable speech. Times are relative to the clip start.
 */
export async function transcribeSegment(o: {
  tools: FfmpegTools;
  whisper: WhisperConfig;
  source: string;
  audioStreamIndex: number;
  start: number;
  duration: number;
  /** "auto", an ISO code ("hi"), or a set ("hi+en"). */
  language?: string;
  workDir: string;
  signal?: AbortSignal;
}): Promise<Transcript> {
  await fsp.mkdir(o.workDir, { recursive: true });
  const wav = path.join(o.workDir, 'speech.wav');
  await runFfmpeg(o.tools, ['-ss', fmtSec(o.start), '-t', fmtSec(o.duration), '-i', o.source, '-map', `0:${o.audioStreamIndex}`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {
    signal: o.signal,
    timeoutMs: 120_000,
    label: 'ffmpeg speech wav',
  });
  const spoken = parseSpokenLanguage(o.language);
  const whisperArgs = (files: string[], lang: string) => ['-m', o.whisper.modelPath, ...files.flatMap((f) => ['-f', f]), '-ojf', '-l', lang, '-ml', '48', '-sow', '-np'];
  const runWhisper = (files: string[], lang: string) =>
    runProcess(o.whisper.executable, whisperArgs(files, lang), { signal: o.signal, timeoutMs: 10 * 60_000, label: 'whisper.cpp' });
  const readJson = async (file: string) => JSON.parse(await fsp.readFile(`${file}.json`, 'utf8')) as unknown;
  const firstLang = spoken.mode === 'auto' ? 'auto' : spoken.mode === 'fixed' ? spoken.langs[0]! : 'auto';

  // Utterance segmentation with Silero VAD (fast, robust to game noise).
  let utterances: Array<{ start: number; end: number }> | null = null;
  if (o.whisper.vadModelPath && fs.existsSync(o.whisper.vadModelPath)) {
    try {
      const vadBin = path.join(path.dirname(o.whisper.executable), 'whisper-vad-speech-segments');
      const r = await runProcess(fs.existsSync(vadBin) ? vadBin : 'whisper-vad-speech-segments', ['-vm', o.whisper.vadModelPath, '-f', wav], { signal: o.signal, timeoutMs: 120_000, label: 'whisper VAD' });
      utterances = groupUtterances(parseVadSegments(r.stdout), o.duration);
    } catch (err) {
      if ((err as { code?: string }).code === 'CANCELLED') throw err;
      utterances = null; // fall back to whole-clip transcription
    }
  }

  let segments: TranscriptSegment[] = [];
  if (utterances) {
    if (!utterances.length) return { language: 'und', segments: [] };
    const { sampleRate, pcm } = readWavPcm(await fsp.readFile(wav));
    const files: string[] = [];
    for (const [i, u] of utterances.entries()) {
      const a = Math.floor(u.start * sampleRate) * 2;
      const b = Math.min(pcm.length, Math.ceil(u.end * sampleRate) * 2);
      const f = path.join(o.workDir, `utt${String(i).padStart(3, '0')}.wav`);
      await fsp.writeFile(f, writeWav(pcm.subarray(a, b), sampleRate));
      files.push(f);
    }
    await runWhisper(files, firstLang);
    const parsed = await Promise.all(files.map(async (f) => parseWhisperJson(await readJson(f))));
    // Language set mode (e.g. hi+en): utterances detected outside the set (Hindi is often detected as
    // Urdu; short shouts are often misdetected) are transcribed in every allowed language and the most
    // confident result wins.
    if (spoken.mode === 'set') {
      const redo = parsed.map((p, i) => (spoken.langs.includes(p.language) ? -1 : i)).filter((i) => i >= 0);
      if (redo.length) {
        const best = new Map<number, Transcript>();
        for (const lang of spoken.langs) {
          await runWhisper(redo.map((i) => files[i]!), lang);
          for (const i of redo) {
            const t = { ...parseWhisperJson(await readJson(files[i]!)), language: lang };
            const cur = best.get(i);
            if (!cur || (t.segments.length && (t.confidence ?? 0) > (cur.confidence ?? 0)) || (!cur.segments.length && t.segments.length)) best.set(i, t);
          }
        }
        for (const [i, t] of best) parsed[i] = t;
      }
    }
    // Short utterances (shouts, interjections) get unreliable language detection: when the clip's longer
    // speech agrees on a language, re-transcribe short ones in that language.
    if (spoken.mode !== 'fixed') {
      const dominant = dominantLanguage(utterances, parsed, spoken.mode === 'set' ? spoken.langs : null);
      if (dominant) {
        const fix = utterances.map((u, i) => (u.end - u.start < SHORT_UTTERANCE_S && parsed[i]!.language !== dominant ? i : -1)).filter((i) => i >= 0);
        if (fix.length) {
          await runWhisper(fix.map((i) => files[i]!), dominant);
          for (const i of fix) parsed[i] = { ...parseWhisperJson(await readJson(files[i]!)), language: dominant };
        }
      }
    }
    utterances.forEach((u, i) => {
      for (const sgm of parsed[i]!.segments) segments.push({ start: u.start + sgm.start, end: Math.min(u.end, u.start + sgm.end), text: sgm.text, lang: parsed[i]!.language });
    });
  } else {
    const base = path.join(o.workDir, 'speech');
    await runProcess(o.whisper.executable, ['-m', o.whisper.modelPath, '-f', wav, '-ojf', '-of', base, '-l', spoken.mode === 'set' ? spoken.langs[0]! : firstLang, '-ml', '48', '-sow', '-np'], {
      signal: o.signal,
      timeoutMs: 10 * 60_000,
      label: 'whisper.cpp',
    });
    const t = parseWhisperJson(JSON.parse(await fsp.readFile(`${base}.json`, 'utf8')) as unknown);
    segments = t.segments.map((sgm) => ({ ...sgm, lang: t.language }));
  }
  segments = mergeShortSegments(segments.filter((sg) => sg.start < o.duration).map((sg) => ({ ...sg, end: Math.min(sg.end, o.duration) })));
  return { language: summariseLanguages(segments), segments };
}

/** Merge very short adjacent segments so subtitles stay on screen long enough to read. */
export function mergeShortSegments(segs: TranscriptSegment[], minDuration = 1.2, maxChars = 60): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.lang === s.lang && (prev.end - prev.start < minDuration || s.end - s.start < 0.6) && s.start - prev.end < 0.4 && (prev.text + ' ' + s.text).length <= maxChars) {
      prev.end = s.end;
      prev.text = `${prev.text} ${s.text}`;
    } else out.push({ ...s });
  }
  return out;
}

function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

/** Standard SubRip (.srt) caption file. */
export function toSrt(segs: TranscriptSegment[]): string {
  return segs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n');
}
