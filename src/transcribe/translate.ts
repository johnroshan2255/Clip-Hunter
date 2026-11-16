import type { ClaudeCli, JsonSchema, ValidationOutcome } from '../ai/claudeCli.js';

/** Human-readable language name for an ISO code ("hi" → "Hindi"). */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Contains Devanagari characters (Hindi, Marathi, Nepali…). */
export function hasDevanagari(text: string): boolean {
  return /[ऀ-ॿ]/.test(text);
}

const schema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['i', 'text'],
        properties: { i: { type: 'integer' }, text: { type: 'string' } },
      },
    },
  },
};

export function validateTranslation(data: unknown, count: number, opts: { target: string; hindiScript: 'devanagari' | 'roman' }): ValidationOutcome<string[]> {
  const lines = (data as { lines?: Array<{ i?: unknown; text?: unknown }> })?.lines;
  if (!Array.isArray(lines)) return { ok: false, errors: ['"lines" must be an array'] };
  const out = new Array<string | undefined>(count).fill(undefined);
  for (const l of lines) {
    if (typeof l?.i === 'number' && l.i >= 1 && l.i <= count && typeof l.text === 'string') out[l.i - 1] = l.text.replace(/\s+/g, ' ').trim();
  }
  const missing = out.map((t, k) => (t === undefined ? k + 1 : 0)).filter(Boolean);
  if (missing.length) return { ok: false, errors: [`Missing translations for line(s): ${missing.join(', ')} — return exactly ${count} lines numbered 1..${count}`] };
  if (opts.target === 'hi' && opts.hindiScript === 'devanagari') {
    const translated = out.filter((t) => t && /[a-z]{3,}/i.test(t) && !hasDevanagari(t!));
    if (translated.length > count / 2) return { ok: false, errors: ['Hindi lines must be written in Devanagari script (देवनागरी), not Latin letters'] };
  }
  return { ok: true, value: out as string[], errors: [] };
}

/**
 * Translate subtitle lines with the local Claude CLI, one request per clip.
 * Timing is kept from the transcription; only the text changes.
 */
export async function translateLines(
  claude: ClaudeCli,
  lines: string[],
  from: string,
  to: string,
  opts: { hindiScript: 'devanagari' | 'roman'; game?: string; signal?: AbortSignal },
): Promise<string[]> {
  if (!lines.length) return [];
  const target =
    to === 'hi'
      ? opts.hindiScript === 'roman'
        ? 'Hindi written in Latin letters (Hinglish, the way Indian gamers type, e.g. "bhai ye dekho kya hua")'
        : 'Hindi in Devanagari script (natural spoken Hindi, the way Indian gamers talk; English gaming words like "headshot" may stay in English but written in Devanagari or kept as-is)'
      : languageName(to);
  const prompt =
    `Translate these ${lines.length} subtitle lines from ${from === 'und' || from === 'auto' ? 'the spoken language' : languageName(from)} to ${target}.\n` +
    `They are speech from a ${opts.game ? `${opts.game} ` : ''}gameplay clip (players, streamers or game characters).\n` +
    `Rules:\n- Translate meaning faithfully and naturally; keep it short and punchy like real subtitles.\n- Never add content, jokes or words that are not in the original.\n- Keep names (characters, places, players) unchanged.\n- If a line is already in the target language, return it unchanged.\n- Return exactly ${lines.length} lines with the same numbers.\n\n` +
    lines.map((l, k) => `${k + 1}. ${l}`).join('\n');
  const res = await claude.invoke<string[]>({
    label: `translate ${from}->${to}`,
    systemPrompt: 'You are a professional subtitle translator for gaming videos. Respond only with JSON matching the schema.',
    prompt,
    schema,
    validate: (d) => validateTranslation(d, lines.length, { target: to, hindiScript: opts.hindiScript }),
    signal: opts.signal,
  });
  return res.value;
}
