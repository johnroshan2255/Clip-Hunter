import type { ClaudeCli, JsonSchema, ValidationOutcome } from '../ai/claudeCli.js';
import type { FxConfig } from '../config/schema.js';
import type { AudioEvent, Candidate, ClipFx, FxEvent, FxEventType, VoiceEffect } from '../types.js';
import { FX_EVENT_TYPES, VOICE_EFFECTS } from '../types.js';
import { cleanHook, effectBudget, MAX_EVENTS } from './plan.js';
import { languageName } from '../transcribe/translate.js';

export interface DirectorInput {
  candidate: Candidate;
  /** Clip range in the source. */
  start: number;
  end: number;
  /** Transcript lines, clip-relative seconds. */
  transcript?: Array<{ start: number; end: number; text: string; lang?: string }>;
  /** Loud audio onsets (absolute source seconds). */
  audioEvents?: AudioEvent[];
  sounds: Array<{ name: string; description: string }>;
  cfg: FxConfig;
  /** Hook languages ("en", "hi"…); "default" when there are no subtitle reels. */
  hookLanguages: string[];
  hindiScript: 'devanagari' | 'roman';
  game?: string;
  signature: string;
}

interface RawPlan {
  hook?: Record<string, unknown>;
  replay?: { use?: unknown; start?: unknown; end?: unknown };
  events?: Array<Record<string, unknown>>;
}

const IMPACT_CATEGORIES = new Set(['vehicle_crash', 'explosion', 'combat', 'elimination', 'near_death', 'fail', 'action', 'vehicle_stunt', 'clutch', 'skill_play', 'victory', 'police_chase']);

function enabledTypes(cfg: FxConfig): FxEventType[] {
  return FX_EVENT_TYPES.filter((t) => cfg[t]);
}

export function directorSchema(o: Pick<DirectorInput, 'cfg' | 'hookLanguages' | 'sounds'>): JsonSchema {
  const types = enabledTypes(o.cfg);
  const event: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['type', 't', 'duration', 'strength'],
    properties: {
      type: { type: 'string', enum: types.length ? types : ['zoom'] },
      t: { type: 'number' },
      duration: { type: 'number' },
      strength: { type: 'number' },
      ...(o.cfg.sfx && o.sounds.length ? { sound: { type: 'string', enum: o.sounds.map((s) => s.name) } } : {}),
      ...(o.cfg.voice ? { voice: { type: 'string', enum: [...VOICE_EFFECTS] } } : {}),
      why: { type: 'string' },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['hook', 'replay', 'events'],
    properties: {
      hook: { type: 'object', additionalProperties: false, required: o.hookLanguages, properties: Object.fromEntries(o.hookLanguages.map((l) => [l, { type: 'string' }])) },
      replay: { type: 'object', additionalProperties: false, required: ['use', 'start', 'end'], properties: { use: { type: 'boolean' }, start: { type: 'number' }, end: { type: 'number' } } },
      events: { type: 'array', items: event },
    },
  };
}

/**
 * Turn the model's plan (clip-relative seconds) into a ClipFx (absolute
 * seconds). Invalid items are dropped rather than failing the request; only a
 * structurally broken answer is rejected.
 */
