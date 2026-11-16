import type { AudioConfig, RenderConfig } from '../config/schema.js';
import type { FacecamRect, VoiceEffect } from '../types.js';
import { cropWindow, cropXExpression, even, type CropPath } from './smartCrop.js';

export interface Overlay {
  /** Input index of the PNG (or image sequence) in the FFmpeg command. */
  inputIndex: number;
  /** Seconds on the output timeline. */
  start: number;
  end: number;
  /** Top position in output pixels. */
  y: number;
  /** Slide down into place during the first 0.25 s (hook titles). */
  slideIn?: boolean;
}

/** One piece of the output timeline, read from its own input (see renderClip). */
export interface TimelinePiece {
  /** Input index holding this piece's video (and audio unless `audio` is set). */
  inputIndex: number;
  /** Audio stream selector for this piece (e.g. "3:1", or "5:a:0" for a processed WAV), or null. */
  audio: string | null;
  /** Clip-relative start of the piece in the source (keeps smart-crop timing right). */
  offset: number;
  /** Source seconds covered. */
  seconds: number;
  /** Playback speed (<1 = slow motion replay). */
  speed: number;
  replay?: boolean;
}

/** Effects on the output timeline (seconds). */
export interface VideoFx {
  zooms: Array<{ t: number; duration: number; strength: number }>;
  shakes: Array<{ t: number; duration: number; strength: number }>;
  flashes: Array<{ t: number; strength: number }>;
  glitches: Array<{ t: number; duration: number; strength: number }>;
}

export interface GraphInput {
  srcW: number;
  srcH: number;
  /** Source seconds of the clip (before any replay is inserted). */
  duration: number;
  render: Pick<RenderConfig, 'width' | 'height' | 'fps' | 'cropPositionX' | 'blurForegroundWidth' | 'blurStrength'>;
  mode: 'blur' | 'crop' | 'smart';
  cropPath?: CropPath;
  /** Facecam layout: webcam region of the source on top, gameplay below. */
  facecam?: { rect: FacecamRect; heightFraction: number; cropPath?: CropPath };
  overlays: Overlay[];
  /** Source audio stream selector (e.g. "0:1") or null if the source has no audio / it's disabled. */
  gameAudio: string | null;
  /** Background music input selector (e.g. "1:a") or null. */
  music: string | null;
  audio: Pick<AudioConfig, 'volume' | 'fadeInSeconds' | 'fadeOutSeconds' | 'backgroundMusicVolume' | 'ducking' | 'normalize' | 'targetLufs'> & { denoise?: AudioConfig['denoise'] };
  /** Measured loudness for two-pass loudnorm (optional). */
  loudness?: LoudnessMeasurement;
  /** Multi-piece timeline (instant replay). Absent = single input 0 / gameAudio. */
  pieces?: TimelinePiece[];
  /** Replay styling (slow-mo frame filling). */
  replayStyle?: { smoothing: 'none' | 'blend' | 'motion'; sourceFps: number };
  fx?: VideoFx;
  /** Image-sequence caption track (one input, transparent PNGs of equal size). */
  captionTrack?: { inputIndex: number; y: number };
  /** Sound effects: input index + output time. */
  sfx?: Array<{ inputIndex: number; at: number; volume: number }>;
  /** Voice effects on output-timeline windows. */
  voice?: Array<{ start: number; end: number; effect: VoiceEffect }>;
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
  /** Length of the output timeline in seconds. */
  outputSeconds: number;
}

const f3 = (n: number) => n.toFixed(3);

/** Output duration of a timeline. */
export function timelineSeconds(g: Pick<GraphInput, 'duration' | 'pieces'>): number {
  return g.pieces?.length ? g.pieces.reduce((a, p) => a + p.seconds / p.speed, 0) : g.duration;
}

/**
 * Horizontal crop position for the gameplay panel of the facecam layout: the
 * requested position, moved just past the webcam overlay when they overlap
 * (so the webcam is not shown twice), as long as the window still fits.
 */
