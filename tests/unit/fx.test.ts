import { describe, expect, it } from 'vitest';
import { configSchema } from '../../src/config/schema.js';
import { classicFrames, cleanHook, fxSignature, fxSummary, hookFor, karaokeFrames, mapFramesToOutput, outputTime, replayWindow, resolveFx, stripEmoji, timelinePieces, toVideoFx, voiceWindows } from '../../src/fx/plan.js';
import { directorSchema, heuristicPlan, validatePlan } from '../../src/fx/director.js';
import { validateFacecam, clampRect } from '../../src/fx/facecam.js';
import { sfxName } from '../../src/fx/sfx.js';
import { buildFilterGraph, facecamGameplayX, flashFilter, glitchFilters, timelineSeconds, voiceChain, zoomShakeFilter } from '../../src/render/filters.js';
import { captionConcatList } from '../../src/render/renderClip.js';
import { autoOrder, encoderArgs } from '../../src/render/encoder.js';
import { xfadeOffsets } from '../../src/render/montage.js';
import { parseYtDlpProgress, validateDownloadUrl } from '../../src/media/download.js';
import { resolveWindowsCommand } from '../../src/util/process.js';
import { hwaccelArgs } from '../../src/media/frames.js';
import type { Candidate, ClipFx } from '../../src/types.js';

const cfg = configSchema.parse({});
const FX = cfg.fx;

describe('effects plan', () => {
  const fx: ClipFx = {
    source: 'manual',
    hook: { en: 'He did NOT see that 💀🔥', hi: 'ये देखो' },
    replay: { start: 102, end: 104.5 },
    events: [
      { type: 'zoom', t: 103, duration: 0.8 },
      { type: 'sfx', t: 103.1, duration: 0, sound: 'boom' },
      { type: 'voice', t: 106, duration: 2, voice: 'chipmunk' },
      { type: 'voice', t: 107, duration: 2, voice: 'deep' }, // overlaps → dropped
      { type: 'shake', t: 99, duration: 1 }, // before clip → dropped
      { type: 'glitch', t: 130, duration: 1 }, // after clip → dropped
      { type: 'sfx', t: 105, duration: 0 }, // no sound → dropped
    ],
  };

  it('validates events against the clip and the enabled effect types', () => {
    const r = resolveFx(fx, 100, 120, FX);
    expect(r.replay).toEqual({ start: 2, end: 4.5, speed: 0.5 });
    expect(r.events.map((e) => [e.type, e.rel])).toEqual([['zoom', 3], ['sfx', 3.1], ['voice', 6]]);
    expect(r.hook).toEqual({ en: 'He did NOT see that', hi: 'ये देखो' });
    const noZoom = resolveFx(fx, 100, 120, { ...FX, zoom: false, replay: false, hookTitle: false });
    expect(noZoom.events.some((e) => e.type === 'zoom')).toBe(false);
    expect(noZoom.replay).toBeNull();
    expect(noZoom.hook).toBeNull();
    expect(resolveFx(fx, 100, 120, { ...FX, enabled: false })).toEqual({ replay: null, events: [], hook: null });
  });

  it('caps the replay length and ignores too-short replays', () => {
    expect(resolveFx({ ...fx, replay: { start: 100, end: 110 } }, 100, 120, FX).replay).toEqual({ start: 7, end: 10, speed: 0.5 });
    expect(resolveFx({ ...fx, replay: { start: 103, end: 103.3 } }, 100, 120, FX).replay).toBeNull();
  });

  it('maps clip time onto the output timeline around the inserted replay', () => {
    const replay = { start: 2, end: 4.5, speed: 0.5 };
    expect(outputTime(3, replay)).toBe(3);
    expect(outputTime(6, replay)).toBe(11);
    expect(replayWindow(replay)).toEqual({ start: 4.5, end: 9.5 });
    expect(timelinePieces(20, replay)).toEqual([
      { offset: 0, seconds: 4.5, speed: 1 },
      { offset: 2, seconds: 2.5, speed: 0.5, replay: true },
      { offset: 4.5, seconds: 15.5, speed: 1 },
    ]);
    expect(timelinePieces(20, null)).toEqual([{ offset: 0, seconds: 20, speed: 1 }]);
    const r = resolveFx(fx, 100, 120, FX);
    expect(toVideoFx(r).zooms).toEqual([{ t: 3, duration: 0.8, strength: 0.6 }]);
    expect(voiceWindows(r)).toEqual([{ start: 11, end: 13, effect: 'chipmunk' }]);
    expect(fxSummary(r)).toEqual(['hook title', 'replay 2.5s @0.5x', 'zoom', 'sfx: boom', 'voice: chipmunk']);
  });

  it('picks the hook for each reel language', () => {
    const hook = { en: 'EN', hi: 'HI' };
    expect(hookFor(hook, 'hi')).toBe('HI');
    expect(hookFor(hook, 'en')).toBe('EN');
    expect(hookFor(hook, 'hi+en')).toBe('HI');
    expect(hookFor({ default: 'D' }, null)).toBe('D');
    expect(hookFor(null, 'en')).toBeNull();
  });

  it('strips emoji and quotes from hooks', () => {
    expect(stripEmoji('Bro 😂 what 🔥🔥')).toBe('Bro what');
    expect(cleanHook('"Watch this"')).toBe('Watch this');
    expect(cleanHook('x'.repeat(80))).toHaveLength(60);
  });

  it('changes the signature when effect settings or languages change', () => {
    expect(fxSignature(FX, ['en'])).toBe(fxSignature({ ...FX }, ['en']));
    expect(fxSignature(FX, ['en'])).not.toBe(fxSignature({ ...FX, intensity: 'crazy' }, ['en']));
    expect(fxSignature(FX, ['en'])).not.toBe(fxSignature(FX, ['hi', 'en']));
  });
});

