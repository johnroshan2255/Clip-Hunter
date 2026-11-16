import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import express, { type NextFunction, type Request, type Response } from 'express';
import archiver from 'archiver';
import Busboy from 'busboy';
import { z } from 'zod';
import type { Services } from '../services.js';
import { Auth } from './auth.js';
import { projectSettingsSchema } from '../config/schema.js';
import { AppError, NotFoundError, ValidationError, errorToJSON } from '../util/errors.js';
import { ensureDir, exists, readJsonOr, writeJsonAtomic, assertDiskSpace } from '../util/fsx.js';
import { ANALYSIS_STAGES, MOMENT_CATEGORIES, type AnalysisFrame, type Candidate, type StageName } from '../types.js';
import { runFfmpeg, fmtSec } from '../media/ffmpeg.js';
import { isSupportedVideo } from '../media/probe.js';
import { round3 } from '../util/time.js';
import { scoreCandidate } from '../pipeline/selection.js';
import type { ScenesFile } from '../pipeline/analyze.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

const idParam = (req: Request, name = 'id'): string => {
  const v = req.params[name];
  if (!v || !/^[\w.-]+$/.test(v)) throw new ValidationError(`Invalid ${name}`);
  return v;
};

/**
 * Host names this server answers to: loopback, the configured bind host, extra configured
 * hosts and — re-read every 30s so Wi-Fi/DHCP changes are picked up — this machine's own
 * interface addresses and hostname (for LAN sharing).
 */
export function localHostNames(bindHost: string, extra: string[]): () => Set<string> {
  let cache: Set<string> | null = null;
  let at = 0;
  return () => {
    if (cache && Date.now() - at < 30_000) return cache;
    const s = new Set<string>(['localhost', '127.0.0.1', '::1', '[::1]', bindHost.toLowerCase(), ...extra.map((h) => h.toLowerCase())]);
    const hn = os.hostname().toLowerCase();
    s.add(hn);
    s.add(hn.endsWith('.local') ? hn : `${hn}.local`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) s.add(a.family === 'IPv6' ? `[${a.address.toLowerCase()}]` : a.address);
    }
    cache = s;
    at = Date.now();
    return s;
  };
}

