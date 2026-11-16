import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../util/process.js';
import { ensureDir, exists, readJsonOr } from '../util/fsx.js';
import type { FfmpegTools } from '../media/ffmpeg.js';

export interface SoundEffect {
  name: string;
  file: string;
  description: string;
  builtin: boolean;
}

/**
 * Built-in sound effects, synthesised locally with FFmpeg (original sounds, no
 * copyright issues). Expressions are per channel (left|right) at 48 kHz.
 */
const BUILTIN: Array<{ name: string; description: string; seconds: number; left: string; right?: string; af?: string }> = [
  {
    name: 'boom',
    description: 'deep explosion boom — explosions, crashes, big impacts',
    seconds: 1.4,
    left: '0.95*sin(2*PI*(58*t-19*t*t))*exp(-2.8*t)+0.35*(random(0)*2-1)*exp(-18*t)',
    af: 'lowpass=f=900,volume=1.4',
  },
  {
    name: 'hit',
    description: 'punchy impact — kills, hits, landings, punches',
    seconds: 0.4,
    left: 'sin(2*PI*(160*t-190*t*t))*exp(-11*t)+0.55*(random(0)*2-1)*exp(-45*t)',
    af: 'lowpass=f=5000',
  },
  {
    name: 'whoosh',
    description: 'fast swoosh — replays, transitions, fast movement',
    seconds: 0.8,
    left: '(random(0)*2-1)*pow(sin(PI*t/0.8),2)*(1-t/0.8)',
    right: '(random(1)*2-1)*pow(sin(PI*t/0.8),2)*(t/0.8)',
    af: 'highpass=f=400,lowpass=f=3200,volume=2.2',
  },
  {
    name: 'riser',
    description: 'tension build-up — right before a big moment',
    seconds: 1.6,
    left: '0.45*sin(2*PI*(180*t+260*t*t))*(t/1.6)+0.25*(random(0)*2-1)*pow(t/1.6,2)',
    af: 'highpass=f=120',
  },
  {
    name: 'ding',
    description: 'bright bell — success, perfect timing, achievement',
    seconds: 1.3,
    left: '0.5*sin(2*PI*1318.5*t)*exp(-4*t)+0.22*sin(2*PI*2637*t)*exp(-7*t)+0.15*sin(2*PI*1975.5*t)*exp(-5*t)',
  },
  {
    name: 'glitch',
    description: 'digital glitch stutter — glitches, bugs, weird physics',
    seconds: 0.55,
    left: '0.35*sgn(sin(2*PI*(110+170*mod(floor(t*26),5))*t))*gt(mod(floor(t*41),3),0)',
    right: '0.35*sgn(sin(2*PI*(140+150*mod(floor(t*23),4))*t))*gt(mod(floor(t*37),3),0)',
    af: 'lowpass=f=6000',
  },
  {
    name: 'bass-drop',
    description: 'heavy bass drop — epic or insane moments',
    seconds: 1.8,
    left: '0.95*sin(2*PI*(95*t-24*t*t))*min(1,t*25)*exp(-1.3*t)',
  },
  {
    name: 'airhorn',
    description: 'hype air horn — clutch plays, wins, hype',
    seconds: 1.1,
    left: '0.16*(2*(440*t-floor(0.5+440*t))+2*(554.4*t-floor(0.5+554.4*t))+2*(659.3*t-floor(0.5+659.3*t)))*gt(mod(t,0.36),0.05)*min(1,t*60)',
    af: 'lowpass=f=4500,volume=1.3',
  },
  {
    name: 'pop',
    description: 'small cartoon pop — funny little moments',
    seconds: 0.18,
    left: '0.7*sin(2*PI*(520*t+2400*t*t))*exp(-22*t)',
  },
];

const BUILTIN_VERSION = 1;
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i;

export function sfxName(file: string): string {
  return path
    .basename(file)
    .replace(AUDIO_EXT, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Synthesise the built-in effects once (cached in dataDir/sfx-builtin). */
export async function ensureBuiltinSfx(tools: FfmpegTools, dataDir: string): Promise<SoundEffect[]> {
  const dir = path.join(dataDir, 'sfx-builtin', `v${BUILTIN_VERSION}`);
  await ensureDir(dir);
  const out: SoundEffect[] = [];
  for (const b of BUILTIN) {
    const file = path.join(dir, `${b.name}.wav`);
    if (!(await exists(file))) {
      const tmp = `${file}.tmp.wav`;
      await runProcess(
        tools.ffmpeg,
        [
          '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
          '-f', 'lavfi', '-i', `aevalsrc='${b.left}|${b.right ?? b.left}':s=48000:d=${b.seconds}`,
          '-af', `${b.af ? `${b.af},` : ''}afade=t=out:st=${Math.max(0, b.seconds - 0.05).toFixed(3)}:d=0.05,alimiter=limit=0.9:level=false`,
          '-c:a', 'pcm_s16le', tmp,
        ],
        { timeoutMs: 30_000, label: `synthesise ${b.name}` },
      );
      await fsp.rename(tmp, file);
    }
    out.push({ name: b.name, file, description: b.description, builtin: true });
  }
  return out;
}

/**
 * All available sound effects: built-ins plus the user's own files in `sfxDir`
 * (file name = effect name; optional sfxDir/sounds.json {"name": "description"}).
 * User files override built-ins with the same name.
 */
export async function loadSfxLibrary(tools: FfmpegTools, dataDir: string, sfxDir: string): Promise<SoundEffect[]> {
  const lib = new Map<string, SoundEffect>();
  for (const s of await ensureBuiltinSfx(tools, dataDir)) lib.set(s.name, s);
  const descriptions = await readJsonOr<Record<string, string>>(path.join(sfxDir, 'sounds.json'), {});
  const files = await fsp.readdir(sfxDir).catch(() => [] as string[]);
  for (const f of files.filter((x) => AUDIO_EXT.test(x)).sort()) {
    const name = sfxName(f);
    if (!name) continue;
    const desc = typeof descriptions[name] === 'string' ? descriptions[name]!.slice(0, 120) : `your sound "${name}"`;
    lib.set(name, { name, file: path.join(sfxDir, f), description: desc, builtin: false });
  }
  return [...lib.values()];
}
