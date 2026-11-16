import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readJsonOr, writeJsonAtomic } from '../util/fsx.js';
import { errorToJSON, isCancelled, AppError, NotFoundError, ValidationError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export type JobType = 'analyze' | 'render' | 'montage' | 'download';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  type: JobType;
  projectId: string;
  status: JobStatus;
  progress: number;
  message?: string;
  params: Record<string, unknown>;
  attempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: Record<string, unknown>;
  /** Number of times this job was resumed after an app restart. */
  recoveries?: number;
}

export interface JobContext {
  job: Job;
  signal: AbortSignal;
  progress: (fraction: number, message?: string) => void;
}

export type JobHandler = (ctx: JobContext) => Promise<string | void>;

/**
 * Persistent background job queue.
 * - State is persisted to data/jobs.json after every transition (atomic writes).
 * - On start-up, jobs that were running when the process died are re-queued
 *   (handlers are resumable: completed stages/clips are reused).
 * - Per-type concurrency limits; jobs of the same project never run concurrently.
 */
export class JobQueue extends EventEmitter {
  private jobs: Job[] = [];
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<void>>();
  private persistChain: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly file: string;

  constructor(
    dataDir: string,
    private limits: Record<JobType, number>,
    private readonly logger: Logger,
  ) {
    super();
    this.file = path.join(dataDir, 'jobs.json');
    this.setMaxListeners(100);
  }

  register(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  setLimits(limits: Partial<Record<JobType, number>>): void {
    this.limits = { ...this.limits, ...limits };
    this.schedule();
  }

  async init(): Promise<{ recovered: number }> {
    this.jobs = await readJsonOr<Job[]>(this.file, []);
    let recovered = 0;
    for (const j of this.jobs) {
      if (j.status === 'running') {
        j.status = 'queued';
        j.message = 'Recovered after restart; resuming';
        j.recoveries = (j.recoveries ?? 0) + 1;
        recovered++;
      }
    }
    // Keep history bounded.
    const finished = this.jobs.filter((j) => j.status !== 'queued');
    if (finished.length > 500) {
      const drop = new Set(finished.slice(0, finished.length - 500).map((j) => j.id));
      this.jobs = this.jobs.filter((j) => !drop.has(j.id));
    }
    await this.persist();
    return { recovered };
  }

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  list(filter: { projectId?: string } = {}): Job[] {
    return this.jobs.filter((j) => !filter.projectId || j.projectId === filter.projectId).slice().reverse();
  }

  get(id: string): Job {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) throw new NotFoundError(`Job not found: ${id}`);
    return j;
  }

  activeForProject(projectId: string): Job | undefined {
    return this.jobs.find((j) => j.projectId === projectId && (j.status === 'queued' || j.status === 'running'));
  }

  async enqueue(type: JobType, projectId: string, params: Record<string, unknown> = {}): Promise<Job> {
    if (!this.handlers.has(type)) throw new ValidationError(`Unknown job type: ${type}`);
    const existing = this.jobs.find((j) => j.projectId === projectId && j.type === type && (j.status === 'queued' || j.status === 'running'));
    if (existing) throw new AppError('JOB_EXISTS', `A ${type} job is already ${existing.status} for this project`, { details: { jobId: existing.id } });
    const job: Job = {
      id: `job_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      type,
      projectId,
      status: 'queued',
      progress: 0,
      params,
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.push(job);
    await this.persist();
    this.emitJob(job);
    this.schedule();
    return job;
  }

  async cancel(id: string): Promise<Job> {
    const job = this.get(id);
    if (job.status === 'queued') {
      job.status = 'cancelled';
      job.finishedAt = new Date().toISOString();
      await this.persist();
      this.emitJob(job);
    } else if (job.status === 'running') {
      this.controllers.get(id)?.abort();
    }
    return job;
  }

  async cancelProject(projectId: string): Promise<void> {
    for (const j of this.jobs.filter((x) => x.projectId === projectId && (x.status === 'queued' || x.status === 'running'))) await this.cancel(j.id);
    await Promise.all([...this.running.entries()].filter(([id]) => this.jobs.find((j) => j.id === id)?.projectId === projectId).map(([, p]) => p));
  }

  async retry(id: string): Promise<Job> {
    const old = this.get(id);
    if (old.status === 'queued' || old.status === 'running') throw new AppError('JOB_ACTIVE', 'Job is still active');
    return this.enqueue(old.type, old.projectId, old.params);
  }

  /** Graceful shutdown: abort running jobs; they are re-queued for the next start. */
  async shutdown(timeoutMs = 15_000): Promise<void> {
    this.stopped = true;
    for (const j of this.jobs.filter((x) => x.status === 'running')) {
      j.message = 'Interrupted by shutdown; will resume';
      this.controllers.get(j.id)?.abort();
    }
    await Promise.race([Promise.allSettled([...this.running.values()]), new Promise((r) => setTimeout(r, timeoutMs))]);
    // Anything still marked running is re-queued so it resumes on next start.
    for (const j of this.jobs) if (j.status === 'running' || (j.status === 'cancelled' && j.message?.includes('shutdown'))) j.status = 'queued';
    await this.persist();
  }

  private persist(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.jobs)) as Job[];
    this.persistChain = this.persistChain.then(() => writeJsonAtomic(this.file, snapshot)).catch((err) => this.logger.error('Failed to persist job queue', { err }));
    return this.persistChain;
  }

  private emitJob(job: Job): void {
    this.emit('job', { ...job });
  }

  private schedule(): void {
    if (this.stopped) return;
    for (const job of this.jobs) {
      if (job.status !== 'queued') continue;
      const runningOfType = this.jobs.filter((j) => j.status === 'running' && j.type === job.type).length;
      if (runningOfType >= (this.limits[job.type] ?? 1)) continue;
      if (this.jobs.some((j) => j.status === 'running' && j.projectId === job.projectId)) continue;
      this.run(job);
    }
  }

  private run(job: Job): void {
    const handler = this.handlers.get(job.type)!;
    const ac = new AbortController();
    this.controllers.set(job.id, ac);
    job.status = 'running';
    job.attempts++;
    job.startedAt = new Date().toISOString();
    job.error = undefined;
    job.message = undefined;
    void this.persist();
    this.emitJob(job);
    let lastEmit = 0;
    const progress = (fraction: number, message?: string) => {
      job.progress = Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 1000;
      if (message) job.message = message;
      const now = Date.now();
      if (now - lastEmit > 500 || fraction >= 1) {
        lastEmit = now;
        this.emitJob(job);
      }
    };
    const p = (async () => {
      try {
        const msg = await handler({ job, signal: ac.signal, progress });
        job.status = 'completed';
        job.progress = 1;
        if (msg) job.message = msg;
      } catch (err) {
        if (isCancelled(err) || ac.signal.aborted) {
          job.status = this.stopped ? 'queued' : 'cancelled';
          job.message = this.stopped ? 'Interrupted by shutdown; will resume' : 'Cancelled';
        } else {
          job.status = 'failed';
          job.error = errorToJSON(err);
          job.message = (err as Error).message;
          this.logger.error('Job failed', { jobId: job.id, type: job.type, projectId: job.projectId, err });
        }
      } finally {
        job.finishedAt = new Date().toISOString();
        this.controllers.delete(job.id);
        this.running.delete(job.id);
        await this.persist();
        this.emitJob(job);
        this.schedule();
      }
    })();
    this.running.set(job.id, p);
  }
}