export function facecamGameplayX(srcW: number, winW: number, positionX: number, cam: FacecamRect): number {
  const x0 = Math.min(srcW - winW, Math.max(0, positionX * srcW - winW / 2));
  const camL = cam.x * srcW;
  const camR = (cam.x + cam.w) * srcW;
  if (x0 >= camR || x0 + winW <= camL) return Math.round(x0);
  const options = [camL - winW, camR].filter((x) => x >= 0 && x + winW <= srcW);
  if (!options.length) return Math.round(x0);
  return Math.round(options.reduce((best, x) => (Math.abs(x - x0) < Math.abs(best - x0) ? x : best)));
}

/**
 * Compose one input into the vertical frame (blur / crop / smart crop / facecam).
 * `offset` shifts timestamps so time-dependent crops see clip-relative time.
 */
function compose(g: GraphInput, inLabel: string, outLabel: string, tag: string, offset: number, fps: number): string[] {
  const W = g.render.width;
  const H = g.render.height;
  const parts: string[] = [];
  const shift = offset > 0 ? `setpts=PTS-STARTPTS+${f3(offset)}/TB,` : 'setpts=PTS-STARTPTS,';
  const unshift = 'setpts=PTS-STARTPTS';
  if (g.facecam) {
    const camH = even(H * g.facecam.heightFraction);
    const gameH = H - camH;
    const r = g.facecam.rect;
    const cx = Math.round(r.x * g.srcW);
    const cy = Math.round(r.y * g.srcH);
    const cw = even(Math.max(16, r.w * g.srcW));
    const ch = even(Math.max(16, r.h * g.srcH));
    const win = cropWindow(g.srcW, g.srcH, W, gameH);
    const xExpr = g.facecam.cropPath
      ? `'${cropXExpression(g.facecam.cropPath.keyframes)}'`
      : String(facecamGameplayX(g.srcW, win.w, g.render.cropPositionX, r));
    const yExpr = win.h < g.srcH ? String(Math.round((g.srcH - win.h) / 2)) : '0';
    parts.push(`[${inLabel}]${shift}fps=${fps},split=2[${tag}cs][${tag}gs]`);
    parts.push(`[${tag}cs]crop=w=${cw}:h=${ch}:x=${cx}:y=${cy},scale=${W}:${camH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${camH}[${tag}cam]`);
    parts.push(`[${tag}gs]crop=w=${win.w}:h=${win.h}:x=${xExpr}:y=${yExpr},scale=${W}:${gameH}:flags=lanczos[${tag}game]`);
    parts.push(`[${tag}cam][${tag}game]vstack=inputs=2,drawbox=x=0:y=${camH - 3}:w=${W}:h=6:color=black@0.85:t=fill,setsar=1,format=yuv420p,${unshift}[${outLabel}]`);
    return parts;
  }
  if (g.mode === 'blur') {
    // Background: cheap blur at quarter resolution, then upscale; slightly darkened.
    const bw = even(W / 4);
    const bh = even(H / 4);
    const sigma = Math.max(1, g.render.blurStrength / 4);
    const fgW = even(W * g.render.blurForegroundWidth);
    const fgH = Math.min(H, even((fgW * g.srcH) / g.srcW));
    const fgWFinal = fgH === H ? even((H * g.srcW) / g.srcH) : fgW;
    parts.push(`[${inLabel}]fps=${fps},split=2[${tag}bgsrc][${tag}fgsrc]`);
    parts.push(`[${tag}bgsrc]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=${sigma},scale=${W}:${H},eq=brightness=-0.06:saturation=1.1[${tag}bg]`);
    parts.push(`[${tag}fgsrc]scale=${fgWFinal}:${fgH}:flags=lanczos[${tag}fg]`);
    parts.push(`[${tag}bg][${tag}fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[${outLabel}]`);
    return parts;
  }
  const win = cropWindow(g.srcW, g.srcH, W, H);
  let xExpr: string;
  let yExpr = '0';
  const timed = g.mode === 'smart' && g.cropPath;
  if (timed) xExpr = `'${cropXExpression(g.cropPath!.keyframes)}'`;
  else xExpr = String(Math.round(Math.min(g.srcW - win.w, Math.max(0, g.render.cropPositionX * g.srcW - win.w / 2))));
  if (win.h < g.srcH) yExpr = String(Math.round((g.srcH - win.h) / 2));
  parts.push(`[${inLabel}]${timed ? shift : ''}fps=${fps},crop=w=${win.w}:h=${win.h}:x=${xExpr}:y=${yExpr},scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p${timed ? `,${unshift}` : ''}[${outLabel}]`);
  return parts;
}