describe('karaoke captions', () => {
  it('splits lines into short chunks with the spoken word highlighted', () => {
    const f = karaokeFrames([{ start: 0, end: 3, text: 'run run run get in the car now' }], 3, 20);
    expect(f[0]).toMatchObject({ words: ['run', 'run', 'run'], active: 0, start: 0 });
    expect(f[1]!.active).toBe(1);
    expect(f.map((x) => x.words.join(' '))).toEqual(['run run run', 'run run run', 'run run run', 'get in the', 'get in the', 'get in the', 'car now', 'car now']);
    expect(f[f.length - 1]!.end).toBeCloseTo(3, 3);
    for (let i = 1; i < f.length; i++) expect(f[i]!.start).toBeCloseTo(f[i - 1]!.end, 3);
  });

  it('keeps Devanagari words intact', () => {
    const f = karaokeFrames([{ start: 1, end: 2, text: 'भाई ये देखो' }]);
    expect(f[0]!.words).toEqual(['भाई', 'ये', 'देखो']);
  });

  it('hides captions during the replay and shifts later ones', () => {
    const replay = { start: 2, end: 4, speed: 0.5 };
    const out = mapFramesToOutput(classicFrames([{ start: 1, end: 3, text: 'a' }, { start: 3.5, end: 5, text: 'b' }]), replay, 10);
    expect(out.map((x) => [x.words[0], x.start, x.end])).toEqual([['a', 1, 3], ['b', 3.5, 4], ['b', 8.001, 9]]);
  });

  it('writes an ffconcat caption track with blanks between captions', () => {
    const list = captionConcatList([{ start: 1, end: 2, file: 'c0.png' }, { start: 2, end: 2.5, file: 'c1.png' }], 'blank.png', 4);
    expect(list.split('\n')).toEqual(['ffconcat version 1.0', "file 'blank.png'", 'duration 1.000', "file 'c0.png'", 'duration 1.000', "file 'c1.png'", 'duration 0.500', "file 'blank.png'", 'duration 1.500', "file 'blank.png'", '']);
  });
});

