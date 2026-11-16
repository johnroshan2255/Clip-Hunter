import { runProcess, type RunOptions, type RunResult } from '../util/process.js';

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

export interface FfmpegRunOptions extends Omit<RunOptions, 'onStdout' | 'label'> {
  /** Called with processed output time in seconds (from -progress). */
  onProgress?: (seconds: number) => void;
  label?: string;
}

/**
 * Run ffmpeg with argument array, machine-readable progress on stdout and
 * errors on stderr. Common flags are prepended.
 */
export function runFfmpeg(tools: FfmpegTools, args: readonly string[], opts: FfmpegRunOptions = {}): Promise<RunResult> {
  const fullArgs = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args];
  let pending = '';
  return runProcess(tools.ffmpeg, fullArgs, {
    ...opts,
    label: opts.label ?? 'ffmpeg',
    collectStdout: false,
    onStdout: (chunk) => {
      if (!opts.onProgress) return;
      pending += chunk.toString('utf8');
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) opts.onProgress(Number(m[1]) / 1e6);
      }
    },
  });
}

/** Decode a file completely and report any decode errors (used for validation). */
export async function decodeCheck(tools: FfmpegTools, file: string, signal?: AbortSignal): Promise<{ ok: boolean; errors: string }> {
  try {
    const r = await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-map', '0', '-f', 'null', '-'], {
      signal,
      timeoutMs: 10 * 60_000,
      label: 'ffmpeg decode-check',
    });
    const errors = r.stderr.trim();
    return { ok: errors.length === 0, errors };
  } catch (err) {
    return { ok: false, errors: (err as Error).message };
  }
}

/**
 * Escape a value for use inside an FFmpeg filtergraph option
 * (e.g. a file path in movie= or a text value). Handles both escaping levels.
 */
export function escapeFilterValue(value: string): string {
  // Level 1: option value escaping
  const lvl1 = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
  // Level 2: filtergraph escaping
  return lvl1.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[[\],;]/g, (c) => `\\${c}`);
}

/** Format a number for FFmpeg arguments (fixed precision, no exponent). */
export function fmtSec(n: number): string {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}
