import type { AudioConfig, RenderConfig } from '../config/schema.js';
import { cropWindow, cropXExpression, even, type CropPath } from './smartCrop.js';

export interface Overlay {
  /** Input index of the PNG in the FFmpeg command. */
  inputIndex: number;
  /** Seconds relative to clip start. */
  start: number;
  end: number;
  /** Top position in output pixels. */
  y: number;
}

export interface GraphInput {
  srcW: number;
  srcH: number;
  duration: number;
  render: Pick<RenderConfig, 'width' | 'height' | 'fps' | 'cropPositionX' | 'blurForegroundWidth' | 'blurStrength'>;
  mode: 'blur' | 'crop' | 'smart';
  cropPath?: CropPath;
  overlays: Overlay[];
  /** Source audio stream selector (e.g. "0:1") or null if the source has no audio / it's disabled. */
  gameAudio: string | null;
  /** Background music input selector (e.g. "1:a") or null. */
  music: string | null;
  audio: Pick<AudioConfig, 'volume' | 'fadeInSeconds' | 'fadeOutSeconds' | 'backgroundMusicVolume' | 'ducking' | 'normalize' | 'targetLufs'>;
  /** Measured loudness for two-pass loudnorm (optional). */
  loudness?: LoudnessMeasurement;
}

export interface LoudnessMeasurement {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

export interface FilterGraph {
  graph: string;
  videoOut: string;
  audioOut: string | null;
}

function videoChain(g: GraphInput): string[] {
  const W = g.render.width;
  const H = g.render.height;
  const F = g.render.fps;
  const parts: string[] = [];
  if (g.mode === 'blur') {
    // Background: cheap blur at quarter resolution, then upscale; slightly darkened.
    const bw = even(W / 4);
    const bh = even(H / 4);
    const sigma = Math.max(1, g.render.blurStrength / 4);
    const fgW = even(W * g.render.blurForegroundWidth);
    const fgH = Math.min(H, even((fgW * g.srcH) / g.srcW));
    const fgWFinal = fgH === H ? even((H * g.srcW) / g.srcH) : fgW;
    parts.push(`[0:v:0]fps=${F},split=2[bgsrc][fgsrc]`);
    parts.push(`[bgsrc]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=${sigma},scale=${W}:${H},eq=brightness=-0.06:saturation=1.1[bg]`);
    parts.push(`[fgsrc]scale=${fgWFinal}:${fgH}:flags=lanczos[fg]`);
    parts.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[vbase]`);
  } else {
    const win = cropWindow(g.srcW, g.srcH, W, H);
    let xExpr: string;
    let yExpr = '0';
    if (g.mode === 'smart' && g.cropPath) {
      xExpr = `'${cropXExpression(g.cropPath.keyframes)}'`;
    } else {
      xExpr = String(Math.round(Math.min(g.srcW - win.w, Math.max(0, g.render.cropPositionX * g.srcW - win.w / 2))));
    }
    if (win.h < g.srcH) yExpr = String(Math.round((g.srcH - win.h) / 2));
    parts.push(`[0:v:0]fps=${F},crop=w=${win.w}:h=${win.h}:x=${xExpr}:y=${yExpr},scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p[vbase]`);
  }
  let last = 'vbase';
  g.overlays.forEach((o, i) => {
    const out = `vov${i}`;
    parts.push(`[${last}][${o.inputIndex}:v]overlay=x=(W-w)/2:y=${Math.round(o.y)}:enable='between(t,${o.start.toFixed(3)},${o.end.toFixed(3)})'[${out}]`);
    last = out;
  });
  parts.push(`[${last}]null[vout]`);
  return parts;
}

function audioChain(g: GraphInput): { parts: string[]; out: string | null } {
  const a = g.audio;
  const parts: string[] = [];
  const fadeOutStart = Math.max(0, g.duration - a.fadeOutSeconds);
  const fades = [
    a.fadeInSeconds > 0 ? `afade=t=in:st=0:d=${a.fadeInSeconds}` : '',
    a.fadeOutSeconds > 0 ? `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${a.fadeOutSeconds}` : '',
  ].filter(Boolean);
  let game: string | null = null;
  if (g.gameAudio) {
    const chain = ['aresample=48000', 'aformat=channel_layouts=stereo'];
    if (a.volume !== 1) chain.push(`volume=${a.volume}`);
    if (a.normalize) {
      const m = g.loudness;
      chain.push(
        m
          ? `loudnorm=I=${a.targetLufs}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
          : `loudnorm=I=${a.targetLufs}:TP=-1.5:LRA=11`,
        'aresample=48000',
      );
    }
    chain.push(...fades);
    parts.push(`[${g.gameAudio}]${chain.join(',')}[game]`);
    game = 'game';
  }
  let music: string | null = null;
  if (g.music) {
    parts.push(`[${g.music}]aresample=48000,aformat=channel_layouts=stereo,volume=${a.backgroundMusicVolume},${fades.join(',') || 'anull'}[music]`);
    music = 'music';
  }
  if (game && music) {
    if (a.ducking) {
      parts.push(`[game]asplit=2[gmain][gkey]`);
      parts.push(`[music][gkey]sidechaincompress=threshold=0.04:ratio=8:attack=20:release=350:makeup=1[mduck]`);
      parts.push(`[gmain][mduck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false[aout]`);
    } else {
      parts.push(`[game][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false[aout]`);
    }
    return { parts, out: 'aout' };
  }
  if (game) {
    parts.push(`[game]alimiter=limit=0.95:level=false[aout]`);
    return { parts, out: 'aout' };
  }
  if (music) {
    parts.push(`[music]atrim=duration=${g.duration.toFixed(3)},alimiter=limit=0.95:level=false[aout]`);
    return { parts, out: 'aout' };
  }
  return { parts, out: null };
}

/** Build the complete filter_complex for a vertical clip. */
export function buildFilterGraph(g: GraphInput): FilterGraph {
  const v = videoChain(g);
  const a = audioChain(g);
  return { graph: [...v, ...a.parts].join(';'), videoOut: 'vout', audioOut: a.out };
}

/** Parse loudnorm's print_format=json block from stderr. */
export function parseLoudnorm(stderr: string): LoudnessMeasurement | undefined {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    if (!j.input_i || j.input_i === '-inf' || !Number.isFinite(Number(j.input_i))) return undefined;
    return { input_i: j.input_i, input_tp: j.input_tp!, input_lra: j.input_lra!, input_thresh: j.input_thresh!, target_offset: j.target_offset! };
  } catch {
    return undefined;
  }
}
