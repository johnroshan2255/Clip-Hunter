import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { runProcess } from '../util/process.js';
import { ensureDir } from '../util/fsx.js';
import { ValidationError } from '../util/errors.js';
import { isSupportedVideo } from './probe.js';

/**
 * Accept only public http(s) links: no local files, no localhost / private
 * network addresses (the server may be shared on the LAN).
 */
export function validateDownloadUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ValidationError('Enter a full link starting with https://');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ValidationError('Only http(s) links are supported');
  if (u.username || u.password) throw new ValidationError('Links with credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !net.isIP(host)) {
    throw new ValidationError('Local network links are not allowed');
  }
  if (net.isIP(host)) {
    const v4 = net.isIPv4(host) ? host.split('.').map(Number) : null;
    const privateV4 = v4 && (v4[0] === 10 || v4[0] === 127 || v4[0] === 0 || (v4[0] === 169 && v4[1] === 254) || (v4[0] === 172 && v4[1]! >= 16 && v4[1]! <= 31) || (v4[0] === 192 && v4[1] === 168) || (v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127));
    const privateV6 = !v4 && (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host === '::');
    if (privateV4 || privateV6) throw new ValidationError('Local network links are not allowed');
  }
  return u;
}

/** Parse "[download]  42.3% of ~ 1.20GiB at 5.1MiB/s ETA 03:12" progress lines. */
export function parseYtDlpProgress(line: string): number | null {
  const m = /^\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line.trim());
  return m ? Number(m[1]) / 100 : null;
}

/**
 * Download a video with yt-dlp (your own streams / VODs, or videos you have the
 * right to use). Returns the absolute path of the merged MP4/MKV file.
 */
export async function downloadVideo(o: {
  ytdlp: string;
  ffmpeg: string;
  url: string;
  outDir: string;
  maxHeight: number;
  cookiesFromBrowser?: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message?: string) => void;
}): Promise<{ file: string; title?: string }> {
  const url = validateDownloadUrl(o.url).toString();
  await ensureDir(o.outDir);
  let pending = '';
  let stage = 0;
  let last = 0;
  const args = [
    '--newline',
    '--no-playlist',
    '--no-part',
    '--restrict-filenames',
    '-f', `bv*[height<=${o.maxHeight}]+ba/b[height<=${o.maxHeight}]/b`,
    '--merge-output-format', 'mp4',
    '-o', path.join(o.outDir, '%(title).80B [%(id)s].%(ext)s'),
    '--print', 'after_move:filepath',
    '--print', 'before_dl:title',
    ...(path.isAbsolute(o.ffmpeg) ? ['--ffmpeg-location', o.ffmpeg] : []),
    ...(o.cookiesFromBrowser ? ['--cookies-from-browser', o.cookiesFromBrowser] : []),
    '--',
    url,
  ];
  const r = await runProcess(o.ytdlp, args, {
    signal: o.signal,
    timeoutMs: 6 * 3600_000,
    label: 'yt-dlp',
    onStdout: (chunk) => {
      pending += chunk.toString('utf8');
      let nl: number;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const p = parseYtDlpProgress(line);
        if (p === null) continue;
        // Video and audio are downloaded separately: report them as two halves.
        if (p < last - 0.5) stage = Math.min(1, stage + 1);
        last = p;
        o.onProgress?.(Math.min(0.99, (stage + p) / 2), `Downloading ${Math.round(p * 100)}%`);
      }
    },
  });
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const file = [...lines].reverse().find((l) => path.isAbsolute(l) && isSupportedVideo(l));
  if (!file) throw new ValidationError('yt-dlp finished but no video file was produced');
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile() || st.size === 0) throw new ValidationError('Downloaded file is missing or empty');
  const title = lines.find((l) => !path.isAbsolute(l) && !l.startsWith('['));
  return { file, title };
}
