import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../util/process.js';
import { runFfmpeg, fmtSec, type FfmpegTools } from '../media/ffmpeg.js';
import { ensureDir } from '../util/fsx.js';

let gifskiCheck: Promise<boolean> | null = null;

/** gifski (best GIF quality) is optional; FFmpeg's palette GIFs are the fallback. */
export function gifskiAvailable(executable = 'gifski'): Promise<boolean> {
  gifskiCheck ??= runProcess(executable, ['--version'], { timeoutMs: 10_000, label: 'gifski --version' }).then(
    () => true,
    () => false,
  );
  return gifskiCheck;
}

/** Make a GIF of [start, end] of a video (WhatsApp / Discord friendly: ≤ 8 s, 480 px wide). */
export async function makeGif(o: { tools: FfmpegTools; input: string; start: number; end: number; outFile: string; workDir: string; width?: number; fps?: number; signal?: AbortSignal }): Promise<{ tool: 'gifski' | 'ffmpeg' }> {
  const width = o.width ?? 480;
  const fps = o.fps ?? 12;
  const dur = Math.max(0.5, Math.min(8, o.end - o.start));
  await ensureDir(path.dirname(o.outFile));
  const tmp = `${o.outFile}.tmp.gif`;
  try {
    if (await gifskiAvailable()) {
      const frames = path.join(o.workDir, 'gif-frames');
      await fsp.rm(frames, { recursive: true, force: true });
      await ensureDir(frames);
      await runFfmpeg(o.tools, ['-ss', fmtSec(o.start), '-t', fmtSec(dur), '-i', o.input, '-vf', `fps=${fps},scale=${width}:-2:flags=lanczos`, path.join(frames, 'f%04d.png')], { signal: o.signal, timeoutMs: 120_000, label: 'ffmpeg gif frames' });
      const files = (await fsp.readdir(frames)).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(frames, f));
      await runProcess('gifski', ['--fps', String(fps), '--quality', '80', '--width', String(width), '-o', tmp, ...files], { signal: o.signal, timeoutMs: 180_000, label: 'gifski' });
      await fsp.rm(frames, { recursive: true, force: true });
      await fsp.rename(tmp, o.outFile);
      return { tool: 'gifski' };
    }
    await runFfmpeg(
      o.tools,
      ['-ss', fmtSec(o.start), '-t', fmtSec(dur), '-i', o.input, '-filter_complex', `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=200[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', '-f', 'gif', tmp],
      { signal: o.signal, timeoutMs: 180_000, label: 'ffmpeg gif' },
    );
    await fsp.rename(tmp, o.outFile);
    return { tool: 'ffmpeg' };
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}