/** Smooth 0→1→0 envelope: fast attack, hold, release (FFmpeg expression of `v`). */
function envelope(v: string, t: number, hold: number, attack: number, release: number): string {
  return `clip((${v}-${f3(t)})/${f3(attack)},0,1)*clip((${f3(t + hold + release)}-${v})/${f3(release)},0,1)`;
}

/** zoompan filter for zoom punches + camera shake (null if none). */
export function zoomShakeFilter(fx: VideoFx, W: number, H: number, fps: number): string | null {
  if (!fx.zooms.length && !fx.shakes.length) return null;
  const zTerms = fx.zooms.map((z) => `${(0.1 + 0.28 * z.strength).toFixed(3)}*${envelope('it', z.t, Math.max(0.05, z.duration - 0.35), 0.1, 0.3)}`);
  const sEnv = fx.shakes.map((s) => ({ env: envelope('it', s.t, Math.max(0.05, s.duration - 0.2), 0.04, 0.2), amp: s.strength }));
  // Shake needs margin around the frame: zoom in slightly while shaking.
  const zoom = ['1', ...zTerms, ...sEnv.map((s) => `${(0.04 + 0.05 * s.amp).toFixed(3)}*${s.env}`)].join('+');
  const dx = sEnv.map((s) => `${(0.018 * s.amp + 0.006).toFixed(4)}*iw*sin(it*71)*${s.env}`).join('+') || '0';
  const dy = sEnv.map((s) => `${(0.012 * s.amp + 0.004).toFixed(4)}*ih*sin(it*59+1.3)*${s.env}`).join('+') || '0';
  return `zoompan=z='${zoom}':x='clip(iw/2-iw/zoom/2+(${dx}),0,iw-iw/zoom)':y='clip(ih/2-ih/zoom/2+(${dy}),0,ih-ih/zoom)':d=1:s=${W}x${H}:fps=${fps}`;
}

/** eq filter for white impact flashes (null if none). */
export function flashFilter(fx: VideoFx): string | null {
  if (!fx.flashes.length) return null;
  const terms = fx.flashes.map((f) => `${(0.35 + 0.4 * f.strength).toFixed(3)}*exp(-(t-${f3(f.t)})/0.11)*between(t,${f3(f.t)},${f3(f.t + 0.6)})`);
  return `eq=brightness='min(0.85,${terms.join('+')})':eval=frame`;
}

/** RGB-split glitch bursts (one rgbashift per event, timeline-enabled). */
export function glitchFilters(fx: VideoFx): string[] {
  return fx.glitches.map((gl) => {
    const px = Math.round(8 + 18 * gl.strength);
    return `rgbashift=rh=-${px}:bh=${px}:gv=${Math.round(px / 3)}:enable='between(t,${f3(gl.t)},${f3(gl.t + gl.duration)})'`;
  });
}

/** Filter chain of a voice effect. */
export function voiceChain(effect: VoiceEffect): string {
  switch (effect) {
    case 'chipmunk':
      return 'asetrate=48000*1.5,aresample=48000,atempo=0.6667';
    case 'deep':
      return 'asetrate=48000*0.75,aresample=48000,atempo=1.3333';
    case 'echo':
      return 'aecho=0.8:0.88:140|280:0.45|0.28';
    case 'robot':
      return "afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75";
  }
}

