import path from 'node:path';
import sharp from 'sharp';
import type { AnalysisFrame, ContactSheet } from '../types.js';
import { ensureDir } from '../util/fsx.js';
import { formatTimestamp } from '../util/time.js';
import { mapLimit } from '../util/concurrency.js';

export interface SheetLayout {
  columns: number;
  rows: number;
  tileWidth: number;
  /** Source aspect ratio (width / height). */
  aspect: number;
}

export function tileHeight(layout: SheetLayout): number {
  return Math.max(2, Math.round(layout.tileWidth / layout.aspect / 2) * 2);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

function labelSvg(text: string, tileW: number): Buffer {
  const fontSize = Math.max(12, Math.round(tileW / 18));
  const w = Math.round(fontSize * 0.62 * text.length + fontSize * 0.8);
  const h = Math.round(fontSize * 1.45);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<rect x="0" y="0" width="${w}" height="${h}" rx="3" fill="#000" fill-opacity="0.72"/>` +
      `<text x="${fontSize * 0.4}" y="${fontSize * 1.08}" font-family="Menlo, Courier New, monospace" font-size="${fontSize}" font-weight="bold" fill="#FFE34D">${escapeXml(text)}</text>` +
      `</svg>`,
  );
}

/** Label shown on each tile: "#07 1:02:33". */
export function tileLabel(tileIndex: number, t: number): string {
  return `#${String(tileIndex + 1).padStart(2, '0')} ${formatTimestamp(t, t < 3600 && Math.abs(t - Math.round(t)) > 0.05)}`;
}

/** Compose one contact sheet image from frames (row-major order). */
export async function buildContactSheet(frames: AnalysisFrame[], projectRoot: string, outFile: string, layout: SheetLayout, id: string): Promise<ContactSheet> {
  const th = tileHeight(layout);
  const width = layout.columns * layout.tileWidth;
  const rows = Math.ceil(frames.length / layout.columns);
  const height = rows * th;
  const composites: sharp.OverlayOptions[] = [];
  await Promise.all(
    frames.map(async (f, i) => {
      const left = (i % layout.columns) * layout.tileWidth;
      const top = Math.floor(i / layout.columns) * th;
      const tile = await sharp(path.join(projectRoot, f.file))
        .resize(layout.tileWidth, th, { fit: 'cover' })
        .toBuffer();
      composites[i * 2] = { input: tile, left, top };
      composites[i * 2 + 1] = { input: labelSvg(tileLabel(i, f.t), layout.tileWidth), left: left + 4, top: top + 4 };
    }),
  );
  // 1px separator grid helps the model see tile boundaries.
  const gridSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      Array.from({ length: layout.columns - 1 }, (_, c) => `<rect x="${(c + 1) * layout.tileWidth - 1}" y="0" width="2" height="${height}" fill="#000"/>`).join('') +
      Array.from({ length: rows - 1 }, (_, r) => `<rect x="0" y="${(r + 1) * th - 1}" width="${width}" height="2" fill="#000"/>`).join('') +
      `</svg>`,
  );
  await ensureDir(path.dirname(outFile));
  await sharp({ create: { width, height, channels: 3, background: '#111' } })
    .composite([...composites.filter(Boolean), { input: gridSvg, left: 0, top: 0 }])
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(outFile);
  return {
    id,
    file: path.relative(projectRoot, outFile),
    start: frames[0]?.t ?? 0,
    end: frames[frames.length - 1]?.t ?? 0,
    tiles: frames.map((f, i) => ({ index: i + 1, t: f.t })),
    width,
    height,
  };
}

/** Group frames into contact sheets and render them. */
export async function buildContactSheets(
  frames: AnalysisFrame[],
  projectRoot: string,
  outDir: string,
  layout: SheetLayout,
  opts: { prefix?: string; concurrency?: number; onProgress?: (f: number) => void } = {},
): Promise<ContactSheet[]> {
  const perSheet = layout.columns * layout.rows;
  const groups: AnalysisFrame[][] = [];
  for (let i = 0; i < frames.length; i += perSheet) groups.push(frames.slice(i, i + perSheet));
  let done = 0;
  return mapLimit(groups, opts.concurrency ?? 4, async (g, i) => {
    const id = `${opts.prefix ?? 'sheet'}-${String(i + 1).padStart(4, '0')}`;
    const sheet = await buildContactSheet(g, projectRoot, path.join(outDir, `${id}.jpg`), layout, id);
    opts.onProgress?.(++done / groups.length);
    return sheet;
  });
}
