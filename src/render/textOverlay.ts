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

/** Fonts with good Devanagari coverage on macOS (fallbacks for Hindi text). */
const DEVANAGARI_FONTS = 'Kohinoor Devanagari, Mukta, Devanagari Sangam MN, Noto Sans Devanagari, Shobhika';

export function fontFamilyFor(text: string, family: string): string {
  return /[\u0900-\u097F]/.test(text) ? `${DEVANAGARI_FONTS}, ${family}` : family;
}

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
