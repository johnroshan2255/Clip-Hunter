import fsp from 'node:fs/promises';
import { ffprobeJson, parseRate } from '../media/probe.js';
import { decodeCheck, type FfmpegTools } from '../media/ffmpeg.js';
import { runProcess } from '../util/process.js';
import type { ClipValidation } from '../types.js';

export interface ValidationExpectations {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  expectAudio: boolean;
  durationTolerance: number;
}

/** Parse "max_volume: -1.2 dB" from volumedetect output. */
export function parseMaxVolume(stderr: string): number | undefined {
  const m = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  if (!m) return undefined;
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

/**
 * Validate a rendered clip with FFprobe + a full decode. A clip is only ever
 * reported as completed when `ok` is true.
 */
export async function validateClip(tools: FfmpegTools, file: string, exp: ValidationExpectations, signal?: AbortSignal): Promise<ClipValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const v: ClipValidation = {
    ok: false,
    durationSeconds: 0,
    width: 0,
    height: 0,
    videoCodec: '',
    pixFmt: '',
    fps: 0,
    hasAudio: false,
    sizeBytes: 0,
    decodeOk: false,
    warnings,
    errors,
  };
  const st = await fsp.stat(file).catch(() => null);
  v.sizeBytes = st?.size ?? 0;
  if (!st || st.size === 0) {
    errors.push('Output file is missing or zero bytes');
    return v;
  }
  let probe;
  try {
    probe = await ffprobeJson(tools, file, signal);
  } catch (err) {
    errors.push(`ffprobe failed: ${(err as Error).message}`);
    return v;
  }
  const vs = probe.streams?.find((s) => s.codec_type === 'video');
  const as = probe.streams?.find((s) => s.codec_type === 'audio');
  v.durationSeconds = Number(probe.format?.duration ?? 0);
  if (!vs) errors.push('No video stream');
  else {
    v.width = vs.width ?? 0;
    v.height = vs.height ?? 0;
    v.videoCodec = vs.codec_name ?? '';
    v.pixFmt = vs.pix_fmt ?? '';
    v.fps = Math.round(parseRate(vs.avg_frame_rate) * 100) / 100;
    if (v.videoCodec !== 'h264') errors.push(`Video codec is ${v.videoCodec}, expected h264`);
    if (v.width !== exp.width || v.height !== exp.height) errors.push(`Resolution ${v.width}x${v.height}, expected ${exp.width}x${exp.height}`);
    if (v.pixFmt !== 'yuv420p') errors.push(`Pixel format ${v.pixFmt}, expected yuv420p`);
    if (Math.abs(v.fps - exp.fps) > 0.5) errors.push(`Frame rate ${v.fps}, expected ${exp.fps}`);
  }
  v.hasAudio = !!as;
  v.audioCodec = as?.codec_name;
  if (exp.expectAudio && !as) errors.push('Audio stream missing');
  if (as && as.codec_name !== 'aac') errors.push(`Audio codec ${as.codec_name}, expected aac`);
  if (Math.abs(v.durationSeconds - exp.durationSeconds) > exp.durationTolerance) {
    errors.push(`Duration ${v.durationSeconds.toFixed(3)}s, expected ${exp.durationSeconds.toFixed(3)}s ±${exp.durationTolerance}s`);
  }
  const dec = await decodeCheck(tools, file, signal);
  v.decodeOk = dec.ok;
  if (!dec.ok) errors.push(`Decode errors: ${dec.errors.slice(0, 300)}`);

  if (as) {
    try {
      const r = await runProcess(tools.ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], {
        signal,
        timeoutMs: 120_000,
        label: 'ffmpeg volumedetect',
      });
      v.peakDb = parseMaxVolume(r.stderr);
      if (v.peakDb !== undefined && v.peakDb >= -0.1) warnings.push(`Audio peaks at ${v.peakDb} dBFS (possible clipping)`);
      if (v.peakDb !== undefined && v.peakDb < -50) warnings.push('Audio is nearly silent');
    } catch {
      warnings.push('Could not measure audio levels');
    }
  }
  v.ok = errors.length === 0;
  return v;
}