function videoChain(g: GraphInput): string[] {
  const W = g.render.width;
  const H = g.render.height;
  const F = g.render.fps;
  const parts: string[] = [];
  if (g.pieces?.length) {
    const labels: string[] = [];
    g.pieces.forEach((p, i) => {
      const tag = `p${i}`;
      if (p.replay) {
        // Slow motion: compose at a higher rate (real frames from high-fps sources), then stretch time.
        const srcFps = g.replayStyle?.sourceFps ?? F;
        const want = F / p.speed;
        const rate = Math.max(F, Math.min(srcFps, want));
        parts.push(...compose(g, `${p.inputIndex}:v:0`, `${tag}c`, tag, p.offset, Math.round(rate * 1000) / 1000));
        const chain = [`setpts=(PTS-STARTPTS)/${p.speed}`];
        const smoothing = g.replayStyle?.smoothing ?? 'blend';
        if (rate * p.speed < F * 0.95 && smoothing !== 'none') {
          chain.push(smoothing === 'motion' ? `minterpolate=fps=${F}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1` : `minterpolate=fps=${F}:mi_mode=blend`);
        }
        chain.push(`fps=${F}`, `crop=iw/1.12:ih/1.12`, `scale=${W}:${H}:flags=lanczos`, 'eq=saturation=1.25:contrast=1.06', 'vignette=PI/5', 'setsar=1', 'format=yuv420p');
        parts.push(`[${tag}c]${chain.join(',')}[${tag}v]`);
      } else {
        parts.push(...compose(g, `${p.inputIndex}:v:0`, `${tag}v`, tag, p.offset, F));
      }
      labels.push(`${tag}v`);
    });
    parts.push(`${labels.map((l) => `[${l}]`).join('')}concat=n=${labels.length}:v=1:a=0[vcat]`);
  } else {
    parts.push(...compose(g, '0:v:0', 'vcat', 'm', 0, F));
  }
  let last = 'vcat';
  const post: string[] = [];
  if (g.fx) {
    const zs = zoomShakeFilter(g.fx, W, H, F);
    if (zs) post.push(zs);
    const fl = flashFilter(g.fx);
    if (fl) post.push(fl);
    post.push(...glitchFilters(g.fx));
  }
  if (post.length) {
    parts.push(`[${last}]${post.join(',')},format=yuv420p[vfx]`);
    last = 'vfx';
  }
  if (g.captionTrack) {
    parts.push(`[${last}][${g.captionTrack.inputIndex}:v]overlay=x=(W-w)/2:y=${Math.round(g.captionTrack.y)}:eof_action=pass[vcap]`);
    last = 'vcap';
  }
  g.overlays.forEach((o, i) => {
    const out = `vov${i}`;
    const y = o.slideIn ? `'if(lt(t-${f3(o.start)},0.25),${Math.round(o.y)}-(0.25-(t-${f3(o.start)}))*${Math.round(H * 0.5)},${Math.round(o.y)})'` : String(Math.round(o.y));
    parts.push(`[${last}][${o.inputIndex}:v]overlay=x=(W-w)/2:y=${y}:enable='between(t,${f3(o.start)},${f3(o.end)})'[${out}]`);
    last = out;
  });
  parts.push(`[${last}]null[vout]`);
  return parts;
}

