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
    this.queue = new JobQueue(cfg.storage.dataDir, { analyze: cfg.server.analysisConcurrency, render: 1 }, this.logger.child({ component: 'queue' }));
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