export function validatePlan(data: unknown, o: Pick<DirectorInput, 'start' | 'end' | 'cfg' | 'hookLanguages' | 'sounds' | 'signature'>): ValidationOutcome<ClipFx> {
  const d = data as RawPlan | null;
  if (!d || typeof d !== 'object' || !Array.isArray(d.events)) return { ok: false, errors: ['Return an object with "hook", "replay" and "events" (array)'] };
  const dur = o.end - o.start;
  const types = new Set(enabledTypes(o.cfg));
  const sounds = new Set(o.sounds.map((s) => s.name));
  const budget = effectBudget(o.cfg.intensity);
  const events: FxEvent[] = [];
  for (const e of d.events) {
    const type = e.type as FxEventType;
    const t = Number(e.t);
    if (!types.has(type) || !Number.isFinite(t) || t < 0 || t >= dur) continue;
    const ev: FxEvent = { type, t: round3(o.start + t), duration: Number.isFinite(Number(e.duration)) ? Math.max(0, Number(e.duration)) : 0.6, strength: Math.min(1, Math.max(0.1, Number(e.strength) || 0.6)) };
    if (type === 'sfx') {
      if (typeof e.sound !== 'string' || !sounds.has(e.sound)) continue;
      ev.sound = e.sound;
    }
    if (type === 'voice') {
      if (!VOICE_EFFECTS.includes(e.voice as VoiceEffect)) continue;
      ev.voice = e.voice as VoiceEffect;
    }
    events.push(ev);
  }
  events.sort((a, b) => a.t - b.t);
  const hook: Record<string, string> = {};
  if (o.cfg.hookTitle) {
    for (const l of o.hookLanguages) {
      const v = d.hook?.[l];
      if (typeof v === 'string' && cleanHook(v)) hook[l] = cleanHook(v);
    }
    const missing = o.hookLanguages.filter((l) => !hook[l]);
    if (missing.length) return { ok: false, errors: [`hook text missing for: ${missing.join(', ')}`] };
  }
  let replay: ClipFx['replay'] = null;
  const r = d.replay;
  if (o.cfg.replay && r && r.use === true) {
    const s = Math.max(0, Number(r.start));
    const en = Math.min(dur, Number(r.end));
    if (Number.isFinite(s) && Number.isFinite(en) && en - s >= 0.6) replay = { start: round3(o.start + Math.max(s, en - o.cfg.replayMaxSeconds)), end: round3(o.start + en) };
  }
  return {
    ok: true,
    errors: [],
    value: {
      source: 'auto',
      hook: Object.keys(hook).length ? hook : undefined,
      replay,
      events: events.slice(0, Math.min(MAX_EVENTS, budget.max + 2)),
      signature: o.signature,
      generatedAt: new Date().toISOString(),
    },
  };
}

function fmt(n: number): string {
  return n.toFixed(1);
}

