import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import type { Services } from '../../src/services.js';
import { fixtureVideo, tempDir, testServices, waitForJob } from './helpers.js';
import type { Candidate } from '../../src/types.js';

describe('HTTP API', () => {
  let dir: string;
  let svc: Services;
  let app: ReturnType<typeof createApp>;
  let video: string;
  let id: string;

  beforeAll(async () => {
    video = await fixtureVideo(60);
    dir = tempDir('api');
    svc = testServices(dir, { clips: { count: 2 } });
    await svc.init();
    app = createApp(svc);
  });
  afterAll(async () => {
    await svc.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('health and system info', async () => {
    expect((await request(app).get('/api/health')).body.ok).toBe(true);
    const sys = await request(app).get('/api/system');
    expect(sys.status).toBe(200);
    expect(sys.body.ffmpeg).toMatch(/ffmpeg version/);
  });

  it('rejects invalid imports', async () => {
    expect((await request(app).post('/api/projects').send({ path: '/etc/passwd' })).status).toBe(400);
    expect((await request(app).post('/api/projects').send({ path: path.join(dir, 'missing.mp4') })).status).toBe(400);
    const txt = path.join(dir, 'notes.txt');
    fs.writeFileSync(txt, 'x');
    expect((await request(app).post('/api/projects').send({ path: txt })).body.error.message).toMatch(/Unsupported/);
    expect((await request(app).post('/api/projects').send({})).status).toBe(400);
  });

  it('rejects foreign Host headers', async () => {
    expect((await request(app).get('/api/projects').set('Host', 'attacker.example')).status).toBe(403);
  });

  it('imports, analyses and exposes moments', async () => {
    const res = await request(app).post('/api/projects').send({ path: video, name: 'API Test' });
    expect(res.status).toBe(201);
    id = res.body.id;
    expect((await request(app).post(`/api/projects/${id}/analyze`).send({})).status).toBe(409);
    await waitForJob(svc, svc.queue.list({ projectId: id })[0]!.id);
    const cands = await request(app).get(`/api/projects/${id}/candidates`);
    expect(cands.body.candidates.length).toBeGreaterThan(0);
    const frame = await request(app).get(`/api/projects/${id}/frame?t=10`);
    expect(frame.headers['content-type']).toMatch(/image\/jpeg/);
  });

  it('validates and applies manual timestamp edits', async () => {
    const { body } = await request(app).get(`/api/projects/${id}/candidates`);
    const c: Candidate = body.candidates[0];
    expect((await request(app).patch(`/api/projects/${id}/candidates/${c.id}`).send({ start: 30, end: 20 })).status).toBe(400);
    expect((await request(app).patch(`/api/projects/${id}/candidates/${c.id}`).send({ end: 9999 })).status).toBe(400);
    const ok = await request(app).patch(`/api/projects/${id}/candidates/${c.id}`).send({ start: 5, end: 17.5, status: 'approved' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ start: 5, end: 17.5, edited: true, status: 'approved', selected: true });
  });

  it('adds a manual moment', async () => {
    const r = await request(app).post(`/api/projects/${id}/candidates`).send({ start: 40, end: 52, title: 'My pick' });
    expect(r.status).toBe(201);
    expect(r.body.source).toBe('manual');
  });

  it('renders, streams, downloads, zips and deletes clips', async () => {
    const r = await request(app).post(`/api/projects/${id}/render`).send({});
    expect(r.status).toBe(202);
    const job = await waitForJob(svc, r.body.id);
    expect(job.status, job.message).toBe('completed');
    const proj = (await request(app).get(`/api/projects/${id}`)).body;
    const clip = proj.clips.find((c: { status: string }) => c.status === 'completed');
    expect(clip).toBeTruthy();
    const ranged = await request(app).get(`/api/projects/${id}/clips/${clip.id}/video`).set('Range', 'bytes=0-1023');
    expect(ranged.status).toBe(206);
    expect((await request(app).get(`/api/projects/${id}/clips/${clip.id}/thumbnail`)).headers['content-type']).toMatch(/jpeg/);
    const zip = await request(app).get(`/api/projects/${id}/export.zip`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(zip.status).toBe(200);
    expect((zip.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const exp = await request(app).post(`/api/projects/${id}/export`).send({});
    expect(exp.body.count).toBeGreaterThan(0);
    expect(fs.readdirSync(exp.body.directory).length).toBe(exp.body.count);
    expect((await request(app).delete(`/api/projects/${id}/clips/${clip.id}`)).status).toBe(200);
    const after = (await request(app).get(`/api/projects/${id}`)).body;
    expect(after.clips.find((c: { id: string }) => c.id === clip.id)).toBeUndefined();
  });

  it('serves logs and deletes projects', async () => {
    const logs = await request(app).get(`/api/projects/${id}/logs?kind=analysis`);
    expect(logs.body.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs.body)).not.toMatch(/sk-ant-/);
    expect((await request(app).delete(`/api/projects/${id}`)).status).toBe(200);
    expect((await request(app).get(`/api/projects/${id}`)).status).toBe(404);
    // The original video must never be touched.
    expect(fs.existsSync(video)).toBe(true);
  });
});
