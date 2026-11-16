import { runProcess } from '../util/process.js';
import type { FfmpegTools } from '../media/ffmpeg.js';
import type { RenderConfig } from '../config/schema.js';

export type VideoEncoder = 'libx264' | 'h264_nvenc' | 'h264_videotoolbox' | 'h264_qsv' | 'h264_amf';
export type EncoderPreference = 'auto' | VideoEncoder;

/** Hardware encoders tried by "auto", best first. libx264 (CPU) is the universal fallback. */
export function autoOrder(platform: NodeJS.Platform = process.platform): VideoEncoder[] {
  return platform === 'darwin' ? ['h264_videotoolbox', 'libx264'] : ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];
}

/**
 * FFmpeg arguments for an encoder, mapping the x264 CRF quality scale onto each
 * hardware encoder's own constant-quality control.
 */
export function encoderArgs(enc: VideoEncoder, r: Pick<RenderConfig, 'crf' | 'preset' | 'threadsPerJob'>): string[] {
  const common = ['-pix_fmt', 'yuv420p', '-profile:v', 'high'];
  switch (enc) {
    case 'h264_nvenc':
      // NVENC (NVIDIA RTX/GTX): constant quality VBR; cq ≈ crf + 2 gives similar size/quality.
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(Math.min(51, r.crf + 2)), '-b:v', '0', '-spatial-aq', '1', '-bf', '2', ...common];
    case 'h264_videotoolbox':
      // Apple Silicon constant quality (1..100, higher = better).
      return ['-c:v', 'h264_videotoolbox', '-q:v', String(Math.max(30, Math.min(90, Math.round(100 - r.crf * 1.75)))), '-allow_sw', '1', ...common];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', String(r.crf + 2), '-preset', 'medium', ...common];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(r.crf + 1), '-qp_p', String(r.crf + 3), ...common];
    default:
      return ['-c:v', 'libx264', '-preset', r.preset, '-crf', String(r.crf), ...common, ...(r.threadsPerJob > 0 ? ['-threads', String(r.threadsPerJob)] : [])];
  }
}

const probeCache = new Map<string, Promise<boolean>>();

/** True if this FFmpeg build has the encoder AND the hardware can actually encode a frame with it. */
export function encoderWorks(tools: FfmpegTools, enc: VideoEncoder): Promise<boolean> {
  if (enc === 'libx264') return Promise.resolve(true);
  const key = `${tools.ffmpeg}|${enc}`;
  let p = probeCache.get(key);
  if (!p) {
    p = runProcess(
      tools.ffmpeg,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.3', '-frames:v', '6', ...encoderArgs(enc, { crf: 23, preset: 'veryfast', threadsPerJob: 0 }), '-f', 'null', '-'],
      { timeoutMs: 20_000, label: `probe ${enc}` },
    ).then(
      () => true,
      () => false,
    );
    probeCache.set(key, p);
  }
  return p;
}

/** Mark an encoder as unusable for the rest of this process (e.g. it failed mid-render). */
export function markEncoderBroken(tools: FfmpegTools, enc: VideoEncoder): void {
  if (enc !== 'libx264') probeCache.set(`${tools.ffmpeg}|${enc}`, Promise.resolve(false));
}

/** Pick the encoder to use for a render. */
export async function chooseEncoder(tools: FfmpegTools, pref: EncoderPreference): Promise<VideoEncoder> {
  const order = pref === 'auto' ? autoOrder() : [pref, 'libx264' as const];
  for (const enc of order) if (await encoderWorks(tools, enc)) return enc;
  return 'libx264';
}

/** Human-readable encoder status for `doctor` / the UI. */
export async function encoderReport(tools: FfmpegTools): Promise<Record<VideoEncoder, boolean>> {
  const all: VideoEncoder[] = ['h264_nvenc', 'h264_videotoolbox', 'h264_qsv', 'h264_amf', 'libx264'];
  const res = await Promise.all(all.map((e) => encoderWorks(tools, e)));
  return Object.fromEntries(all.map((e, i) => [e, res[i]!])) as Record<VideoEncoder, boolean>;
}
