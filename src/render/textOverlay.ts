import sharp from 'sharp';
import type { TextStyle } from '../config/schema.js';

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);
}

/** Greedy word wrap using an approximate glyph width. */
export function wrapText(text: string, fontSize: number, maxWidth: number, maxLines = 4): string[] {
  const approxChar = fontSize * 0.56;
  const maxChars = Math.max(6, Math.floor(maxWidth / approxChar));
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1]!.replace(/.{0,1}$/, '…');
    return kept;
  }
  return lines;
}

/** Fonts with good Devanagari coverage: macOS, Windows (Nirmala UI), Linux/Google (Noto, Mukta). */
const DEVANAGARI_FONTS = 'Kohinoor Devanagari, Nirmala UI, Mukta, Devanagari Sangam MN, Noto Sans Devanagari, Mangal, Shobhika';
/** Latin fallbacks present on every platform (Helvetica is macOS-only). */
const LATIN_FALLBACK = 'Arial, Segoe UI, Liberation Sans, DejaVu Sans, sans-serif';

export function fontFamilyFor(text: string, family: string): string {
  return /[\u0900-\u097F]/.test(text) ? `${DEVANAGARI_FONTS}, ${family}, ${LATIN_FALLBACK}` : `${family}, ${LATIN_FALLBACK}`;
}

const deva = (s: string) => /[\u0900-\u097F]/.test(s);

export interface TextBlock {
  text: string;
  style: TextStyle;
}

/**
 * Render one or more stacked text blocks (e.g. Hindi line above its English
 * translation) as a transparent full-width PNG using SVG via sharp/librsvg.
 * Used instead of FFmpeg drawtext, which requires libfreetype. Supports outline
 * (stroke), drop shadow, any installed font family and complex scripts such as
 * Devanagari (shaped by Pango).
 */
export async function renderTextBlocksPng(blocks: TextBlock[], frameWidth: number, outFile: string): Promise<{ width: number; height: number }> {
  const margin = Math.round(frameWidth * 0.06);
  const width = frameWidth;
  let y = 0;
  const parts: string[] = [];
  const filters: string[] = [];
  blocks.forEach((b, bi) => {
    const st = b.style;
    // Devanagari glyphs are taller (matras above/below): give them more line height.
    const deva = /[\u0900-\u097F]/.test(b.text);
    const lines = wrapText(b.text, st.fontSize, width - margin * 2, 3);
    const lineH = Math.round(st.fontSize * (deva ? 1.45 : 1.22));
    const pad = Math.round(st.fontSize * (bi === 0 ? 0.5 : 0.15) + st.outlineWidth * 2);
    if (st.shadow) {
      filters.push(`<filter id="s${bi}" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="${Math.max(2, st.fontSize / 16)}" stdDeviation="${Math.max(2, st.fontSize / 14)}" flood-color="#000" flood-opacity="0.75"/></filter>`);
    }
    const tspans = lines.map((l, i) => `<tspan x="${width / 2}" y="${y + pad + st.fontSize + i * lineH}">${escapeXml(l)}</tspan>`).join('');
    parts.push(
      `<text text-anchor="middle" font-family="${escapeXml(fontFamilyFor(b.text, st.fontFamily))}" font-size="${st.fontSize}" font-weight="${st.fontWeight}" ` +
        `fill="${escapeXml(st.color)}" stroke="${escapeXml(st.outlineColor)}" stroke-width="${st.outlineWidth}" stroke-linejoin="round" paint-order="stroke"` +
        `${st.shadow ? ` filter="url(#s${bi})"` : ''}>${tspans}</text>`,
    );
    y += lines.length * lineH + pad + Math.round(st.fontSize * 0.25);
  });
  const height = Math.max(2, Math.round(y + 8));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${filters.join('')}</defs>${parts.join('')}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outFile);
  return { width, height };
}

/** Single text block (intro / ending text, captions). */
export async function renderTextPng(text: string, style: TextStyle, frameWidth: number, outFile: string): Promise<{ width: number; height: number }> {
  return renderTextBlocksPng([{ text, style }], frameWidth, outFile);
}

// ── Caption track frames (all the same size so they can be played as one image sequence) ──

export interface Layout {
  height: number;
  defs: string[];
  /** SVG elements, drawn with the block's top at `top`. */
  draw: (top: number) => string;
}

function shadowFilter(id: string, st: TextStyle): string {
  return `<filter id="${id}" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="${Math.max(2, st.fontSize / 16)}" stdDeviation="${Math.max(2, st.fontSize / 14)}" flood-color="#000" flood-opacity="0.75"/></filter>`;
}

/** Karaoke caption: a few words, the active one highlighted (and slightly larger). */
export function layoutKaraoke(words: string[], active: number, st: TextStyle, highlight: string, frameWidth: number): Layout {
  const margin = Math.round(frameWidth * 0.07);
  const isDeva = deva(words.join(' '));
  const size = Math.round(st.fontSize * 1.18);
  const lines = wrapText(words.join(' '), size, frameWidth - margin * 2, 2);
  // Re-split lines into word indexes.
  let k = 0;
  const lineWords = lines.map((l) => l.split(' ').map(() => k++));
  const lineH = Math.round(size * (isDeva ? 1.5 : 1.25));
  const pad = Math.round(size * 0.35 + st.outlineWidth * 2);
  const height = lines.length * lineH + pad * 2;
  const family = escapeXml(fontFamilyFor(words.join(' '), st.fontFamily));
  return {
    height,
    defs: st.shadow ? [shadowFilter('ks', st)] : [],
    draw: (top) =>
      lineWords
        .map((idxs, li) => {
          const spans = idxs
            .map((wi) => {
              const on = wi === active;
              return `<tspan fill="${escapeXml(on ? highlight : st.color)}"${on ? ` font-size="${Math.round(size * 1.12)}"` : ''}>${escapeXml(words[wi] ?? '')}</tspan>`;
            })
            .join(' ');
          return (
            `<text xml:space="preserve" x="${frameWidth / 2}" y="${top + pad + size + li * lineH}" text-anchor="middle" font-family="${family}" font-size="${size}" font-weight="${st.fontWeight}" ` +
            `stroke="${escapeXml(st.outlineColor)}" stroke-width="${Math.round(st.outlineWidth * 1.25)}" stroke-linejoin="round" paint-order="stroke"${st.shadow ? ' filter="url(#ks)"' : ''}>${spans}</text>`
          );
        })
        .join(''),
  };
}

