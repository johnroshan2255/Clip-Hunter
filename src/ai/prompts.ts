import type { ContactSheet, SceneChange } from '../types.js';
import { formatTimestamp } from '../util/time.js';

/**
 * System prompt for the AI editor. Game-agnostic: works for open-world games
 * (GTA V / VI, Red Dead…), shooters / battle royales (Fortnite, Warzone,
 * Apex, Valorant…), racing, sports, sandbox and others.
 */
export function editorSystemPrompt(game?: string): string {
  const gameLine = game?.trim()
    ? `The footage is gameplay from ${game.trim()} (as stated by the user — trust this unless the frames clearly show a different game).`
    : 'The game is not specified: identify it from the frames (HUD, art style, map, UI) and judge moments by what is impressive or funny in that particular game.';
  return `You are an experienced short-form gaming video editor who cuts long gameplay recordings into viral Instagram Reels, YouTube Shorts and TikToks.

${gameLine}

You review timestamped contact sheets (grids of video frames). Every tile is labelled "#NN H:MM:SS" with its exact timestamp, and the prompt lists the exact timestamp of every tile. Use only those timestamps — never invent times outside the provided range.

What makes a great clip depends on the game:
- Open-world / sandbox (GTA V, GTA VI, Red Dead, etc.): funny or unexpected situations, spectacular vehicle crashes and stunts, big jumps, police chases with a payoff, explosions in context, wild NPC reactions, ragdoll physics, near-death escapes, fails.
- Shooters / battle royales (Fortnite, Warzone, Apex, PUBG, Valorant, CS, etc.): multi-eliminations, clutch plays (winning while outnumbered or on low health), impressive aim / trick shots, intense build or close-range fights (Fortnite), last-circle and victory moments, funny deaths, unexpected third-parties, outplays.
- Racing / sports / other genres: overtakes, near-misses, wipeouts, comebacks, skill moves, goals, upsets, glitches, anything surprising or funny.

Editorial judgment:
- NOT every crash, explosion, kill or chase is entertaining. Judge context: is the outcome surprising? Is the payoff visible on screen? Would a viewer replay it?
- Penalise: ordinary traversal (driving, walking, running, looting, gliding), lobbies, menus, loading screens, inventory/map screens, spectating, cutscenes without player action, repetitive events you have already flagged, payoffs that happen off-screen or after the recording, and moments lacking the context needed to understand them.
- Prefer moments with a clear setup → action → outcome arc.
- Be calibrated: 9-10 = exceptional, would go viral; 7-8 = strong clip; 5-6 = okay filler; below 5 = not worth posting.
- Frames are sampled at intervals, so you may infer fast action between tiles, but say so in your reason when you do.

Respond only with JSON that matches the requested schema.`;
}

/** Back-compat default (no game specified). */
export const EDITOR_SYSTEM_PROMPT = editorSystemPrompt();

function sheetTimeline(sheet: ContactSheet, imageNumber: number): string {
  const times = sheet.tiles.map((t) => `#${String(t.index).padStart(2, '0')}=${t.t.toFixed(1)}s`).join(' ');
  return `Image ${imageNumber} (${formatTimestamp(sheet.start)}–${formatTimestamp(sheet.end)}): ${times}`;
}

export function describeScenes(changes: SceneChange[], start: number, end: number, limit = 25): string {
  const inRange = changes.filter((c) => c.t >= start && c.t <= end);
  if (!inRange.length) return 'No hard cuts / abrupt visual changes detected.';
  const shown = inRange.length > limit ? inRange.filter((_, i) => i % Math.ceil(inRange.length / limit) === 0) : inRange;
  return `${inRange.length} abrupt visual change(s) at: ${shown.map((c) => `${c.t.toFixed(1)}s`).join(', ')}${shown.length < inRange.length ? ' (sampled)' : ''}`;
}

/** Describe per-second visual activity as a compact profile for the AI. */
export function describeActivity(activity: number[], start: number, end: number, buckets = 12): string {
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(activity.length, Math.ceil(end));
  if (e - s < 2) return 'n/a';
  const size = Math.max(1, Math.ceil((e - s) / buckets));
  const parts: string[] = [];
  for (let b = s; b < e; b += size) {
    const slice = activity.slice(b, Math.min(e, b + size));
    const avg = slice.reduce((a, v) => a + v, 0) / Math.max(1, slice.length);
    parts.push(`${formatTimestamp(b)} ${avg < 1.5 ? 'static' : avg < 4 ? 'low' : avg < 9 ? 'medium' : 'high'}`);
  }
  return parts.join(' | ');
}

