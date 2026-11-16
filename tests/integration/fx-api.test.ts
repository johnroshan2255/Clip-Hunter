import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import type { Services } from '../../src/services.js';
import { probeVideo } from '../../src/media/probe.js';
import { runProcess } from '../../src/util/process.js';
import { fixtureVideo, tempDir, testServices, waitForJob } from './helpers.js';
import type { Candidate } from '../../src/types.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('fun effects, montages, GIFs, sounds and link import (HTTP API)', () => {
  let dir: string;
  let svc: Services;
  let app: ReturnType<typeof createApp>;
  let video: string;
  let id: string;
  let cands: Candidate[];

  beforeAll(async () => {
    video = await fixtureVideo(60);
    dir = tempDir('fxapi');
    process.env.MOCK_YTDLP_SOURCE = video;
    svc = testServices(dir, {
      clips: { count: 2 },
      fx: { sfxDir: path.join(dir, 'sfx'), facecam: 'auto' },
      download: { ytdlpExecutable: path.join(here, '../fixtures/mock-ytdlp.mjs') },
    });
    await svc.init();
    app = createApp(svc);
    const res = await request(app).post('/api/projects').send({ path: video, name: 'FX Test' });
    id = res.body.id;
    await waitForJob(svc, svc.queue.list({ projectId: id })[0]!.id);
    cands = (await request(app).get(`/api/projects/${id}/candidates`)).body.candidates;
  });
  afterAll(async () => {
    await svc.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists built-in sounds and manages uploaded ones', async () => {
    const list = await request(app).get('/api/fx/sounds');
    expect(list.body.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(['boom', 'hit', 'whoosh', 'airhorn']));
    const wav = path.join(dir, 'Vine Boom.wav');
    await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=80:d=0.5', wav]);
    const up = await request(app).post('/api/fx/sounds').attach('file', wav);
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    expect(up.body.name).toBe('vine-boom');
    expect((await request(app).get('/api/fx/sounds/vine-boom')).status).toBe(200);
    expect((await request(app).post('/api/fx/sounds').attach('file', video)).status).toBe(400);
    expect((await request(app).delete('/api/fx/sounds/boom')).status).toBe(404);
  });

  it('saves manual effects and rejects invalid ones', async () => {
    const c = cands.find((x) => x.selected)!;
    expect((await request(app).put(`/api/projects/${id}/candidates/${c.id}/fx`).send({ events: [{ type: 'laser', t: 1 }] })).status).toBe(400);
    const fx = {
      hook: { default: 'Manual hook' },
      replay: { start: c.start + 2, end: c.start + 4 },
      events: [
        { type: 'zoom', t: c.start + 3, duration: 0.8, strength: 0.7 },
        { type: 'sfx', t: c.start + 3, duration: 0, sound: 'vine-boom' },
        { type: 'voice', t: c.start + 5, duration: 1.5, voice: 'robot' },
        { type: 'glitch', t: c.start + 6, duration: 0.4 },
      ],
    };
    const r = await request(app).put(`/api/projects/${id}/candidates/${c.id}/fx`).send(fx);
    expect(r.status).toBe(200);
    expect(r.body.fx).toMatchObject({ source: 'manual', hook: { default: 'Manual hook' } });
  });

  it('stores a manual facecam position', async () => {
    expect((await request(app).patch(`/api/projects/${id}`).send({ facecam: { x: 2, y: 0, w: 0.2, h: 0.2 } })).status).toBe(400);
    const r = await request(app).patch(`/api/projects/${id}`).send({ facecam: { x: 0.7, y: 0.65, w: 0.25, h: 0.3 } });
    expect(r.body.facecam).toMatchObject({ rect: { x: 0.7, y: 0.65, w: 0.25, h: 0.3 }, source: 'manual' });
  });

  it('renders manual effects (with facecam) and AI-planned effects', async () => {
    const job = (await request(app).post(`/api/projects/${id}/render`).send({})).body;
    const done = await waitForJob(svc, job.id);
    expect(done.status, done.message).toBe('completed');
    const p = svc.store.get(id);
    const manual = cands.find((x) => x.selected)!;
    const clip = p.clips.find((c) => c.candidateId === manual.id)!;
    expect(clip.fxSummary).toEqual(['facecam layout', 'hook title', 'replay 2.0s @0.5x', 'zoom', 'glitch', 'sfx: vine-boom', 'voice: robot']);
    expect(clip.outputSeconds).toBeCloseTo(clip.end - clip.start + 4, 1);
    const md = await probeVideo(svc.tools, svc.store.paths(id).abs(clip.file!));
    expect(md.durationSeconds).toBeCloseTo(clip.outputSeconds!, 0);
    // The other clip had no plan: the (mock) AI director planned it and the plan was saved.
    const saved: Candidate[] = (await request(app).get(`/api/projects/${id}/candidates`)).body.candidates;
    const other = p.clips.find((c) => c.candidateId !== manual.id)!;
    expect(saved.find((c) => c.id === other.candidateId)!.fx?.source).toBe('auto');
    expect(saved.find((c) => c.id === manual.id)!.fx?.source).toBe('manual');
  });

  it('makes GIFs of the best seconds', async () => {
    const clip = svc.store.get(id).clips[0]!;
    const g = await request(app).get(`/api/projects/${id}/clips/${clip.id}/gif`).buffer(true).parse(binary);
    expect(g.status).toBe(200);
    expect((g.body as Buffer).subarray(0, 4).toString()).toBe('GIF8');
  });

  it('builds vertical and horizontal montages', async () => {
    for (const orientation of ['vertical', 'horizontal'] as const) {
      const m = await request(app).post(`/api/projects/${id}/montages`).send({ orientation, transition: 'fade' });
      expect(m.status, JSON.stringify(m.body)).toBe(202);
      const job = svc.queue.list({ projectId: id }).find((j) => j.type === 'montage' && j.params.montageId === m.body.id)!;
      expect((await waitForJob(svc, job.id)).status).toBe('completed');
      const rec = svc.store.get(id).montages!.find((x) => x.id === m.body.id)!;
      expect(rec.status).toBe('completed');
      const md = await probeVideo(svc.tools, svc.store.paths(id).abs(rec.file!));
      expect([md.video.width, md.video.height]).toEqual(orientation === 'vertical' ? [1080, 1920] : [1920, 1080]);
      expect((await request(app).get(`/api/projects/${id}/montages/${rec.id}/video`).set('Range', 'bytes=0-99')).status).toBe(206);
      expect((await request(app).delete(`/api/projects/${id}/montages/${rec.id}`)).status).toBe(200);
    }
    expect((await request(app).post(`/api/projects/${id}/montages`).send({ clipIds: ['clip-001'] })).status).toBe(400);
  });

  it('re-plans with AI and resets to automatic', async () => {
    const c = cands.find((x) => x.selected)!;
    const plan = await request(app).post(`/api/projects/${id}/candidates/${c.id}/fx/auto`);
    expect(plan.status).toBe(200);
    expect(plan.body.source).toBe('auto');
    const reset = await request(app).delete(`/api/projects/${id}/candidates/${c.id}/fx`);
    expect(reset.body.fx).toBeUndefined();
    const det = await request(app).post(`/api/projects/${id}/facecam/detect`);
    expect(det.body.facecam).toMatchObject({ rect: null, source: 'auto' });
  });

  it('imports from a link: download, then analysis', async () => {
    expect((await request(app).post('/api/projects/from-url').send({ url: 'http://localhost:4317/x.mp4' })).status).toBe(400);
    const r = await request(app).post('/api/projects/from-url').send({ url: 'https://example.com/watch?v=abc123' });
    expect(r.status).toBe(201);
    const dl = svc.queue.list({ projectId: r.body.id }).find((j) => j.type === 'download')!;
    expect((await waitForJob(svc, dl.id)).status).toBe('completed');
    const an = svc.queue.list({ projectId: r.body.id }).find((j) => j.type === 'analyze')!;
    expect((await waitForJob(svc, an.id)).status).toBe('completed');
    const p = svc.store.get(r.body.id);
    expect(p.name).toBe('Mock Video Title');
    expect(p.download).toMatchObject({ status: 'done', progress: 1 });
    expect(p.counts.candidates).toBeGreaterThan(0);
    expect((await request(app).delete(`/api/projects/${p.id}`)).status).toBe(200);
    expect(fs.existsSync(svc.downloadsDir(p.id))).toBe(false);
  });
});