/** Stacked text blocks (e.g. Hindi above English). */
export function layoutBlocks(blocks: TextBlock[], frameWidth: number): Layout {
  const margin = Math.round(frameWidth * 0.06);
  let y = 0;
  const defs: string[] = [];
  const items: Array<(top: number) => string> = [];
  blocks.forEach((b, bi) => {
    const st = b.style;
    const lines = wrapText(b.text, st.fontSize, frameWidth - margin * 2, 3);
    const lineH = Math.round(st.fontSize * (deva(b.text) ? 1.45 : 1.22));
    const pad = Math.round(st.fontSize * (bi === 0 ? 0.5 : 0.15) + st.outlineWidth * 2);
    if (st.shadow) defs.push(shadowFilter(`bs${bi}`, st));
    const y0 = y;
    items.push((top) => {
      const tspans = lines.map((l, i) => `<tspan x="${frameWidth / 2}" y="${top + y0 + pad + st.fontSize + i * lineH}">${escapeXml(l)}</tspan>`).join('');
      return (
        `<text text-anchor="middle" font-family="${escapeXml(fontFamilyFor(b.text, st.fontFamily))}" font-size="${st.fontSize}" font-weight="${st.fontWeight}" ` +
        `fill="${escapeXml(st.color)}" stroke="${escapeXml(st.outlineColor)}" stroke-width="${st.outlineWidth}" stroke-linejoin="round" paint-order="stroke"` +
        `${st.shadow ? ` filter="url(#bs${bi})"` : ''}>${tspans}</text>`
      );
    });
    y += lines.length * lineH + pad + Math.round(st.fontSize * 0.25);
  });
  return { height: Math.max(2, Math.round(y + 8)), defs, draw: (top) => items.map((f) => f(top)).join('') };
}

/** Render layouts onto equally sized transparent canvases (content vertically centred). */
export async function renderLayoutsPng(layouts: Array<{ layout: Layout | null; file: string }>, frameWidth: number): Promise<number> {
  const canvasH = even2(Math.max(4, ...layouts.map((l) => l.layout?.height ?? 0)));
  for (const { layout, file } of layouts) {
    const top = layout ? Math.round((canvasH - layout.height) / 2) : 0;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frameWidth}" height="${canvasH}"><defs>${layout?.defs.join('') ?? ''}</defs>${layout?.draw(top) ?? ''}</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(file);
  }
  return canvasH;
}

function even2(n: number): number {
  const r = Math.ceil(n);
  return r % 2 ? r + 1 : r;
}

/**
 * Text on a rounded box (hook titles, REPLAY badge). The text is measured by
 * rendering it once and trimming, so the box fits any script.
 */
export async function renderBoxedTextPng(
  text: string,
  o: { fontSize: number; color: string; box: string; fontFamily: string; maxLines?: number; rotate?: number },
  frameWidth: number,
  outFile: string,
): Promise<{ width: number; height: number }> {
  const margin = Math.round(frameWidth * 0.08);
  const lines = wrapText(text, o.fontSize, frameWidth - margin * 2, o.maxLines ?? 3);
  const lineH = Math.round(o.fontSize * (deva(text) ? 1.42 : 1.18));
  const family = escapeXml(fontFamilyFor(text, o.fontFamily));
  const textH = lines.length * lineH + o.fontSize;
  const textSvg = (fill: string) =>
    `<text text-anchor="middle" font-family="${family}" font-size="${o.fontSize}" font-weight="bold" fill="${fill}">` +
    lines.map((l, i) => `<tspan x="${frameWidth / 2}" y="${o.fontSize * 1.1 + i * lineH}">${escapeXml(l)}</tspan>`).join('') +
    `</text>`;
  const measure = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${frameWidth}" height="${textH}">${textSvg('#000')}</svg>`))
    .trim()
    .toBuffer({ resolveWithObject: true })
    .catch(() => null);
  const padX = Math.round(o.fontSize * 0.45);
  const padY = Math.round(o.fontSize * 0.3);
  const bx = measure ? Math.max(0, -(measure.info.trimOffsetLeft ?? 0) - padX) : margin;
  const by = measure ? Math.max(0, -(measure.info.trimOffsetTop ?? 0) - padY) : 0;
  const bw = measure ? Math.min(frameWidth - bx, measure.info.width + padX * 2) : frameWidth - margin * 2;
  const bh = measure ? measure.info.height + padY * 2 : textH;
  const height = even2(by + bh + 12);
  const rot = o.rotate ? ` transform="rotate(${o.rotate} ${frameWidth / 2} ${height / 2})"` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${frameWidth}" height="${height}"><defs><filter id="bxs" x="-10%" y="-20%" width="120%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity="0.45"/></filter></defs>` +
    `<g${rot}><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${Math.round(o.fontSize * 0.28)}" fill="${escapeXml(o.box)}" filter="url(#bxs)"/>${textSvg(escapeXml(o.color))}</g></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outFile);
  return { width: frameWidth, height };
}
