import { describe, expect, it } from 'vitest';
import { normaliseProbe, parseRate } from '../../src/media/probe.js';
import { parseSceneMetadata, planChunks } from '../../src/media/frames.js';
import { EnvelopeAccumulator, analyseEnvelope, audioScoreForRange, quietestNear } from '../../src/media/audio.js';
import { buildFilterGraph, parseLoudnorm } from '../../src/render/filters.js';
import { buildCropPath, cropWindow, cropXExpression, motionCentroids } from '../../src/render/smartCrop.js';
import { parseMaxVolume } from '../../src/render/validate.js';
import { parseWhisperJson } from '../../src/transcribe/whisper.js';
import { wrapText } from '../../src/render/textOverlay.js';
import { escapeFilterValue } from '../../src/media/ffmpeg.js';
import { formatTimestamp, parseTimestamp, overlapRatio } from '../../src/util/time.js';
import { loadConfig, effectiveConfig } from '../../src/config/load.js';

describe('probe normalisation', () => {
  const raw = {
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '47300/1000', r_frame_rate: '60/1', pix_fmt: 'yuv420p' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000', disposition: { default: 0 } },
      { index: 2, codec_type: 'audio', codec_name: 'opus', channels: 1, sample_rate: '48000', disposition: { default: 1 } },
    ],
    format: { duration: '3600.5', format_name: 'mov,mp4', start_time: '0.0' },
  };
  it('extracts metadata, detects VFR and picks the default audio stream', () => {
    const md = normaliseProbe(raw, '/x.mp4', 1000);
    expect(md.durationSeconds).toBe(3600.5);
    expect(md.video.isVariableFrameRate).toBe(true);
    expect(md.selectedAudioIndex).toBe(2);
    expect(normaliseProbe(raw, '/x.mp4', 1000, 1).selectedAudioIndex).toBe(1);
  });
  it('applies rotation to display dimensions', () => {
    const r = structuredClone(raw) as typeof raw & { streams: Array<Record<string, unknown>> };
    r.streams[0]!.side_data_list = [{ rotation: -90 }];
    const md = normaliseProbe(r, '/x.mp4', 1);
    expect(md.video.displayWidth).toBe(1080);
    expect(md.video.displayHeight).toBe(1920);
  });
  it('rejects files without video', () => {
    expect(() => normaliseProbe({ streams: [], format: { duration: '5' } }, '/x', 1)).toThrow(/No video/);
  });
  it('parses rates', () => {
    expect(parseRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseRate('0/0')).toBe(0);
  });
});

describe('frame chunk planning and scene parsing', () => {
  it('covers the whole duration with aligned chunks', () => {
    const c = planChunks(1250, 600, 2);
    expect(c.map((x) => [x.start, x.end])).toEqual([[0, 600], [600, 1200], [1200, 1250]]);
  });
  it('parses scdet metadata with offset', () => {
    const text = 'frame:0 pts:0 pts_time:0\nlavfi.scd.mafd=1.5\nlavfi.scd.score=1.5\nframe:1 pts:1 pts_time:0.1\nlavfi.scd.mafd=30\nlavfi.scd.score=25\nlavfi.scd.time=0.1\n';
    const r = parseSceneMetadata(text, 600);
    expect(r.changes).toEqual([{ t: 600.1, score: 25 }]);
    expect(r.activity).toHaveLength(2);
  });
});

