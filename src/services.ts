import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AppConfig } from './config/schema.js';
import { effectiveConfig, loadConfig } from './config/load.js';
import { ClaudeCli } from './ai/claudeCli.js';
import { ProjectStore, freshStages } from './pipeline/projectStore.js';
import { runAnalysis, resetStages, stageSelection, type PipelineContext } from './pipeline/analyze.js';
import { runRenderJob, type RenderJobParams } from './render/renderJob.js';
import { JobQueue } from './jobs/queue.js';
import { Logger, createRootLogger, fileSink } from './util/logger.js';
import { cleanupTempFiles, ensureDir, freeDiskBytes, isInside } from './util/fsx.js';
import { runProcess } from './util/process.js';
import { isSupportedVideo, SUPPORTED_EXTENSIONS } from './media/probe.js';
import { ValidationError, isCancelled } from './util/errors.js';
import { whisperAvailable } from './transcribe/whisper.js';
import { ANALYSIS_STAGES, type Project, type StageName } from './types.js';
import type { FfmpegTools } from './media/ffmpeg.js';
import type { ProjectSettings } from './config/schema.js';
import { downloadVideo, validateDownloadUrl } from './media/download.js';
import { renderMontage, type MontageItem, type Transition } from './render/montage.js';
import { encoderReport } from './render/encoder.js';
import { gifskiAvailable } from './render/gif.js';
import { demucsAvailable } from './fx/separate.js';
import { loadSfxLibrary, type SoundEffect } from './fx/sfx.js';
import { detectFacecam } from './fx/facecam.js';
import { heuristicPlan, planEffectsWithClaude } from './fx/director.js';
import { fxSignature } from './fx/plan.js';
import { hookLanguages } from './render/renderJob.js';
import { readJsonOr, writeJsonAtomic } from './util/fsx.js';
import { NotFoundError } from './util/errors.js';
import type { AnalysisFrame, AudioAnalysis, Candidate, ClipFx, MontageRecord } from './types.js';

/** Application service container shared by the HTTP server and the CLI. */
export class Services {
  readonly logger: Logger;
  readonly store: ProjectStore;
  readonly claude: ClaudeCli;
  readonly queue: JobQueue;
  readonly tools: FfmpegTools;

  constructor(readonly cfg: AppConfig, logger?: Logger) {
    this.logger = logger ?? createRootLogger(cfg.logLevel, [fileSink(path.join(cfg.storage.dataDir, 'logs', 'app.log'), cfg.logLevel)]);
    this.tools = { ffmpeg: cfg.ffmpegPath, ffprobe: cfg.ffprobePath };
    this.store = new ProjectStore(cfg.storage.projectsDir, this.logger);
    this.claude = new ClaudeCli(cfg.claude, this.logger.child({ component: 'claude' }));
    this.queue = new JobQueue(cfg.storage.dataDir, { analyze: cfg.server.analysisConcurrency, render: 1, montage: 1, download: 2 }, this.logger.child({ component: 'queue' }));
    this.queue.register('montage', async ({ job, signal, progress }) => this.runMontage(job.projectId, String((job.params as { montageId?: string }).montageId), signal, progress));
    this.queue.register('download', async ({ job, signal, progress }) => this.runDownload(job.projectId, signal, progress));
    this.queue.register('analyze', async ({ job, signal, progress }) => {
      const params = job.params as { fromStage?: StageName };
      if (params.fromStage && job.attempts === 1 && !job.recoveries) await resetStages(this.store, job.projectId, params.fromStage);
      const ctx = this.pipelineContext(job.projectId, signal);
      const onEvent = () => {
        const p = this.store.get(job.projectId);
        const done = ANALYSIS_STAGES.filter((s) => p.stages[s].status === 'done' || p.stages[s].status === 'skipped').length;
        const running = ANALYSIS_STAGES.find((s) => p.stages[s].status === 'running');
        progress((done + (running ? p.stages[running].progress : 0)) / ANALYSIS_STAGES.length, running ? `${running}: ${p.stages[running].message ?? ''}` : undefined);
      };
      const listener = (e: { projectId: string }) => e.projectId === job.projectId && onEvent();
      this.store.on('event', listener);
      try {
        await runAnalysis(ctx);
      } catch (err) {
        await this.store.update(job.projectId, (p) => {
          p.status = isCancelled(err) ? 'cancelled' : 'failed';
          p.error = isCancelled(err) ? undefined : { message: (err as Error).message, code: (err as { code?: string }).code };
        });
        throw err;
      } finally {
        this.store.off('event', listener);
      }
      const p = this.store.get(job.projectId);
      return `${p.counts.candidates} candidates, ${p.counts.selected} selected`;
    });
    this.queue.register('render', async ({ job, signal, progress }) => {
      const p = this.store.get(job.projectId);
      return runRenderJob({
        store: this.store,
        projectId: job.projectId,
        cfg: this.projectConfig(p),
        tools: this.tools,
        logger: this.store.logger(job.projectId, 'rendering'),
        signal,
        params: job.params as RenderJobParams,
        claude: this.claude,
        onProgress: progress,
      });
    });
  }

