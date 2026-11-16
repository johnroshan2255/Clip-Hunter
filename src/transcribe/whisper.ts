import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../util/process.js';
import { runFfmpeg, fmtSec, type FfmpegTools } from '../media/ffmpeg.js';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

/** Non-speech tokens whisper emits for music/noise; these are never shown as dialogue. */
const NON_SPEECH = /^[\s[(]*(music|applause|laughter|noise|silence|blank_audio|inaudible|engine|sound|gunshots?|explosion|static)[\s\])]*\.?$/i;

export interface WhisperConfig {
  executable: string;
  modelPath: string;
}

/** Whether optional local speech recognition is usable (never required). */
export async function whisperAvailable(cfg: WhisperConfig): Promise<{ ok: boolean; reason?: string }> {
  if (!cfg.modelPath) return { ok: false, reason: 'No whisper model configured (text.whisperModelPath)' };
  if (!fs.existsSync(cfg.modelPath)) return { ok: false, reason: `Whisper model not found: ${cfg.modelPath}` };
  try {
    await runProcess(cfg.executable, ['--help'], { timeoutMs: 15_000, label: 'whisper --help', okExitCodes: [0, 1] });
    return { ok: true };
  } catch {
    return { ok: false, reason: `whisper.cpp executable not found: ${cfg.executable}` };
  }
}

/** Parse whisper.cpp `-oj` JSON output. Exported for tests. */
export function parseWhisperJson(json: unknown): TranscriptSegment[] {
  const t = (json as { transcription?: Array<{ offsets?: { from: number; to: number }; text?: string }> }).transcription ?? [];
  return t
    .map((s) => ({ start: (s.offsets?.from ?? 0) / 1000, end: (s.offsets?.to ?? 0) / 1000, text: (s.text ?? '').trim() }))
    .filter((s) => s.text.length > 1 && !NON_SPEECH.test(s.text) && s.end > s.start);
}

/**
 * Transcribe a clip segment locally with whisper.cpp. Returns [] when there is
 * no detectable speech. Times are relative to the clip start.
 */
export async function transcribeSegment(o: {
  tools: FfmpegTools;
  whisper: WhisperConfig;
  source: string;
  audioStreamIndex: number;
  start: number;
  duration: number;
  workDir: string;
  signal?: AbortSignal;
}): Promise<TranscriptSegment[]> {
  await fsp.mkdir(o.workDir, { recursive: true });
  const wav = path.join(o.workDir, 'speech.wav');
  await runFfmpeg(o.tools, ['-ss', fmtSec(o.start), '-t', fmtSec(o.duration), '-i', o.source, '-map', `0:${o.audioStreamIndex}`, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {
    signal: o.signal,
    timeoutMs: 120_000,
    label: 'ffmpeg speech wav',
  });
  const base = path.join(o.workDir, 'speech');
  await runProcess(o.whisper.executable, ['-m', o.whisper.modelPath, '-f', wav, '-oj', '-of', base, '-l', 'auto', '-np'], {
    signal: o.signal,
    timeoutMs: 10 * 60_000,
    label: 'whisper.cpp',
  });
  const json = JSON.parse(await fsp.readFile(`${base}.json`, 'utf8')) as unknown;
  return parseWhisperJson(json).filter((s) => s.start < o.duration);
}
