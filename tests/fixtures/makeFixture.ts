import path from 'node:path';
import fs from 'node:fs';
import { runProcess } from '../../src/util/process.js';

/**
 * Generate a synthetic "gameplay-like" test video: several visually distinct
 * segments (scene changes) with background noise and loud audio bursts at
 * known times. Used by integration tests; no real gameplay needed.
 */
export async function makeFixtureVideo(out: string, opts: { seconds?: number; width?: number; height?: number; fps?: number; audio?: boolean } = {}): Promise<string> {
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const seconds = opts.seconds ?? 60;
  const w = opts.width ?? 1280;
  const h = opts.height ?? 720;
  const fps = opts.fps ?? 30;
  const seg = seconds / 4;
  const sources = ['testsrc2', 'smptehdbars', 'testsrc', 'rgbtestsrc'];
  const v = sources.map((s, i) => `${s}=size=${w}x${h}:rate=${fps},trim=duration=${seg},setpts=PTS-STARTPTS[v${i}]`).join(';');
  const graph = `${v};[v0][v1][v2][v3]concat=n=4:v=1:a=0,format=yuv420p[vout]`;
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.1'];
  const audio = opts.audio !== false;
  if (audio) {
    // Quiet pink noise bed + loud bursts at seg*0.5, seg*2.5 (approx).
    const b1 = (seg * 0.5).toFixed(2);
    const b2 = (seg * 2.5).toFixed(2);
    args.push('-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.02:duration=${seconds}:sample_rate=48000`);
    args.push('-f', 'lavfi', '-i', `anoisesrc=color=white:amplitude=0.9:duration=${seconds}:sample_rate=48000`);
    args.push('-filter_complex', `${graph};[2:a]volume='if(between(t,${b1},${(Number(b1) + 1.2).toFixed(2)})+between(t,${b2},${(Number(b2) + 0.8).toFixed(2)}),1,0)':eval=frame[burst];[1:a][burst]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[aout]`);
    args.push('-map', '[vout]', '-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-filter_complex', graph, '-map', '[vout]');
  }
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-g', String(fps * 2), '-t', String(seconds), '-movflags', '+faststart', out);
  await runProcess('ffmpeg', args, { timeoutMs: 600_000, label: 'ffmpeg fixture' });
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('makeFixture.ts')) {
  const out = process.argv[2] ?? 'tests/fixtures/media/fixture.mp4';
  const seconds = Number(process.argv[3] ?? 60);
  makeFixtureVideo(out, { seconds, width: Number(process.argv[4] ?? 1280), height: Number(process.argv[5] ?? 720), fps: Number(process.argv[6] ?? 30) })
    .then((f) => console.log('fixture', f))
    .catch((e) => { console.error(e); process.exit(1); });
}
