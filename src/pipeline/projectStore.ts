import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ANALYSIS_STAGES, type Project, type StageName, type StageState } from '../types.js';
import { ensureDir, readJson, readJsonOr, writeJsonAtomic, isInside } from '../util/fsx.js';
import { NotFoundError, ValidationError } from '../util/errors.js';
import { Logger, fileSink } from '../util/logger.js';

/** Canonical layout of a project directory. */
export class ProjectPaths {
  constructor(readonly root: string) {}
  get projectFile(): string { return path.join(this.root, 'project.json'); }
  get sourceDir(): string { return path.join(this.root, 'source'); }
  get analysisDir(): string { return path.join(this.root, 'analysis'); }
  get metadataFile(): string { return path.join(this.analysisDir, 'metadata.json'); }
  get scenesFile(): string { return path.join(this.analysisDir, 'scenes.json'); }
  get framesDir(): string { return path.join(this.analysisDir, 'frames'); }
  get framesIndexFile(): string { return path.join(this.analysisDir, 'frames.json'); }
  get detailDir(): string { return path.join(this.analysisDir, 'detail'); }
  get contactSheetsDir(): string { return path.join(this.analysisDir, 'contact-sheets'); }
  get contactSheetsFile(): string { return path.join(this.analysisDir, 'contact-sheets.json'); }
  get audioDir(): string { return path.join(this.analysisDir, 'audio'); }
  get audioEnvelopeFile(): string { return path.join(this.audioDir, 'envelope.json'); }
  get audioAnalysisFile(): string { return path.join(this.audioDir, 'audio-analysis.json'); }
  get discoveryDir(): string { return path.join(this.analysisDir, 'discovery'); }
  get discoveryFile(): string { return path.join(this.analysisDir, 'discovery.json'); }
  get inspectionDir(): string { return path.join(this.analysisDir, 'inspection'); }
  get candidatesFile(): string { return path.join(this.analysisDir, 'candidates.json'); }
  get selectedFile(): string { return path.join(this.analysisDir, 'selected-clips.json'); }
  get previewsDir(): string { return path.join(this.analysisDir, 'previews'); }
  get clipsDir(): string { return path.join(this.root, 'clips'); }
  get thumbnailsDir(): string { return path.join(this.root, 'thumbnails'); }
  get logsDir(): string { return path.join(this.root, 'logs'); }
  get workDir(): string { return path.join(this.root, 'work'); }
  get analysisLog(): string { return path.join(this.logsDir, 'analysis.log'); }
  get renderingLog(): string { return path.join(this.logsDir, 'rendering.log'); }
  abs(rel: string): string {
    const p = path.resolve(this.root, rel);
    if (!isInside(this.root, p)) throw new ValidationError(`Path escapes project directory: ${rel}`);
    return p;
  }
  rel(abs: string): string { return path.relative(this.root, abs); }
}

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 48);
  return s || 'project';
}

export function freshStages(): Record<StageName, StageState> {
  return Object.fromEntries(ANALYSIS_STAGES.map((s) => [s, { status: 'pending', progress: 0 }])) as Record<StageName, StageState>;
}

export interface ProjectEvent {
  type: 'project' | 'deleted';
  projectId: string;
  project?: Project;
}

/**
 * Persistent store for projects. Every mutation goes through `update`, which
 * serialises writes per project and persists atomically to project.json.
 */
export class ProjectStore extends EventEmitter {
  private cache = new Map<string, Project>();
  private locks = new Map<string, Promise<unknown>>();
  private loggers = new Map<string, { analysis: Logger; rendering: Logger }>();

  constructor(readonly projectsDir: string, private readonly baseLogger: Logger) {
    super();
    this.setMaxListeners(100);
  }

  paths(id: string): ProjectPaths {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new ValidationError(`Invalid project id: ${id}`);
    return new ProjectPaths(path.join(this.projectsDir, id));
  }

  async init(): Promise<void> {
    await ensureDir(this.projectsDir);
    const entries = await fsp.readdir(this.projectsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(this.projectsDir, e.name, 'project.json');
      if (!fs.existsSync(file)) continue;
      try {
        const p = await readJson<Project>(file);
        this.cache.set(p.id, p);
      } catch (err) {
        this.baseLogger.warn('Skipping unreadable project', { dir: e.name, err });
      }
    }
  }

  list(): Project[] {
    return [...this.cache.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Project {
    const p = this.cache.get(id);
    if (!p) throw new NotFoundError(`Project not found: ${id}`);
    return p;
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  uniqueId(name: string): string {
    const base = slugify(name);
    let id = base;
    for (let n = 2; this.cache.has(id) || fs.existsSync(path.join(this.projectsDir, id)); n++) id = `${base}-${String(n).padStart(3, '0')}`;
    return id;
  }

  async create(p: Project): Promise<Project> {
    const paths = this.paths(p.id);
    await ensureDir(paths.root);
    await writeJsonAtomic(paths.projectFile, p);
    this.cache.set(p.id, p);
    this.emit('event', { type: 'project', projectId: p.id, project: p } satisfies ProjectEvent);
    return p;
  }

  /** Serialised read-modify-write of a project. */
  async update(id: string, mutate: (p: Project) => void | Promise<void>): Promise<Project> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const current = this.get(id);
      const draft = structuredClone(current);
      await mutate(draft);
      draft.updatedAt = new Date().toISOString();
      await writeJsonAtomic(this.paths(id).projectFile, draft);
      this.cache.set(id, draft);
      this.emit('event', { type: 'project', projectId: id, project: draft } satisfies ProjectEvent);
      return draft;
    });
    this.locks.set(id, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === run) this.locks.delete(id);
    }
  }

  async setStage(id: string, stage: StageName, patch: Partial<StageState>): Promise<Project> {
    return this.update(id, (p) => {
      p.stages[stage] = { ...p.stages[stage], ...patch };
    });
  }

  async delete(id: string): Promise<void> {
    const paths = this.paths(id);
    this.cache.delete(id);
    this.loggers.delete(id);
    await fsp.rm(paths.root, { recursive: true, force: true });
    this.emit('event', { type: 'deleted', projectId: id } satisfies ProjectEvent);
  }

  logger(id: string, kind: 'analysis' | 'rendering'): Logger {
    let l = this.loggers.get(id);
    if (!l) {
      const paths = this.paths(id);
      l = {
        analysis: this.baseLogger.child({ project: id }, [fileSink(paths.analysisLog)]),
        rendering: this.baseLogger.child({ project: id }, [fileSink(paths.renderingLog)]),
      };
      this.loggers.set(id, l);
    }
    return l[kind];
  }

  async readArtifact<T>(id: string, file: (p: ProjectPaths) => string, fallback: T): Promise<T> {
    return readJsonOr<T>(file(this.paths(id)), fallback);
  }
}