  static create(overrides?: unknown): Services {
    return new Services(loadConfig({ overrides }));
  }

  async init(): Promise<void> {
    await ensureDir(this.cfg.storage.projectsDir);
    await ensureDir(this.cfg.storage.dataDir);
    await this.store.init();
    const removed = await cleanupTempFiles(this.cfg.storage.projectsDir);
    if (removed) this.logger.info('Cleaned up temporary files from a previous run', { removed });
    const { recovered } = await this.queue.init();
    if (recovered) this.logger.warn('Recovered interrupted jobs; they will resume from their last checkpoint', { recovered });
    // Projects that were mid-flight without an active job are marked accordingly.
    for (const p of this.store.list()) {
      const active = this.queue.activeForProject(p.id);
      if (!active && (p.status === 'analyzing' || p.status === 'rendering' || p.status === 'queued')) {
        await this.store.update(p.id, (d) => {
          d.status = p.status === 'rendering' ? 'analyzed' : 'created';
          for (const c of d.clips) if (c.status === 'rendering' || c.status === 'validating' || c.status === 'queued') c.status = 'cancelled';
          for (const s of ANALYSIS_STAGES) if (d.stages[s].status === 'running') d.stages[s] = { ...d.stages[s], status: 'pending' };
        });
      }
    }
    this.queue.start();
  }

  projectConfig(p: Project): AppConfig {
    return effectiveConfig(this.cfg, p.settings);
  }

  pipelineContext(projectId: string, signal: AbortSignal): PipelineContext {
    const p = this.store.get(projectId);
    return {
      store: this.store,
      projectId,
      paths: this.store.paths(projectId),
      cfg: this.projectConfig(p),
      tools: this.tools,
      claude: this.claude,
      logger: this.store.logger(projectId, 'analysis'),
      signal,
    };
  }

  allowedImportRoots(): string[] {
    return (this.cfg.server.allowedImportRoots.length ? this.cfg.server.allowedImportRoots : [os.homedir(), '/Volumes']).map((r) => path.resolve(r));
  }