describe('effects filter graph', () => {
  const render = { width: 1080, height: 1920, fps: 30, cropPositionX: 0.5, blurForegroundWidth: 1, blurStrength: 30 };
  const audio = { volume: 1, fadeInSeconds: 0.3, fadeOutSeconds: 0.6, backgroundMusicVolume: 0.25, ducking: true, normalize: true, targetLufs: -14 };
  it('builds zoom/shake, flash and glitch filters', () => {
    const fx = { zooms: [{ t: 3, duration: 0.8, strength: 0.6 }], shakes: [{ t: 3.1, duration: 0.5, strength: 0.5 }], flashes: [{ t: 3.1, strength: 0.5 }], glitches: [{ t: 8, duration: 0.4, strength: 0.5 }] };
    expect(zoomShakeFilter(fx, 1080, 1920, 30)).toMatch(/^zoompan=z='1\+0\.268\*clip/);
    expect(zoomShakeFilter({ ...fx, zooms: [], shakes: [] }, 1080, 1920, 30)).toBeNull();
    expect(flashFilter(fx)).toContain("eval=frame");
    expect(glitchFilters(fx)[0]).toBe("rgbashift=rh=-17:bh=17:gv=6:enable='between(t,8.000,8.400)'");
    expect(voiceChain('chipmunk')).toContain('asetrate=48000*1.5');
  });

  it('assembles a replay timeline from three inputs with slowed audio', () => {
    const g = buildFilterGraph({
      srcW: 1920, srcH: 1080, duration: 20, render, mode: 'blur', overlays: [], gameAudio: null, music: null, audio,
      pieces: [
        { inputIndex: 0, audio: '0:1', offset: 0, seconds: 4.5, speed: 1 },
        { inputIndex: 1, audio: '1:1', offset: 2, seconds: 2.5, speed: 0.5, replay: true },
        { inputIndex: 2, audio: '2:1', offset: 4.5, seconds: 15.5, speed: 1 },
      ],
      replayStyle: { smoothing: 'blend', sourceFps: 30 },
      sfx: [{ inputIndex: 3, at: 4.25, volume: 0.8 }],
      voice: [{ start: 11, end: 13, effect: 'deep' }],
      captionTrack: { inputIndex: 4, y: 1400 },
    });
    expect(g.outputSeconds).toBe(25);
    expect(g.graph).toContain('[p0v][p1v][p2v]concat=n=3:v=1:a=0[vcat]');
    expect(g.graph).toContain('setpts=(PTS-STARTPTS)/0.5,minterpolate=fps=30:mi_mode=blend');
    expect(g.graph).toContain('asetrate=48000*0.5');
    expect(g.graph).toContain('adelay=4250:all=1');
    expect(g.graph).toContain("volume=0:enable='between(t,11.000,13.000)'");
    expect(g.graph).toContain('[4:v]overlay=x=(W-w)/2:y=1400:eof_action=pass');
    expect(g.graph).toContain('afade=t=out:st=24.400');
    expect(timelineSeconds({ duration: 20 })).toBe(20);
  });

  it('uses real frames for slow motion when the source has a high frame rate', () => {
    const g = buildFilterGraph({
      srcW: 1920, srcH: 1080, duration: 10, render, mode: 'crop', overlays: [], gameAudio: null, music: null, audio,
      pieces: [{ inputIndex: 0, audio: null, offset: 0, seconds: 4, speed: 1 }, { inputIndex: 1, audio: null, offset: 2, seconds: 2, speed: 0.5, replay: true }],
      replayStyle: { smoothing: 'blend', sourceFps: 60 },
    });
    expect(g.graph).toContain('fps=60');
    expect(g.graph).not.toContain('minterpolate');
    expect(g.audioOut).toBeNull();
  });

  it('stacks webcam over gameplay in facecam layout', () => {
    const g = buildFilterGraph({ srcW: 1920, srcH: 1080, duration: 10, render, mode: 'crop', overlays: [], gameAudio: '0:1', music: null, audio, facecam: { rect: { x: 0.7, y: 0.6, w: 0.25, h: 0.35 }, heightFraction: 0.34 } });
    expect(g.graph).toContain('crop=w=480:h=378:x=1344:y=648');
    expect(g.graph).toContain('vstack=inputs=2');
    expect(g.graph).toContain('scale=1080:1268');
    // The gameplay window (920 px) is moved left so it ends where the webcam starts (x = 1344).
    expect(g.graph).toContain('crop=w=920:h=1080:x=424:y=0');
    expect(facecamGameplayX(1920, 920, 0.5, { x: 0.3, y: 0.6, w: 0.2, h: 0.3 })).toBe(960);
    expect(facecamGameplayX(1920, 920, 0.5, { x: 0.02, y: 0.02, w: 0.1, h: 0.1 })).toBe(500);
  });
});

describe('AI director', () => {
  const cand = { id: 'c1', title: 'Huge crash', description: 'car flips', category: 'vehicle_crash', reason: 'wow', peakTime: 105, start: 100, end: 120 } as unknown as Candidate;
  const base = { start: 100, end: 120, cfg: FX, hookLanguages: ['hi', 'en'], sounds: [{ name: 'boom', description: 'x' }, { name: 'whoosh', description: 'y' }], signature: 'sig' };

  it('asks for a hook in every reel language and only enabled effects', () => {
    const s = directorSchema({ ...base, cfg: { ...FX, voice: false } }) as { properties: { hook: { required: string[] }; events: { items: { properties: Record<string, { enum?: string[] }> } } } };
    expect(s.properties.hook.required).toEqual(['hi', 'en']);
    expect(s.properties.events.items.properties.type!.enum).not.toContain('voice');
    expect(s.properties.events.items.properties.sound!.enum).toEqual(['boom', 'whoosh']);
  });

  it('converts the plan to absolute times and drops invalid items', () => {
    const r = validatePlan(
      {
        hook: { hi: 'भाई गाड़ी उड़ गई 🚗', en: 'This car had other plans' },
        replay: { use: true, start: 3, end: 6 },
        events: [{ type: 'zoom', t: 5, duration: 1 }, { type: 'sfx', t: 5, sound: 'airhorn' }, { type: 'voice', t: 2, voice: 'squeaky' }, { type: 'flash', t: -1 }, { type: 'sfx', t: 5.1, sound: 'boom' }],
      },
      base,
    );
    expect(r.ok).toBe(true);
    expect(r.value!.hook).toEqual({ hi: 'भाई गाड़ी उड़ गई', en: 'This car had other plans' });
    expect(r.value!.replay).toEqual({ start: 103, end: 106 });
    expect(r.value!.events.map((e) => [e.type, e.t, e.sound])).toEqual([['zoom', 105, undefined], ['sfx', 105.1, 'boom']]);
    expect(r.value!.source).toBe('auto');
  });

  it('requires a hook per language and rejects broken answers', () => {
    expect(validatePlan({ hook: { en: 'x' }, replay: { use: false }, events: [] }, base).errors[0]).toMatch(/hi/);
    expect(validatePlan({ moments: [] }, base).ok).toBe(false);
  });

  it('has a rule-based fallback', () => {
    const p = heuristicPlan({ ...base, candidate: cand, hindiScript: 'devanagari' });
    expect(p.hook).toEqual({ hi: 'Huge crash', en: 'Huge crash' });
    expect(p.replay!.end).toBeCloseTo(105.6, 3);
    expect(p.events.map((e) => e.type)).toEqual(['zoom', 'flash', 'shake', 'sfx']);
    expect(p.events.find((e) => e.type === 'sfx')!.sound).toBe('boom');
  });
});

describe('facecam', () => {
  it('validates detected boxes', () => {
    expect(validateFacecam({ present: false, x: 0, y: 0, w: 0, h: 0, confidence: 0.9 }).value).toBeNull();
    expect(validateFacecam({ present: true, x: 0.7, y: 0.6, w: 0.25, h: 0.3, confidence: 0.4 }).value).toBeNull();
    expect(validateFacecam({ present: true, x: 0.7, y: 0.6, w: 0.25, h: 0.3, confidence: 0.9 }).value).toEqual({ x: 0.7, y: 0.6, w: 0.25, h: 0.3 });
    expect(validateFacecam({ present: true, x: 0.1, y: 0.1, w: 0.9, h: 0.9, confidence: 0.9 }).ok).toBe(false);
    expect(clampRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ x: 0.9, y: 0.9, w: 0.1, h: 0.1 });
  });
});

