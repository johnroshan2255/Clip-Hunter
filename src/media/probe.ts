import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../util/process.js';
import { ValidationError } from '../util/errors.js';
import type { AudioStreamInfo, VideoMetadata, VideoStreamInfo } from '../types.js';
import type { FfmpegTools } from './ffmpeg.js';

export const SUPPORTED_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v'] as const;

export function isSupportedVideo(file: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(path.extname(file).toLowerCase());
}

interface RawStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  bit_rate?: string;
  channels?: number;
  sample_rate?: string;
  channel_layout?: string;
  disposition?: { default?: number; attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}

interface RawProbe {
  streams?: RawStream[];
  format?: {
    filename?: string;
    format_name?: string;
    format_long_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    start_time?: string;
  };
}

export function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [n, d] = r.split('/').map(Number);
  if (n === undefined || !Number.isFinite(n)) return 0;
  if (d === undefined) return n;
  return d > 0 ? n / d : 0;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function ffprobeJson(tools: FfmpegTools, file: string, signal?: AbortSignal): Promise<RawProbe> {
  const r = await runProcess(
    tools.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { signal, timeoutMs: 60_000, label: 'ffprobe' },
  );
  try {
    return JSON.parse(r.stdout) as RawProbe;
  } catch {
    throw new ValidationError(`ffprobe returned invalid JSON for ${path.basename(file)}`);
  }
}

/** Convert raw ffprobe output into normalised metadata. Exported for unit testing. */
export function normaliseProbe(raw: RawProbe, file: string, sizeBytes: number, preferredAudio = -1): VideoMetadata {
  const streams = raw.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v || !v.width || !v.height) throw new ValidationError('No video stream found', { file: path.basename(file) });

  let duration = num(raw.format?.duration) ?? 0;
  if (!(duration > 0)) throw new ValidationError('Could not determine video duration', { file: path.basename(file) });

  const rotationSide = v.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  const rotation = ((Math.round(rotationSide ?? Number(v.tags?.rotate ?? 0)) % 360) + 360) % 360;
  const swap = rotation === 90 || rotation === 270;
  const avgFps = parseRate(v.avg_frame_rate);
  const rFps = parseRate(v.r_frame_rate);
  // Containers like MKV/WebM often report r_frame_rate as a timebase; treat big mismatch as VFR.
  const isVfr = avgFps > 0 && rFps > 0 && Math.abs(avgFps - rFps) / rFps > 0.01;

  const video: VideoStreamInfo = {
    index: v.index,
    codec: v.codec_name ?? 'unknown',
    profile: v.profile,
    width: v.width,
    height: v.height,
    displayWidth: swap ? v.height : v.width,
    displayHeight: swap ? v.width : v.height,
    rotation,
    pixFmt: v.pix_fmt,
    avgFps: avgFps || rFps,
    rFps,
    isVariableFrameRate: isVfr,
    frameCount: num(v.nb_frames),
    bitRate: num(v.bit_rate),
  };

  const audio: AudioStreamInfo[] = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index,
      codec: s.codec_name ?? 'unknown',
      channels: s.channels ?? 0,
      sampleRate: num(s.sample_rate) ?? 0,
      channelLayout: s.channel_layout,
      language: s.tags?.language,
      title: s.tags?.title ?? s.tags?.handler_name,
      isDefault: s.disposition?.default === 1,
      bitRate: num(s.bit_rate),
    }));

  let selectedAudioIndex: number | null = null;
  if (audio.length) {
    const preferred = preferredAudio >= 0 ? audio.find((a) => a.index === preferredAudio) : undefined;
    selectedAudioIndex = (preferred ?? audio.find((a) => a.isDefault) ?? audio[0]!).index;
  }

  duration = Math.round(duration * 1000) / 1000;
  return {
    path: file,
    sizeBytes,
    durationSeconds: duration,
    startTime: num(raw.format?.start_time) ?? 0,
    formatName: raw.format?.format_name ?? 'unknown',
    formatLongName: raw.format?.format_long_name,
    bitRate: num(raw.format?.bit_rate),
    video,
    audio,
    selectedAudioIndex,
    probedAt: new Date().toISOString(),
  };
}

export async function probeVideo(tools: FfmpegTools, file: string, opts: { signal?: AbortSignal; audioStreamIndex?: number } = {}): Promise<VideoMetadata> {
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new ValidationError(`File not found: ${path.basename(file)}`);
  if (st.size === 0) throw new ValidationError(`File is empty: ${path.basename(file)}`);
  const raw = await ffprobeJson(tools, file, opts.signal);
  return normaliseProbe(raw, file, st.size, opts.audioStreamIndex ?? -1);
}