export function directorPrompt(o: DirectorInput): string {
  const c = o.candidate;
  const dur = o.end - o.start;
  const budget = effectBudget(o.cfg.intensity);
  const peak = c.peakTime !== undefined ? c.peakTime - o.start : undefined;
  const onsets = (o.audioEvents ?? [])
    .filter((e) => e.t >= o.start && e.t <= o.end)
    .sort((a, b) => b.deltaDb - a.deltaDb)
    .slice(0, 8)
    .sort((a, b) => a.t - b.t)
    .map((e) => `  - ${fmt(e.t - o.start)}s: ${e.kind.replace('_', ' ')}, +${Math.round(e.deltaDb)} dB (${e.character.replace('_', ' ')})`);
  const lines = (o.transcript ?? []).slice(0, 30).map((s) => `  - ${fmt(s.start)}–${fmt(s.end)}s${s.lang ? ` [${s.lang}]` : ''}: ${s.text}`);
  const types = enabledTypes(o.cfg);
  const hookLangs = o.hookLanguages.map((l) =>
    l === 'default' || l === 'en'
      ? `"${l}": English`
      : l === 'hi'
        ? `"hi": Hindi${o.hindiScript === 'roman' ? ' in Latin letters (Hinglish)' : ' in Devanagari script, natural Hinglish gamer tone'}`
        : `"${l}": ${languageName(l)}`,
  );
  return [
    `Plan fun edit effects for one vertical gaming reel${o.game ? ` (${o.game})` : ''}.`,
    '',
    `Clip: ${fmt(dur)} seconds. All times you return are seconds from the clip start (0 – ${fmt(dur)}).`,
    `Title: ${c.title}`,
    `Category: ${c.category.replace(/_/g, ' ')}`,
    `What happens: ${c.description}`,
    c.reason ? `Why it is entertaining: ${c.reason}` : '',
    peak !== undefined ? `Peak moment (the payoff): ${fmt(peak)}s` : '',
    onsets.length ? `Loud audio moments (impacts, gunshots, crashes, shouting):\n${onsets.join('\n')}` : 'No loud audio moments were detected.',
    lines.length ? `Speech in the clip:\n${lines.join('\n')}` : 'No speech in the clip.',
    '',
    `Available effect types: ${types.join(', ') || 'none'}.`,
    o.cfg.zoom ? '- zoom: quick zoom punch-in on an impact or reaction (duration 0.4–1.5 s).' : '',
    o.cfg.shake ? '- shake: camera shake on explosions, crashes, heavy hits (duration 0.3–1 s).' : '',
    o.cfg.flash ? '- flash: white impact flash at the exact frame of an explosion / kill / crash.' : '',
    o.cfg.glitch ? '- glitch: RGB glitch burst — only for glitches, bugs, weird physics or "what just happened" moments (0.2–0.8 s).' : '',
    o.cfg.sfx && o.sounds.length ? `- sfx: a sound effect, set "sound" to one of:\n${o.sounds.map((s) => `    ${s.name}: ${s.description}`).join('\n')}` : '',
    o.cfg.voice ? '- voice: funny voice change on someone talking/screaming, set "voice" to chipmunk, deep, echo or robot (duration 0.8–4 s). Only when it is clearly funny; never on lines the viewer must understand.' : '',
    '',
    'Rules:',
    `- Use ${budget.min}–${budget.max} effects in total (intensity: ${o.cfg.intensity}). Fewer is better than random effects.`,
    '- Every effect must match something that actually happens. Put impact effects exactly on the impact: use the peak moment and the loud audio moments as anchors.',
    '- Do not stack more than two effects within the same second, and leave the first 0.5 s clean.',
    '- strength is 0.1–1 (0.6 = normal).',
    o.cfg.replay
      ? `- replay: set use=true only when there is a clear visual payoff worth seeing again in slow motion (crash, kill, explosion, stunt, fail). start/end = the ${Math.min(1.5, o.cfg.replayMaxSeconds)}–${o.cfg.replayMaxSeconds} s span that ends just after the payoff. For talking or slow moments set use=false.`
      : '- replay: set use=false.',
    o.cfg.hookTitle
      ? `- hook: a short on-screen hook title for the first seconds (max 7 words) that makes people keep watching — curiosity, tension or humour, in the style of viral gaming shorts. Describe only what really happens (no lies, no made-up dialogue), no emoji, no hashtags. Write one per language: ${hookLangs.join('; ')}.`
      : `- hook: return empty strings.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Ask Claude to plan a clip's effects. */
export async function planEffectsWithClaude(claude: ClaudeCli, o: DirectorInput, signal?: AbortSignal): Promise<ClipFx> {
  const res = await claude.invoke<ClipFx>({
    label: `fx plan ${o.candidate.id}`,
    systemPrompt: 'You are a top short-form video editor who makes gaming clips go viral on Reels, Shorts and TikTok. You plan tasteful, well-timed effects. Respond only with JSON matching the schema.',
    prompt: directorPrompt(o),
    schema: directorSchema(o),
    validate: (d) => validatePlan(d, o),
    signal,
  });
  return res.value;
}

/** Rule-based plan used when Claude is unavailable. */
export function heuristicPlan(o: Omit<DirectorInput, 'transcript' | 'sounds'> & { sounds: Array<{ name: string }> }): ClipFx {
  const c = o.candidate;
  const dur = o.end - o.start;
  const peak = Math.min(dur - 0.2, Math.max(0.6, (c.peakTime ?? o.start + dur * 0.6) - o.start));
  const has = (n: string) => o.sounds.some((s) => s.name === n);
  const impact = IMPACT_CATEGORIES.has(c.category);
  const events: FxEvent[] = [];
  const at = (rel: number) => round3(o.start + rel);
  if (o.cfg.zoom) events.push({ type: 'zoom', t: at(Math.max(0.5, peak - 0.05)), duration: 0.9, strength: 0.6 });
  if (impact && o.cfg.flash) events.push({ type: 'flash', t: at(peak), duration: 0, strength: 0.5 });
  if (impact && o.cfg.shake && /crash|explosion|combat|near_death|elimination/.test(c.category)) events.push({ type: 'shake', t: at(peak), duration: 0.6, strength: 0.6 });
  if (o.cfg.sfx) {
    const sound = c.category === 'explosion' || c.category === 'vehicle_crash' ? 'boom' : c.category === 'glitch' ? 'glitch' : c.category === 'funny' || c.category === 'fail' ? 'pop' : 'hit';
    if (has(sound)) events.push({ type: 'sfx', t: at(peak), duration: 0, sound });
  }
  if (c.category === 'glitch' && o.cfg.glitch) events.push({ type: 'glitch', t: at(peak), duration: 0.5, strength: 0.6 });
  const budget = effectBudget(o.cfg.intensity);
  const hook: Record<string, string> = {};
  if (o.cfg.hookTitle && c.title.trim()) for (const l of o.hookLanguages) hook[l] = cleanHook(c.title);
  return {
    source: 'auto',
    hook: Object.keys(hook).length ? hook : undefined,
    replay: o.cfg.replay && impact && peak > 1.2 ? { start: at(Math.max(0, peak - Math.min(o.cfg.replayMaxSeconds, 2.2) + 0.6)), end: at(Math.min(dur, peak + 0.6)) } : null,
    events: events.slice(0, budget.max),
    signature: o.signature,
    generatedAt: new Date().toISOString(),
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