export function createApp(svc: Services, opts: { staticDir?: string } = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Only accept requests addressed to this machine (DNS-rebinding guard). When the server is
  // shared on the LAN, this machine's own interface IPs and hostname are allowed too.
  const allowedHosts = localHostNames(svc.cfg.server.host, svc.cfg.server.allowedHosts);
  app.use((req, res, next) => {
    const raw = (req.headers.host ?? '').toLowerCase();
    const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]!;
    if (host && !allowedHosts().has(host)) {
      res.status(403).json({ error: { code: 'FORBIDDEN_HOST', message: 'Host not allowed' } });
      return;
    }
    next();
  });

  const api = express.Router();

  api.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // Password protection (when server.passwordHash is set). Everything below requires a session.
  const auth = new Auth({
    passwordHash: svc.cfg.server.passwordHash,
    requireOnLoopback: svc.cfg.server.requirePasswordOnLocalhost,
    secretFile: path.join(svc.cfg.storage.dataDir, 'session-secret'),
  });
  api.use('/auth', auth.routes());
  api.use(auth.guard());

  api.get('/system', h(async (_req, res) => res.json(await svc.systemInfo())));

  api.post('/system/claude-check', h(async (_req, res) => {
    const version = await svc.claude.checkVersion().catch((e: Error) => `error: ${e.message}`);
    const auth = await svc.claude.checkAuth();
    res.json({ version, auth, status: svc.claude.status() });
  }));

  api.post('/system/claude-resume', h(async (_req, res) => {
    svc.claude.resume();
    res.json(svc.claude.status());
  }));

  api.get('/config', (_req, res) => {
    res.json({ config: svc.cfg, categories: MOMENT_CATEGORIES, stages: ANALYSIS_STAGES });
  });

  // ── Projects ──
  api.get('/projects', (_req, res) => {
    res.json(svc.store.list().map((p) => ({ ...p, activeJob: svc.queue.activeForProject(p.id) ?? null })));
  });

  api.post('/projects', h(async (req, res) => {
    const body = parse(
      z.object({ path: z.string().min(1), name: z.string().max(100).optional(), settings: projectSettingsSchema.optional(), autoAnalyze: z.boolean().optional() }),
      req.body,
    );
    const p = await svc.createProject(body);
    res.status(201).json(p);
  }));

  // Streaming multipart upload (never buffers the whole file in memory).
  api.post('/projects/upload', h(async (req, res) => {
    const uploadDir = path.join(svc.cfg.storage.dataDir, 'uploads');
    await ensureDir(uploadDir);
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared) await assertDiskSpace(uploadDir, declared + svc.cfg.storage.minFreeDiskGb * 1e9, 'the upload');
    const fields: Record<string, string> = {};
    const saved = await new Promise<string>((resolve, reject) => {
      const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 200 * 1024 ** 3 } });
      let target: string | null = null;
      let writeDone: Promise<void> | null = null;
      bb.on('field', (name, val) => {
        fields[name] = val;
      });
      bb.on('file', (_name, file, info) => {
        const safe = path.basename(info.filename || 'upload.mp4').replace(/[^\w.\-]+/g, '_');
        if (!isSupportedVideo(safe)) {
          file.resume();
          reject(new ValidationError('Unsupported file type'));
          return;
        }
        target = path.join(uploadDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safe}`);
        const ws = fs.createWriteStream(target);
        writeDone = new Promise((r, j) => {
          ws.on('finish', () => r());
          ws.on('error', j);
        });
        file.pipe(ws);
      });
      bb.on('error', reject);
      bb.on('close', () => {
        if (!target || !writeDone) return reject(new ValidationError('No file uploaded'));
        writeDone.then(() => resolve(target!), reject);
      });
      req.pipe(bb);
    });
    let settings;
    if (fields.settings) settings = parse(projectSettingsSchema, JSON.parse(fields.settings));
    const p = await svc.createProject({ path: saved, name: fields.name, settings, uploaded: true });
    res.status(201).json(p);
  }));

  api.get('/projects/:id', h(async (req, res) => {
    const id = idParam(req);
    const p = svc.store.get(id);
    res.json({ ...p, jobs: svc.queue.list({ projectId: id }).slice(0, 20), effectiveConfig: svc.projectConfig(p) });
  }));

  api.patch('/projects/:id', h(async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ name: z.string().min(1).max(100).optional(), settings: projectSettingsSchema.optional() }), req.body);
    const p = await svc.store.update(id, (d) => {
      if (body.name) d.name = body.name;
      if (body.settings) {
        d.settings = {
          analysis: { ...d.settings.analysis, ...body.settings.analysis },
          clips: { ...d.settings.clips, ...body.settings.clips },
          render: { ...d.settings.render, ...body.settings.render },
          audio: { ...d.settings.audio, ...body.settings.audio },
          text: { ...d.settings.text, ...body.settings.text },
        };
      }
    });
    svc.projectConfig(p); // throws if the combination is invalid
    res.json(p);
  }));

  api.delete('/projects/:id', h(async (req, res) => {
    const id = idParam(req);
    svc.store.get(id);
    await svc.queue.cancelProject(id);
    await svc.store.delete(id);
    res.json({ ok: true });
  }));

  api.post('/projects/:id/analyze', h(async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ fromStage: z.enum(ANALYSIS_STAGES as [StageName, ...StageName[]]).optional() }), req.body ?? {});
    res.status(202).json(await svc.enqueueAnalysis(id, body.fromStage));
  }));

  api.post('/projects/:id/render', h(async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ clipIds: z.array(z.string().regex(/^clip-\d{3,}$/)).optional(), force: z.boolean().optional() }), req.body ?? {});
    res.status(202).json(await svc.enqueueRender(id, body));
  }));

  api.post('/projects/:id/cancel', h(async (req, res) => {
    const id = idParam(req);
    const job = svc.queue.activeForProject(id);
    if (!job) throw new NotFoundError('No active job');
    res.json(await svc.queue.cancel(job.id));
  }));

  api.post('/projects/:id/reselect', h(async (req, res) => {
    const id = idParam(req);
    await svc.reselect(id);
    res.json(svc.store.get(id));
  }));

  // ── Candidates (moments) ──
  api.get('/projects/:id/candidates', h(async (req, res) => {
    const paths = svc.store.paths(idParam(req));
    res.json({
      candidates: await readJsonOr<Candidate[]>(paths.candidatesFile, []),
      selection: await readJsonOr(paths.selectedFile, null),
    });
  }));

  const candidatePatch = z.object({
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    selected: z.boolean().optional(),
    start: z.number().min(0).optional(),
    end: z.number().min(0).optional(),
    title: z.string().max(120).optional(),
  });

  api.patch('/projects/:id/candidates/:cid', h(async (req, res) => {
    const id = idParam(req);
    const cid = idParam(req, 'cid');
    const body = parse(candidatePatch, req.body);
    const p = svc.store.get(id);
    const cfg = svc.projectConfig(p);
    const paths = svc.store.paths(id);
    const list = await readJsonOr<Candidate[]>(paths.candidatesFile, []);
    const c = list.find((x) => x.id === cid);
    if (!c) throw new NotFoundError('Moment not found');
    if (body.start !== undefined || body.end !== undefined) {
      const start = round3(body.start ?? c.start);
      const end = round3(body.end ?? c.end);
      const dur = p.metadata?.durationSeconds ?? Infinity;
      if (end <= start) throw new ValidationError('End must be after start');
      if (end > dur + 0.01) throw new ValidationError('End is beyond the video duration');
      if (end - start < 1) throw new ValidationError('Clip must be at least 1 second');
      if (end - start > Math.max(cfg.clips.maxDurationSeconds, 180)) throw new ValidationError('Clip is too long');
      c.start = start;
      c.end = end;
      c.edited = true;
      if (c.peakTime !== undefined && (c.peakTime < start || c.peakTime > end)) c.peakTime = (start + end) / 2;
    }
    if (body.title !== undefined) c.title = body.title;
    if (body.status) {
      c.status = body.status;
      if (body.status === 'approved') c.selected = true;
      if (body.status === 'rejected') c.selected = false;
    }
    if (body.selected !== undefined) c.selected = body.selected;
    await writeJsonAtomic(paths.candidatesFile, list);
    await svc.store.update(id, (d) => {
      d.counts.selected = list.filter((x) => x.selected && x.status !== 'rejected').length;
    });
    res.json(c);
  }));

  api.post('/projects/:id/candidates', h(async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ start: z.number().min(0), end: z.number().min(0), title: z.string().max(120).default('Manual clip'), category: z.enum(MOMENT_CATEGORIES as [string, ...string[]]).default('other') }), req.body);
    const p = svc.store.get(id);
    if (!p.metadata) throw new ValidationError('Video metadata not available yet');
    if (body.end <= body.start || body.end > p.metadata.durationSeconds + 0.01) throw new ValidationError('Invalid time range');
    const paths = svc.store.paths(id);
    const list = await readJsonOr<Candidate[]>(paths.candidatesFile, []);
    const scenes = await readJsonOr<ScenesFile>(paths.scenesFile, { threshold: 0, changes: [], activity: [] });
    const audio = await readJsonOr<import('../types.js').AudioAnalysis | null>(paths.audioAnalysisFile, null);
    const base: Candidate = {
      id: `manual-${Date.now().toString(36)}`,
      start: round3(body.start),
      end: round3(body.end),
      category: body.category as Candidate['category'],
      title: body.title ?? 'Manual clip',
      description: 'Added manually',
      entertainmentScore: 10,
      confidence: 1,
      reason: 'User-selected moment',
      audioScore: 0,
      sceneScore: 0,
      finalScore: 10,
      source: 'manual',
      refined: true,
      status: 'approved',
      selected: true,
      edited: true,
    };
    const c = scoreCandidate(base, { audio: audio ?? undefined, changes: scenes.changes, activity: scenes.activity });
    list.push(c);
    list.sort((a, b) => a.start - b.start);
    await writeJsonAtomic(paths.candidatesFile, list);
    await svc.store.update(id, (d) => {
      d.counts.candidates = list.length;
      d.counts.selected = list.filter((x) => x.selected && x.status !== 'rejected').length;
    });
    res.status(201).json(c);
  }));

  // Low-res horizontal preview of a moment (rendered on demand, cached).
  api.get('/projects/:id/candidates/:cid/preview', h(async (req, res) => {
    const id = idParam(req);
    const cid = idParam(req, 'cid');
    const p = svc.store.get(id);
    const paths = svc.store.paths(id);
    const list = await readJsonOr<Candidate[]>(paths.candidatesFile, []);
    const c = list.find((x) => x.id === cid);
    if (!c) throw new NotFoundError('Moment not found');
    const out = path.join(paths.previewsDir, `${cid}-${c.start.toFixed(2)}-${c.end.toFixed(2)}.mp4`);
    if (!(await exists(out))) {
      await ensureDir(paths.previewsDir);
      const tmp = `${out}.tmp.mp4`;
      await runFfmpeg(
        svc.tools,
        ['-ss', fmtSec(c.start), '-t', fmtSec(c.end - c.start), '-i', paths.abs(p.sourceFile), '-map', '0:v:0', ...(p.metadata?.selectedAudioIndex != null ? ['-map', `0:${p.metadata.selectedAudioIndex}`] : []),
          '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tmp],
        { timeoutMs: 180_000, label: 'ffmpeg preview' },
      );
      await fsp.rename(tmp, out);
    }
    res.sendFile(out);
  }));

  // Nearest analysis frame for a timestamp (moment thumbnails).
  api.get('/projects/:id/frame', h(async (req, res) => {
    const id = idParam(req);
    const t = Number(req.query.t);
    if (!Number.isFinite(t)) throw new ValidationError('t is required');
    const paths = svc.store.paths(id);
    const idx = await readJsonOr<{ frames: AnalysisFrame[] } | null>(paths.framesIndexFile, null);
    if (!idx?.frames.length) throw new NotFoundError('Frames not extracted yet');
    let best = idx.frames[0]!;
    for (const f of idx.frames) if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
    res.setHeader('Cache-Control', 'max-age=3600');
    res.sendFile(paths.abs(best.file));
  }));

  api.get('/projects/:id/source', h(async (req, res) => {
    const id = idParam(req);
    const p = svc.store.get(id);
    res.sendFile(svc.store.paths(id).abs(p.sourceFile));
  }));

  // ── Clips ──
  const clipFile = (id: string, clipId: string, kind: 'file' | 'thumbnail', lang?: unknown) => {
    const p = svc.store.get(id);
    const c = p.clips.find((x) => x.id === clipId);
    if (!c) throw new NotFoundError('Clip not found');
    let rel = c[kind];
    if (kind === 'file' && typeof lang === 'string' && lang) {
      const v = c.variants?.find((x) => x.lang === lang);
      if (!v) throw new NotFoundError(`No ${lang} reel for this clip`);
      rel = v.file;
    }
    if (!rel) throw new NotFoundError(`Clip ${kind} not available`);
    return { abs: svc.store.paths(id).abs(rel), clip: c, project: p };
  };

  /** Every reel of a clip (all languages), falling back to the main file. */
  const allReels = (c: { file?: string; variants?: Array<{ lang: string | null; file: string }> }) =>
    c.variants?.length ? c.variants : c.file ? [{ lang: null, file: c.file }] : [];

  api.get('/projects/:id/clips/:clipId/video', h(async (req, res) => {
    const { abs } = clipFile(idParam(req), idParam(req, 'clipId'), 'file', req.query.lang);
    res.sendFile(abs);
  }));

  api.get('/projects/:id/clips/:clipId/thumbnail', h(async (req, res) => {
    const { abs } = clipFile(idParam(req), idParam(req, 'clipId'), 'thumbnail');
    res.sendFile(abs);
  }));

  api.get('/projects/:id/clips/:clipId/download', h(async (req, res) => {
    const { abs, clip, project } = clipFile(idParam(req), idParam(req, 'clipId'), 'file', req.query.lang);
    res.download(abs, `${project.id}-${path.basename(abs)}`);
    void clip;
  }));

  api.get('/projects/:id/clips/:clipId/subtitles/:lang', h(async (req, res) => {
    const id = idParam(req);
    const lang = idParam(req, 'lang');
    const { clip, project } = clipFile(id, idParam(req, 'clipId'), 'file');
    const sub = clip.subtitleFiles?.find((f) => f.lang === lang);
    if (!sub) throw new NotFoundError('No subtitles in that language for this clip');
    res.download(svc.store.paths(id).abs(sub.file), `${project.id}-${clip.id}.${lang}.srt`);
  }));

  api.delete('/projects/:id/clips/:clipId', h(async (req, res) => {
    const id = idParam(req);
    const clipId = idParam(req, 'clipId');
    const p = svc.store.get(id);
    const c = p.clips.find((x) => x.id === clipId);
    if (!c) throw new NotFoundError('Clip not found');
    if (c.status === 'rendering' || c.status === 'validating') throw new ValidationError('Clip is currently rendering');
    const paths = svc.store.paths(id);
    for (const rel of [c.file, c.thumbnail, ...allReels(c).map((v) => v.file), ...(c.subtitleFiles ?? []).map((f) => f.file)]) if (rel) await fsp.rm(paths.abs(rel), { force: true });
    // Deselect the moment so the next render does not recreate it.
    const list = await readJsonOr<Candidate[]>(paths.candidatesFile, []);
    const cand = list.find((x) => x.id === c.candidateId);
    if (cand) {
      cand.selected = false;
      await writeJsonAtomic(paths.candidatesFile, list);
    }
    await svc.store.update(id, (d) => {
      d.clips = d.clips.filter((x) => x.id !== clipId);
      d.counts.clipsCompleted = d.clips.filter((x) => x.status === 'completed').length;
      d.counts.clipsFailed = d.clips.filter((x) => x.status === 'failed').length;
      d.counts.selected = list.filter((x) => x.selected && x.status !== 'rejected').length;
    });
    res.json({ ok: true });
  }));

  // Export all completed clips as a zip stream.
  api.get('/projects/:id/export.zip', h(async (req, res) => {
    const id = idParam(req);
    const p = svc.store.get(id);
    const paths = svc.store.paths(id);
    const only = typeof req.query.clips === 'string' ? new Set(req.query.clips.split(',')) : null;
    const clips = p.clips.filter((c) => c.status === 'completed' && c.file && (!only || only.has(c.id)));
    if (!clips.length) throw new NotFoundError('No completed clips to export');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${p.id}-clips.zip"`);
    const zip = archiver('zip', { store: true });
    zip.on('error', (err) => res.destroy(err));
    zip.pipe(res);
    for (const c of clips) {
      for (const v of allReels(c)) zip.file(paths.abs(v.file), { name: path.basename(v.file) });
      for (const sub of c.subtitleFiles ?? []) zip.file(paths.abs(sub.file), { name: `${c.id}.${sub.lang}.srt` });
    }
    zip.append(JSON.stringify(clips.map((c) => ({ id: c.id, title: c.title, category: c.category, start: c.start, end: c.end, score: c.score })), null, 2), { name: 'clips.json' });
    await zip.finalize();
  }));

  // Copy completed clips into the exports folder.
  api.post('/projects/:id/export', h(async (req, res) => {
    const id = idParam(req);
    const body = parse(z.object({ clipIds: z.array(z.string()).optional() }), req.body ?? {});
    const p = svc.store.get(id);
    const paths = svc.store.paths(id);
    const clips = p.clips.filter((c) => c.status === 'completed' && c.file && (!body.clipIds || body.clipIds.includes(c.id)));
    if (!clips.length) throw new NotFoundError('No completed clips to export');
    const dir = path.join(svc.cfg.storage.exportsDir, p.id);
    await ensureDir(dir);
    let files = 0;
    for (const c of clips) {
      for (const v of allReels(c)) {
        await fsp.copyFile(paths.abs(v.file), path.join(dir, path.basename(v.file)));
        files++;
      }
      for (const sub of c.subtitleFiles ?? []) await fsp.copyFile(paths.abs(sub.file), path.join(dir, path.basename(sub.file)));
    }
    res.json({ ok: true, directory: dir, count: clips.length, files });
  }));

  api.get('/projects/:id/logs', h(async (req, res) => {
    const id = idParam(req);
    const kind = req.query.kind === 'rendering' ? 'rendering' : 'analysis';
    const tail = Math.min(2000, Math.max(1, Number(req.query.tail ?? 200)));
    const paths = svc.store.paths(id);
    const file = kind === 'rendering' ? paths.renderingLog : paths.analysisLog;
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    const lines = text.trim().split('\n').filter(Boolean).slice(-tail);
    res.json(lines.map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return { msg: l };
      }
    }));
  }));

  // ── Jobs ──
  api.get('/jobs', (req, res) => {
    res.json(svc.queue.list({ projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined }).slice(0, 200));
  });
  api.post('/jobs/:jobId/cancel', h(async (req, res) => res.json(await svc.queue.cancel(idParam(req, 'jobId')))));
  api.post('/jobs/:jobId/retry', h(async (req, res) => res.status(202).json(await svc.queue.retry(idParam(req, 'jobId')))));

  // ── Server-sent events: live project / job / Claude status updates ──
  api.get('/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { ok: true });
    const onProject = (e: unknown) => send('project', e);
    const onJob = (j: unknown) => send('job', j);
    const onClaude = (s: unknown) => send('claude', s);
    svc.store.on('event', onProject);
    svc.queue.on('job', onJob);
    svc.claude.on('status', onClaude);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      svc.store.off('event', onProject);
      svc.queue.off('job', onJob);
      svc.claude.off('status', onClaude);
    });
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API route' } });
  });

  if (opts.staticDir && fs.existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: 'index.html', maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(opts.staticDir!, 'index.html')));
  }

  // Structured error responses.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      err instanceof NotFoundError ? 404 :
      err instanceof ValidationError ? 400 :
      err instanceof AppError && (err.code === 'JOB_EXISTS' || err.code === 'JOB_ACTIVE') ? 409 :
      err instanceof AppError && err.code === 'DISK_SPACE_LOW' ? 507 :
      err instanceof AppError ? 422 :
      (err as { code?: string }).code === 'ENOENT' ? 404 : 500;
    if (status >= 500) svc.logger.error('Request failed', { err });
    if (res.headersSent) return;
    res.status(status).json({ error: errorToJSON(err) });
  });
  return app;
}