describe('audio analysis', () => {
  function pcm(seconds: number, sr: number, amp: (t: number) => number): Buffer {
    const n = Math.round(seconds * sr);
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp(i / sr) * Math.sin(i * 0.9) * 32000), i * 2);
    return b;
  }
  it('computes an envelope across odd chunk boundaries', () => {
    const acc = new EnvelopeAccumulator(8000, 0.25);
    const data = pcm(4, 8000, () => 0.5);
    acc.push(data.subarray(0, 1001));
    acc.push(data.subarray(1001));
    const env = acc.finish();
    expect(env.rmsDb).toHaveLength(16);
    expect(env.rmsDb[5]!).toBeGreaterThan(-12);
  });
  it('detects a sudden loud event above the background', () => {
    const acc = new EnvelopeAccumulator(8000, 0.25);
    acc.push(pcm(30, 8000, (t) => (t > 15 && t < 16 ? 0.9 : 0.01)));
    const a = analyseEnvelope(acc.finish(), { onsetDb: 12 });
    expect(a.events).toHaveLength(1);
    expect(a.events[0]!.t).toBeCloseTo(15, 0);
    expect(audioScoreForRange(a, 10, 20)).toBeGreaterThan(5);
    expect(audioScoreForRange(a, 20, 30)).toBe(0);
  });
  it('finds quiet points for boundary snapping', () => {
    const env = { windowSeconds: 1, sampleRate: 8000, rmsDb: [-10, -10, -60, -10, -10], peakDb: [], zcr: [] };
    expect(quietestNear(env, 3, 1.5)).toBe(2);
  });
});

describe('render filter graph', () => {
  const render = { width: 1080, height: 1920, fps: 30, cropPositionX: 0.5, blurForegroundWidth: 1, blurStrength: 30 };
  const audio = { volume: 1, fadeInSeconds: 0.3, fadeOutSeconds: 0.6, backgroundMusicVolume: 0.25, ducking: true, normalize: true, targetLufs: -14 };
  it('builds a blurred-background graph with audio processing', () => {
    const g = buildFilterGraph({ srcW: 1920, srcH: 1080, duration: 20, render, mode: 'blur', overlays: [], gameAudio: '0:1', music: null, audio });
    expect(g.graph).toContain('gblur');
    expect(g.graph).toContain('overlay=(W-w)/2:(H-h)/2');
    expect(g.graph).toContain('loudnorm=I=-14');
    expect(g.graph).toContain('afade=t=out:st=19.400');
    expect(g.audioOut).toBe('aout');
  });
  it('builds a crop graph honouring horizontal position', () => {
    const g = buildFilterGraph({ srcW: 1920, srcH: 1080, duration: 10, render: { ...render, cropPositionX: 0 }, mode: 'crop', overlays: [], gameAudio: null, music: null, audio });
    expect(g.graph).toMatch(/crop=w=608:h=1080:x=0:y=0/);
    expect(g.audioOut).toBeNull();
  });
  it('mixes and ducks background music under game audio', () => {
    const g = buildFilterGraph({ srcW: 1920, srcH: 1080, duration: 10, render, mode: 'blur', overlays: [{ inputIndex: 2, start: 0, end: 2, y: 100 }], gameAudio: '0:1', music: '1:a:0', audio });
    expect(g.graph).toContain('sidechaincompress');
    expect(g.graph).toContain("enable='between(t,0.000,2.000)'");
  });
  it('parses loudnorm measurement output', () => {
    const m = parseLoudnorm('blah\n{\n "input_i" : "-23.5",\n "input_tp" : "-3.1",\n "input_lra" : "5.0",\n "input_thresh" : "-34.0",\n "target_offset" : "0.2"\n}');
    expect(m?.input_i).toBe('-23.5');
    expect(parseLoudnorm('{"input_i":"-inf"}')).toBeUndefined();
  });
});

