import type { TranscriptSegment, Transcript } from './whisper.js';
import { languageName } from './translate.js';

export interface SubtitleTrack {
  /** ISO code of this track's language ("orig" = each line as spoken, for mixed-language clips). */
  lang: string;
  /** Same timing as the transcript; text in `lang`. */
  segments: TranscriptSegment[];
  /** True if any line of this track is machine-translated. */
  translated: boolean;
}

export interface SubtitleResult {
  /** Spoken language(s), e.g. "hi", "en" or "hi+en". */
  spokenLanguage: string;
  tracks: SubtitleTrack[];
  warnings: string[];
}

export type TranslateFn = (lines: string[], from: string, to: string) => Promise<string[]>;

/**
 * Resolve the requested subtitle languages (e.g. ["hi", "en"] or ["original"])
 * into tracks. Lines already spoken in a target language are used as-is; the
 * rest are translated (one request per target language), keeping transcript timing.
 */
export async function buildSubtitleTracks(transcript: Transcript, requested: string[], translate: TranslateFn | null): Promise<SubtitleResult> {
  const warnings: string[] = [];
  const tracks: SubtitleTrack[] = [];
  const segs = transcript.segments;
  const spoken = transcript.language || 'und';
  if (!segs.length) return { spokenLanguage: spoken, tracks, warnings };
  const langOf = (s: TranscriptSegment) => s.lang ?? (spoken.includes('+') ? 'und' : spoken);
  const mixed = new Set(segs.map(langOf)).size > 1;
  const single = mixed ? null : langOf(segs[0]!);

  const wanted: string[] = [];
  for (const r of requested) {
    const l = r === 'original' ? (single && single !== 'und' ? single : 'orig') : r;
    if (!wanted.includes(l)) wanted.push(l);
  }
  for (const lang of wanted) {
    if (lang === 'orig') {
      tracks.push({ lang: 'orig', segments: segs, translated: false });
      continue;
    }
    const need = segs.map((s, i) => (langOf(s) === lang ? -1 : i)).filter((i) => i >= 0);
    if (!need.length) {
      tracks.push({ lang, segments: segs, translated: false });
      continue;
    }
    if (!translate) {
      warnings.push(`${languageName(lang)} subtitles skipped: translation needs the Claude CLI`);
      continue;
    }
    try {
      const fromLangs = [...new Set(need.map((i) => langOf(segs[i]!)))];
      const from = fromLangs.length === 1 ? fromLangs[0]! : 'und';
      const texts = await translate(need.map((i) => segs[i]!.text), from, lang);
      const out = segs.map((s) => ({ ...s }));
      need.forEach((i, k) => {
        out[i]!.text = texts[k] ?? out[i]!.text;
      });
      tracks.push({ lang, segments: out, translated: true });
    } catch (err) {
      if ((err as { code?: string }).code === 'CANCELLED') throw err;
      warnings.push(`${languageName(lang)} translation failed: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  return { spokenLanguage: spoken, tracks, warnings };
}
