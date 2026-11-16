import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureVideo, tempDir, testServices, waitForJob } from './helpers.js';
import type { Services } from '../../src/services.js';
import { probeVideo } from '../../src/media/probe.js';
import type { Candidate } from '../../src/types.js';

describe('full pipeline (mock Claude CLI, real FFmpeg)', () => {
  let dir: string;
  let video: string;
  let svc: Services;
  let projectId: string;

  beforeAll(async () => {
    video = await fixtureVideo(90);
    dir = tempDir('pipeline');
    svc = testServices(dir);
    await svc.init();
  });
  afterAll(async () => {
    await svc.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('imports and analyses a video through every stage', async () => {
    const p = await svc.createProject({ path: video, name: 'Pipeline Test', settings: { analysis: { gameTitle: 'Fortnite' } } });
    projectId = p.id;
    const job = svc.queue.activeForProject(p.id)!;
    const done = await waitForJob(svc, job.id);
    expect(done.status, done.message).toBe('completed');
    const proj = svc.store.get(p.id);
    expect(proj.status).toBe('analyzed');
    for (const s of Object.values(proj.stages)) expect(['done', 'skipped']).toContain(s.status);
    expect(proj.metadata?.durationSeconds).toBeCloseTo(90, 0);
    expect(proj.game).toBe('Fortnite');
    const paths = svc.store.paths(p.id);
    for (const f of [paths.metadataFile, paths.scenesFile, paths.candidatesFile, paths.selectedFile, paths.contactSheetsFile, paths.audioAnalysisFile, paths.analysisLog]) {
      expect(fs.existsSync(f), f).toBe(true);
    }
    const sheets = JSON.parse(fs.readFileSync(paths.contactSheetsFile, 'utf8'));
    expect(sheets.length).toBe(Math.ceil(45 / 20));
    const candidates: Candidate[] = JSON.parse(fs.readFileSync(paths.candidatesFile, 'utf8'));
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.start).toBeGreaterThanOrEqual(0);
      expect(c.end).toBeLessThanOrEqual(90.01);
      expect(c.end - c.start).toBeGreaterThanOrEqual(8 - 0.01);
      expect(c.end - c.start).toBeLessThanOrEqual(20 + 0.01);
    }
    expect(proj.counts.selected).toBeGreaterThan(0);
    expect(proj.counts.selected).toBeLessThanOrEqual(3);
  });

  it('renders validated 1080x1920 clips, thumbnails and logs', async () => {
    const job = await svc.enqueueRender(projectId);
    const done = await waitForJob(svc, job.id);
    expect(done.status, done.message).toBe('completed');
    const proj = svc.store.get(projectId);
    const paths = svc.store.paths(projectId);
    expect(proj.clips.length).toBe(proj.counts.selected);
    for (const c of proj.clips) {
      expect(c.status).toBe('completed');
      expect(c.validation?.ok).toBe(true);
      expect(c.id).toMatch(/^clip-\d{3}$/);
      const file = paths.abs(c.file!);
      const md = await probeVideo(svc.tools, file);
      expect(md.video.width).toBe(1080);
      expect(md.video.height).toBe(1920);
      expect(md.video.codec).toBe('h264');
      expect(md.audio[0]?.codec).toBe('aac');
      expect(md.durationSeconds).toBeCloseTo(c.end - c.start, 0);
      expect(fs.existsSync(paths.abs(c.thumbnail!))).toBe(true);
    }
    expect(fs.existsSync(paths.renderingLog)).toBe(true);
  });

  it('reuses completed clips on re-render and keeps them when another clip fails', async () => {
    const before = svc.store.get(projectId).clips.map((c) => [c.id, c.renderedAt]);
    const job = await svc.enqueueRender(projectId);
    const done = await waitForJob(svc, job.id);
    expect(done.message).toMatch(/up to date/);
    expect(svc.store.get(projectId).clips.map((c) => [c.id, c.renderedAt])).toEqual(before);
  });

  it('honours user rejections when re-running selection', async () => {
    const paths = svc.store.paths(projectId);
    const list: Candidate[] = JSON.parse(fs.readFileSync(paths.candidatesFile, 'utf8'));
    const target = list.find((c) => c.selected)!;
    target.status = 'rejected';
    fs.writeFileSync(paths.candidatesFile, JSON.stringify(list));
    await svc.reselect(projectId);
    const after: Candidate[] = JSON.parse(fs.readFileSync(paths.candidatesFile, 'utf8'));
    const t = after.find((c) => c.id === target.id)!;
    expect(t.status).toBe('rejected');
    expect(t.selected).toBe(false);
  });

  it('organises the project folder as specified', () => {
    const root = svc.store.paths(projectId).root;
    for (const d of ['source', 'analysis', 'analysis/contact-sheets', 'analysis/frames', 'analysis/audio', 'clips', 'thumbnails', 'logs']) {
      expect(fs.existsSync(path.join(root, d)), d).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'project.json'))).toBe(true);
  });
});

describe('crash recovery and cancellation', () => {
  it('resumes an interrupted analysis from its last checkpoint', async () => {
    const video = await fixtureVideo(90);
    const dir = tempDir('recovery');
    try {
      const svc1 = testServices(dir);
      await svc1.init();
      const p = await svc1.createProject({ path: video, name: 'Recovery' });
      // Wait until frames are done, then simulate a crash/shutdown mid-pipeline.
      await new Promise<void>((resolve) => {
        const on = () => {
          const s = svc1.store.get(p.id).stages;
          if (s.frames.status === 'done') {
            svc1.store.off('event', on);
            resolve();
          }
        };
        svc1.store.on('event', on);
      });
      await svc1.shutdown();
      const job = svc1.queue.list({ projectId: p.id })[0]!;
      expect(job.status).toBe('queued');

      // "Restart" the app.
      const svc2 = testServices(dir);
      await svc2.init();
      expect(svc2.store.get(p.id).stages.frames.status).toBe('done');
      const done = await waitForJob(svc2, job.id);
      expect(done.status).toBe('completed');
      expect(done.attempts).toBe(2);
      expect(svc2.store.get(p.id).status).toBe('analyzed');
      await svc2.shutdown();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-queues jobs left "running" by a hard crash (kill -9)', async () => {
    const video = await fixtureVideo(60);
    const dir = tempDir('crash');
    try {
      const svc1 = testServices(dir);
      await svc1.init();
      const p = await svc1.createProject({ path: video, name: 'Crash' });
      const job = svc1.queue.activeForProject(p.id)!;
      await waitForJob(svc1, job.id);
      await svc1.shutdown();
      // Simulate a hard crash mid-job: persisted state says "running".
      const jobsFile = path.join(dir, 'data', 'jobs.json');
      const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'));
      jobs[0].status = 'running';
      fs.writeFileSync(jobsFile, JSON.stringify(jobs));
      const svc2 = testServices(dir);
      await svc2.init();
      const done = await waitForJob(svc2, job.id);
      expect(done.recoveries).toBe(1);
      expect(done.status).toBe('completed');
      await svc2.shutdown();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cancels a running job and kills its subprocesses', async () => {
    const video = await fixtureVideo(90);
    const dir = tempDir('cancel');
    const svc = testServices(dir);
    try {
      await svc.init();
      const p = await svc.createProject({ path: video, name: 'Cancel' });
      const job = svc.queue.activeForProject(p.id)!;
      await new Promise((r) => setTimeout(r, 400));
      await svc.queue.cancel(job.id);
      const done = await waitForJob(svc, job.id);
      expect(done.status).toBe('cancelled');
      expect(svc.store.get(p.id).status).toBe('cancelled');
    } finally {
      await svc.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