function audioChain(g: GraphInput): { parts: string[]; out: string | null } {
  const a = g.audio;
  const parts: string[] = [];
  const total = timelineSeconds(g);
  const fadeOutStart = Math.max(0, total - a.fadeOutSeconds);
  const fades = [
    a.fadeInSeconds > 0 ? `afade=t=in:st=0:d=${a.fadeInSeconds}` : '',
    a.fadeOutSeconds > 0 ? `afade=t=out:st=${f3(fadeOutStart)}:d=${a.fadeOutSeconds}` : '',
  ].filter(Boolean);

  // ── Raw game audio on the output timeline ──
  let raw: string | null = null;
  if (g.pieces?.length) {
    if (g.pieces.every((p) => p.audio)) {
      g.pieces.forEach((p, i) => {
        const slow = p.speed !== 1 ? `,asetrate=48000*${p.speed},aresample=48000` : '';
        parts.push(`[${p.audio}]aresample=48000,aformat=channel_layouts=stereo${slow},asetpts=PTS-STARTPTS[pa${i}]`);
      });
      parts.push(`${g.pieces.map((_, i) => `[pa${i}]`).join('')}concat=n=${g.pieces.length}:v=0:a=1[araw]`);
      raw = 'araw';
    }
  } else if (g.gameAudio) raw = g.gameAudio;

  let game: string | null = null;
  if (raw) {
    const chain = ['aresample=48000', 'aformat=channel_layouts=stereo'];
    if (a.volume !== 1) chain.push(`volume=${a.volume}`);
    if (a.denoise === 'light') chain.push('afftdn=nr=10:nf=-42:tn=1');
    if (a.denoise === 'strong') chain.push('afftdn=nr=22:nf=-36:tn=1');
    if (a.normalize) {
      const m = g.loudness;
      chain.push(
        m
          ? `loudnorm=I=${a.targetLufs}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
          : `loudnorm=I=${a.targetLufs}:TP=-1.5:LRA=11`,
        'aresample=48000',
      );
    }
    parts.push(`[${raw}]${chain.join(',')}[g0]`);
    game = 'g0';
    // Voice effects: wet copy replaces the dry signal inside each window.
    (g.voice ?? []).forEach((v, i) => {
      const win = `between(t,${f3(v.start)},${f3(v.end)})`;
      parts.push(`[${game}]asplit=2[vd${i}][vw${i}]`);
      parts.push(`[vw${i}]${voiceChain(v.effect)},volume=0:enable='not(${win})'[vwet${i}]`);
      parts.push(`[vd${i}]volume=0:enable='${win}'[vdry${i}]`);
      parts.push(`[vdry${i}][vwet${i}]amix=inputs=2:duration=first:normalize=0[gv${i}]`);
      game = `gv${i}`;
    });
    if (fades.length) {
      parts.push(`[${game}]${fades.join(',')}[gf]`);
      game = 'gf';
    }
  }

  // ── Sound effects ──
  const sfx = g.sfx ?? [];
  if (sfx.length) {
    if (!game) {
      parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${f3(total)}[gsil]`);
      game = 'gsil';
    }
    sfx.forEach((s, i) => {
      const ms = Math.max(0, Math.round(s.at * 1000));
      parts.push(`[${s.inputIndex}:a:0]aresample=48000,aformat=channel_layouts=stereo,volume=${s.volume.toFixed(2)},adelay=${ms}:all=1[sfx${i}]`);
    });
    parts.push(`[${game}]${sfx.map((_, i) => `[sfx${i}]`).join('')}amix=inputs=${sfx.length + 1}:duration=first:normalize=0[gsfx]`);
    game = 'gsfx';
  }

  let music: string | null = null;
  if (g.music) {
    parts.push(`[${g.music}]aresample=48000,aformat=channel_layouts=stereo,volume=${a.backgroundMusicVolume},${fades.join(',') || 'anull'}[music]`);
    music = 'music';
  }
  if (game && music) {
    if (a.ducking) {
      parts.push(`[${game}]asplit=2[gmain][gkey]`);
      parts.push(`[music][gkey]sidechaincompress=threshold=0.04:ratio=8:attack=20:release=350:makeup=1[mduck]`);
      parts.push(`[gmain][mduck]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false[aout]`);
    } else {
      parts.push(`[${game}][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:level=false[aout]`);
    }
    return { parts, out: 'aout' };
  }
  if (game) {
    parts.push(`[${game}]alimiter=limit=0.95:level=false[aout]`);
    return { parts, out: 'aout' };
  }
  if (music) {
    parts.push(`[music]atrim=duration=${f3(total)},alimiter=limit=0.95:level=false[aout]`);
    return { parts, out: 'aout' };
  }
  return { parts, out: null };
}

/** Build the complete filter_complex for a vertical clip. */
export function buildFilterGraph(g: GraphInput): FilterGraph {
  const v = videoChain(g);
  const a = audioChain(g);
  return { graph: [...v, ...a.parts].join(';'), videoOut: 'vout', audioOut: a.out, outputSeconds: timelineSeconds(g) };
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
