import path from 'node:path';
import sharp from 'sharp';
import type { ClaudeCli, JsonSchema, ValidationOutcome } from '../ai/claudeCli.js';
import type { FacecamRect } from '../types.js';
import { ensureDir } from '../util/fsx.js';

/** Draw a labelled 10×10 grid over a frame so the model can give precise coordinates. */
export async function gridImage(frameFile: string, outFile: string, width = 960): Promise<void> {
  const img = sharp(frameFile).resize({ width });
  const { data, info } = await img.jpeg().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const lines: string[] = [];
  for (let i = 1; i < 10; i++) {
    const x = (W * i) / 10;
    const y = (H * i) / 10;
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#00ffff" stroke-opacity="0.55" stroke-width="1"/>`);
    lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#00ffff" stroke-opacity="0.55" stroke-width="1"/>`);
    lines.push(`<text x="${x + 2}" y="12" font-size="11" font-family="Arial" fill="#ffff00" stroke="#000" stroke-width="2" paint-order="stroke">${(i / 10).toFixed(1)}</text>`);
    lines.push(`<text x="2" y="${y - 2}" font-size="11" font-family="Arial" fill="#ffff00" stroke="#000" stroke-width="2" paint-order="stroke">${(i / 10).toFixed(1)}</text>`);
  }
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${lines.join('')}</svg>`);
  await ensureDir(path.dirname(outFile));
  await sharp(data).composite([{ input: overlay }]).jpeg({ quality: 82 }).toFile(outFile);
}

const schema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['present', 'x', 'y', 'w', 'h', 'confidence'],
  properties: {
    present: { type: 'boolean' },
    x: { type: 'number' },
    y: { type: 'number' },
    w: { type: 'number' },
    h: { type: 'number' },
    confidence: { type: 'number' },
    description: { type: 'string' },
  },
};

export function validateFacecam(d: unknown): ValidationOutcome<FacecamRect | null> {
  const r = d as { present?: unknown; x?: number; y?: number; w?: number; h?: number; confidence?: number } | null;
  if (!r || typeof r.present !== 'boolean') return { ok: false, errors: ['"present" must be true or false'] };
  if (!r.present || (r.confidence ?? 0) < 0.6) return { ok: true, value: null, errors: [] };
  const rect = { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) };
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return { ok: false, errors: ['x, y, w, h must be numbers between 0 and 1'] };
  if (rect.w < 0.05 || rect.h < 0.05 || rect.w > 0.7 || rect.h > 0.7) return { ok: false, errors: ['The webcam box should be 0.05–0.7 of the frame in each dimension; if there is no webcam overlay, set present=false'] };
  return { ok: true, value: clampRect(rect), errors: [] };
}

export function clampRect(r: FacecamRect): FacecamRect {
  const x = Math.min(0.95, Math.max(0, r.x));
  const y = Math.min(0.95, Math.max(0, r.y));
  return { x: round3(x), y: round3(y), w: round3(Math.min(1 - x, Math.max(0.05, r.w))), h: round3(Math.min(1 - y, Math.max(0.05, r.h))) };
}

/**
 * Ask Claude whether the recording has a webcam (facecam) overlay and where.
 * Uses three frames from different parts of the video (the overlay is static).
 */
export async function detectFacecam(claude: ClaudeCli, frameFiles: string[], workDir: string, signal?: AbortSignal): Promise<FacecamRect | null> {
  const images: string[] = [];
  for (const [i, f] of frameFiles.slice(0, 3).entries()) {
    const out = path.join(workDir, `facecam-grid-${i}.jpg`);
    await gridImage(f, out);
    images.push(out);
  }
  const res = await claude.invoke<FacecamRect | null>({
    label: 'facecam detection',
    systemPrompt: 'You analyse gameplay recordings. Respond only with JSON matching the schema.',
    prompt:
      `These ${images.length} frames come from different parts of the same gameplay recording. A cyan grid with labels (0.1 … 0.9) marks fractions of the frame width (top labels) and height (left labels).\n` +
      'Is there a webcam / facecam overlay showing a real person (the streamer) that stays in the same place in every frame? ' +
      'If yes, give its bounding box as fractions of the frame: x, y = top-left corner, w, h = size. Include the whole camera rectangle including its border. ' +
      'Game HUD elements, minimaps and in-game characters are NOT a facecam. If there is no webcam overlay, set present=false and the numbers to 0.',
    images,
    schema,
    validate: validateFacecam,
    signal,
  });
  return res.value;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
