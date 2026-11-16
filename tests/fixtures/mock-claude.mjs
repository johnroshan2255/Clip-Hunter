#!/usr/bin/env node
// Mock of the Claude Code CLI for tests: speaks the same `-p --input-format stream-json
// --output-format stream-json` protocol and returns deterministic, schema-valid moments.
// Behaviour switches via env: MOCK_CLAUDE_MODE=ok|garbage-once|error|auth
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('9.9.9 (Mock Claude Code)');
  process.exit(0);
}
const mode = process.env.MOCK_CLAUDE_MODE ?? 'ok';
const schemaArg = args[args.indexOf('--json-schema') + 1] ?? '';
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const msg = JSON.parse(input.trim().split('\n')[0]);
  const content = msg.message.content;
  const images = content.filter((c) => c.type === 'image').length;
  const text = content.find((c) => c.type === 'text')?.text ?? '';
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', model: 'mock-model' });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: Math.floor(Date.now() / 1000) + 3600, unifiedWindows: { five_hour: { utilization: 0.1 } } } });
  if (mode === 'auth') {
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
    process.exit(1);
  }
  if (mode === 'error') {
    process.stderr.write('API Error: 529 overloaded\n');
    process.exit(1);
  }
  // Corrective-retry test: first call (no CORRECTION in prompt) returns an invalid answer.
  const counter = process.env.MOCK_CLAUDE_COUNTER;
  if (mode === 'garbage-once' && !text.includes('IMPORTANT CORRECTION')) {
    if (counter) fs.appendFileSync(counter, 'garbage\n');
    out({ type: 'result', subtype: 'success', is_error: false, result: 'not json', structured_output: { moments: [{ start: 999999, end: 5, category: 'x', entertainment_score: 'high' }] } });
    return;
  }
  if (counter) fs.appendFileSync(counter, 'ok\n');
  const m = /\((\d+(?:\.\d+)?)s[–-](\d+(?:\.\d+)?)s\)/.exec(text);
  const start = m ? Number(m[1]) : 0;
  const end = m ? Number(m[2]) : 60;
  let structured;
  let schema = {};
  try {
    schema = JSON.parse(schemaArg);
  } catch {
    /* not JSON */
  }
  if (schema.properties?.present) {
    // Facecam detection: the synthetic fixture has no webcam.
    structured = { present: false, x: 0, y: 0, w: 0, h: 0, confidence: 0.9 };
  } else if (schema.properties?.events && schema.properties?.replay) {
    // Effects plan: hook per requested language, a replay, a zoom + sound on the "impact".
    const langs = schema.properties.hook?.required ?? [];
    const sounds = schema.properties.events.items.properties.sound?.enum ?? [];
    structured = {
      hook: Object.fromEntries(langs.map((l) => [l, l === 'hi' ? 'ये देखो क्या हुआ' : 'Mock hook: watch this 🔥'])),
      replay: { use: true, start: 2, end: 4.5 },
      events: [
        { type: 'zoom', t: 3, duration: 0.8, strength: 0.7 },
        { type: 'flash', t: 3.1, duration: 0, strength: 0.5 },
        ...(sounds.includes('boom') ? [{ type: 'sfx', t: 3.1, duration: 0, strength: 0.6, sound: 'boom' }] : []),
        { type: 'shake', t: 3.1, duration: 0.5, strength: 0.6 },
        { type: 'zoom', t: 999, duration: 1, strength: 0.5 },
      ],
    };
  } else if (schemaArg.includes('verdict')) {
    // Inspection: one refined moment centred in the window.
    const mid = (start + end) / 2;
    const s = Math.max(start, mid - 9);
    const e = Math.min(end, mid + 9);
    structured = {
      verdict: 'keep',
      moments: [{
        start: s, end: e, peak_time: mid, category: 'vehicle_stunt', title: 'Mock stunt', description: `Mock refined moment (${images} images)`,
        entertainment_score: 7 + (Math.round(mid) % 3), confidence: 0.85, reason: 'mock',
        scores: { unexpectedness: 7, visual_clarity: 8, intensity: 7, context: 6, boundary_quality: 7, replay_value: 7 },
        focus: [{ t: s, x: 0.4, confidence: 0.8 }, { t: mid, x: 0.5, confidence: 0.8 }, { t: e, x: 0.6, confidence: 0.8 }],
      }],
    };
  } else {
    // Discovery: one moment per ~40s of range.
    const moments = [];
    for (let t = start + 5; t + 12 < end; t += 40) {
      moments.push({ start: t, end: t + 12, category: 'vehicle_crash', title: `Mock crash at ${t}`, description: 'mock', entertainment_score: 7, confidence: 0.8, reason: 'mock' });
    }
    structured = { summary: `Mock summary for ${start}-${end}`, game: 'Mock Game', moments };
  }
  out({ type: 'assistant', message: { model: 'mock-model', content: [{ type: 'text', text: JSON.stringify(structured) }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(structured), structured_output: structured, total_cost_usd: 0.001, usage: { input_tokens: 100 * images, output_tokens: 50 } });
});