describe('smart crop', () => {
  it('computes a 9:16 window', () => {
    expect(cropWindow(1920, 1080, 1080, 1920)).toEqual({ w: 608, h: 1080 });
    expect(cropWindow(1080, 1920, 1080, 1920)).toEqual({ w: 1080, h: 1920 });
  });
  it('follows confident AI focus points with limited pan speed', () => {
    const p = buildCropPath({ srcW: 1920, srcH: 1080, outW: 1080, outH: 1920, duration: 10, aiFocus: [{ t: 0, x: 0.2, confidence: 0.9 }, { t: 10, x: 0.8, confidence: 0.9 }], motion: [], maxPanPerSecond: 0.25 });
    expect(p.source).toBe('ai');
    expect(p.confidence).toBeGreaterThan(0.8);
    expect(p.keyframes[0]!.x).toBeLessThan(p.keyframes[p.keyframes.length - 1]!.x);
    for (let i = 1; i < p.keyframes.length; i++) {
      const k = p.keyframes[i]!;
      const prev = p.keyframes[i - 1]!;
      expect(Math.abs(k.x - prev.x) / (k.t - prev.t)).toBeLessThanOrEqual(0.25 * 1920 + 1);
    }
  });
  it('reports zero confidence without any tracking data (caller falls back to blur)', () => {
    const p = buildCropPath({ srcW: 1920, srcH: 1080, outW: 1080, outH: 1920, duration: 10, aiFocus: [], motion: [], maxPanPerSecond: 0.25 });
    expect(p.source).toBe('center');
    expect(p.confidence).toBe(0);
  });
  it('detects localised motion', () => {
    const w = 40, h = 10;
    const f1 = new Uint8Array(w * h);
    const f2 = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 30; x < 34; x++) f2[y * w + x] = 200;
    const pts = motionCentroids([f1, f2], w, h, 4);
    expect(pts[0]!.x).toBeGreaterThan(0.7);
  });
  it('builds a piecewise expression', () => {
    expect(cropXExpression([{ t: 0, x: 0 }, { t: 1, x: 100 }])).toBe('if(lt(t,1.000),0+(100)*(t-0.000)/1.000,100)');
  });
});

describe('misc parsers', () => {
  it('volumedetect', () => {
    expect(parseMaxVolume('[Parsed_volumedetect_0] max_volume: -0.5 dB')).toBe(-0.5);
  });
  it('whisper output filters non-speech', () => {
    const t = parseWhisperJson({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1500 }, text: ' [Music]' }, { offsets: { from: 2000, to: 3500 }, text: ' Watch this!' }] });
    expect(t).toMatchObject({ language: 'en', segments: [{ start: 2, end: 3.5, text: 'Watch this!' }] });
  });
  it('wraps text', () => {
    expect(wrapText('one two three four five six seven', 60, 400).length).toBeGreaterThan(1);
  });
  it('escapes filter values', () => {
    expect(escapeFilterValue("a:b,c'd")).not.toMatch(/(^|[^\\]):/);
  });
  it('time helpers', () => {
    expect(formatTimestamp(3725)).toBe('1:02:05');
    expect(parseTimestamp('1:02:05.5')).toBeCloseTo(3725.5);
    expect(parseTimestamp('bad')).toBeNaN();
    expect(overlapRatio({ start: 0, end: 10 }, { start: 5, end: 25 })).toBe(0.5);
  });
});

describe('config', () => {
  it('provides sensible defaults', () => {
    const c = loadConfig({ root: '/nonexistent' });
    expect(c.render.width).toBe(1080);
    expect(c.render.height).toBe(1920);
    expect(c.analysis.frameIntervalSeconds).toBe(2);
    expect(c.analysis.contactSheetColumns * c.analysis.contactSheetRows).toBe(20);
    expect(c.claude.executable).toBe('claude');
  });
  it('rejects invalid duration ordering', () => {
    expect(() => loadConfig({ root: '/nonexistent', overrides: { clips: { minDurationSeconds: 50, maxDurationSeconds: 20 } } })).toThrow(/Clip durations/);
  });
  it('applies per-project settings and keeps preferred window consistent', () => {
    const base = loadConfig({ root: '/nonexistent' });
    const e = effectiveConfig(base, { clips: { maxDurationSeconds: 20 }, render: { compositionMode: 'smart' } });
    expect(e.clips.maxDurationSeconds).toBe(20);
    expect(e.clips.preferredMaxSeconds).toBeLessThanOrEqual(20);
    expect(e.render.compositionMode).toBe('smart');
  });
});
