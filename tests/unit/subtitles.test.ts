import { describe, expect, it } from 'vitest';
import { groupUtterances, mergeShortSegments, parseSpokenLanguage, parseVadSegments, parseWhisperJson, summariseLanguages, toSrt } from '../../src/transcribe/whisper.js';
import { buildSubtitleTracks } from '../../src/transcribe/subtitles.js';
import { hasDevanagari, languageName, validateTranslation } from '../../src/transcribe/translate.js';
import { fontFamilyFor } from '../../src/render/textOverlay.js';

describe('VAD + utterances', () => {
  it('parses whisper-vad-speech-segments output (centiseconds)', () => {
    const out = 'Detected 2 speech segments:\nSpeech segment 0: start = 99.00, end = 173.00\nSpeech segment 1: start = 797.00, end = 1030.00\n';
    expect(parseVadSegments(out)).toEqual([{ start: 0.99, end: 1.73 }, { start: 7.97, end: 10.3 }]);
  });
  it('merges close regions, pads and caps length', () => {
    const u = groupUtterances([{ start: 1, end: 1.7 }, { start: 1.9, end: 3.4 }, { start: 8, end: 10 }], 12);
    expect(u).toEqual([{ start: 0.75, end: 3.65 }, { start: 7.75, end: 10.25 }]);
    const long = groupUtterances(Array.from({ length: 10 }, (_, i) => ({ start: i * 3, end: i * 3 + 2.5 })), 40, { maxLen: 6 });
    expect(long.every((g) => g.end - g.start <= 6.5)).toBe(true);
  });
});

describe('whisper parsing', () => {
  it('drops low-confidence segments and known hallucinations', () => {
    const t = parseWhisperJson({
      result: { language: 'hi' },
      transcription: [
        { offsets: { from: 0, to: 2000 }, text: ' भाई ये देखो', tokens: [{ text: '[_BEG_]', p: 0.9 }, { text: ' भ', p: 0.95 }, { text: 'ाई', p: 0.9 }] },
        { offsets: { from: 2000, to: 4000 }, text: ' mumble', tokens: [{ text: ' mum', p: 0.1 }, { text: 'ble', p: 0.2 }] },
        { offsets: { from: 4000, to: 6000 }, text: ' Thanks for watching!' },
      ],
    });
    expect(t.language).toBe('hi');
    expect(t.segments.map((s) => s.text)).toEqual(['भाई ये देखो']);
  });
  it('parses spoken-language settings', () => {
    expect(parseSpokenLanguage('auto')).toEqual({ mode: 'auto', langs: [] });
    expect(parseSpokenLanguage('hi')).toEqual({ mode: 'fixed', langs: ['hi'] });
    expect(parseSpokenLanguage('hi+en')).toEqual({ mode: 'set', langs: ['hi', 'en'] });
  });
  it('summarises languages by speaking time', () => {
    expect(summariseLanguages([{ start: 0, end: 2, text: 'a', lang: 'hi' }, { start: 3, end: 9, text: 'b', lang: 'en' }])).toBe('en+hi');
    expect(summariseLanguages([])).toBe('und');
  });
  it('merges short segments only within the same language', () => {
    const m = mergeShortSegments([
      { start: 0, end: 0.5, text: 'arre', lang: 'hi' },
      { start: 0.6, end: 2, text: 'bhai', lang: 'hi' },
      { start: 2.1, end: 2.5, text: 'wow', lang: 'en' },
    ]);
    expect(m.map((s) => s.text)).toEqual(['arre bhai', 'wow']);
  });
  it('writes valid SRT', () => {
    expect(toSrt([{ start: 0.71, end: 4.47, text: 'भाई' }, { start: 3661.5, end: 3662, text: 'hi' }])).toBe('1\n00:00:00,710 --> 00:00:04,470\nभाई\n\n2\n01:01:01,500 --> 01:01:02,000\nhi\n');
  });
});