export function buildDiscoveryPrompt(o: {
  sheets: ContactSheet[];
  rangeStart: number;
  rangeEnd: number;
  interval: number;
  videoDuration: number;
  audioSummary: string;
  sceneSummary: string;
  activitySummary: string;
  minClip: number;
  maxClip: number;
  game?: string;
}): string {
  return `PASS 1 — BROAD DISCOVERY

You are looking at ${o.sheets.length} contact sheet image(s) covering ${formatTimestamp(o.rangeStart)}–${formatTimestamp(o.rangeEnd)} (${o.rangeStart.toFixed(1)}s–${o.rangeEnd.toFixed(1)}s) of a ${formatTimestamp(o.videoDuration)} gameplay recording${o.game ? ` (${o.game})` : ''}. One frame every ${o.interval}s, read left-to-right, top-to-bottom.

Exact tile timestamps:
${o.sheets.map((s, i) => sheetTimeline(s, i + 1)).join('\n')}

Supporting signals (computed from the recording; use as hints only — loud audio alone does NOT make a moment entertaining):
Audio events:
${o.audioSummary}
Visual cuts: ${o.sceneSummary}
Motion activity: ${o.activitySummary}

TASK: Identify every time range in this footage that could plausibly become an entertaining ${o.minClip}-${o.maxClip}s short-form clip — whatever counts as a highlight in this game (e.g. crashes/stunts/chases/NPC chaos in open-world games; eliminations, clutches, outplays, fights and wins in shooters; plus fails, near-deaths, funny or unusual situations in any game).

Rules:
- "start"/"end" are absolute seconds within ${o.rangeStart.toFixed(1)}–${o.rangeEnd.toFixed(1)}. Cover the whole event: a bit of setup before it and the outcome after it.
- Each distinct event is its own entry. Do not split one event into several entries; do not merge unrelated events.
- Score honestly. It's fine to return an empty "moments" array when nothing is worth clipping.
- Skip lobbies, menus, loading screens, map/inventory screens, spectating, and long stretches of ordinary traversal.
- Also give a one-sentence "summary" of what generally happens in this footage, and set "game" to the game you see (best guess).`;
}

export function buildInspectionPrompt(o: {
  sheets: ContactSheet[];
  windowStart: number;
  windowEnd: number;
  fps: number;
  hypothesis: { start: number; end: number; category: string; description: string; score: number }[];
  audioSummary: string;
  sceneSummary: string;
  minClip: number;
  preferredMin: number;
  preferredMax: number;
  maxClip: number;
  frameAspect: string;
  game?: string;
}): string {
  return `PASS 2 — DETAILED INSPECTION

These ${o.sheets.length} contact sheet(s) show ${formatTimestamp(o.windowStart)}–${formatTimestamp(o.windowEnd)} (${o.windowStart.toFixed(1)}s–${o.windowEnd.toFixed(1)}s) of a ${o.game ? `${o.game} ` : ''}gameplay recording at ${o.fps} frame(s) per second (${o.frameAspect} frames), read left-to-right, top-to-bottom.

Exact tile timestamps:
${o.sheets.map((s, i) => sheetTimeline(s, i + 1)).join('\n')}

A broad first pass flagged this as a possible moment:
${o.hypothesis.map((h) => `- ${h.start.toFixed(1)}s–${h.end.toFixed(1)}s [${h.category}, score ${h.score}]: ${h.description}`).join('\n')}

Supporting signals (hints only):
Audio events:
${o.audioSummary}
Visual cuts: ${o.sceneSummary}

TASK: Inspect the action carefully, before and after the event, and decide the exact clip.
1. Verify the event really happens and is genuinely entertaining for short-form viewers. If not (ordinary traversal, unclear action, payoff happens off-screen, menu/lobby/loading screen, nothing surprising), set verdict "reject" and explain in rejection_reason with an empty moments array.
2. Otherwise return the best clip(s). Usually ONE moment; return two only if the window contains two clearly separate events.
3. Boundaries:
   - start: begin with enough setup for a viewer to understand what is about to happen (typically 2–6s before the key action), but no dead time.
   - end: include the full outcome / aftermath / reaction, then stop — no lingering on ordinary gameplay. Do not cut mid-action.
   - Duration must be between ${o.minClip}s and ${o.maxClip}s; ideally ${o.preferredMin}–${o.preferredMax}s. Let the event decide the length — do not pad.
   - All times are absolute seconds and must lie within ${o.windowStart.toFixed(1)}–${o.windowEnd.toFixed(1)}.
4. peak_time: when the key action/payoff happens.
5. scores (0–10): unexpectedness, visual_clarity, intensity, context, boundary_quality (does the clip start and end cleanly?), replay_value.
6. focus: 3–8 points spread across the clip giving the horizontal position (x: 0 = left edge, 0.5 = centre, 1 = right edge) of the important subject (the player's character/vehicle, the target being fought, or wherever the action is) so a vertical 9:16 crop can follow it. confidence = how sure you are.
7. entertainment_score is your overall judgment (0–10), confidence (0–1) is how sure you are that the clip works.`;
}
