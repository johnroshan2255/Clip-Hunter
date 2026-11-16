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

/**
 * Render a text block as a transparent PNG (full frame width) using SVG via
 * sharp/librsvg. Used instead of FFmpeg drawtext, which requires libfreetype.
 * Supports outline (stroke), drop shadow and any installed font family.
 */
export async function renderTextPng(text: string, style: TextStyle, frameWidth: number, outFile: string): Promise<{ width: number; height: number }> {
  const margin = Math.round(frameWidth * 0.06);
  const lines = wrapText(text, style.fontSize, frameWidth - margin * 2);
  const lineH = Math.round(style.fontSize * 1.22);
  const pad = Math.round(style.fontSize * 0.5 + style.outlineWidth * 2);
  const height = lines.length * lineH + pad * 2;
  const width = frameWidth;
  const shadow = style.shadow
    ? `<filter id="s" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="${Math.max(2, style.fontSize / 16)}" stdDeviation="${Math.max(2, style.fontSize / 14)}" flood-color="#000" flood-opacity="0.75"/></filter>`
    : '';
  const tspans = lines
    .map((l, i) => `<tspan x="${width / 2}" y="${pad + style.fontSize + i * lineH}">${escapeXml(l)}</tspan>`)
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs>${shadow}</defs>` +
    `<text text-anchor="middle" font-family="${escapeXml(style.fontFamily)}" font-size="${style.fontSize}" font-weight="${style.fontWeight}" ` +
    `fill="${escapeXml(style.color)}" stroke="${escapeXml(style.outlineColor)}" stroke-width="${style.outlineWidth}" stroke-linejoin="round" paint-order="stroke"` +
    `${style.shadow ? ' filter="url(#s)"' : ''}>${tspans}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outFile);
  return { width, height };
}