describe('subtitle tracks', () => {
  const segs = [
    { start: 0.7, end: 4.5, text: 'अरे भाई, पुलिस पीछे है', lang: 'hi' },
    { start: 7.7, end: 10.9, text: 'Did you see that jump?', lang: 'en' },
  ];
  const fakeTranslate = async (lines: string[], from: string, to: string) => lines.map((l) => `[${from}->${to}] ${l}`);

  it('translates only lines not already in each target language (mixed Hindi/English)', async () => {
    const r = await buildSubtitleTracks({ language: 'en+hi', segments: segs }, ['hi', 'en'], fakeTranslate);
    expect(r.tracks.map((t) => t.lang)).toEqual(['hi', 'en']);
    expect(r.tracks[0]!.segments.map((s) => s.text)).toEqual(['अरे भाई, पुलिस पीछे है', '[en->hi] Did you see that jump?']);
    expect(r.tracks[1]!.segments.map((s) => s.text)).toEqual(['[hi->en] अरे भाई, पुलिस पीछे है', 'Did you see that jump?']);
    // Timing is preserved exactly.
    expect(r.tracks[1]!.segments.map((s) => [s.start, s.end])).toEqual([[0.7, 4.5], [7.7, 10.9]]);
  });
  it('collapses "original" into the spoken language when the clip is monolingual', async () => {
    const r = await buildSubtitleTracks({ language: 'en', segments: [segs[1]!] }, ['original', 'en'], fakeTranslate);
    expect(r.tracks.map((t) => t.lang)).toEqual(['en']);
  });
  it('produces nothing when there is no speech, and warns without a translator', async () => {
    expect((await buildSubtitleTracks({ language: 'und', segments: [] }, ['hi', 'en'], fakeTranslate)).tracks).toEqual([]);
    const r = await buildSubtitleTracks({ language: 'en', segments: [segs[1]!] }, ['hi', 'en'], null);
    expect(r.tracks.map((t) => t.lang)).toEqual(['en']);
    expect(r.warnings[0]).toMatch(/Hindi subtitles skipped/);
  });
  it('keeps going when translation fails', async () => {
    const r = await buildSubtitleTracks({ language: 'en', segments: [segs[1]!] }, ['hi', 'en'], async () => {
      throw new Error('boom');
    });
    expect(r.tracks.map((t) => t.lang)).toEqual(['en']);
    expect(r.warnings[0]).toMatch(/Hindi translation failed/);
  });
});

describe('translation validation and fonts', () => {
  it('requires exactly one translation per line', () => {
    expect(validateTranslation({ lines: [{ i: 1, text: 'a' }] }, 2, { target: 'en', hindiScript: 'devanagari' }).ok).toBe(false);
    const ok = validateTranslation({ lines: [{ i: 2, text: 'b' }, { i: 1, text: 'a' }] }, 2, { target: 'en', hindiScript: 'devanagari' });
    expect(ok.value).toEqual(['a', 'b']);
  });
  it('rejects romanised output when Devanagari Hindi is requested', () => {
    expect(validateTranslation({ lines: [{ i: 1, text: 'bhai dekho kya hua' }] }, 1, { target: 'hi', hindiScript: 'devanagari' }).ok).toBe(false);
    expect(validateTranslation({ lines: [{ i: 1, text: 'भाई देखो क्या हुआ' }] }, 1, { target: 'hi', hindiScript: 'devanagari' }).ok).toBe(true);
    expect(validateTranslation({ lines: [{ i: 1, text: 'bhai dekho kya hua' }] }, 1, { target: 'hi', hindiScript: 'roman' }).ok).toBe(true);
  });
  it('detects Devanagari and picks a Devanagari-capable font', () => {
    expect(hasDevanagari('भाई')).toBe(true);
    expect(hasDevanagari('bro')).toBe(false);
    expect(fontFamilyFor('भाई', 'Helvetica')).toMatch(/^Kohinoor Devanagari/);
    expect(fontFamilyFor('bro', 'Helvetica')).toBe('Helvetica');
    expect(languageName('hi')).toBe('Hindi');
  });
});

describe('whisper confidence', () => {
  it('reports mean token confidence of kept segments', () => {
    const t = parseWhisperJson({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1000 }, text: ' Run run', tokens: [{ text: ' Run', p: 0.9 }, { text: ' run', p: 0.7 }] }] });
    expect(t.confidence).toBeCloseTo(0.8);
  });
});

import { dominantLanguage } from '../../src/transcribe/whisper.js';
describe('short-utterance language correction', () => {
  const seg = [{}];
  it('finds the dominant language among long utterances only', () => {
    const utts = [{ start: 0, end: 1.2 }, { start: 2, end: 8 }, { start: 9, end: 14 }];
    const parsed = [{ language: 'hi', segments: seg }, { language: 'en', segments: seg }, { language: 'en', segments: seg }];
    expect(dominantLanguage(utts, parsed, ['hi', 'en'])).toBe('en');
  });
  it('returns null for genuinely mixed speech or no long utterances', () => {
    const utts = [{ start: 0, end: 5 }, { start: 6, end: 11 }];
    expect(dominantLanguage(utts, [{ language: 'hi', segments: seg }, { language: 'en', segments: seg }], null)).toBeNull();
    expect(dominantLanguage([{ start: 0, end: 1 }], [{ language: 'hi', segments: seg }], null)).toBeNull();
  });
});