  /** Validate a local path for import (no traversal outside allowed roots, supported format). */
  async validateImportPath(p: string): Promise<string> {
    if (typeof p !== 'string' || !p.trim()) throw new ValidationError('A file path is required');
    const abs = path.resolve(p.trim().replace(/^~(?=$|\/)/, os.homedir()));
    if (!this.allowedImportRoots().some((r) => isInside(r, abs))) throw new ValidationError(`Path is outside the allowed import folders: ${this.allowedImportRoots().join(', ')}`);
    if (!isSupportedVideo(abs)) throw new ValidationError(`Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new ValidationError('File not found');
    if (st.size === 0) throw new ValidationError('File is empty');
    return abs;
  }

  /** Create a project for a local video file (source is linked/copied by the ingest stage). */
  async createProject(o: { path: string; name?: string; settings?: ProjectSettings; autoAnalyze?: boolean; uploaded?: boolean }): Promise<Project> {
    const abs = o.uploaded ? o.path : await this.validateImportPath(o.path);
    const name = o.name?.trim() || path.basename(abs, path.extname(abs));
    const id = this.store.uniqueId(name);
    const now = new Date().toISOString();
    const project: Project = {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      originalPath: abs,
      sourceFile: path.join('source', path.basename(abs).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '')),
      importMethod: o.uploaded ? 'upload' : undefined,
      status: 'created',
      settings: o.settings ?? {},
      stages: freshStages(),
      counts: { candidates: 0, selected: 0, clipsCompleted: 0, clipsFailed: 0 },
      clips: [],
    };
    await this.store.create(project);
    this.store.logger(id, 'analysis').info('Project created', { name, source: path.basename(abs) });
    if (o.autoAnalyze !== false) await this.enqueueAnalysis(id);
    return this.store.get(id);
  }

  async enqueueAnalysis(projectId: string, fromStage?: StageName) {
    this.store.get(projectId);
    if (this.queue.activeForProject(projectId)) return this.queue.enqueue('analyze', projectId, {}); // throws JOB_EXISTS
    // Mark queued *before* enqueueing: the queue may start the job immediately and set "analyzing".
    const prevStatus = this.store.get(projectId).status;
    await this.store.update(projectId, (p) => {
      p.status = 'queued';
    });
    try {
      return await this.queue.enqueue('analyze', projectId, fromStage ? { fromStage } : {});
    } catch (err) {
      await this.store.update(projectId, (p) => {
        p.status = prevStatus;
      });
      throw err;
    }
  }

  async enqueueRender(projectId: string, params: RenderJobParams = {}) {
    this.store.get(projectId);
    return this.queue.enqueue('render', projectId, params as Record<string, unknown>);
  }

  /** Re-run only the selection stage (after user approvals / edits). Fast, no AI calls. */
  async reselect(projectId: string): Promise<void> {
    const p = this.store.get(projectId);
    if (p.stages.inspection.status !== 'done') throw new ValidationError('Analysis has not finished yet');
    if (this.queue.activeForProject(projectId)) throw new ValidationError('A job is running for this project');
    const ctx = this.pipelineContext(projectId, new AbortController().signal);
    const msg = await stageSelection(ctx);
    await this.store.setStage(projectId, 'selection', { status: 'done', progress: 1, message: msg, finishedAt: new Date().toISOString() });
  }

  // ── Import from a link (yt-dlp) ──

  async createProjectFromUrl(o: { url: string; name?: string; settings?: ProjectSettings }): Promise<Project> {
    const url = validateDownloadUrl(o.url);
    const name = o.name?.trim() || `${url.hostname.replace(/^www\./, '')} video`;
    const id = this.store.uniqueId(name);
    const now = new Date().toISOString();
    await this.store.create({
      id,
      name,
      createdAt: now,
      updatedAt: now,
      originalPath: url.toString(),
      sourceFile: path.join('source', 'download.mp4'),
      importMethod: 'upload',
      status: 'queued',
      settings: o.settings ?? {},
      stages: freshStages(),
      counts: { candidates: 0, selected: 0, clipsCompleted: 0, clipsFailed: 0 },
      clips: [],
      download: { url: url.toString(), status: 'queued', progress: 0 },
    });
    await this.queue.enqueue('download', id, {});
    return this.store.get(id);
  }

  downloadsDir(projectId: string): string {
    return path.join(this.cfg.storage.dataDir, 'downloads', projectId);
  }

  private async runDownload(projectId: string, signal: AbortSignal, progress: (f: number, m?: string) => void): Promise<string> {
    const p = this.store.get(projectId);
    if (!p.download) throw new ValidationError('Project was not imported from a link');
    if (p.download.status === 'done' && (await fsp.stat(p.originalPath).catch(() => null))?.isFile()) return 'Already downloaded';
    const log = this.store.logger(projectId, 'analysis');
    await this.store.update(projectId, (d) => {
      d.download = { ...d.download!, status: 'downloading', progress: 0, error: undefined };
      d.status = 'queued';
    });
    let lastSave = 0;
    try {
      const res = await downloadVideo({
        ytdlp: this.cfg.download.ytdlpExecutable,
        ffmpeg: this.cfg.ffmpegPath,
        url: p.download.url,
        outDir: this.downloadsDir(projectId),
        maxHeight: this.cfg.download.maxHeight,
        cookiesFromBrowser: this.cfg.download.cookiesFromBrowser || undefined,
        signal,
        onProgress: (f, m) => {
          progress(f, m);
          if (Date.now() - lastSave > 2000) {
            lastSave = Date.now();
            void this.store.update(projectId, (d) => {
              if (d.download) d.download.progress = Math.round(f * 100) / 100;
            });
          }
        },
      });
      await this.store.update(projectId, (d) => {
        d.originalPath = res.file;
        d.sourceFile = path.join('source', path.basename(res.file).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, ''));
        d.download = { ...d.download!, status: 'done', progress: 1, title: res.title };
        if (res.title && d.name.endsWith(' video')) d.name = res.title.slice(0, 100);
      });
      log.info('Downloaded video from link', { file: path.basename(res.file) });
    } catch (err) {
      await this.store.update(projectId, (d) => {
        d.download = { ...d.download!, status: 'failed', error: (err as Error).message.slice(0, 300) };
        d.status = isCancelled(err) ? 'cancelled' : 'failed';
        d.error = isCancelled(err) ? undefined : { message: (err as Error).message.slice(0, 300), code: 'DOWNLOAD_FAILED' };
      });
      throw err;
    }
    // Analysis starts as soon as this job finishes (jobs of one project never overlap).
    await this.queue.enqueue('analyze', projectId, {});
    return 'Downloaded; analysis queued';
  }

  // ── Montages ──

  async createMontage(projectId: string, o: { clipIds?: string[]; orientation: 'vertical' | 'horizontal'; lang?: string | null; transition: Transition }): Promise<MontageRecord> {
    const p = this.store.get(projectId);
    const done = p.clips.filter((c) => c.status === 'completed' && c.file && (!o.clipIds || o.clipIds.includes(c.id)));
    if (done.length < 2) throw new ValidationError('Pick at least 2 rendered clips');
    const id = `montage-${Date.now().toString(36)}`;
    const rec: MontageRecord = { id, orientation: o.orientation, lang: o.lang ?? null, clipIds: done.map((c) => c.id), transition: o.transition, status: 'queued', progress: 0, createdAt: new Date().toISOString() };
    await this.store.update(projectId, (d) => {
      d.montages = [...(d.montages ?? []), rec];
    });
    try {
      await this.queue.enqueue('montage', projectId, { montageId: id });
    } catch (err) {
      await this.store.update(projectId, (d) => {
        d.montages = (d.montages ?? []).filter((m) => m.id !== id);
      });
      throw err;
    }
    return rec;
  }

  private async runMontage(projectId: string, montageId: string, signal: AbortSignal, progress: (f: number, m?: string) => void): Promise<string> {
    const p = this.store.get(projectId);
    const m = p.montages?.find((x) => x.id === montageId);
    if (!m) throw new NotFoundError('Montage not found');
    const paths = this.store.paths(projectId);
    const cfg = this.projectConfig(p);
    const clips = m.clipIds.map((id) => p.clips.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c && c.status === 'completed');
    const items: MontageItem[] = clips.map((c) => {
      if (m.orientation === 'horizontal') return { kind: 'source', file: paths.abs(p.sourceFile), start: c.start, end: c.end, audioIndex: p.metadata?.selectedAudioIndex ?? null };
      const reel = (m.lang ? c.variants?.find((v) => v.lang === m.lang)?.file : undefined) ?? c.file!;
      return { kind: 'reel', file: paths.abs(reel) };
    });
    const set = (patch: Partial<MontageRecord>) =>
      this.store.update(projectId, (d) => {
        const x = d.montages?.find((y) => y.id === montageId);
        if (x) Object.assign(x, patch);
      });
    await set({ status: 'rendering', progress: 0, error: undefined });
    const file = path.join(paths.root, 'montages', `${montageId}-${m.orientation}${m.lang ? `-${m.lang}` : ''}.mp4`);
    try {
      let last = 0;
      const r = await renderMontage({
        tools: this.tools,
        cfg,
        items,
        orientation: m.orientation,
        transition: m.transition as Transition,
        outFile: file,
        signal,
        onProgress: (f) => {
          progress(f);
          if (f - last > 0.05) {
            last = f;
            void set({ progress: Math.round(f * 100) / 100 });
          }
        },
      });
      await set({ status: 'completed', progress: 1, file: paths.rel(file), durationSeconds: r.durationSeconds, sizeBytes: r.sizeBytes });
      return `Montage of ${items.length} clips ready (${Math.round(r.durationSeconds)}s)`;
    } catch (err) {
      await set({ status: 'failed', progress: 0, error: isCancelled(err) ? 'Cancelled' : (err as Error).message.slice(0, 300) });
      throw err;
    }
  }

  // ── Effects ──

  async sfxLibrary(): Promise<SoundEffect[]> {
    return loadSfxLibrary(this.tools, this.cfg.storage.dataDir, this.cfg.fx.sfxDir);
  }

  /** Plan a moment's effects with Claude right now (from the effects editor). */
  async planFxNow(projectId: string, candidateId: string): Promise<ClipFx> {
    const p = this.store.get(projectId);
    const cfg = this.projectConfig(p);
    const paths = this.store.paths(projectId);
    const list = await readJsonOr<Candidate[]>(paths.candidatesFile, []);
    const cand = list.find((c) => c.id === candidateId);
    if (!cand) throw new NotFoundError('Moment not found');
    const clip = p.clips.find((c) => c.candidateId === candidateId);
    const lib = await this.sfxLibrary();
    const audio = await readJsonOr<AudioAnalysis | null>(paths.audioAnalysisFile, null);
    const input = {
      candidate: cand,
      start: clip?.start ?? cand.start,
      end: clip?.end ?? cand.end,
      audioEvents: audio?.events,
      sounds: lib.map((s) => ({ name: s.name, description: s.description })),
      cfg: { ...cfg.fx, enabled: true },
      hookLanguages: hookLanguages(cfg),
      hindiScript: cfg.text.hindiScript,
      game: p.game || cfg.analysis.gameTitle || undefined,
      signature: fxSignature(cfg.fx, hookLanguages(cfg)),
    };
    let fx: ClipFx;
    try {
      fx = await planEffectsWithClaude(this.claude, input);
    } catch (err) {
      this.store.logger(projectId, 'rendering').warn('AI effects planning failed; using rule-based effects', { err });
      fx = heuristicPlan(input);
    }
    const fresh = await readJsonOr<Candidate[]>(paths.candidatesFile, []);
    const c = fresh.find((x) => x.id === candidateId);
    if (c) {
      c.fx = fx;
      await writeJsonAtomic(paths.candidatesFile, fresh);
    }
    return fx;
  }

  /** Detect the webcam overlay now (Settings → Facecam). */
  async detectFacecamNow(projectId: string): Promise<Project> {
    const paths = this.store.paths(projectId);
    const idx = await readJsonOr<{ frames: AnalysisFrame[] } | null>(paths.framesIndexFile, null);
    const frames = idx?.frames ?? [];
    if (frames.length < 3) throw new ValidationError('Analyze the video first');
    const pick = [0.2, 0.5, 0.8].map((f) => paths.abs(frames[Math.floor(frames.length * f)]!.file));
    const work = path.join(paths.workDir, 'facecam');
    await ensureDir(work);
    const rect = await detectFacecam(this.claude, pick, work);
    return this.store.update(projectId, (d) => {
      d.facecam = { rect, source: 'auto', checkedAt: new Date().toISOString() };
    });
  }

  async toolsInfo(): Promise<Record<string, unknown>> {
    const check = async (cmd: string, args: string[]) => {
      try {
        const r = await runProcess(cmd, args, { timeoutMs: 20_000 });
        return (r.stdout || r.stderr).split('\n').find((l) => l.trim())?.trim().slice(0, 80) ?? 'ok';
      } catch {
        return null;
      }
    };
    const [encoders, ytdlp, gifski, demucs] = await Promise.all([
      encoderReport(this.tools),
      check(this.cfg.download.ytdlpExecutable, ['--version']),
      gifskiAvailable(),
      demucsAvailable(this.cfg.audio.demucsExecutable),
    ]);
    return { encoders, ytdlp, gifski, demucs: demucs.ok, sfxDir: this.cfg.fx.sfxDir };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    const version = async (cmd: string, args: string[]) => {
      try {
        const r = await runProcess(cmd, args, { timeoutMs: 15_000 });
        return (r.stdout || r.stderr).split('\n')[0]?.trim();
      } catch {
        return null;
      }
    };
    const [ffmpeg, ffprobe] = await Promise.all([version(this.cfg.ffmpegPath, ['-version']), version(this.cfg.ffprobePath, ['-version'])]);
    if (!this.claude.status().version) await this.claude.checkVersion().catch(() => undefined);
    const whisper = await whisperAvailable({ executable: this.cfg.text.whisperExecutable, modelPath: this.cfg.text.whisperModelPath });
    return {
      node: process.version,
      platform: `${process.platform} ${os.release()}`,
      cpus: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 1e9),
      ffmpeg,
      ffprobe,
      claude: this.claude.status(),
      whisper,
      tools: await this.toolsInfo(),
      freeDiskGb: Math.round((await freeDiskBytes(this.cfg.storage.projectsDir)) / 1e8) / 10,
      projectsDir: this.cfg.storage.projectsDir,
      config: {
        model: this.cfg.claude.model,
        frameInterval: this.cfg.analysis.frameIntervalSeconds,
        clipCount: this.cfg.clips.count,
        composition: this.cfg.render.compositionMode,
        renderConcurrency: this.cfg.render.concurrency,
        output: `${this.cfg.render.width}x${this.cfg.render.height}@${this.cfg.render.fps}`,
      },
    };
  }

  async shutdown(): Promise<void> {
    await this.queue.shutdown();
  }
}