describe('platform support', () => {
  it('resolves npm .cmd shims on Windows to node + script', () => {
    const files = new Set(['C:\\npm\\claude.cmd', 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', 'C:\\ffmpeg\\bin\\ffmpeg.exe']);
    const io = { isFile: (p: string) => files.has(p), readFile: () => '@IF EXIST "%dp0%\\node.exe" (\r\n  "%dp0%\\node.exe"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)', nodePath: 'C:\\node\\node.exe' };
    const env = { PATH: 'C:\\ffmpeg\\bin;C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(resolveWindowsCommand('claude', env, io)).toEqual({ command: 'C:\\node\\node.exe', prefixArgs: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'] });
    expect(resolveWindowsCommand('ffmpeg', env, io)).toEqual({ command: 'C:\\ffmpeg\\bin\\ffmpeg.exe', prefixArgs: [] });
    expect(resolveWindowsCommand('missing', env, io)).toBeNull();
  });

  it('prefers .exe over .cmd (native Claude installer)', () => {
    const files = new Set(['C:\\bin\\claude.exe', 'C:\\bin\\claude.cmd']);
    const io = { isFile: (p: string) => files.has(p), readFile: () => '', nodePath: 'node' };
    expect(resolveWindowsCommand('claude', { PATH: 'C:\\bin' }, io)).toEqual({ command: 'C:\\bin\\claude.exe', prefixArgs: [] });
  });

  it('maps quality settings onto GPU encoders', () => {
    const r = { crf: 20, preset: 'medium' as const, threadsPerJob: 0 };
    expect(encoderArgs('h264_nvenc', r)).toEqual(expect.arrayContaining(['h264_nvenc', '-cq', '22', '-pix_fmt', 'yuv420p']));
    expect(encoderArgs('h264_videotoolbox', r)).toEqual(expect.arrayContaining(['-q:v', '65']));
    expect(encoderArgs('libx264', r)).toEqual(expect.arrayContaining(['libx264', '-crf', '20', '-preset', 'medium']));
    expect(autoOrder('win32')[0]).toBe('h264_nvenc');
    expect(autoOrder('darwin')[0]).toBe('h264_videotoolbox');
    expect(hwaccelArgs('win32')).toEqual(['-hwaccel', 'auto']);
    expect(hwaccelArgs('darwin')).toEqual(['-hwaccel', 'videotoolbox']);
  });
});

describe('montage, downloads, sounds', () => {
  it('computes xfade offsets', () => {
    expect(xfadeOffsets([10, 8, 6], 0.5)).toEqual([9.5, 17]);
  });

  it('accepts public links only', () => {
    expect(validateDownloadUrl('https://www.youtube.com/watch?v=abc').hostname).toBe('www.youtube.com');
    for (const bad of ['file:///etc/passwd', 'http://localhost:4317/api', 'http://192.168.1.5/x.mp4', 'http://10.0.0.1/', 'http://[::1]/', 'https://user:pw@example.com/', 'http://router/', 'not a url']) {
      expect(() => validateDownloadUrl(bad), bad).toThrow();
    }
  });

  it('parses yt-dlp progress', () => {
    expect(parseYtDlpProgress('[download]  42.3% of ~ 1.20GiB at 5.1MiB/s ETA 03:12')).toBeCloseTo(0.423);
    expect(parseYtDlpProgress('[Merger] Merging formats')).toBeNull();
  });

  it('names sound files', () => {
    expect(sfxName('Vine Boom (loud).MP3')).toBe('vine-boom-loud');
    expect(sfxName('/x/bruh.wav')).toBe('bruh');
  });
});
