import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../util/process.js';
import { runFfmpeg, fmtSec, type FfmpegTools } from '../media/ffmpeg.js';
import { ensureDir, exists } from '../util/fsx.js';

const availability = new Map<string, Promise<{ ok: boolean; reason?: string }>>();

/** Is the Demucs CLI installed? (cached per executable) */
export function demucsAvailable(executable: string): Promise<{ ok: boolean; reason?: string }> {
  let p = availability.get(executable);
  if (!p) {
    p = runProcess(executable, ['--help'], { timeoutMs: 60_000, label: 'demucs --help' }).then(
      () => ({ ok: true }),
      (err: Error) => ({ ok: false, reason: `Demucs not found (${err.message.slice(0, 80)}). Install it with: pip install demucs` }),
    );
    availability.set(executable, p);
  }
  return p;
}

/**
 * Separate voices from music with Demucs (htdemucs, two stems) and write a
 * 48 kHz stereo WAV of the clip range: voices at full level plus the rest
 * turned down ("reduce") or removed ("voices"). Runs on the GPU when PyTorch
 * has CUDA (NVIDIA) or MPS (Apple) available.
 */
export async function removeMusic(o: {
  tools: FfmpegTools;
  demucs: string;
  source: string;
  audioStreamIndex: number;
  start: number;
  duration: number;
  mode: 'reduce' | 'voices';
  workDir: string;
  signal?: AbortSignal;
}): Promise<string> {
  const dir = path.join(o.workDir, 'demucs');
  await ensureDir(dir);
  const input = path.join(dir, 'clip.wav');
  await runFfmpeg(o.tools, ['-ss', fmtSec(o.start), '-t', fmtSec(o.duration), '-i', o.source, '-map', `0:${o.audioStreamIndex}`, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', input], {
    signal: o.signal,
    timeoutMs: 120_000,
    label: 'ffmpeg extract audio for demucs',
  });
  await runProcess(o.demucs, ['--two-stems', 'vocals', '-n', 'htdemucs', '-o', dir, input], {
    signal: o.signal,
    timeoutMs: Math.max(10 * 60_000, o.duration * 20_000),
    label: 'demucs',
  });
  const stems = path.join(dir, 'htdemucs', 'clip');
  const vocals = path.join(stems, 'vocals.wav');
  const rest = path.join(stems, 'no_vocals.wav');
  if (!(await exists(vocals)) || !(await exists(rest))) throw new Error('Demucs did not produce vocals.wav / no_vocals.wav');
  const out = path.join(o.workDir, 'audio-no-music.wav');
  const restGain = o.mode === 'reduce' ? 0.18 : 0;
  await runFfmpeg(
    o.tools,
    ['-i', vocals, '-i', rest, '-filter_complex', `[1:a]volume=${restGain}[r];[0:a][r]amix=inputs=2:duration=first:normalize=0,aresample=48000[a]`, '-map', '[a]', '-c:a', 'pcm_s16le', out],
    { signal: o.signal, timeoutMs: 120_000, label: 'ffmpeg mix stems' },
  );
  await fsp.rm(dir, { recursive: true, force: true });
  return out;
}
